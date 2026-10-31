import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { extractCommit } from "../../../src/mcp/tools/extractCommit";
import { settingsPrompt, settingsValidate } from "../../../src/mcp/tools/settings";
import { novelPropose } from "../../../src/mcp/tools/propose";
import { workScan } from "../../../src/mcp/tools/workScan";
import {
  EditorModeBlockedError,
  assertEditorModeAllows,
  readWorkFolderMode,
} from "../../../src/mcp/tools/editorGuard";
import { EDITING_SITE_FILE, EDITOR_SHARE_MANIFEST_FILE } from "../../../src/core/editingRepo";
import { MCP_EDITOR_ALLOWED_MESSAGE_HINT } from "../../../src/core/editorMode";
import { folderFingerprint } from "../support/folderFingerprint";

/**
 * MCP サーバーの編集者モードの守り（設計書6.87.25・5.6.5。作者の指示 2026-10-31
 * 「MCPサーバの穴ふさぎは実行してください」）。
 *
 * **見張りたいのは2つ。**
 * 1. 編集用の写し（`.aiwriter/editor-share-manifest.json` がある作品）では、
 *    書き込みを伴う道具が**1バイトも書かずに**断る
 * 2. 作者の作品（印が無い）では、**今までどおり**書ける
 *
 * 転送層（`server.ts` の `tool()`）は stdio を立てないと呼べないので、
 * ここでは**同じ順で**守り → 道具を呼ぶ（`callThroughGuard`）。
 * 転送層がその順で呼んでいることは `mcpEditorPolicy.test.ts`（cross）がソースで見る。
 */

const NUM_CTX = 32768;
const temporary: string[] = [];
const EPISODE = "001_出会い.txt";
const TEXT = "　港町に灯という娘がいた。\n　漁師の岩男が港町へ戻ってきた。\n";

function makeWork(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-editor-guard-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE), TEXT, "utf8");
  fs.mkdirSync(nodePath.join(folder, "設定", "characters"), { recursive: true });
  return folder;
}

/** 編集部へ渡したときに `copyForEditor` が置く印を、同じ場所へ置く */
function markAsEditorCopy(folder: string): void {
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", EDITOR_SHARE_MANIFEST_FILE),
    `${JSON.stringify({ files: [] }, null, 2)}\n`,
    "utf8"
  );
}

/** 作者の作品が編集部へ渡したことを覚える印（`writeSite`）。編集用へは写らない */
function markAsSharedByAuthor(folder: string): void {
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", EDITING_SITE_FILE),
    `${JSON.stringify({ remoteUrl: "https://github.com/owner/repo.git" }, null, 2)}\n`,
    "utf8"
  );
}

/** 抽出の答えを1つ貯める（守りを通さず直に。保存の道を試すための前準備） */
function stashAnswer(folder: string): void {
  const chunkId = settingsPrompt({ folder, filePath: `本文/${EPISODE}`, numCtx: NUM_CTX })
    .chunks[0].chunkId;
  settingsValidate({
    folder,
    chunkId,
    response: JSON.stringify({
      characters: [
        {
          name: "岩男",
          aliases: [],
          entityType: "person",
          role: "漁師",
          evidence: "漁師の岩男が港町へ戻ってきた",
        },
      ],
    }),
    stash: true,
  });
}

/** 転送層と同じ順：守り → 道具 */
async function callThroughGuard<Args>(
  name: string,
  args: Args,
  handler: (args: Args) => unknown
): Promise<unknown> {
  assertEditorModeAllows(args, name);
  return await handler(args);
}

function characterFiles(folder: string): string[] {
  const dir = nodePath.join(folder, "設定", "characters");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

afterEach(() => {
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("作品フォルダーの印から、編集用の写しかを読む", () => {
  it("印が無い作品は作者（一度も渡していない普通の作品）", () => {
    expect(readWorkFolderMode(makeWork())).toBe("author");
  });

  it("作者が渡したことを覚えているだけの作品も作者", () => {
    const folder = makeWork();
    markAsSharedByAuthor(folder);
    expect(readWorkFolderMode(folder)).toBe("author");
  });

  it("編集用の写しの印があれば編集者", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    expect(readWorkFolderMode(folder)).toBe("editor");
  });

  it("両方の印がある（ありえない組）は、分からない扱い", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    markAsSharedByAuthor(folder);
    expect(readWorkFolderMode(folder)).toBe("unknown");
  });

  it("印の場所がファイルでない（フォルダーになっている）ときも、分からない扱い", () => {
    const folder = makeWork();
    fs.mkdirSync(nodePath.join(folder, ".aiwriter", EDITOR_SHARE_MANIFEST_FILE), {
      recursive: true,
    });
    expect(readWorkFolderMode(folder)).toBe("unknown");
  });
});

describe("編集用の写しでは、書く道具が1バイトも書かずに断る", () => {
  it("novel.extract.commit：設定/ も .aiwriter/ も変わらない", async () => {
    const folder = makeWork();
    stashAnswer(folder);
    markAsEditorCopy(folder);
    const before = folderFingerprint(folder);

    await expect(callThroughGuard("novel.extract.commit", { folder }, extractCommit)).rejects.toThrow(
      EditorModeBlockedError
    );

    expect(folderFingerprint(folder)).toBe(before);
    expect(characterFiles(folder)).toEqual([]);
  });

  it("novel.propose の設定資料の案（kind 省略）：承認待ちへ置かない", async () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    const before = folderFingerprint(folder);

    await expect(
      callThroughGuard(
        "novel.propose",
        { folder, name: "岩男", changes: { role: "漁師" }, reason: "本文に漁師とある" },
        novelPropose as (args: unknown) => unknown
      )
    ).rejects.toThrow(EditorModeBlockedError);

    expect(folderFingerprint(folder)).toBe(before);
    expect(fs.existsSync(nodePath.join(folder, ".aiwriter", "pending-characters"))).toBe(false);
  });

  it("断りの文は理由と代わりの道（kind: finding）を言う", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    let message = "";
    try {
      assertEditorModeAllows({ folder }, "outbox.import");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("編集者モードでは使えません");
    expect(message).toContain("作者の原稿と資料を、編集部の側から書き換えないためです");
    expect(message).toContain(MCP_EDITOR_ALLOWED_MESSAGE_HINT);
  });

  it("印が読めないときも、書く道具は断る（断り文に、確かめられなかったことを書く）", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    markAsSharedByAuthor(folder);
    expect(() => assertEditorModeAllows({ folder }, "novel.synopsis.commit")).toThrow(
      /確かめられませんでした/
    );
  });
});

describe("編集用の写しでも、許す道具は通る", () => {
  it("novel.scan は動いて本文を返す", async () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    const result = (await callThroughGuard("novel.scan", { folder }, workScan)) as {
      episodes: unknown[];
    };
    expect(result.episodes.length).toBe(1);
  });

  it("novel.propose の kind: finding は守りを通る", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    expect(() => assertEditorModeAllows({ folder, kind: "finding" }, "novel.propose")).not.toThrow();
  });

  it("印が読めないときも、読むだけの道具は通る", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    markAsSharedByAuthor(folder);
    expect(() => assertEditorModeAllows({ folder }, "novel.read")).not.toThrow();
  });
});

describe("作者の作品では、今までどおり", () => {
  it("novel.extract.commit は新しい人物を 設定/ へ作る", async () => {
    const folder = makeWork();
    markAsSharedByAuthor(folder);
    stashAnswer(folder);

    await callThroughGuard("novel.extract.commit", { folder }, extractCommit);

    expect(characterFiles(folder).some((name) => name.endsWith("_岩男.json"))).toBe(true);
  });

  it("断る側の道具も、作者の作品では1つも断らない", () => {
    const folder = makeWork();
    for (const name of [
      "novel.extract.commit",
      "novel.synopsis.commit",
      "outbox.import",
      "novel.propose",
      "run.request",
      "novel.run",
      "novel.validate",
    ]) {
      expect(
        () => assertEditorModeAllows({ folder, feature: "settings", stash: true }, name),
        name
      ).not.toThrow();
    }
  });

  it("作品を指さない道具（setup.request を除く）は、印を読まずに通す", () => {
    for (const name of ["mcp.version", "windows.list", "notices.recent", "works.list", "ai.settings"]) {
      expect(() => assertEditorModeAllows({}, name), name).not.toThrow();
    }
  });

  it("setup.request は作者の作品の path なら、どの段も断らない", () => {
    const folder = makeWork();
    for (const step of ["external-access", "register", "create", "ollama"]) {
      expect(() => assertEditorModeAllows({ step, path: folder }, "setup.request"), step).not.toThrow();
    }
  });
});

describe("setup.request は作品を path で受ける", () => {
  it("編集用の写しの path へ、外部AIの許可・登録・作成を頼めない", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    for (const step of ["external-access", "register", "create"]) {
      expect(
        () => assertEditorModeAllows({ step, path: folder }, "setup.request"),
        step
      ).toThrow(EditorModeBlockedError);
    }
  });

  it("作品に触らない段は、写しの path でも通す", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    expect(() => assertEditorModeAllows({ step: "ollama", path: folder }, "setup.request")).not.toThrow();
  });

  it("ほかの道具の path は作品として読まない", () => {
    const folder = makeWork();
    markAsEditorCopy(folder);
    expect(() => assertEditorModeAllows({ path: folder }, "outbox.import")).not.toThrow();
  });
});
