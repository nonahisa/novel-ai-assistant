import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { z } from "zod";
import {
  FEATURES,
  FILE_TARGET_FEATURES as MEASURE_FILE_TARGETS,
} from "../../scripts/measureScoring.mjs";
import {
  FEATURE_LABELS,
  FEATURE_NAMES,
  FILE_TARGET_FEATURES,
  type FeatureName,
} from "../../src/core/mcpFeatures";
import {
  ALL_TOOLS,
  ANONYMOUS_CLIENT,
  LEGACY_TOOL_KEYS,
  isToolAllowed,
  parseExternalAccessPermission,
  permissionKeyOf,
} from "../../src/core/externalAccessPermission";
import {
  NOVEL_DETECT_INPUT,
  NOVEL_MATERIAL_INPUT,
  NOVEL_PROMPT_INPUT,
  NOVEL_RUN_INPUT,
  NOVEL_VALIDATE_INPUT,
  novelDetect,
  novelMaterial,
  novelPrompt,
  novelRun,
  novelValidate,
} from "../../src/mcp/tools/features";
import { assertExternalAccessAllowed } from "../../src/mcp/tools/permission";

/**
 * 道具を束ねた入口（設計書6.87.15 の柱1。0.66.7）。
 *
 * **いちばん見張りたいのは許可の読み替えである。** 作者の作品には
 * 0.66.6 までの道具名（`typo.run`）で書かれた印が実在する。
 *
 * - **古い印がそのまま効かない**と、作者は許可を置き直すことになる
 * - **読み替えが広すぎる**と、許していない機能まで通る——
 *   そのときは**許していない作品の原稿が外へ出る**
 */

const WORK = nodePath.join(__dirname, "..", "fixtures", "mcp-work");

/* ── 許可の読み替え ─────────────────────────────────────── */

function permissionWith(tools: string[]) {
  return parseExternalAccessPermission(
    JSON.stringify({ clients: [{ name: "claude-code", tools }] })
  );
}

describe("許可の鍵——古い印をそのまま読む", () => {
  it("古い道具名の印が、いまの feature として効く", () => {
    const permission = permissionWith(["typo.run"]);
    expect(isToolAllowed(permission, "claude-code", "typo")).toBe(true);
  });

  it("prompt・validate・run の別は鍵に含めない", () => {
    // `typo.prompt` しか許していなくても、feature が同じなら通る
    // （どこまで原稿が出るかは runner が決める。設計書6.87.15 の柱1）
    const permission = permissionWith(["typo.prompt"]);
    expect(isToolAllowed(permission, "claude-code", "typo")).toBe(true);
  });

  it("**許可は広がらない**。ほかの feature には届かない", () => {
    const permission = permissionWith(["typo.run"]);
    for (const feature of FEATURE_NAMES) {
      if (feature === "typo") continue;
      expect(isToolAllowed(permission, "claude-code", feature)).toBe(false);
    }
    expect(isToolAllowed(permission, "claude-code", "novel.scan")).toBe(false);
    expect(isToolAllowed(permission, "claude-code", "novel.propose")).toBe(
      false
    );
  });

  it("**矛盾検知の許可は、事実の照合へ漏れない**（別の機能だから別に要る）", () => {
    /*
      0.67.2 で足した `factContradiction`（設計書6.88）は、P-12 とは
      **通るプロンプトも、本文が出る回数も違う**。`contradiction` を
      許したことが、こちらを許したことになってはいけない。

      古い道具名（`contradiction.run`）の読み替えにも足していない
      ——**そんな道具は存在しなかった**ので、それを許した印もありえない。
    */
    const old = permissionWith(["contradiction.run"]);
    expect(isToolAllowed(old, "claude-code", "contradiction")).toBe(true);
    expect(isToolAllowed(old, "claude-code", "factContradiction")).toBe(false);

    const now = permissionWith(["contradiction"]);
    expect(isToolAllowed(now, "claude-code", "factContradiction")).toBe(false);

    // 逆も同じ。事実の照合を許しても、P-12 は通らない
    const fact = permissionWith(["factContradiction"]);
    expect(isToolAllowed(fact, "claude-code", "factContradiction")).toBe(true);
    expect(isToolAllowed(fact, "claude-code", "contradiction")).toBe(false);
  });

  it("読み替え表に factContradiction へ向かう行は無い", () => {
    // **無かった道具の名前を読み替えない。** 足すと、古い印のどれかが
    // 知らないうちにこの feature を許すことになる
    expect(
      Object.entries(LEGACY_TOOL_KEYS).filter(
        ([, key]) => key === "factContradiction"
      )
    ).toEqual([]);
  });

  it("承認待ちへ置く道具は、設定資料の抽出を許したことにならない", () => {
    // **ここを取り違えると、置くだけを許した印で資料を読み出せる**
    const permission = permissionWith(["settings.propose"]);
    expect(isToolAllowed(permission, "claude-code", "novel.propose")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "settings")).toBe(false);
  });

  it("走査の古い名前は、走査だけを許す", () => {
    const permission = permissionWith(["work.scan"]);
    expect(isToolAllowed(permission, "claude-code", "novel.scan")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "typo")).toBe(false);
  });

  it("新しい鍵で書かれた印も、そのまま効く", () => {
    const permission = permissionWith(["typo", "novel.scan"]);
    expect(isToolAllowed(permission, "claude-code", "typo")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "novel.scan")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "proofread")).toBe(false);
  });

  it("古い印と新しい鍵が混ざっていても、両方効く", () => {
    const permission = permissionWith(["typo.run", "proofread"]);
    expect(isToolAllowed(permission, "claude-code", "typo")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "proofread")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "settings")).toBe(false);
  });

  it("`*` は、これから足すものも含めて全部", () => {
    const permission = permissionWith([ALL_TOOLS]);
    for (const feature of FEATURE_NAMES) {
      expect(isToolAllowed(permission, "claude-code", feature)).toBe(true);
    }
  });

  it("読み替えの行き先は、実在する feature か決まった鍵だけ", () => {
    // **表に書き損じがあると、そこだけ永久に断られる**
    const keys = new Set<string>([
      ...FEATURE_NAMES,
      "novel.scan",
      "novel.propose",
    ]);
    for (const [legacy, key] of Object.entries(LEGACY_TOOL_KEYS)) {
      expect(keys.has(key), `${legacy} → ${key}`).toBe(true);
    }
  });

  it("鍵は、道具の名前と feature から決まる", () => {
    expect(permissionKeyOf("novel.run", "typo")).toBe("typo");
    expect(permissionKeyOf("novel.validate", "deviation")).toBe("deviation");
    expect(permissionKeyOf("novel.scan", undefined)).toBe("novel.scan");
    expect(permissionKeyOf("novel.propose", undefined)).toBe("novel.propose");
    // feature が無い（あり得ないが）ときは道具の名前＝許可されない鍵に倒す
    expect(permissionKeyOf("novel.run", undefined)).toBe("novel.run");
  });
});

describe("門番——feature ごとに断る", () => {
  const temporary: string[] = [];

  function workWith(tools: string[]): string {
    const folder = fs.mkdtempSync(
      nodePath.join(os.tmpdir(), "novelai-bundled-")
    );
    temporary.push(folder);
    fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(folder, ".aiwriter", "external-access.json"),
      // 名乗らずに繋いだ相手（このテストはクライアント名を設定していない）
      JSON.stringify({ clients: [{ name: ANONYMOUS_CLIENT, tools }] }),
      "utf8"
    );
    return folder;
  }

  it("許した feature は通り、許していない feature は断られる", () => {
    // 名乗りなしで繋いだ想定（`setExternalClientName` を呼んでいない）
    const folder = workWith(["typo.run"]);
    expect(() =>
      assertExternalAccessAllowed({ folder, feature: "typo" }, "novel.run")
    ).not.toThrow();
    expect(() =>
      assertExternalAccessAllowed({ folder, feature: "settings" }, "novel.run")
    ).toThrow(/許可されていません/);
  });

  it("矛盾検知を許した作品でも、事実の照合は門番が断る", () => {
    const folder = workWith(["contradiction"]);
    expect(() =>
      assertExternalAccessAllowed(
        { folder, feature: "contradiction" },
        "novel.run"
      )
    ).not.toThrow();
    expect(() =>
      assertExternalAccessAllowed(
        { folder, feature: "factContradiction" },
        "novel.run"
      )
    ).toThrow(/矛盾検知（事実の照合）/);
  });

  it("断り文句に、何を使おうとしたかが日本語で出る", () => {
    const folder = workWith([]);
    expect(() =>
      assertExternalAccessAllowed({ folder, feature: "typo" }, "novel.run")
    ).toThrow(/誤字脱字の検知/);
  });
});

/* ── 束ねた入口 ─────────────────────────────────────────── */

describe("束ねた入口——足りない引数は名前を挙げて断る", () => {
  it("話ごとに見る feature は、filePath が無ければ断る", () => {
    expect(() =>
      novelPrompt({ folder: WORK, feature: "typo", numCtx: 32768 })
    ).toThrow(/filePath/);
  });

  it("チャンクに切る feature は、numCtx が無ければ断る", () => {
    expect(() =>
      novelPrompt({
        folder: WORK,
        feature: "typo",
        filePath: "本文/004_よあけ.txt",
      })
    ).toThrow(/numCtx/);
  });

  it("検算は chunkId が無ければ断る", () => {
    expect(() =>
      novelValidate({ folder: WORK, feature: "typo", response: "{}" })
    ).toThrow(/chunkId/);
  });

  it("options の必須も、名前を挙げて断る", () => {
    expect(() =>
      novelPrompt({ folder: WORK, feature: "episodePlot" })
    ).toThrow(/options\.plotPath/);
    expect(() => novelPrompt({ folder: WORK, feature: "chat" })).toThrow(
      /options\.question/
    );
    expect(() => novelPrompt({ folder: WORK, feature: "name" })).toThrow(
      /options\.characterName/
    );
    expect(() => novelPrompt({ folder: WORK, feature: "notation" })).toThrow(
      /options\.group/
    );
  });

  it("options の形が違えば断る（黙って落とさない）", () => {
    expect(() =>
      novelPrompt({
        folder: WORK,
        feature: "notation",
        options: { group: { label: "x", forms: [] } },
      })
    ).toThrow(/options\.group/);
  });

  it("runner は省略できない", async () => {
    await expect(
      novelRun({
        folder: WORK,
        feature: "typo",
        filePath: "本文/004_よあけ.txt",
        numCtx: 32768,
      })
    ).rejects.toThrow(/runner/);
  });

  it("detect と material は、扱える feature だけを受ける", () => {
    // 形（zod）でも弾くが、**ハンドラでも断る**（形を通り抜けても止まる）
    expect(() =>
      novelDetect({ folder: WORK, feature: "typo" })
    ).toThrow(/novel\.detect/);
    expect(() =>
      novelMaterial({ folder: WORK, feature: "typo" })
    ).toThrow(/novel\.material/);
  });
});

describe("束ねた入口——今までと同じものを返す", () => {
  it("prompt は、束ねる前のハンドラと同じ戻し先を返す", () => {
    const result = novelPrompt({
      folder: WORK,
      feature: "typo",
      filePath: "本文/004_よあけ.txt",
      numCtx: 32768,
    }) as { validateWith: string; chunks: Array<{ chunkId: string }> };
    expect(result.validateWith).toBe("novel.validate（feature: typo）");
    expect(result.chunks[0].chunkId).toContain("004_よあけ.txt");
  });

  it("validate は、prompt が返した chunkId で検算できる", () => {
    const prompt = novelPrompt({
      folder: WORK,
      feature: "proofread",
      filePath: "本文/004_よあけ.txt",
      numCtx: 32768,
    }) as { chunks: Array<{ chunkId: string }> };
    const result = novelValidate({
      folder: WORK,
      feature: "proofread",
      chunkId: prompt.chunks[0].chunkId,
      response: JSON.stringify({
        issues: [
          {
            line: 2,
            original: "まず最初に",
            suggestion: "まず",
            reason: "冗長",
            explanation: "同じ意味が重なっている",
            confidence: "high",
          },
        ],
      }),
    }) as { accepted: Array<{ original: string }> };
    expect(result.accepted.map((issue) => issue.original)).toEqual([
      "まず最初に",
    ]);
  });

  it("detect（表記ゆれ）は、AIを使わずに組を返す", () => {
    const result = novelDetect({ folder: WORK, feature: "notation" }) as {
      total: number;
    };
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("material（矛盾）は、その話の時点の材料を返す", () => {
    const result = novelMaterial({
      folder: WORK,
      feature: "contradiction",
      filePath: "本文/004_よあけ.txt",
      numCtx: 32768,
    }) as { chunks: unknown[] };
    expect(Array.isArray(result.chunks)).toBe(true);
  });
});

/* ── 入力の形 ───────────────────────────────────────────── */

describe("入力の形", () => {
  it("feature は必須（省略を既定で埋めない）", () => {
    expect(
      z.object(NOVEL_PROMPT_INPUT).safeParse({ folder: WORK }).success
    ).toBe(false);
    expect(
      z.object(NOVEL_VALIDATE_INPUT).safeParse({ folder: WORK, response: "{}" })
        .success
    ).toBe(false);
  });

  it("detect と material は、扱える feature しか受けない", () => {
    expect(
      z.object(NOVEL_DETECT_INPUT).safeParse({ folder: WORK, feature: "typo" })
        .success
    ).toBe(false);
    expect(
      z
        .object(NOVEL_MATERIAL_INPUT)
        .safeParse({ folder: WORK, feature: "typo" }).success
    ).toBe(false);
  });

  it("**一覧を小さく保つ**——入力の形は共通＋options だけ", () => {
    /*
      束ねた目的は、AI が繋いだ瞬間に読む量を減らすことだった
      （44,882字・56本）。feature ごとに形を分けると、ここがまた膨らむ。
      **5本ぶん合わせて1万字に収まっている**ことを見張る。
    */
    const size = [
      NOVEL_PROMPT_INPUT,
      NOVEL_VALIDATE_INPUT,
      NOVEL_RUN_INPUT,
      NOVEL_DETECT_INPUT,
      NOVEL_MATERIAL_INPUT,
    ]
      .map((shape) => JSON.stringify(z.toJSONSchema(z.object(shape))).length)
      .reduce((total, chars) => total + chars, 0);
    expect(size).toBeLessThan(10_000);
  });
});

/* ── 測定の台本と、束の表がずれていないか ────────────────── */

describe("測定の台本（scripts/measureScoring.mjs）と揃っている", () => {
  it("測れる feature の顔ぶれが同じ", () => {
    expect([...FEATURES].sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("話ごとに回す feature の顔ぶれが同じ", () => {
    // **ずれると、作品ぜんたいを1回見る機能を話数ぶん回す**
    expect([...MEASURE_FILE_TARGETS].sort()).toEqual(
      [...FILE_TARGET_FEATURES].sort()
    );
  });

  it("どの feature にも日本語の呼び名がある", () => {
    for (const feature of FEATURE_NAMES) {
      expect(FEATURE_LABELS[feature as FeatureName]).toBeTruthy();
    }
  });
});
