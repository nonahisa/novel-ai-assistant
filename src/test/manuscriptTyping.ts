import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ManuscriptEditorProvider,
  type ManuscriptEditorDeps,
} from "../features/manuscriptEditor";
import type { TermHighlighter } from "../views/termHighlight";

/**
 * 原稿エディターで打った字が、文書へ届いて消えないこと（設計書6.25.9）。
 *
 * 作者の報告（2026-09-28、ノートPC）：「×ボタンで消したら400文字ぐらいが
 * 消えました。自動保存がきいていません」。空の原稿（0字）へ打った字が、
 * 画面にだけ残って文書へ入っていなかった。
 *
 * **本物の拡張機能ホストで、本物の `ManuscriptEditorProvider` と本物の文書を
 * 使う。** 画面（WebView の中）だけは作り物にして、画面が送るのと同じ用件
 * （`ready`・`edit`）を渡し、画面へ返ってきた用件を控える。作品は一時フォルダーに
 * 作る（作者の原稿・確認用コピーには触れない）。
 */

type RunCase = (name: string, test: () => Promise<void>) => Promise<void>;

export async function runManuscriptTypingChecks(runCase: RunCase): Promise<void> {
  await runCase(
    "原稿エディター：空の原稿へ打った字が文書へ入り、「入った」が画面へ返り、保存すればファイルに残る",
    checkTypedTextReachesDocument
  );
  await runCase(
    "原稿エディター：画面を閉じても、文書へ入った字は未保存のまま残り、保存の流れに乗る",
    checkTypedTextSurvivesClose
  );
  await runCase(
    "原稿エディター：右クリックの貼り付け・コピーは拡張機能がクリップボードを読み書きし、切り取り・貼り付けの本文は打鍵と同じ便で文書へ入る",
    checkClipboardMenu
  );
}

interface FakePanel {
  panel: vscode.WebviewPanel;
  posted: unknown[];
  receive(message: unknown): Promise<void>;
  close(): void;
}

/** 画面（WebView）の作り物。送った用件を控え、画面からの用件を渡せるようにする */
function fakePanel(): FakePanel {
  const posted: unknown[] = [];
  let listener: ((message: unknown) => unknown) | undefined;
  const disposeListeners: Array<() => void> = [];
  const noop = { dispose() {} };
  const panel = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      postMessage: async (message: unknown) => {
        posted.push(message);
        return true;
      },
      onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
        listener = handler;
        return noop;
      },
      asWebviewUri: (uri: vscode.Uri) => uri,
    },
    onDidDispose: (handler: () => void) => {
      disposeListeners.push(handler);
      return noop;
    },
    onDidChangeViewState: () => noop,
    visible: true,
    active: false,
    viewColumn: vscode.ViewColumn.One,
    dispose() {
      for (const handler of disposeListeners.splice(0)) handler();
    },
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    posted,
    receive: async (message) => {
      assert.ok(listener, "画面からの用件の受け口が張られていません");
      await listener(message);
    },
    close: () => panel.dispose(),
  };
}

/** 作品に属さない原稿として開く（色付け・字数の走査は空で返す） */
function fakeDeps(): ManuscriptEditorDeps {
  const deps = {
    highlighter: { indexFor: async () => undefined } as unknown as TermHighlighter,
    workOf: () => undefined,
    openSettings: async () => undefined,
    previewTerm: async () => undefined,
    openChat: async () => undefined,
    workStats: async () => ({
      fileCount: 0,
      totals: { total: 0, pure: 0 },
      conflictedCount: 0,
    }),
    workEpisodes: async () => [],
    todayFileCount: async () => undefined,
    rebaseline: async () => undefined,
    convertToMarkdown: async () => undefined,
    markdownDeclined: () => [],
    declineMarkdown: async () => undefined,
  };
  return deps as unknown as ManuscriptEditorDeps;
}

async function waitFor<T>(
  read: () => T | undefined,
  label: string,
  timeoutMs = 5000
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`${label}が${timeoutMs}ミリ秒たっても来ません`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Ack {
  type: "editApplied";
  seq: number;
  ok: boolean;
}

function ackOf(posted: unknown[], seq: number): Ack | undefined {
  for (const message of posted) {
    const candidate = message as Partial<Ack>;
    if (candidate?.type === "editApplied" && candidate.seq === seq) {
      return candidate as Ack;
    }
  }
  return undefined;
}

/** 作者と同じ「0字の原稿」を一時フォルダーに作って、原稿エディターで開く */
async function openEmptyManuscript(): Promise<{
  root: string;
  file: string;
  document: vscode.TextDocument;
  view: FakePanel;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-typing-"));
  const folder = path.join(root, "テスト作品", "本文");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "001.txt");
  await fs.writeFile(file, "");
  // 画面には出さない（原稿エディターの受け口へ、文書として渡すだけ）
  const uri = vscode.Uri.file(file);
  const document = await vscode.workspace.openTextDocument(uri);
  const view = fakePanel();
  const provider = new ManuscriptEditorProvider(fakeDeps());
  await provider.resolveCustomTextEditor(
    document,
    view.panel,
    new vscode.CancellationTokenSource().token
  );
  await view.receive({ type: "ready" });
  return { root, file, document, view };
}

async function checkTypedTextReachesDocument(): Promise<void> {
  const { root, file, document, view } = await openEmptyManuscript();
  try {
    assert.equal(document.getText(), "", "0字の原稿から始まっていません");

    // 画面で打って、変換を確定した——画面は本文まるごとを番号付きで送る
    await view.receive({ type: "edit", text: "一行目の字", seq: 1 });
    await view.receive({ type: "edit", text: "一行目の字\n二行目", seq: 2 });

    const ack = await waitFor(() => ackOf(view.posted, 2), "2便目の「入った」");
    assert.equal(ack.ok, true, "文書へ入れられなかったと返ってきました");
    assert.equal(
      document.getText().replace(/\r\n/g, "\n"),
      "一行目の字\n二行目",
      "打った字が文書へ入っていません"
    );
    // **未保存になっている＝VS Code の自動保存・閉じる前の確認に乗る**
    assert.equal(document.isDirty, true, "文書が未保存になっていません");

    assert.equal(await document.save(), true, "保存できませんでした");
    const saved = await fs.readFile(file, "utf8");
    assert.equal(saved.replace(/\r\n/g, "\n"), "一行目の字\n二行目");
  } finally {
    view.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * 右クリックの「切り取り」「コピー」「貼り付け」（設計書6.25）。
 *
 * 画面の中の動き（写す→消す、控えた位置へ入れる）は単体テスト
 * （manuscriptEditorClipboardMenu.test.ts）で見ている。ここでは拡張機能の側——
 * **クリップボードを読んで返すこと・写すこと**と、その後に画面が送る本文が
 * 打鍵と同じ `edit` 便で文書へ入ること——を本物のホストで確かめる。
 * 作者のクリップボードは、終わったら元へ戻す。
 */
async function checkClipboardMenu(): Promise<void> {
  const saved = await vscode.env.clipboard.readText();
  const { root, document, view } = await openEmptyManuscript();
  try {
    await view.receive({ type: "edit", text: "あいうえお", seq: 1 });
    await waitFor(() => ackOf(view.posted, 1), "1便目の「入った」");

    // 切り取り：画面の copy が断られたときは、拡張機能に写してもらう
    await view.receive({ type: "clipboardWrite", text: "いう", id: 7 });
    assert.equal(await vscode.env.clipboard.readText(), "いう", "クリップボードへ写っていません");
    // 写し終わった返事（画面はこれが来てから消す）
    const written = await waitFor(
      () =>
        view.posted.find(
          (message) => (message as { type?: string })?.type === "clipboardWritten"
        ) as { id: number; ok: boolean } | undefined,
      "写し終わった返事"
    );
    assert.deepEqual({ id: written.id, ok: written.ok }, { id: 7, ok: true });
    // 画面は選んだところを消し、打鍵と同じ便で送る
    await view.receive({ type: "edit", text: "あえお", seq: 2 });
    await waitFor(() => ackOf(view.posted, 2), "切り取った後の「入った」");
    assert.equal(document.getText(), "あえお", "切り取りが文書へ入っていません");

    // 貼り付け：拡張機能がクリップボードを読んで返す
    await view.receive({ type: "clipboardRead" });
    const reply = await waitFor(
      () =>
        view.posted.find(
          (message) => (message as { type?: string })?.type === "clipboardText"
        ) as { type: string; text: string } | undefined,
      "クリップボードの字の返事"
    );
    assert.equal(reply.text, "いう", "読んだクリップボードの字が違います");
    await view.receive({ type: "edit", text: "あいうえお", seq: 3 });
    await waitFor(() => ackOf(view.posted, 3), "貼り付けた後の「入った」");
    assert.equal(document.getText(), "あいうえお", "貼り付けが文書へ入っていません");
  } finally {
    view.close();
    await vscode.env.clipboard.writeText(saved);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function checkTypedTextSurvivesClose(): Promise<void> {
  const { root, file, document, view } = await openEmptyManuscript();
  try {
    await view.receive({ type: "edit", text: "閉じる前に打った字", seq: 1 });
    await waitFor(() => ackOf(view.posted, 1), "「入った」");

    // タブの×にあたる。画面は消えるが、文書は残る
    view.close();
    assert.equal(document.isDirty, true, "閉じたあと文書の変更が消えています");
    assert.equal(document.getText(), "閉じる前に打った字");

    assert.equal(await document.save(), true, "保存できませんでした");
    assert.equal(await fs.readFile(file, "utf8"), "閉じる前に打った字");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
