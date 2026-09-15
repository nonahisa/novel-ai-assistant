import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  DENIED,
  EXTERNAL_ACCESS_DENIED_MESSAGE,
  describeExternalAccessPermission,
  formatExternalAccessPermission,
  parseExternalAccessPermission,
} from "../../src/core/externalAccessPermission";
import {
  assertExternalAccessAllowed,
  readExternalAccessPermission,
} from "../../src/mcp/tools/permission";
import { IGNORED_PATHS } from "../../src/core/workRegistry";

/**
 * 外部AIの利用は**既定で拒否**（設計書6.87.10。作者の指示、2026-09-15）。
 *
 * **ここで守りたいのは1つ。** 意思確認をしていない作品の原稿が、
 * 外から1文字も読めないこと。**迷ったら断る**側に倒っていることを、
 * あらゆる入り方で確かめる。
 */

describe("印の読み方——迷ったら断る", () => {
  it("印が無ければ拒否", () => {
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-perm-"));
    try {
      expect(readExternalAccessPermission(folder).allowed).toBe(false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("壊れたJSONは拒否", () => {
    expect(parseExternalAccessPermission("{壊れている").allowed).toBe(false);
  });

  it("配列や文字列は拒否", () => {
    expect(parseExternalAccessPermission("[]").allowed).toBe(false);
    expect(parseExternalAccessPermission('"はい"').allowed).toBe(false);
    expect(parseExternalAccessPermission("null").allowed).toBe(false);
  });

  it("allowed が true そのものでなければ拒否", () => {
    // **書き損じを許可にしない**
    expect(parseExternalAccessPermission('{"allowed":"true"}').allowed).toBe(
      false
    );
    expect(parseExternalAccessPermission('{"allowed":1}').allowed).toBe(false);
    expect(parseExternalAccessPermission('{"allowed":"yes"}').allowed).toBe(
      false
    );
  });

  it("allowed が true なら許可", () => {
    const parsed = parseExternalAccessPermission(
      '{"allowed":true,"decidedAt":"2026-09-15T04:00:00.000Z","decidedOn":"机の上"}'
    );
    expect(parsed.allowed).toBe(true);
    expect(parsed.decidedOn).toBe("机の上");
  });

  it("取り消しは false を書く（消さない）", () => {
    // 消すと「一度も決めていない」のか「取り消した」のか分からなくなる
    const text = formatExternalAccessPermission({
      allowed: false,
      decidedAt: "2026-09-15T04:00:00.000Z",
      decidedOn: "机の上",
      note: "",
    });
    expect(parseExternalAccessPermission(text).allowed).toBe(false);
    expect(text).toContain("decidedAt");
  });

  it("書いたものが、そのまま読める", () => {
    const text = formatExternalAccessPermission({
      allowed: true,
      decidedAt: "2026-09-15T04:00:00.000Z",
      decidedOn: "机の上",
      note: "テスト用",
    });
    const parsed = parseExternalAccessPermission(text);
    expect(parsed.allowed).toBe(true);
    expect(parsed.note).toBe("テスト用");
  });

  it("作者が開いて読めるよう、説明が入っている", () => {
    // 作者はプログラマではない。何のファイルか分かる必要がある
    const text = formatExternalAccessPermission(DENIED);
    expect(text).toContain("外部AI");
    expect(text).toContain("拒否");
  });
});

describe("門番——道具が動く前に断る", () => {
  let folder: string;

  beforeEach(() => {
    folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-perm-"));
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  function allow(): void {
    const dir = nodePath.join(folder, ".aiwriter");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "external-access.json"),
      formatExternalAccessPermission({
        allowed: true,
        decidedAt: "2026-09-15T04:00:00.000Z",
        decidedOn: "机の上",
        note: "",
      }),
      "utf8"
    );
  }

  it("許可が無ければ投げる", () => {
    expect(() => assertExternalAccessAllowed({ folder })).toThrow(
      /許可されていません/
    );
  });

  it("断る返事に、どうすれば使えるかが書いてある", () => {
    // **断っただけでは、呼んだ側は不具合と区別が付かない**
    expect(EXTERNAL_ACCESS_DENIED_MESSAGE).toContain("VS Code");
    expect(EXTERNAL_ACCESS_DENIED_MESSAGE).toContain("許可");
    expect(EXTERNAL_ACCESS_DENIED_MESSAGE).toContain("記録");
  });

  it("許可してあれば通る", () => {
    allow();
    expect(() => assertExternalAccessAllowed({ folder })).not.toThrow();
  });

  it("作品を指していない呼び出しは素通り", () => {
    // `mcp.version`・`ollama.generate` は原稿を読まないので、許可の対象が無い
    expect(() => assertExternalAccessAllowed({})).not.toThrow();
    expect(() => assertExternalAccessAllowed(undefined)).not.toThrow();
    expect(() => assertExternalAccessAllowed({ folder: "   " })).not.toThrow();
  });

  it("別の作品の許可では通らない", () => {
    allow();
    const other = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-perm2-"));
    try {
      expect(() => assertExternalAccessAllowed({ folder: other })).toThrow(
        /許可されていません/
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("転送層で、どの道具も門番を抜けられない", () => {
  const source = fs.readFileSync(
    nodePath.join(__dirname, "../../src/mcp/server.ts"),
    "utf8"
  );

  it("門番は tool() の中にあり、道具ごとに書かれていない", () => {
    /*
      **1か所でなければならない。** 道具ごとに書くと、新しい道具を
      足した人が忘れる——そして**忘れた道具は、許可なしで原稿を読む**。
    */
    const calls = [...source.matchAll(/assertExternalAccessAllowed\(/g)];
    expect(calls).toHaveLength(1);
  });

  it("門番は、道具の中身より先に呼ばれる", () => {
    const gate = source.indexOf("assertExternalAccessAllowed(args)");
    const handler = source.indexOf("await handler(args)");
    expect(gate).toBeGreaterThan(0);
    expect(handler).toBeGreaterThan(0);
    // **先に断るので、断られた呼び出しではファイルを開かない**
    expect(gate).toBeLessThan(handler);
  });
});

describe("印は同期しない", () => {
  it("除外の一覧に入っている", () => {
    // 同期すると、リポジトリを共有した編集部の機械でも許可済みになる
    expect(IGNORED_PATHS).toContain(".aiwriter/external-access.json");
  });
});

describe("画面に出す一文", () => {
  it("拒否のときは、既定であることまで言う", () => {
    const text = describeExternalAccessPermission(DENIED);
    expect(text).toContain("拒否");
    expect(text).toContain("既定");
  });

  it("許可のときは、いつ決めたかを言う", () => {
    const text = describeExternalAccessPermission({
      allowed: true,
      decidedAt: "2026-09-15T04:00:00.000Z",
      decidedOn: "机の上",
      note: "",
    });
    expect(text).toContain("許可");
    expect(text).toContain("机の上");
  });
});
