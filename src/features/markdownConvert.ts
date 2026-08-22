import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import {
  describeRefusal,
  isPlainTextManuscript,
  planConversion,
  planFolderConversion,
  type ConversionPlan,
} from "../core/markdownConversion";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { pathExists } from "../core/fileSystem";
import {
  readTextFile,
  writeTextFilePreservingFormat,
  type WriteTextFileResult,
} from "../core/textFile";
import { countSiteNotation, fromSiteNotation } from "../core/ruby";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 本文の `.txt` を `.md` にする（設計書6.12.1）。
 *
 * **中身は1文字も変えない。名前だけを変える。** 文字コードも改行も、
 * 書いた本文もそのまま残る。Markdownとして書き換えると（見出しを付ける、
 * 空行を詰めるなど）、それは原稿の改変になる。
 *
 * ## 入口を独立させた理由
 *
 * **もとは「ルビを振る」を押したときにだけ現れる救済の道だった。**
 * `.txt` でルビを使おうとした作者へ「ルビは .md でしか使えません」と
 * 断ったうえで、その場で変換を申し出る形である。
 *
 * **しかしMD化したい理由はルビだけではない**（プレビューで読みたい、
 * 見出しを使いたい）。作者から「どこから操作すればいいのでしょうか？」と
 * 訊かれた（2026-08-22）——**機能はあるのに辿り着けない**、
 * GitHubへ載せる入口と同じ形の抜けだった（5.7.9）。
 */

/** 同じフォルダーにある名前の一覧（拡張子込み） */
export async function siblingNames(filePath: string): Promise<string[]> {
  const dir = path.toUri(path.dirname(filePath));
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([, kind]) => kind === vscode.FileType.File)
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** 1件だけ変換する。変換後のパスを返す */
export async function convertOne(
  filePath: string
): Promise<string | undefined> {
  const decision = planConversion(filePath, await siblingNames(filePath));
  if (!decision.plan) {
    void vscode.window.showErrorMessage(
      `変換できませんでした。${describeRefusal(decision.refusal!)}`
    );
    return undefined;
  }
  try {
    await renamePreservingContent(decision.plan);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `変換できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
  // **名前を変えたら、中のルビ・傍点も直す**（設計書6.12.4）
  const imported = await importNotation(decision.plan.to);
  void vscode.window.showInformationMessage(
    `${path.basename(filePath)} を ${path.basename(decision.plan.to)} にしました。` +
      describeImported([imported])
  );
  return decision.plan.to;
}

/** フォルダーの .txt をまとめて変換する。もとのファイルに当たる変換後のパスを返す */
export async function convertFolder(
  filePath: string
): Promise<string | undefined> {
  const dir = path.dirname(filePath);
  const names = await siblingNames(filePath);
  const targets = names
    .filter((name) => isPlainTextManuscript(name))
    .map((name) => path.join(dir, name))
    .sort();

  const { plans, skipped } = planFolderConversion(targets, names);
  if (plans.length === 0) {
    void vscode.window.showWarningMessage("変換できる .txt がありませんでした。");
    return undefined;
  }

  const done: string[] = [];
  const failed: string[] = [];
  for (const plan of plans) {
    try {
      await renamePreservingContent(plan);
      done.push(plan.to);
    } catch (error) {
      // **1件失敗しても残りは進める。** 途中で止めると、
      // どこまで終わったのかが作者に分からない
      failed.push(
        `${path.basename(plan.from)}（${
          error instanceof Error ? error.message : String(error)
        }）`
      );
    }
  }

  // **名前を変えたら、中のルビ・傍点も直す**（設計書6.12.4）
  const imported = [];
  for (const target of done) imported.push(await importNotation(target));

  const notes = [`${done.length}件を .md にしました。` + describeImported(imported)];
  if (skipped.length > 0) {
    notes.push(
      `${skipped.length}件は見送りました：` +
        skipped
          .map(
            (entry) =>
              `${path.basename(entry.file)}（${describeRefusal(entry.refusal)}）`
          )
          .join("、")
    );
  }
  if (failed.length > 0) {
    notes.push(`${failed.length}件は失敗：${failed.join("、")}`);
  }
  void vscode.window.showInformationMessage(notes.join(" "));

  const mine = plans.find((plan) => plan.from === filePath);
  return mine?.to ?? done[0];
}

/**
 * 名前だけを変える。
 *
 * **中身を読み書きしない。** 読んで書き直すと、文字コードや改行の
 * 扱いを1つ間違えただけで原稿が壊れる。名前を変えるだけなら、
 * 中身に触れる余地がそもそも無い。
 */
export async function renamePreservingContent(
  plan: ConversionPlan
): Promise<void> {
  await vscode.workspace.fs.rename(path.toUri(plan.from), path.toUri(plan.to), {
    // **上書きしない。** 既にあるなら planConversion が止めているが、
    // その後に作られている場合もある
    overwrite: false,
  });
}

/**
 * すでに入っているルビ・傍点を、この拡張機能の書き方へ直す（設計書6.12.4）。
 *
 * 作者の指示（2026-08-23）：「テキスト形式の中にルビや傍点がすでにある
 * ときは、MD形式に変換してください」。
 *
 * **投稿サイトから持ってきた本文には、すでに `｜漢字《かんじ》` が入って
 * いる。** 名前を `.md` に変えただけでは、プレビューでルビとして表示されず、
 * 「ルビを振る」の対象にもならない。**MD化の意味が半分しかない。**
 *
 * ## ここだけは中身を書き換える
 *
 * 名前を変えるだけの処理（`renamePreservingContent`）と違い、本文の
 * バイトが変わる。だから**原稿を守る手順をそのまま通す**——
 * 読み込み時のハッシュを照合し、文字コードと改行を保って書き戻す
 * （`writeTextFilePreservingFormat`。設計書5.4.1）。
 *
 * @returns 直した件数。0なら書き込んでいない
 */
export async function importNotation(
  filePath: string
): Promise<{ ok: boolean; ruby: number; emphasis: number; reason?: string }> {
  let content;
  try {
    content = await readTextFile(filePath);
  } catch (error) {
    return {
      ok: false,
      ruby: 0,
      emphasis: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const counts = countSiteNotation(content.text);
  if (counts.ruby === 0 && counts.emphasis === 0) {
    return { ok: true, ruby: 0, emphasis: 0 };
  }

  const converted = fromSiteNotation(content.text);
  if (converted === content.text) return { ok: true, ruby: 0, emphasis: 0 };

  const result = await writeTextFilePreservingFormat(
    filePath,
    converted,
    content,
    content.hash
  );
  if (!result.ok) {
    return { ok: false, ruby: 0, emphasis: 0, reason: describeWriteFailure(result) };
  }
  return { ok: true, ruby: counts.ruby, emphasis: counts.emphasis };
}

/**
 * 直したルビ・傍点の件数を、報告へ添える。
 *
 * **0件なら何も足さない。** ルビの入っていない本文で「ルビ0件」と
 * 出しても、読ませるだけ無駄である。
 */
function describeImported(
  results: ReadonlyArray<{
    ok: boolean;
    ruby: number;
    emphasis: number;
    reason?: string;
  }>
): string {
  const ruby = results.reduce((total, entry) => total + entry.ruby, 0);
  const emphasis = results.reduce((total, entry) => total + entry.emphasis, 0);
  const failed = results.filter((entry) => !entry.ok);

  const parts: string[] = [];
  if (ruby > 0) parts.push(`ルビ${ruby}件`);
  if (emphasis > 0) parts.push(`傍点${emphasis}件`);

  const notes: string[] = [];
  if (parts.length > 0) {
    notes.push(`${parts.join("と")}を、この拡張機能の書き方へ直しました。`);
  }
  if (failed.length > 0) {
    // **黙って諦めない。** 名前は変わったのに中身が直っていない状態なので、
    // 作者は「ルビを取り込む」を自分で押す必要がある
    notes.push(
      `${failed.length}件は中の記法を直せませんでした（${
        failed[0].reason ?? "理由なし"
      }）。「投稿サイトのルビを取り込む」からやり直せます。`
    );
  }
  return notes.length > 0 ? ` ${notes.join(" ")}` : "";
}

function describeWriteFailure(result: WriteTextFileResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "unsaved_changes":
      return "開いたまま直していない変更があります（保存してからお試しください）";
    case "conflict_markers":
      return "競合の印（<<<<<<<）が残っています";
    case "modified_externally":
      return "読み込んだあとに、他の場所から変更されました";
    default:
      return result.detail ?? "書き込めませんでした";
  }
}

/**
 * 操作メニューから呼ぶ。**何を対象にするかを、まず決める。**
 *
 * ファイルを右クリックしたときは対象が決まっているので訊かない
 * （`convertOne` を直に呼ぶ）。メニューから押したときは、いま開いている
 * 1件なのか本文まるごとなのかが分からないので、そこだけ選んでもらう。
 */
export async function convertToMarkdown(work: WorkEntry): Promise<boolean> {
  const active = vscode.window.activeTextEditor;
  const activePath = active ? fromUri(active.document.uri) : undefined;
  const activeIsText = activePath
    ? isPlainTextManuscript(activePath)
    : false;

  const folder = await manuscriptFolder(work);
  const count = await countPlainText(folder);

  const items: Array<
    vscode.QuickPickItem & { choice?: "folder" | "one" }
  > = [];

  if (count > 0) {
    items.push({
      label: "$(files) この作品の本文をまとめて .md にする",
      description: `${count}件`,
      detail: `${folder} の中の .txt が対象です`,
      choice: "folder",
    });
  }
  if (activeIsText && activePath) {
    items.push({
      label: "$(file) いま開いているファイルだけ .md にする",
      description: path.basename(activePath),
      detail: activePath,
      choice: "one",
    });
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "変換できる .txt が見つかりませんでした。本文がすでに .md か、本文フォルダーが空です。"
    );
    return false;
  }

  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { choice?: "folder" | "one" }
  >([...items, cancelItem()], {
    title: "本文を .md にする",
    placeHolder: "中身は変えず、名前だけを .md に変えます",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !picked.choice) return false;

  if (picked.choice === "one" && activePath) {
    return Boolean(await convertOne(activePath));
  }

  // **まとめて変えるときは、件数を見せてから確認する。**
  // 名前が変わるとGitからは「消して作った」に見えるので、
  // 何件動くのかを知らせてから実行する
  const answer = await vscode.window.showWarningMessage(
    `${count}件の .txt を .md にしますか？`,
    {
      modal: true,
      detail: [
        "中身は1文字も変えません。文字コードも改行もそのままです。",
        "戻したくなったら、名前を .txt に戻すだけで元どおりです。",
        "",
        "同じ名前の .md がすでにあるものは、上書きせずに飛ばします。",
      ].join("\n"),
    },
    "変換する"
  );
  if (answer !== "変換する") return false;

  // フォルダーの中の1件を起点にすれば、そのフォルダーがまるごと対象になる
  const names = await vscode.workspace.fs.readDirectory(path.toUri(folder));
  const first = names.find(
    ([name, kind]) =>
      kind === vscode.FileType.File && isPlainTextManuscript(name)
  );
  if (!first) return false;
  return Boolean(await convertFolder(path.join(folder, first[0])));
}

/**
 * 本文の置き場。
 *
 * **本文フォルダーが無ければ、作品フォルダーの直下を見る**
 * （`scanner.ts` と同じ扱い。話数ファイルを直に置く作者がいる）。
 */
async function manuscriptFolder(work: WorkEntry): Promise<string> {
  let config;
  try {
    config = await readWorkConfig(work);
  } catch {
    config = undefined;
  }
  const paths = workPaths(work, config);
  return (await pathExists(paths.manuscript)) ? paths.manuscript : paths.root;
}

async function countPlainText(folder: string): Promise<number> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      path.toUri(folder)
    );
    return entries.filter(
      ([name, kind]) =>
        kind === vscode.FileType.File && isPlainTextManuscript(name)
    ).length;
  } catch {
    return 0;
  }
}
