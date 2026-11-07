import { describe, expect, test } from "vitest";
import {
  READONLY_IN_SESSION_COMMAND,
  RESET_READONLY_IN_SESSION_COMMAND,
  SessionReadonlyKeeper,
  type ActiveEditorView,
} from "../../../src/features/editorLockReadonly";

/**
 * 編集者が校閲中の話を素のテキストエディターで開いたら、その画面をこの窓のあいだだけ
 * 読み取り専用にする（作者の裁定 2026-11-07。設計書5.7.5.2）。
 *
 * VS Code の命令は「いま前に出ている画面」に効く。命令を差し替え口にして、
 * どの画面が前にいるときに何を呼んだかを見る。
 */

const EPISODE = "file:///c%3A/%E4%BD%9C%E5%93%81/002.txt";
const OTHER = "file:///c%3A/%E4%BD%9C%E5%93%81/003.txt";

function keeper(start: { active?: ActiveEditorView; locked: Set<string> }) {
  const calls: string[] = [];
  const state = { active: start.active };
  const keep = new SessionReadonlyKeeper({
    active: () => state.active,
    isLocked: async (uri) => start.locked.has(uri),
    execute: async (command) => {
      calls.push(command);
    },
  });
  return { keep, calls, state, locked: start.locked };
}

describe("素のエディターを読み取り専用にする", () => {
  test("校閲中の話を素のエディターで前に出したら、読み取り専用にする（1回だけ）", async () => {
    const k = keeper({ active: { uri: EPISODE, kind: "text" }, locked: new Set([EPISODE]) });
    await k.keep.settle();
    await k.keep.settle();
    expect(k.calls).toEqual([READONLY_IN_SESSION_COMMAND]);
  });

  test("校閲中でない話には何もしない", async () => {
    const k = keeper({ active: { uri: OTHER, kind: "text" }, locked: new Set([EPISODE]) });
    await k.keep.settle();
    expect(k.calls).toEqual([]);
  });

  test("原稿エディター（素のエディターでない画面）が前にいるときは、読み取り専用にしない", async () => {
    // 命令は前にいる画面に効く。原稿エディターの文書を読み取り専用にすると、鍵が外れても書けなくなる
    const k = keeper({ active: { uri: EPISODE, kind: "other" }, locked: new Set([EPISODE]) });
    await k.keep.settle();
    expect(k.calls).toEqual([]);
  });

  test("鍵が外れたら、前にいる画面の読み取り専用を解く", async () => {
    const k = keeper({ active: { uri: EPISODE, kind: "text" }, locked: new Set([EPISODE]) });
    await k.keep.settle();
    k.locked.delete(EPISODE);
    await k.keep.settle();
    expect(k.calls).toEqual([READONLY_IN_SESSION_COMMAND, RESET_READONLY_IN_SESSION_COMMAND]);
  });

  test("前に出ていない間に鍵が外れたら、次に前に出たときに解く", async () => {
    const k = keeper({ active: { uri: EPISODE, kind: "text" }, locked: new Set([EPISODE]) });
    await k.keep.settle();
    k.state.active = { uri: OTHER, kind: "text" };
    k.locked.delete(EPISODE);
    await k.keep.settle();
    expect(k.calls).toEqual([READONLY_IN_SESSION_COMMAND]);
    // 同じ話を原稿エディターで前に出した（命令は前にいる画面の文書に効くので、ここでも解ける）
    k.state.active = { uri: EPISODE, kind: "other" };
    await k.keep.settle();
    expect(k.calls).toEqual([READONLY_IN_SESSION_COMMAND, RESET_READONLY_IN_SESSION_COMMAND]);
  });

  test("鍵を確かめている間に前の画面が替わったら、命令を呼ばない（別の画面に効いてしまう）", async () => {
    const calls: string[] = [];
    const state: { active?: ActiveEditorView } = { active: { uri: EPISODE, kind: "text" } };
    const keep = new SessionReadonlyKeeper({
      active: () => state.active,
      isLocked: async () => {
        state.active = { uri: OTHER, kind: "text" };
        return true;
      },
      execute: async (command) => {
        calls.push(command);
      },
    });
    await keep.settle();
    expect(calls).toEqual([]);
  });

  test("命令が失敗しても投げない（警告は別に出ている）", async () => {
    const keep = new SessionReadonlyKeeper({
      active: () => ({ uri: EPISODE, kind: "text" }),
      isLocked: async () => true,
      execute: async () => {
        throw new Error("command not found");
      },
    });
    await expect(keep.settle()).resolves.toBeUndefined();
  });
});
