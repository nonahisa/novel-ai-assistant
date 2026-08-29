import * as vscode from "vscode";
import * as path from "../core/paths";
import { canRunProcesses } from "../core/runtime";
import { logFailure } from "../core/logger";
import {
  GENERATED_DIR,
  pruneGeneratedFiles,
  sanitizeNamePart,
  writeGeneratedFile,
} from "../core/generatedFiles";
import { workPaths } from "../core/workRegistry";
import type { WorkEntry } from "../models/types";

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
    path.toUri(filePath),
    options
  );
}

/**
 * 拡張機能の保管庫にある、作品に属さない生成文書の置き場。
 *
 * `extension.ts` の起動時に一度だけ登録する（`core/logger.ts` の
 * `useLogFile` と同じ形）。**各所へ `ExtensionContext` を持ち回らない**
 * ——生成文書を開く場面は8か所あり、そのすべてに引数を1つ足すのは、
 * この機能と関係のないところまで書き換えることになる。
 */
let generatedStorageRoot: string | undefined;

export function setGeneratedStorageRoot(root: vscode.Uri): void {
  generatedStorageRoot = path.fromUri(root);
}

/**
 * その場で作ったMarkdownを、実ファイルとして置いて開く（設計書6.17.7）。
 *
 * 執筆再開の1枚・使い方・冒頭診断・伏線の一覧・反映待ちの更新・
 * IME辞書の取り込み手順・セットアップの内訳・ブラウザ版の診断に使う。
 *
 * ## なぜ無題文書をやめたか
 *
 * もとは `untitled:反映待ちの更新.md` という**名前だけの空の文書**を作り、
 * 中身を差し込んで見せていた（6.17.6）。作者が `*.md` へ割り当てた
 * 編集画面がそれを「実在するファイル」として解決しようとして開けず
 * （実機報告、2026-08-29）、いったんMarkdownのプレビューへ逃がしたが、
 * 副作用が3つ残った。
 *
 * - VS Code を閉じるとき、見た覚えのない文書について保存を聞かれる
 *   （プレビューしか見せていないので、未保存の文書がタブに現れない）
 * - 2枚目を開くと1枚目のプレビューが入れ替わる（プレビューは1枚を使い回す）
 * - 「〇〇-2.md」「〇〇-3.md」と名前がずれていく（隠れた文書が残り続ける）
 *
 * **実ファイルにすれば3つとも消える。** 実在するので割り当ても素直に通り、
 * `preview: false`（タブを残す）の指定も効く。代わりに溜まるので、
 * 書くたびに古いものを消す（`core/generatedFiles.ts`）。
 *
 * ## 置き場と、書けなかったときの逃げ道
 *
 * 作品が分かるなら `作品/.aiwriter/generated/`、分からないなら
 * 拡張機能の保管庫。どちらも使えないとき、あるいは書き込みに失敗した
 * ときは、**従来どおり無題文書で見せる**。読み物が読めなくなるより、
 * 副作用のある形でも開くほうがましである。
 *
 * **`.aiwriter/generated/` はまだGitの除外規則に入っていない**
 * （`workRegistry.ts` の `IGNORED_PATHS` に入っているのは `cache/`・
 * `logs/`・`exports/` だけ）。作り直せる読み物をGitへ載せない方針
 * （6.17.7）に合わせるなら、そこへ1行足す必要がある。
 *
 * @param displayName タブに出る名前。**ファイル名の前置き（種類）にもなる**
 *   ので、作品名のような一回ごとに変わる語を混ぜない（置き場が作品ごとに
 *   分かれているので、そもそも要らない）
 * @param location 作品が分かるなら渡す。渡さないと保管庫へ置く
 */
export async function openGeneratedMarkdown(
  displayName: string,
  content: string,
  options?: vscode.TextDocumentShowOptions,
  location?: { work?: WorkEntry }
): Promise<void> {
  const directory = generatedDirectoryFor(location?.work);
  if (directory) {
    try {
      const target = await writeGeneratedFile(directory, displayName, content);
      await pruneGeneratedFilesQuietly(directory, displayName);
      await openInDefaultEditor(target, options);
      return;
    } catch (error) {
      // 書けない置き場（権限・容量・ブラウザ版の保管庫）でも読めるように、
      // 下の無題文書へ落ちる。**理由は残す**——黙って形が変わると、
      // 「なぜかタブが増えない」という追いにくい報告になる
      logFailure("生成文書の書き出し", {
        種類: displayName,
        置き場: directory,
        理由: messageOf(error),
      });
    }
  }

  await openUntitledMarkdown(displayName, content, options);
}

/** 生成文書の置き場。作品が分かればその中、分からなければ保管庫 */
function generatedDirectoryFor(work?: WorkEntry): string | undefined {
  if (work) return path.join(workPaths(work).aiwriter, GENERATED_DIR);
  return generatedStorageRoot;
}

/**
 * 古い生成文書を片付ける。**失敗しても開く処理は止めない。**
 *
 * 片付けは作者の用ではない。ここで投げると、読むために開いた文書が
 * 出てこなくなる
 */
async function pruneGeneratedFilesQuietly(
  directory: string,
  kind: string
): Promise<void> {
  try {
    await pruneGeneratedFiles(directory, kind);
  } catch (error) {
    logFailure("生成文書の整理", {
      種類: kind,
      置き場: directory,
      理由: messageOf(error),
    });
  }
}

/**
 * 実ファイルとして置けなかったときの逃げ道。
 *
 * `openTextDocument({content, language})` では名前を付けられず
 * （`Untitled-1` になる）、`*.md` の割り当てに当たらない。名前だけの
 * 空の文書を先に作って、中身を差し込む。
 */
async function openUntitledMarkdown(
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

  // 無題文書は `vscode.open` では開けない（実在するファイルとして
  // 解決しようとして失敗する）。素のテキストで開く
  await vscode.window.showTextDocument(document, options);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 * 名前に使えない文字の落とし方は `core/generatedFiles.ts` と共用する
 * （実ファイルと無題文書で規則がずれると、片方だけ通る名前が生まれる）。
 *
 * @param taken すでに開いている、保存されていない文書の名前
 */
export function untitledMarkdownUri(
  displayName: string,
  taken: readonly string[]
): vscode.Uri {
  const base = sanitizeNamePart(displayName);
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
      path.toUri(location)
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
