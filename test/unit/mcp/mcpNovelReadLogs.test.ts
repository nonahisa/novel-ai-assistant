import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { novelRead } from "../../../src/mcp/tools/read";
import { estimateResultTokens, READ_RESULT_TOKEN_BUDGET } from "../../../src/mcp/tools/payloadBudget";
import { recordExternalAccess, setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { folderSnapshot } from "../support/folderFingerprint";

/**
 * 読む口 `novel.read` の相談ログ・ログ・編集履歴（作者の裁定 2026-10-16 の6。設計書6.87.24）。
 *
 * - 鍵は名指し（`novel.read.chatLog` など）。`"*"` では通らない
 * - **新しいものが先**に並び、大きければ続きの印（next.offset）で分けて返す
 * - **何も書かない**
 *
 * 作品は一時フォルダーの作り物で、作者の作品の印には触らない。
 */

let library: string;

function write(folder: string, relative: string, text: string): void {
  const target = nodePath.join(folder, relative);
  fs.mkdirSync(nodePath.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function makeWork(name: string, tools: string[] = []): string {
  const folder = nodePath.join(library, name);
  write(folder, ".aiwriter/config.json", JSON.stringify({ schemaVersion: "1", workTitle: name }));
  write(
    folder,
    ".aiwriter/external-access.json",
    JSON.stringify({ clients: [{ name: "claude-code", tools, sampling: false }] })
  );
  write(folder, "本文/001_灯.txt", "　港の灯が消えた夜。\n");
  return folder;
}

/** 相談ログ（製品の `renderChatLogEntry` が書く形） */
function chatLogOf(count: number, replyChars = 20): string {
  const head = "# 灯 の相談ログ\n\nAIとのやり取りをそのまま残しています。**原稿の一部を含みます。**\n";
  const entries = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return [
      "",
      "---",
      "",
      `## 2026-10-${String(n).padStart(2, "0")} 10:00:00　相談パネル`,
      "",
      "- AI: ollama（gemma）・無料",
      "",
      "### 質問",
      "",
      `> 質問${n}`,
      "",
      "### 返事",
      "",
      `> 返事${n}${"あ".repeat(replyChars)}`,
      "",
    ].join("\n");
  });
  return head + entries.join("");
}

function snapshot(folder: string): Record<string, string> {
  return folderSnapshot(folder);
}

beforeEach(() => {
  library = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-read-logs-"));
  setExternalClientName("claude-code");
});

afterEach(() => {
  fs.rmSync(library, { recursive: true, force: true });
  setExternalClientName("");
});

describe("許可", () => {
  test("\"*\" だけの作品では3つとも断る（ほかの kind は通る）", () => {
    const folder = makeWork("全部", ["*"]);
    for (const kind of ["chatLog", "log", "editHistory"]) {
      expect(() => assertExternalAccessAllowed({ folder, kind }, "novel.read")).toThrow(
        new RegExp(`novel\\.read\\.${kind}`)
      );
    }
    expect(() => assertExternalAccessAllowed({ folder, kind: "settings" }, "novel.read")).not.toThrow();
  });

  test("名指しで許した鍵だけ通る", () => {
    const folder = makeWork("名指し", ["novel.read.chatLog"]);
    expect(() => assertExternalAccessAllowed({ folder, kind: "chatLog" }, "novel.read")).not.toThrow();
    expect(() => assertExternalAccessAllowed({ folder, kind: "log" }, "novel.read")).toThrow();
  });

  test("記録には何を読んだかだけを残す", () => {
    const folder = makeWork("記録", ["novel.read.chatLog"]);
    recordExternalAccess({ tool: "novel.read", args: { folder, kind: "chatLog" }, ok: true, result: {} });
    recordExternalAccess({ tool: "novel.read", args: { folder, kind: "editHistory" }, ok: true, result: {} });
    const log = fs.readFileSync(nodePath.join(folder, ".aiwriter", "history", "external.jsonl"), "utf8");
    expect(log).toContain("相談ログを読んだ");
    expect(log).toContain("編集履歴を読んだ");
  });
});

describe("kind: chatLog", () => {
  test("新しい回が先。見出しと中身を回ごとに返す", () => {
    const folder = makeWork("相談");
    write(folder, ".aiwriter/logs/chat.md", chatLogOf(3));
    const result = novelRead({ folder, kind: "chatLog" });
    if (result.kind !== "chatLog") throw new Error(result.kind);
    expect(result.total).toBe(3);
    expect(result.entries.map((entry) => entry.heading)).toEqual([
      "2026-10-03 10:00:00　相談パネル",
      "2026-10-02 10:00:00　相談パネル",
      "2026-10-01 10:00:00　相談パネル",
    ]);
    expect(result.entries[0].text).toContain("> 質問3");
    // 見出し（日時）は heading に分け、中身には重ねない
    expect(result.entries[0].text).not.toContain("2026-10-03");
    expect(result.next).toBeNull();
  });

  test("大きければ上限の手前で切って、続きの印を返す。続きで残りが読める", () => {
    const folder = makeWork("大きい相談");
    write(folder, ".aiwriter/logs/chat.md", chatLogOf(12, 2000));
    const first = novelRead({ folder, kind: "chatLog" });
    if (first.kind !== "chatLog") throw new Error(first.kind);
    expect(estimateResultTokens(first)).toBeLessThanOrEqual(READ_RESULT_TOKEN_BUDGET);
    expect(first.truncated).toBe(true);
    expect(first.next).not.toBeNull();
    const seen = [...first.entries.map((entry) => entry.heading)];
    let offset = first.next?.offset;
    while (offset !== undefined) {
      const page = novelRead({ folder, kind: "chatLog", offset });
      if (page.kind !== "chatLog") throw new Error(page.kind);
      seen.push(...page.entries.map((entry) => entry.heading));
      offset = page.next?.offset;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  test("ログが無ければ空と断りを返す（作らない）", () => {
    const folder = makeWork("相談なし");
    const before = snapshot(folder);
    const result = novelRead({ folder, kind: "chatLog" });
    if (result.kind !== "chatLog") throw new Error(result.kind);
    expect(result.entries).toEqual([]);
    expect(result.notices.join("")).toMatch(/まだありません/);
    expect(snapshot(folder)).toEqual(before);
  });
});

describe("kind: log", () => {
  test("新しい行が先。limit で件数を絞れる", () => {
    const folder = makeWork("ログ");
    write(
      folder,
      ".aiwriter/logs/actions.log",
      "[2026-10-01 10:00:00] 一行目\n[2026-10-01 10:00:01] 二行目\n[2026-10-01 10:00:02] 三行目\n"
    );
    const result = novelRead({ folder, kind: "log" });
    if (result.kind !== "log") throw new Error(result.kind);
    expect(result.lines).toEqual([
      "[2026-10-01 10:00:02] 三行目",
      "[2026-10-01 10:00:01] 二行目",
      "[2026-10-01 10:00:00] 一行目",
    ]);
    const limited = novelRead({ folder, kind: "log", limit: 2 });
    if (limited.kind !== "log") throw new Error(limited.kind);
    expect(limited.lines).toHaveLength(2);
    expect(limited.next).toEqual({ offset: 2 });
  });
});

describe("kind: editHistory", () => {
  test("製品と同じ読み方（新しい順・壊れた行と重なりは落とす）", () => {
    const folder = makeWork("履歴");
    const line = (time: string, action: string) =>
      JSON.stringify({ time, actor: "author", actorName: "作者", action, file: "本文/001_灯.txt", detail: "" });
    write(
      folder,
      ".aiwriter/history/edits.jsonl",
      [
        line("2026-10-01T00:00:00.000Z", "誤字を直した"),
        "{壊れた行",
        line("2026-10-03T00:00:00.000Z", "推敲を当てた"),
        line("2026-10-03T00:00:00.000Z", "推敲を当てた"),
      ].join("\n") + "\n"
    );
    const result = novelRead({ folder, kind: "editHistory" });
    if (result.kind !== "editHistory") throw new Error(result.kind);
    expect(result.entries.map((entry) => entry.action)).toEqual(["推敲を当てた", "誤字を直した"]);
    expect(result.total).toBe(2);
  });

  test("3つとも作品フォルダーに何も書かない", () => {
    const folder = makeWork("書かない");
    write(folder, ".aiwriter/logs/chat.md", chatLogOf(2));
    write(folder, ".aiwriter/logs/actions.log", "[x] 行\n");
    const before = snapshot(folder);
    novelRead({ folder, kind: "chatLog" });
    novelRead({ folder, kind: "log" });
    novelRead({ folder, kind: "editHistory" });
    expect(snapshot(folder)).toEqual(before);
  });
});

describe("置き場所の名前を製品と揃える", () => {
  test("相談ログ・ログ・編集履歴の置き場所は、書く側のソースと同じ名前", () => {
    const root = nodePath.join(__dirname, "../../..");
    const chatLog = fs.readFileSync(nodePath.join(root, "src/core/chatLog.ts"), "utf8");
    const logger = fs.readFileSync(nodePath.join(root, "src/core/logger.ts"), "utf8");
    expect(chatLog).toContain('"logs", "chat.md"');
    expect(logger).toContain('".aiwriter", "logs", "actions.log"');
  });
});
