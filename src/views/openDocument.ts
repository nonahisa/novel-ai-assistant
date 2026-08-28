import * as vscode from "vscode";
import { toUri } from "../core/paths";
import { canRunProcesses } from "../core/runtime";

/**
 * 作者の既定のエディターでファイルを開く（設計書6.17.6）。
 *
 * **`openTextDocument` + `showTextDocument` は、常に素のテキストエディターで
 * 開く。** 作者が `workbench.editorAssociations` で `*.md` に Markdown の
 * エディターを割り当てていても、無視される。
 *
 * 実際に起きた（2026-08-21、作者が実機で発見）。`plot.md` だけが
 * 「テキスト エディター」で開き、記法がそのまま並んでいた。作品一覧から
 * 開いた `.md` は Markdown のエディターで出るのに、こちらだけ違っていた。
 *
 * `vscode.open` は**既定の割り当てを通る**ので、作者の設定どおりに開く。
 *
 * ## エディターの実体が要るときは、これを使わない
 *
 * 該当行へ飛ぶ・選択範囲を作るといった操作には `TextEditor` が要る。
 * `vscode.open` は何も返さないので、そこは `showTextDocument` のままにする
 * （提案パネルの「該当箇所へ移動」、ルビを振る、相談パネルの引用）。
 */
export async function openInDefaultEditor(
  filePath: string,
  options?: vscode.TextDocumentShowOptions
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.open",
    toUri(filePath),
    options
  );
}

/**
 * その場で作ったMarkdownを、作者の既定の画面で見せる（設計書6.17.6）。
 *
 * 保存しない読み物（「反映待ちの更新」、IME辞書の取り込み手順、
 * セットアップの内訳、ブラウザ版の診断）に使う。
 *
 * **`showTextDocument` の決め打ちだと、素のテキストで開く。** 作者から
 * 「反映待ちの更新がデフォルトで開きません」と報告があった（2026-08-27）。
 * `.md` ファイルのときと同じ理屈で、`workbench.editorAssociations` の
 * 割り当てを素通りしてしまう。
 *
 * ## 名前を付けてから中身を入れる
 *
 * `openTextDocument({content, language})` は手軽だが、**名前を付けられない**
 * （`Untitled-1` になる）。既定の割り当ては `*.md` のような**名前のかたち**で
 * 決まるので、拡張子の無い文書には当たらない。それでは `vscode.open` に
 * 渡しても直らない。
 *
 * そこで、先に `untitled:反映待ちの更新.md` という**名前だけの空の文書**を
 * 作り、`WorkspaceEdit` で中身を入れる。保存されていない文書のままなので、
 * 「これはまだ保存されていません」という性質は変わらない。
 *
 * @param displayName タブに出る名前（拡張子は付けない）
 */
export async function openGeneratedMarkdown(
  displayName: string,
  content: string,
  options?: vscode.TextDocumentShowOptions
): Promise<void> {
  const uri = untitledMarkdownUri(displayName, openUntitledNames());
  const document = await vscode.workspace.openTextDocument(uri);
  await ensureMarkdown(document);

  // **中身を入れてから見せる。** 逆にすると空の画面が先に出て、
  // 長い文書（診断結果は表が何十行もある）では流れ込むのが目に見える
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), content);
  await vscode.workspace.applyEdit(edit);

  // **`vscode.open`（既定の割り当て経由）では開かない。** `*.md` に
  // 割り当てられたMarkdownの編集画面が、保存されていない文書を
  // 「実在するファイル」として解決しようとして開けない（作者の実機報告、
  // 2026-08-29「MDファイルが開かないケースが増えています」——執筆再開・
  // マニュアルなど生成文書が全滅した）。生成文書は読むためのものなので、
  // **Markdownのプレビュー（組んだ表示）で開く**。プレビューが使えない
  // 環境では、素のテキストで開く——記法のままでも、開けないよりよい
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    await vscode.window.showTextDocument(document, options);
  }
}

/** 名前に使えない文字。URIの区切りと混ざる */
const UNUSABLE_IN_NAME = /[\\/:?#]/g;

/**
 * 保存されていないMarkdownのURIを作る。
 *
 * **末尾は必ず `.md`。** ここが `Untitled-1` だと、作者が `*.md` へ割り当てた
 * エディターに当たらない——この関数の存在理由そのものである。
 *
 * 同じ名前の文書がすでに開いていると、`openTextDocument` は**その文書を
 * 返す**。そこへ中身を差し込むと、前に見せた内容と混ざる。「反映待ちの更新」は
 * 抽出のたびに出るので、実際に起こりうる。開いているものを避けて番号を振る。
 *
 * @param taken すでに開いている、保存されていない文書の名前
 */
export function untitledMarkdownUri(
  displayName: string,
  taken: readonly string[]
): vscode.Uri {
  const base = displayName.replace(UNUSABLE_IN_NAME, "").trim() || "無題";
  let name = `${base}.md`;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}-${n}.md`;
  // **`paths.toUri()` は使わない。** あれは実在する場所を指すためのもので、
  // ここで欲しいのは保存先を持たない `untitled:` である
  return vscode.Uri.from({ scheme: "untitled", path: name });
}

/** いま開いている、保存されていない文書の名前 */
function openUntitledNames(): string[] {
  return vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === "untitled")
    .map((document) => document.uri.path);
}

/**
 * 言語がMarkdownになっていなければ、明示して直す。
 *
 * `.md` で終わる名前なら普通はVS Codeが自動で付けるので、これは保険である。
 * **中身を入れる前に呼ぶ。** `setTextDocumentLanguage` は文書を開き直すため、
 * 空のうちに済ませておけば中身を失いようがない。
 */
async function ensureMarkdown(document: vscode.TextDocument): Promise<void> {
  if (document.languageId === "markdown") return;
  try {
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
  } catch {
    // 直せなくても文書は開ける。ここで止めるより、見せるほうが用に適う
  }
}

/**
 * その場所を、作者に見せる（設計書5.8.10）。
 *
 * 書き出しやまとめが済んだあとの「フォルダーを開く」に使う。
 *
 * **ブラウザ版では、OSのフォルダーを開けない。** `revealFileInOS` は
 * 手元のVS Codeにしか無いコマンドで、呼ぶと失敗する。かといって
 * ボタンごと消すと、**書き出したものがどこへ行ったのか分からなくなる**
 * ——機能そのものはブラウザでも動いているので、そこだけ行き止まりにしない。
 *
 * 代わりに、VS Code の中のエクスプローラーで在り処を見せる。
 * 開けなかったときは黙って諦める——**もとの用は済んでいる**（書き出しは
 * 成功していて、その旨は先に伝えてある）ので、ここで失敗を重ねて
 * 作者を驚かせない。
 */
export async function revealFolder(location: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      revealCommandFor(canRunProcesses()),
      toUri(location)
    );
  } catch {
    // 在り処は、呼び出し元がすでに文言で伝えている
  }
}

/**
 * 場所を見せるのに使うコマンド名。
 *
 * **`canRunProcesses()` は実行環境そのものを見るので、単体テストからは
 * 片側（常にNode）しか確かめられない。** どちらを選ぶかだけを切り出して、
 * 両方の分岐をテストできるようにする（`providerRuntimeFilter.ts` と同じ手）。
 */
export function revealCommandFor(canRun: boolean): string {
  // `revealFileInOS` は手元のVS Codeにしか無い。
  // ブラウザでは VS Code の中のエクスプローラーで見せる
  return canRun ? "revealFileInOS" : "revealInExplorer";
}
