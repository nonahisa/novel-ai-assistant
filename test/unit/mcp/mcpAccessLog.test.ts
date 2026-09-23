import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  EXTERNAL_EXPOSURE_LABELS,
  dedupeExternalAccess,
  describeExternalAccess,
  formatExternalAccessLine,
  parseExternalAccessLine,
  parseExternalAccessLog,
  type ExternalAccessEntry,
} from "../../src/core/externalAccessLog";
import {
  exposureOf,
  recordExternalAccess,
  setExternalClientName,
} from "../../src/mcp/tools/accessLog";

/**
 * 外部AIが作品を触った記録（設計書6.87.9）。
 *
 * **いちばん見張りたいのは2つ。**
 *
 * 1. **道具を足した人が記録を忘れられないこと。** 転送層の1か所で取るので、
 *    `registerTool` の名前と `tool()` へ渡した名前が食い違うと、
 *    別の道具の名前で記録されてしまう。目視では見つからない
 * 2. **本文が外へ出た回を、軽いほうへ倒さないこと。** 見落とすと、
 *    作者は原稿がクラウドへ渡ったことに気づけない
 */

const SERVER = nodePath.join(__dirname, "../../src/mcp/server.ts");

describe("転送層が、全部の道具の記録を取る", () => {
  const source = fs.readFileSync(SERVER, "utf8");

  it("registerTool の名前と、tool() へ渡した名前が全部そろっている", () => {
    /*
      `server.registerTool(\n  "NAME",\n  {...},\n  tool("NAME", ...)\n);`
      の対を読む。**ずれていると、別の道具の名前で記録が残る。**
    */
    const registered = [...source.matchAll(/registerTool\(\s*"([\w.]+)"/g)].map(
      (match) => match[1]
    );
    const logged = [...source.matchAll(/\btool\("([\w.]+)",/g)].map(
      (match) => match[1]
    );

    // **0.66.7 で束ねて10本になった**（それまでは56本）
    expect(registered.length).toBeGreaterThanOrEqual(8);
    expect(logged).toEqual(registered);
  });

  it("名前を渡さない tool( が残っていない", () => {
    // **渡し忘れると、その道具だけ記録されない**（型では捕まらない）
    const bare = [...source.matchAll(/\btool\((?!")/g)];
    expect(bare).toHaveLength(0);
  });
});

describe("exposureOf——原稿がどこまで外へ出たか", () => {
  it("手元の Ollama で通したものは、この機械から出ていない", () => {
    expect(
      exposureOf("novel.run", { feature: "typo", runner: "ollama", model: "x" })
    ).toBe("local");
    expect(
      exposureOf("novel.run", {
        feature: "synopsis",
        runner: "ollama",
        model: "x",
      })
    ).toBe("local");
  });

  it("遠くの Ollama を指していれば、出ていると数える", () => {
    expect(
      exposureOf("novel.run", {
        feature: "typo",
        runner: "ollama",
        model: "x",
        endpoint: "http://192.168.0.9:11434",
        allowRemote: true,
      })
    ).toBe("body");
  });

  it("runner が claude なら、本文が外へ出る", () => {
    expect(exposureOf("novel.run", { feature: "typo", runner: "claude" })).toBe(
      "body"
    );
  });

  it("プロンプトを組む道具は、本文が外へ出る", () => {
    expect(exposureOf("novel.prompt", { feature: "typo" })).toBe("body");
    expect(exposureOf("novel.prompt", { feature: "synopsis" })).toBe("body");
    expect(exposureOf("novel.prompt", { feature: "notation" })).toBe("body");
  });

  it("走査・検算・検出・材料は抜粋どまり", () => {
    expect(exposureOf("novel.scan", {})).toBe("excerpt");
    expect(exposureOf("novel.validate", { feature: "typo" })).toBe("excerpt");
    expect(exposureOf("novel.detect", { feature: "notation" })).toBe("excerpt");
    expect(exposureOf("novel.material", { feature: "contradiction" })).toBe(
      "excerpt"
    );
  });

  it("承認待ちへ置く道具は、原稿を外へ出さない", () => {
    // 呼び出し元が持ち込んだ案を置くだけで、こちらから本文も資料も返さない
    expect(exposureOf("novel.propose", { name: "誰か" })).toBe("none");
  });

  it("版の確認は原稿に触れない", () => {
    expect(exposureOf("mcp.version", undefined)).toBe("none");
  });

  it("手元のモデル一覧は原稿に触れない", () => {
    // **読むのは Ollama に何が入っているかだけ**（設計書6.87.15 の柱2の2）。
    // こちらから本文も資料も送らない
    expect(exposureOf("ollama.models", {})).toBe("none");
  });

  it("知らない道具は、重いほうへ倒す", () => {
    // **軽いほうへ倒すと、本当に本文が出た回を見落とす**
    expect(exposureOf("future.somethingNew", {})).toBe("body");
  });

  it("runner を省いた run は、重いほうへ倒す", () => {
    // 製品は runner の省略を断るが、断る前に記録が走ることがある
    expect(exposureOf("novel.run", { feature: "typo" })).toBe("body");
  });
});

describe("記録の読み書き", () => {
  const entry: ExternalAccessEntry = {
    time: "2026-09-15T04:00:00.000Z",
    tool: "typo.run",
    client: "claude-code",
    file: "episode_0001.md",
    exposure: "local",
    model: "gemma4:e4b",
    ok: true,
    detail: "チャンク0",
  };

  it("書いたものが、そのまま読める", () => {
    const parsed = parseExternalAccessLine(formatExternalAccessLine(entry));
    expect(parsed).toEqual(entry);
  });

  it("本文の写しにならないよう、補足は切る", () => {
    const long = { ...entry, detail: "あ".repeat(500) };
    const parsed = parseExternalAccessLine(formatExternalAccessLine(long));
    expect(parsed?.detail.length).toBe(200);
  });

  it("時刻か道具が無い行は捨てる", () => {
    expect(parseExternalAccessLine('{"tool":"typo.run"}')).toBeUndefined();
    expect(parseExternalAccessLine('{"time":"2026-09-15"}')).toBeUndefined();
  });

  it("壊れた行を飛ばして、読める行は残す", () => {
    const text = [
      formatExternalAccessLine(entry),
      "{壊れている",
      "<<<<<<< HEAD",
      formatExternalAccessLine({ ...entry, time: "2026-09-15T05:00:00.000Z" }),
      "=======",
    ].join("\n");
    const entries = parseExternalAccessLog(text);
    expect(entries).toHaveLength(2);
    // **新しいものが先**
    expect(entries[0].time).toBe("2026-09-15T05:00:00.000Z");
  });

  it("同じ操作が二重に入っていたら1つにする", () => {
    const text = [
      formatExternalAccessLine(entry),
      formatExternalAccessLine(entry),
    ].join("\n");
    expect(parseExternalAccessLog(text)).toHaveLength(1);
  });

  it("読めない exposure は、重いほうへ倒す", () => {
    const parsed = parseExternalAccessLine(
      '{"time":"2026-09-15T04:00:00.000Z","tool":"x","exposure":"てきとう"}'
    );
    expect(parsed?.exposure).toBe("body");
  });

  it("読めない ok は、成功にしない", () => {
    const parsed = parseExternalAccessLine(
      '{"time":"2026-09-15T04:00:00.000Z","tool":"x","ok":"はい"}'
    );
    expect(parsed?.ok).toBe(false);
  });

  it("画面に出す一文に、出どころと扱いが入る", () => {
    const text = describeExternalAccess(entry);
    expect(text).toContain("typo.run");
    expect(text).toContain("episode_0001.md");
    expect(text).toContain(EXTERNAL_EXPOSURE_LABELS.local);
  });

  it("重複の畳み込みは、違う操作までは畳まない", () => {
    const other = { ...entry, tool: "typo.prompt" };
    expect(dedupeExternalAccess([entry, other])).toHaveLength(2);
  });
});

describe("recordExternalAccess——実際に書く", () => {
  let folder: string;

  beforeEach(() => {
    folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-access-"));
    setExternalClientName("テストの呼び出し元");
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
    setExternalClientName("");
  });

  function readLog(): ExternalAccessEntry[] {
    const target = nodePath.join(
      folder,
      ".aiwriter",
      "history",
      "external.jsonl"
    );
    if (!fs.existsSync(target)) return [];
    return parseExternalAccessLog(fs.readFileSync(target, "utf8"));
  }

  it("同期される場所へ書く", () => {
    const wrote = recordExternalAccess({
      tool: "work.scan",
      args: { folder },
      ok: true,
    });
    expect(wrote).toBe(true);
    // `.aiwriter/` のうち除外されているのは cache/ と logs/ だけ
    expect(
      fs.existsSync(nodePath.join(folder, ".aiwriter", "history", "external.jsonl"))
    ).toBe(true);
    expect(readLog()[0].client).toBe("テストの呼び出し元");
  });

  it("追記する。前の記録を消さない", () => {
    recordExternalAccess({ tool: "work.scan", args: { folder }, ok: true });
    recordExternalAccess({
      tool: "typo.prompt",
      args: { folder, filePath: "episode_0001.md" },
      ok: true,
    });
    const entries = readLog();
    expect(entries.map((entry) => entry.tool).sort()).toEqual([
      "typo.prompt",
      "work.scan",
    ]);
  });

  it("失敗した試みも残す", () => {
    recordExternalAccess({
      tool: "episode.deviationPrompt",
      args: { folder, filePath: "episode_0001.md" },
      ok: false,
      failure: "プロットが見つかりません",
    });
    const entry = readLog()[0];
    expect(entry.ok).toBe(false);
    expect(entry.detail).toBe("プロットが見つかりません");
  });

  it("作品の分からない呼び出しは残さない", () => {
    // どの作品の記録なのか決められないので、書く先がない
    expect(
      recordExternalAccess({ tool: "mcp.version", args: {}, ok: true })
    ).toBe(false);
    expect(
      recordExternalAccess({ tool: "mcp.version", args: undefined, ok: true })
    ).toBe(false);
  });

  it("本文を残さない", () => {
    recordExternalAccess({
      tool: "ollama.generate",
      args: {
        folder,
        userPrompt: "ここに本文がまるごと入っている",
        systemPrompt: "指示",
      },
      ok: true,
    });
    const raw = fs.readFileSync(
      nodePath.join(folder, ".aiwriter", "history", "external.jsonl"),
      "utf8"
    );
    expect(raw).not.toContain("ここに本文がまるごと入っている");
  });

  it("手元で通した回は、モデル名まで残す", () => {
    recordExternalAccess({
      tool: "novel.run",
      args: {
        folder,
        feature: "typo",
        filePath: "episode_0001.md",
        runner: "ollama",
        model: "gemma4:e4b",
        chunkIndex: 2,
      },
      ok: true,
    });
    const entry = readLog()[0];
    expect(entry.exposure).toBe("local");
    expect(entry.model).toBe("gemma4:e4b");
    // **どの機能だったかが残る**（道具の名前は novel.run の1つしかない）
    expect(entry.detail).toContain("typo");
    expect(entry.detail).toContain("チャンク2");
    // **許可の鍵も残る**（作者はこれを見て、その機能だけを許す）
    expect(entry.key).toBe("typo");
  });

  it("単話プロットは options の中にあるが、対象として残る", () => {
    // **見落とすと、その機能のときだけ記録に対象が残らない**
    recordExternalAccess({
      tool: "novel.run",
      args: {
        folder,
        feature: "episodePlot",
        options: { plotPath: "プロット/第3話.md" },
        runner: "ollama",
        model: "gemma4:e4b",
      },
      ok: true,
    });
    expect(readLog()[0].file).toBe("プロット/第3話.md");
  });

  it("書けなくても、呼んだ側を止めない", () => {
    // 作れない場所を指しても、例外にしない
    expect(() =>
      recordExternalAccess({
        tool: "work.scan",
        // 作れない場所（名前に使えない文字）
        args: { folder: "\u0000" },
        ok: true,
      })
    ).not.toThrow();
  });
});
