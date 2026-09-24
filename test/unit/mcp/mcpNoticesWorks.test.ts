import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  NOTICE_LOG_DIRECTORY,
  NOTICE_LOG_SCHEMA,
  serializeNoticeLog,
  type NoticeLogFile,
} from "../../../src/core/noticeLog";
import {
  WORKS_SNAPSHOT_PATH,
  buildWorksSnapshot,
  serializeWorksSnapshot,
} from "../../../src/core/worksSnapshot";
import { GLOBAL_STORAGE_ENV } from "../../../src/mcp/globalStorage";
import { noticesRecent } from "../../../src/mcp/tools/notices";
import { worksList } from "../../../src/mcp/tools/works";
import { exposureOf } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { McpToolError } from "../../../src/mcp/tools/shared";

/**
 * MCP の道具 `notices.recent` と `works.list`（作者の承認、2026-09-24）。
 *
 * どちらも**拡張機能が保管庫へ書いたものを読むだけ**（`windows.list` と同じ形）。
 * 見張るのは：保管庫を1バイトも書き換えないこと・作品を取らないので
 * 門番（許可）を通らないこと・壊れたものがあっても止めないこと。
 */

const NOW = new Date("2026-09-24T10:00:00.000Z");

let storage: string;
let previousEnv: string | undefined;

beforeEach(() => {
  storage = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-notices-"));
  previousEnv = process.env[GLOBAL_STORAGE_ENV];
  process.env[GLOBAL_STORAGE_ENV] = storage;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[GLOBAL_STORAGE_ENV];
  else process.env[GLOBAL_STORAGE_ENV] = previousEnv;
  fs.rmSync(storage, { recursive: true, force: true });
});

function log(pid: number, messages: [string, string][]): NoticeLogFile {
  return {
    schema: NOTICE_LOG_SCHEMA,
    pid,
    machineName: "DESKTOP",
    extensionVersion: "0.85.0",
    startedAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T09:30:00.000Z",
    notices: messages.map(([at, message], index) => ({
      seq: index + 1,
      at,
      severity: "info",
      modal: false,
      message,
      detail: null,
      items: [],
      truncated: false,
      answer: null,
    })),
  };
}

function writeNoticeFile(name: string, text: string): void {
  const directory = nodePath.join(storage, ...NOTICE_LOG_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(nodePath.join(directory, name), text, "utf8");
}

/** 保管庫の中身をまるごと控える（読むだけであることを確かめる） */
function listing(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const full = nodePath.join(directory, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(`${full}|${stat.size}|${stat.mtimeMs}|${fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(storage);
  return out.sort();
}

describe("notices.recent", () => {
  it("窓ごとの記録を合わせ、新しい順に返す", () => {
    writeNoticeFile(
      "100-1.json",
      serializeNoticeLog(log(100, [["2026-09-24T09:00:00.000Z", "作品を登録しました"]]))
    );
    writeNoticeFile(
      "200-1.json",
      serializeNoticeLog(log(200, [["2026-09-24T09:20:00.000Z", "保存しました"]]))
    );
    const result = noticesRecent({}, NOW);
    expect(result.storage).toBe(nodePath.join(storage, ...NOTICE_LOG_DIRECTORY));
    expect(result.notices.map((item) => [item.pid, item.message])).toEqual([
      [200, "保存しました"],
      [100, "作品を登録しました"],
    ]);
    expect(result.matched).toBe(2);
    expect(result.unreadable).toEqual([]);
  });

  it("since・contains・pid・limit で絞れる", () => {
    writeNoticeFile(
      "100-1.json",
      serializeNoticeLog(
        log(100, [
          ["2026-09-24T09:00:00.000Z", "作品を登録しました"],
          ["2026-09-24T09:10:00.000Z", "このフォルダは「灯台」としてすでに登録されています。"],
        ])
      )
    );
    writeNoticeFile(
      "200-1.json",
      serializeNoticeLog(log(200, [["2026-09-24T09:20:00.000Z", "保存しました"]]))
    );
    expect(noticesRecent({ contains: "すでに登録" }, NOW).notices).toHaveLength(1);
    expect(noticesRecent({ pid: 200 }, NOW).notices.map((item) => item.message)).toEqual([
      "保存しました",
    ]);
    expect(
      noticesRecent({ since: "2026-09-24T09:05:00.000Z" }, NOW).notices.map((item) => item.pid)
    ).toEqual([200, 100]);
    const limited = noticesRecent({ limit: 1 }, NOW);
    expect(limited.notices).toHaveLength(1);
    expect(limited.matched).toBe(3);
  });

  it("読めない since は断る（黙って全部を返さない）", () => {
    expect(() => noticesRecent({ since: "きのう" }, NOW)).toThrow(McpToolError);
  });

  it("壊れた記録があっても止めず、読めなかったものを添える。書きかけの一時ファイルは数えない", () => {
    writeNoticeFile(
      "100-1.json",
      serializeNoticeLog(log(100, [["2026-09-24T09:00:00.000Z", "作品を登録しました"]]))
    );
    writeNoticeFile("300-1.json", "{");
    writeNoticeFile("100-1.json.novelai-x.tmp", "{");
    const result = noticesRecent({}, NOW);
    expect(result.notices).toHaveLength(1);
    expect(result.unreadable).toEqual([{ file: "300-1.json", reason: "記録の形になっていません" }]);
  });

  it("記録が1つも無くても失敗にしない", () => {
    const result = noticesRecent({}, NOW);
    expect(result.notices).toEqual([]);
    expect(result.note).toContain("記録が1つもありません");
  });

  it("保管庫を1バイトも書き換えない（読むだけ）", () => {
    writeNoticeFile(
      "100-1.json",
      serializeNoticeLog(log(100, [["2026-09-01T09:00:00.000Z", "古い知らせ"]]))
    );
    const before = listing();
    noticesRecent({}, NOW);
    // 期限切れの記録も、読む側は消さない（片づけるのは拡張機能）
    expect(listing()).toEqual(before);
  });
});

describe("works.list", () => {
  const snapshotFile = (): string => nodePath.join(storage, ...WORKS_SNAPSHOT_PATH);

  function writeSnapshot(text: string): void {
    fs.mkdirSync(nodePath.dirname(snapshotFile()), { recursive: true });
    fs.writeFileSync(snapshotFile(), text, "utf8");
  }

  it("写しと、写しを書いてからの経過を返す", () => {
    const snapshot = buildWorksSnapshot(
      [
        { id: "a", title: "灯台", folderPath: "C:/小説/灯台", registeredAt: "2026-09-01T00:00:00.000Z" },
        { id: "b", title: "灯台", folderPath: "c:/小説/灯台/", registeredAt: "2026-09-24T00:00:00.000Z" },
      ],
      { pid: 1, extensionVersion: "0.85.0", machineName: "DESKTOP" },
      new Date("2026-09-24T09:30:00.000Z")
    );
    writeSnapshot(serializeWorksSnapshot(snapshot));
    const result = worksList(NOW);
    expect(result.storage).toBe(snapshotFile());
    expect(result.snapshot).toEqual(snapshot);
    expect(result.minutesSinceWritten).toBe(30);
    expect(result.snapshot?.duplicates).toEqual([{ folderPath: "C:/小説/灯台", ids: ["a", "b"] }]);
  });

  it("写しが無ければ null と理由（失敗にしない）", () => {
    const result = worksList(NOW);
    expect(result.snapshot).toBeNull();
    expect(result.note).toContain("写しがありません");
  });

  it("壊れた写しは直さずに null と理由", () => {
    writeSnapshot("{");
    const before = listing();
    const result = worksList(NOW);
    expect(result.snapshot).toBeNull();
    expect(result.note).toContain("写しの形になっていません");
    expect(listing()).toEqual(before);
  });
});

describe("作品を取らないので、門番を通らない。原稿は出ない", () => {
  it("許可の印が無くても断らない", () => {
    expect(() =>
      assertExternalAccessAllowed({ since: "2026-09-24T00:00:00Z", contains: "登録" }, "notices.recent")
    ).not.toThrow();
    expect(() => assertExternalAccessAllowed({}, "works.list")).not.toThrow();
    expect(() => assertExternalAccessAllowed(undefined, "works.list")).not.toThrow();
  });

  it("原稿の出方は none", () => {
    expect(exposureOf("notices.recent", {})).toBe("none");
    expect(exposureOf("works.list", undefined)).toBe("none");
  });

  it("引数に folder が無い（道具の入力の形）", () => {
    const server = fs.readFileSync(
      nodePath.join(__dirname, "../../../src/mcp/tools/notices.ts"),
      "utf8"
    );
    expect(server).not.toMatch(/\bfolder\s*:/u);
  });
});

describe("登録と文書", () => {
  const root = nodePath.join(__dirname, "../../..");
  const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");

  it("サーバーに登録され、記録の名前もそろっている", () => {
    for (const name of ["notices.recent", "works.list"]) {
      expect(server).toContain(`registerTool(\n  "${name}"`);
      expect(server).toContain(`tool("${name}"`);
    }
  });

  it("外部AIへ配るスキルと、セットアップの手順書に載っている", () => {
    const skill = fs.readFileSync(nodePath.join(root, "docs/skills/novel-assist.md"), "utf8");
    const guide = fs.readFileSync(nodePath.join(root, "src/mcp/prompts/setupGuide.ts"), "utf8");
    for (const name of ["notices.recent", "works.list"]) {
      expect(skill).toContain(`\`${name}\``);
      expect(guide).toContain(`\`${name}\``);
    }
  });

  it("保管庫の場所は mcpGlobalStorageRoot の1か所から（束の居場所を自分で読まない）", () => {
    for (const file of ["notices.ts", "works.ts"]) {
      const source = fs.readFileSync(nodePath.join(root, "src/mcp/tools", file), "utf8");
      expect(source).toContain("mcpGlobalStorageRoot");
      expect(source).not.toMatch(/process\.argv/u);
      // 読むだけ：書き込み・消去の関数を呼ばない
      expect(source).not.toMatch(/\b(writeFileSync|writeFile|rmSync|unlinkSync|renameSync|mkdirSync)\b/u);
    }
  });
});
