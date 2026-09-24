import { describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { WorkEntry } from "../../../src/models/types";

/**
 * ブラウザ版の相談パネルが、ブラウザで開いた本文を相談の相手にする
 * （作者の裁定、2026-09-24 夜）。
 *
 * ## 何が起きていたか
 *
 * `trackEditor`・`currentWorkId`・`resolveContext` が `uri.scheme === "file"`
 * の文書しか受け取っていなかった。ブラウザ版（vscode.dev / github.dev）の
 * 本文は `vscode-vfs://github/…` で開くので、本文を開いていても
 * 相談の対象はいつまでも「選んである作品」のまま——**開いている話について
 * 聞いても、その話を読まずに答える**状態だった。
 *
 * ## 直し方
 *
 * `file` の文書は今までどおり受け取る。`file` 以外は、**登録済みの作品の
 * 中にある文書だけ**受け取る（`findWorkForFile`）。無題の文書・設定・出力の
 * ような作品の外の文書は、今までどおり相談の相手にしない。
 *
 * 登録簿の場所は生の日本語、`fromUri` で取った本文の場所は百分率符号の
 * 形で来る。**日本語名の作品で確かめる**——ASCII の名前だけで試すと、
 * 符号の食い違いで「作品の外」と判定される壊れ方を見逃す。
 */

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const BROWSER_WORK: WorkEntry = {
  id: "w_browser",
  title: "氷の街",
  folderPath: "vscode-vfs://github/owner/repo/氷の街",
  registeredAt: "2026-09-24T00:00:00.000Z",
};

const DESKTOP_WORK: WorkEntry = {
  id: "w_desktop",
  title: "春の庭",
  folderPath: "C:\\novels\\春の庭",
  registeredAt: "2026-09-24T00:00:00.000Z",
};

function makePanel() {
  const registry = { list: () => [BROWSER_WORK, DESKTOP_WORK] };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => undefined,
  };
  const runner = { run: async () => undefined };
  return new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
}

/** 開いている文書の作り物。相談パネルが見るのは `document.uri` だけ */
function editorAt(uri: unknown): vscode.TextEditor {
  return {
    document: { uri, getText: () => "" },
    selection: { active: { line: 0, character: 0 } },
  } as unknown as vscode.TextEditor;
}

/** ブラウザ版で開いた本文の URI。本物と同じく日本語は符号化された形で来る */
const browserEpisodeUri = vscode.Uri.parse(
  "vscode-vfs://github/owner/repo/" +
    encodeURIComponent("氷の街") +
    "/" +
    encodeURIComponent("第1話.txt")
);

describe("相談パネルが受け取る文書（ブラウザ版）", () => {
  test("ブラウザで開いた日本語名の作品の本文は、その作品が相談の対象になる", () => {
    const panel = makePanel();
    panel.trackEditor(editorAt(browserEpisodeUri));
    expect(panel.currentWorkId()).toBe(BROWSER_WORK.id);
  });

  test("手元の本文（file）は、今までどおりその作品が対象になる", () => {
    const panel = makePanel();
    panel.trackEditor(
      editorAt(vscode.Uri.file("C:\\novels\\春の庭\\第1話.txt"))
    );
    expect(panel.currentWorkId()).toBe(DESKTOP_WORK.id);
  });

  test("作品の外の文書（無題・設定・出力）は受け取らない", () => {
    const panel = makePanel();
    panel.trackEditor(editorAt(browserEpisodeUri));
    // 相談パネルへフォーカスが移る途中で、作品の外の文書が前に来ることがある。
    // それを受け取ると、直前まで見ていた本文を手放してしまう
    panel.trackEditor(editorAt(vscode.Uri.parse("untitled:Untitled-1")));
    panel.trackEditor(
      editorAt(vscode.Uri.parse("vscode-userdata:/User/settings.json"))
    );
    panel.trackEditor(
      editorAt(vscode.Uri.parse("output:extension-output-novelai"))
    );
    expect(panel.currentWorkId()).toBe(BROWSER_WORK.id);
  });

  test("別の場所（別のリポジトリ）の vscode-vfs の文書は受け取らない", () => {
    const panel = makePanel();
    panel.trackEditor(
      editorAt(
        vscode.Uri.parse(
          "vscode-vfs://github/owner/other/" + encodeURIComponent("第1話.txt")
        )
      )
    );
    expect(panel.currentWorkId()).toBeUndefined();
  });
});
