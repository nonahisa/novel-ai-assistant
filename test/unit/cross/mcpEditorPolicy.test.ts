import { describe, expect, it } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";
import {
  EDITOR_FEATURE_RULES,
  EDITOR_RUN_REQUEST_RULES,
  MCP_EDITOR_POLICY,
  isMcpToolAllowedForEditor,
} from "../../../src/core/mcpEditorPolicy";
import { FEATURE_NAMES } from "../../../src/core/mcpFeatures";
import { RUN_REQUESTABLE_FEATURES } from "../../../src/core/runRequest";
import { findBlockAfter } from "../support/sourceBlock";

/**
 * MCP の道具の一覧と、編集者モードの表（`core/mcpEditorPolicy.ts`）を突き合わせる
 * （設計書6.87.25）。道具を足したのに表へ入れ忘れると、その道具は編集者には
 * 断られる（表に無い名前は断る）——**黙って開いてしまうことはない**が、許すつもりの
 * 道具が理由も無く断られるので、ここで止めて決めさせる。
 *
 * 道具名の抜き方は `mcp/mcpAccessLog.test.ts` と同じ（`registerTool("名前"`）。
 */

const SERVER = nodePath.join(__dirname, "../../../src/mcp/server.ts");
const source = fs.readFileSync(SERVER, "utf8");
const registered = [...source.matchAll(/registerTool\(\s*"([\w.]+)"/g)].map((m) => m[1]);

describe("道具の一覧と、編集者モードの表", () => {
  it("登録した道具は、すべて表のどちらか（許す／断る）に入っている", () => {
    expect(registered.length).toBeGreaterThan(0);
    const missing = registered.filter(
      (name) => !Object.prototype.hasOwnProperty.call(MCP_EDITOR_POLICY, name)
    );
    expect(missing, "表（MCP_EDITOR_POLICY）に無い道具").toEqual([]);
  });

  it("表に、もう無い道具の名前が残っていない", () => {
    const stale = Object.keys(MCP_EDITOR_POLICY).filter((name) => !registered.includes(name));
    expect(stale).toEqual([]);
  });

  it("表に無い名前は断る（新しい道具は、足すまで編集者に開かない）", () => {
    expect(isMcpToolAllowedForEditor("novel.somethingNew", { folder: "x" })).toBe(false);
  });

  it("feature の表と run.request の表も、機能の一覧と過不足が無い", () => {
    expect(Object.keys(EDITOR_FEATURE_RULES).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(Object.keys(EDITOR_RUN_REQUEST_RULES).sort()).toEqual(
      [...RUN_REQUESTABLE_FEATURES].sort()
    );
  });

  it("転送層は、許可を確かめたあと・道具を動かす前に、編集者モードを確かめる", () => {
    // 引数の型に `{ signal?: AbortSignal }` があるので、返す関数の矢印のあとから切り出す
    const body = findBlockAfter(source.slice(source.indexOf("function tool<Args>(")), "}) => {", {
      openAt: "afterMarker",
    });
    expect(body).toBeDefined();
    const text = body as string;
    const permission = text.indexOf("assertExternalAccessAllowed(args, name)");
    const guard = text.indexOf("assertEditorModeAllows(args, name)");
    const handler = text.indexOf("await handler(args)");
    expect(permission).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(permission);
    expect(handler).toBeGreaterThan(guard);
  });
});

describe("編集者モードで断る道具・許す道具", () => {
  const folder = { folder: "C:/作品" };

  it("資料・本文へ保存する道具は、引数に関わらず断る", () => {
    for (const name of ["novel.extract.commit", "novel.synopsis.commit", "outbox.import"]) {
      expect(isMcpToolAllowedForEditor(name, folder), name).toBe(false);
      expect(isMcpToolAllowedForEditor(name, { ...folder, dryRun: true }), name).toBe(false);
    }
  });

  it("novel.propose は kind: finding だけ許す", () => {
    expect(isMcpToolAllowedForEditor("novel.propose", { ...folder, kind: "finding" })).toBe(true);
    for (const kind of [undefined, "settings", "chapter", "foreshadow", "schedule"]) {
      expect(isMcpToolAllowedForEditor("novel.propose", { ...folder, kind }), String(kind)).toBe(
        false
      );
    }
  });

  it("novel.run・novel.validate は、貯め（stash）と作品へ書く feature を断る", () => {
    expect(isMcpToolAllowedForEditor("novel.run", { ...folder, feature: "typo" })).toBe(true);
    expect(isMcpToolAllowedForEditor("novel.validate", { ...folder, feature: "typo" })).toBe(true);
    for (const feature of ["factContradiction", "settings", "announce"]) {
      expect(isMcpToolAllowedForEditor("novel.run", { ...folder, feature }), feature).toBe(false);
    }
    expect(isMcpToolAllowedForEditor("novel.validate", { ...folder, feature: "announce" })).toBe(false);
    for (const feature of ["settings", "synopsis", "blurb", "settingsEnrich"]) {
      expect(
        isMcpToolAllowedForEditor("novel.validate", { ...folder, feature, stash: true }),
        feature
      ).toBe(false);
    }
    // 知らない feature は断る
    expect(isMcpToolAllowedForEditor("novel.run", { ...folder, feature: "nope" })).toBe(false);
  });

  it("run.request は、結果を返すだけの機能だけ許す", () => {
    for (const feature of ["typo", "proofread", "contradiction", "testAI"]) {
      expect(isMcpToolAllowedForEditor("run.request", { ...folder, feature }), feature).toBe(true);
    }
    for (const feature of [
      "settings",
      "factContradiction",
      "vectorIndex",
      "coverBake",
      "exportPdf",
      "exportEpub",
    ]) {
      expect(isMcpToolAllowedForEditor("run.request", { ...folder, feature }), feature).toBe(false);
    }
  });

  it("読むだけの道具は許す", () => {
    for (const name of [
      "novel.scan",
      "novel.read",
      "novel.search",
      "novel.prompt",
      "novel.detect",
      "novel.material",
      "pending.list",
      "run.result",
      "outbox.pack",
    ]) {
      expect(isMcpToolAllowedForEditor(name, folder), name).toBe(true);
    }
  });
});
