import { describe, expect, it } from "vitest";
import { mkdtempSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  windowRanges,
  docWindows,
  codeWindows,
  planRefresh,
  refreshIndex,
  rankTop,
  isLockStale,
  tryTakeLock,
  releaseLock,
  keyOf,
  REFRESH_LIMIT,
  LOCK_STALE_MS,
} from "../../../scripts/devSearch/lib.mjs";

/** 偽の埋め込み：文の長さと先頭の字から決まる2次元（Ollama は呼ばない） */
function fakeEmbed(log: string[][] = []) {
  return async (texts: string[]) => {
    log.push(texts);
    return texts.map((t) => [t.length % 7 || 1, t.charCodeAt(0) % 5 || 1]);
  };
}

describe("開発用の意味の検索：窓の切り方", () => {
  it("2,000字の窓が400字ずつ重なり、最後の窓は終わりまで届く", () => {
    const r = windowRanges(5000, 2000, 400);
    expect(r).toEqual([[0, 2000], [1600, 3600], [3200, 5000]]);
  });

  it("短い文は1つの窓で、空の文は窓なし", () => {
    expect(windowRanges(10)).toEqual([[0, 10]]);
    expect(windowRanges(0)).toEqual([]);
  });

  it("文書は見出しの道を窓の頭に付け、窓ごとに始まりと終わりの行を持つ", () => {
    const text = ["# 題", "前置き", "## 一章", "あ".repeat(30), "### 小節", "い".repeat(30), "ううう"].join("\n");
    const wins = docWindows("docs/x.md", text, 2000, 400);
    expect(wins.map((w: { hp: string }) => w.hp)).toEqual(["題", "題 > 一章", "題 > 一章 > 小節"]);
    expect(wins[2].startLine).toBe(5);
    expect(wins[2].endLine).toBe(7);
    expect(wins[2].embedText.startsWith("docs/x.md｜題 > 一章 > 小節\n")).toBe(true);
  });

  it("コードの囲みの中の # は見出しにしない", () => {
    const text = ["## 見出し", "```", "# 手順のコメント", "```", "本文"].join("\n");
    const wins = docWindows("docs/y.md", text);
    expect(wins).toHaveLength(1);
    expect(wins[0].hp).toBe("見出し");
  });

  it("長い節は複数の窓に切れ、行の範囲が重なる", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `行${i + 1}：${"x".repeat(40)}`);
    const wins = docWindows("docs/long.md", ["## 長い", ...lines].join("\n"), 2000, 400);
    expect(wins.length).toBeGreaterThan(1);
    expect(wins[1].startLine).toBeLessThanOrEqual(wins[0].endLine);
    expect(wins[0].startLine).toBe(1);
    expect(wins[wins.length - 1].endLine).toBe(201);
  });

  it("コードは「ファイルの道｜export の名前（12個まで）」を頭に付ける", () => {
    const exports = Array.from({ length: 15 }, (_, i) => `export function f${i}() {}`).join("\n");
    const wins = codeWindows("src/core/a.ts", `import x from "y";\n${exports}\n`);
    expect(wins).toHaveLength(1);
    const head = wins[0].embedText.split("\n")[0];
    expect(head.startsWith("src/core/a.ts｜f0, f1")).toBe(true);
    expect(head.includes("f11")).toBe(true);
    expect(head.includes("f12")).toBe(false);
  });
});

describe("開発用の意味の検索：変わった窓だけ埋め直す", () => {
  const withKey = (ws: Array<{ embedText: string }>) =>
    ws.map((w) => ({ ...w, key: keyOf("m", w.embedText) }));
  const make = (a: string, b: string) => [
    ...withKey(docWindows("docs/a.md", `## A\n${a}`)),
    ...withKey(docWindows("docs/b.md", `## B\n${b}`)),
  ];

  it("変わったファイルの窓だけが埋め直しに出る", async () => {
    const first = make("あ".repeat(100), "い".repeat(100));
    const log1: string[][] = [];
    const r1 = await refreshIndex({ current: first, old: null, embed: fakeEmbed(log1), model: "m" });
    expect(r1.embedded).toBe(2);

    const second = make("あ".repeat(100), "う".repeat(100)); // b だけ変えた
    const plan = planRefresh(second, new Set(r1.index.windows.map((w: { key: string }) => w.key)));
    expect(plan.missing.map((w: { path: string }) => w.path)).toEqual(["docs/b.md"]);

    const log2: string[][] = [];
    const r2 = await refreshIndex({ current: second, old: r1.index, embed: fakeEmbed(log2), model: "m" });
    expect(log2.flat()).toHaveLength(1);
    expect(r2.index.windows).toHaveLength(2);
  });

  it("変わった窓が上限（300）を超えると作り直しの案内側に倒れる", () => {
    const many = Array.from({ length: REFRESH_LIMIT + 1 }, (_, i) => ({ key: `k${i}`, embedText: "" }));
    expect(planRefresh(many, new Set()).tooMany).toBe(true);
    expect(planRefresh(many.slice(0, REFRESH_LIMIT), new Set()).tooMany).toBe(false);
  });

  it("途中で止まっても、埋まった分だけの索引が控えに渡る", async () => {
    const current = withKey(Array.from({ length: 5 }, (_, i) => ({ embedText: `文${i}`, path: "p", startLine: i, endLine: i, hp: "" })));
    const saved: number[] = [];
    await refreshIndex({
      current,
      old: null,
      embed: fakeEmbed(),
      model: "m",
      batch: 2,
      checkpointEvery: 1,
      onCheckpoint: (idx: { windows: unknown[] }) => saved.push(idx.windows.length),
    });
    expect(saved).toEqual([2, 4, 5].slice(0, saved.length));
    expect(saved[0]).toBe(2);
  });
});

describe("開発用の意味の検索：上位10件の並べ方", () => {
  it("点の高い順に10件で、同じファイルの重なる窓は高いほうだけ残す", () => {
    // 2次元の単位ベクトル。角度が問いに近いほど点が高い
    const wins = Array.from({ length: 14 }, (_, i) => ({
      path: `f${i}.md`, startLine: 1, endLine: 5, hp: `h${i}`, key: `k${i}`,
    }));
    wins.push({ path: "f0.md", startLine: 3, endLine: 9, hp: "重なり", key: "dup" });
    const angle = (i: number) => i * 0.05;
    const vecs = new Float32Array(wins.length * 2);
    wins.forEach((_, i) => {
      const a = i === 14 ? angle(1) : angle(i);
      vecs[i * 2] = Math.cos(a);
      vecs[i * 2 + 1] = Math.sin(a);
    });
    const top = rankTop(wins, vecs, 2, new Float32Array([1, 0]), 10);
    expect(top).toHaveLength(10);
    expect(top[0].path).toBe("f0.md");
    // f0 と重なる窓（最後）は f0 のほうが高いので落ちる
    expect(top.some((t: { hp: string }) => t.hp === "重なり")).toBe(false);
    const scores = top.map((t: { score: number }) => t.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("開発用の意味の検索：ロック", () => {
  it("90分より古ければ放置、新しければ使用中", () => {
    expect(isLockStale(LOCK_STALE_MS + 1)).toBe(true);
    expect(isLockStale(LOCK_STALE_MS - 1)).toBe(false);
  });

  it("新しいロックは取れず持ち主を返し、古いロックは外して取れる。返せば取り直せる", () => {
    const base = mkdtempSync(join(tmpdir(), "devrag_lock_"));
    try {
      const dir = join(base, "novelai-ollama.lock");
      expect(tryTakeLock(dir, "最初の持ち主").ok).toBe(true);
      const second = tryTakeLock(dir, "二番目");
      expect(second).toEqual({ ok: false, owner: "最初の持ち主" });

      // フォルダーの作られた時刻を2時間前へ戻す
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(dir, old, old);
      expect(tryTakeLock(dir, "三番目").ok).toBe(true);

      releaseLock(dir);
      expect(existsSync(dir)).toBe(false);
      expect(tryTakeLock(dir, "四番目").ok).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
