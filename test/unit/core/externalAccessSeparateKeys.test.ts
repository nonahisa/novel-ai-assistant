import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import * as path from "path";
import {
  ACTION_LOG_READ_KEY,
  ALL_TOOLS,
  CHAT_LOG_READ_KEY,
  EDIT_HISTORY_READ_KEY,
  SEPARATE_READ_KEYS,
  describeExternalAccessPermission,
  isSeparatelyGrantedKey,
  isToolAllowed,
  parseExternalAccessPermission,
  permissionKeyOf,
} from "../../../src/core/externalAccessPermission";
import { ExternalAccessPermissionStore } from "../../../src/core/externalAccessPermissionStore";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 相談ログ・ログ・編集履歴を読む鍵は、**`"*"` に含めない**
 * （作者の裁定 2026-10-16 の2と6。設計書6.87.24）。
 *
 * 相談の中身と本文の断片が外へ出るので、「全部の道具」を許した接続元でも、
 * 作者がその鍵を名指しで許すまでは読めない。
 *
 * 印は一時フォルダーの作り物で、作者の作品の印には触らない。
 */

function permissionOf(tools: string[]) {
  return parseExternalAccessPermission(
    JSON.stringify({ clients: [{ name: "claude-code", tools, sampling: false }] })
  );
}

describe("鍵の決め方", () => {
  it("novel.read の chatLog・log・editHistory は、それぞれ別の鍵になる", () => {
    expect(permissionKeyOf("novel.read", undefined, "chatLog")).toBe(CHAT_LOG_READ_KEY);
    expect(permissionKeyOf("novel.read", undefined, "log")).toBe(ACTION_LOG_READ_KEY);
    expect(permissionKeyOf("novel.read", undefined, "editHistory")).toBe(EDIT_HISTORY_READ_KEY);
  });

  it("ほかの kind はこれまでどおり道具の名前（novel.read）", () => {
    expect(permissionKeyOf("novel.read", undefined, "settings")).toBe("novel.read");
    expect(permissionKeyOf("novel.read", undefined, undefined)).toBe("novel.read");
  });

  it("別の道具の kind: chatLog は、別の鍵にならない（読み替えを広げない）", () => {
    expect(permissionKeyOf("novel.propose", undefined, "chatLog")).toBe("novel.propose");
  });

  it("3つの鍵には作者が読める呼び名がある", () => {
    for (const key of [CHAT_LOG_READ_KEY, ACTION_LOG_READ_KEY, EDIT_HISTORY_READ_KEY]) {
      expect(isSeparatelyGrantedKey(key)).toBe(true);
      expect(SEPARATE_READ_KEYS[key]).toMatch(/読む/);
    }
    expect(isSeparatelyGrantedKey("novel.read")).toBe(false);
    expect(isSeparatelyGrantedKey(ALL_TOOLS)).toBe(false);
  });
});

describe("\"*\" は別の鍵を覆わない", () => {
  it("全部を許した接続元でも、相談ログ・ログ・編集履歴は断る", () => {
    const permission = permissionOf([ALL_TOOLS]);
    expect(isToolAllowed(permission, "claude-code", "novel.read")).toBe(true);
    expect(isToolAllowed(permission, "claude-code", CHAT_LOG_READ_KEY)).toBe(false);
    expect(isToolAllowed(permission, "claude-code", ACTION_LOG_READ_KEY)).toBe(false);
    expect(isToolAllowed(permission, "claude-code", EDIT_HISTORY_READ_KEY)).toBe(false);
  });

  it("名指しで許した鍵だけが通る", () => {
    const permission = permissionOf([ALL_TOOLS, CHAT_LOG_READ_KEY]);
    expect(isToolAllowed(permission, "claude-code", CHAT_LOG_READ_KEY)).toBe(true);
    expect(isToolAllowed(permission, "claude-code", ACTION_LOG_READ_KEY)).toBe(false);
  });

  it("全部を許していなくても、名指しの鍵だけで読める", () => {
    const permission = permissionOf([EDIT_HISTORY_READ_KEY]);
    expect(isToolAllowed(permission, "claude-code", EDIT_HISTORY_READ_KEY)).toBe(true);
    expect(isToolAllowed(permission, "claude-code", "novel.read")).toBe(false);
  });

  it("画面の一文は、全部を許していても別の鍵が要ることを言う", () => {
    expect(describeExternalAccessPermission(permissionOf([ALL_TOOLS]))).toMatch(
      /相談ログ・ログ・編集履歴は別/
    );
  });
});

describe("転送層の確かめ（MCP）", () => {
  const temporary: string[] = [];
  afterEach(() => {
    setExternalClientName("");
    for (const folder of temporary.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  function workAllowing(tools: string[]): string {
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-sep-"));
    temporary.push(folder);
    fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(folder, ".aiwriter", "external-access.json"),
      JSON.stringify({ clients: [{ name: "claude-code", tools, sampling: false }] })
    );
    return folder;
  }

  it("\"*\" の作品で kind: chatLog を撃つと、鍵の名前を挙げて断る", () => {
    setExternalClientName("claude-code");
    const folder = workAllowing([ALL_TOOLS]);
    expect(() => assertExternalAccessAllowed({ folder, kind: "chatLog" }, "novel.read")).toThrow(
      /novel\.read\.chatLog/
    );
    // 同じ接続で、ほかの kind はこれまでどおり通る
    expect(() => assertExternalAccessAllowed({ folder, kind: "settings" }, "novel.read")).not.toThrow();
  });

  it("名指しで許した作品では通る", () => {
    setExternalClientName("claude-code");
    const folder = workAllowing([ALL_TOOLS, ACTION_LOG_READ_KEY]);
    expect(() => assertExternalAccessAllowed({ folder, kind: "log" }, "novel.read")).not.toThrow();
    expect(() => assertExternalAccessAllowed({ folder, kind: "editHistory" }, "novel.read")).toThrow();
  });
});

describe("許可の印を書く側（拡張機能）", () => {
  const work: WorkEntry = {
    id: "work_test",
    title: "氷の街",
    folderPath: path.join("C:", "novels", "work"),
    registeredAt: "2026-09-03T00:00:00.000Z",
  };
  const target = Uri.file(path.join(work.folderPath, ".aiwriter", "external-access.json")).fsPath;
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.fs = memoryFs(disk, { methods: ["createDirectory", "readFile", "writeFile"] });
  });

  function tools(): string[] {
    const bytes = disk.get(target);
    if (!bytes) return [];
    return parseExternalAccessPermission(new TextDecoder().decode(bytes)).clients[0]?.tools ?? [];
  }

  it("全部を許している接続元にも、別の鍵を足せる（足さないと、許したつもりで印が変わらない）", async () => {
    const store = new ExternalAccessPermissionStore(work);
    await store.allowTool("claude-code", ALL_TOOLS);
    await store.allowTool("claude-code", CHAT_LOG_READ_KEY);
    expect(tools()).toEqual([ALL_TOOLS, CHAT_LOG_READ_KEY]);
  });

  it("あとから全部を許しても、名指しで許した別の鍵は畳まない", async () => {
    const store = new ExternalAccessPermissionStore(work);
    await store.allowTool("claude-code", EDIT_HISTORY_READ_KEY);
    await store.allowTool("claude-code", "typo");
    await store.allowTool("claude-code", ALL_TOOLS);
    expect(tools()).toEqual([ALL_TOOLS, EDIT_HISTORY_READ_KEY]);
  });

  it("別の鍵を1つ取り消しても、全部の許可はそのまま", async () => {
    const store = new ExternalAccessPermissionStore(work);
    await store.allowTool("claude-code", ALL_TOOLS);
    await store.allowTool("claude-code", CHAT_LOG_READ_KEY);
    await store.allowTool("claude-code", ACTION_LOG_READ_KEY);
    await store.revokeTool("claude-code", CHAT_LOG_READ_KEY);
    expect(tools()).toEqual([ALL_TOOLS, ACTION_LOG_READ_KEY]);
  });

  it("全部を取り消しても、名指しで許した別の鍵は残る（別々に決めたものなので）", async () => {
    const store = new ExternalAccessPermissionStore(work);
    await store.allowTool("claude-code", ALL_TOOLS);
    await store.allowTool("claude-code", CHAT_LOG_READ_KEY);
    await store.revokeTool("claude-code", ALL_TOOLS);
    expect(tools()).toEqual([CHAT_LOG_READ_KEY]);
  });
});
