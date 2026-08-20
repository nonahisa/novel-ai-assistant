import * as vscode from "vscode";
import * as path from "path";
import {
  describeRefusal,
  isPlainTextManuscript,
  planConversion,
  planFolderConversion,
  type ConversionPlan,
} from "../core/markdownConversion";
import {
  fromSiteNotation,
  RUBY_STYLES,
  toSiteNotation,
  validateRuby,
  type RubyStyle,
} from "../core/ruby";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * ルビの操作（設計書6.12）。
 *
 * **対象は `.md` だけ。** txtはルビ機能の対象外と決まっている（要求仕様）。
 * 投稿サイトのダウンロード形式をそのまま置いている作者が多く、そこへ
 * 独自記法を混ぜると、元の場所へ戻せなくなる。
 *
 * **本文を書き換えるのは「ルビを振る」だけ。** それも作者自身の編集操作で、
 * `editor.edit` を通すので取り消し（Ctrl+Z）が効く。
 * 投稿サイト向けの変換は**クリップボードへ出すだけ**で、原稿には触らない。
 */

/**
 * `.md` を編集中かを確かめる。
 *
 * **`.txt` なら、断るだけで終わらせない。** 作者は「ルビを振りたい」と
 * 思って押している。使えない理由と、使えるようにする道を同時に出す。
 */
async function requireMarkdown(): Promise<vscode.TextEditor | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(
      "本文のファイルを開いてから実行してください。"
    );
    return undefined;
  }

  const filePath = editor.document.uri.fsPath;
  if (filePath.toLowerCase().endsWith(".md")) return editor;

  if (!isPlainTextManuscript(filePath)) {
    void vscode.window.showWarningMessage(
      "ルビはMarkdown（.md）のファイルで使えます。"
    );
    return undefined;
  }

  const answer = await vscode.window.showWarningMessage(
    "ルビはMarkdown（.md）でしか使えません。",
    {
      modal: true,
      detail:
        "テキスト（.txt）は投稿サイトから持ってきた形をそのまま保つため、" +
        "ルビの対象外にしています。\n\n" +
        "**中身は1文字も変えず、名前だけを .md に変えます。**" +
        "文字コードも改行も、書いた本文もそのままです。\n" +
        "取り消したくなったら、名前を .txt に戻すだけで元どおりです。",
    },
    "このファイルを .md にする",
    "このフォルダーの .txt をまとめて .md にする"
  );
  if (!answer) return undefined;

  const converted =
    answer === "このファイルを .md にする"
      ? await convertOne(filePath)
      : await convertFolder(filePath);
  if (!converted) return undefined;

  // 変換した .md を開き直す。作者は続きを書こうとしている
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(converted)
  );
  return vscode.window.showTextDocument(document, {
    selection: editor.selection,
  });
}

/** 同じフォルダーにある名前の一覧（拡張子込み） */
async function siblingNames(filePath: string): Promise<string[]> {
  const dir = vscode.Uri.file(path.dirname(filePath));
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
async function convertOne(filePath: string): Promise<string | undefined> {
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
  void vscode.window.showInformationMessage(
    `${path.basename(filePath)} を ${path.basename(decision.plan.to)} にしました。`
  );
  return decision.plan.to;
}

/** フォルダーの .txt をまとめて変換する。もとのファイルに当たる変換後のパスを返す */
async function convertFolder(filePath: string): Promise<string | undefined> {
  const dir = path.dirname(filePath);
  const names = await siblingNames(filePath);
  const targets = names
    .filter((name) => isPlainTextManuscript(name))
    .map((name) => path.join(dir, name))
    .sort();

  const { plans, skipped } = planFolderConversion(targets, names);
  if (plans.length === 0) {
    void vscode.window.showWarningMessage(
      "変換できる .txt がありませんでした。"
    );
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

  const notes = [`${done.length}件を .md にしました。`];
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
  if (failed.length > 0) notes.push(`${failed.length}件は失敗：${failed.join("、")}`);
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
async function renamePreservingContent(plan: ConversionPlan): Promise<void> {
  await vscode.workspace.fs.rename(
    vscode.Uri.file(plan.from),
    vscode.Uri.file(plan.to),
    // **上書きしない。** 既にあるなら planConversion が止めているが、
    // その後に作られている場合もある
    { overwrite: false }
  );
}

/**
 * 選択した文字にルビを振る。
 *
 * 選択が無ければ、カーソルの前にある漢字のまとまりを拾う。
 * **いちいち選択させない。** 書いている流れの中で使うものなので。
 */
export async function addRuby(): Promise<void> {
  const editor = await requireMarkdown();
  if (!editor) return;

  const document = editor.document;
  let range: vscode.Range = editor.selection;
  if (range.isEmpty) {
    const line = document.lineAt(range.start.line).text;
    const before = line.slice(0, range.start.character);
    // 直前の漢字（々・ヶも含む）のまとまり
    const match = before.match(/[\u4E00-\u9FFF\u3005々ヶ]+$/u);
    if (!match) {
      void vscode.window.showInformationMessage(
        "ルビを振る文字を選んでから実行してください。" +
          "（漢字の直後なら、選ばなくても拾います）"
      );
      return;
    }
    range = new vscode.Range(
      range.start.line,
      range.start.character - match[0].length,
      range.start.line,
      range.start.character
    );
  }

  const base = document.getText(range);
  const reading = await askText({
    title: `「${base}」の読み`,
    prompt: "ひらがな・カタカナで入力してください",
    placeHolder: "よみがな",
    validateInput: (value) => validateRuby(base, value) ?? undefined,
  });
  if (!reading) return;

  await editor.edit((builder) => {
    builder.replace(range, `{${base}|${reading.trim()}}`);
  });
}

/**
 * 投稿サイト用に変換してクリップボードへ。
 *
 * **原稿には触らない。** 貼り付ける先はサイトの投稿欄であって、
 * 手元の原稿を投稿サイト記法へ変えてしまうと、次に書くときに困る。
 */
export async function copyForPosting(): Promise<void> {
  const editor = await requireMarkdown();
  if (!editor) return;

  const style = await pickStyle();
  if (!style) return;

  const selection = editor.selection;
  const source = selection.isEmpty
    ? editor.document.getText()
    : editor.document.getText(selection);
  const converted = toSiteNotation(source, style.id);

  await vscode.env.clipboard.writeText(converted);
  const scope = selection.isEmpty ? "本文全体" : "選んだ範囲";
  void vscode.window.showInformationMessage(
    `${scope}を${style.label}に変換して、クリップボードへ入れました。` +
      "原稿はそのままです。"
  );
}

/**
 * 投稿サイトの記法を取り込む。
 *
 * すでにサイトへ投稿した原稿を持ち込んだときに使う。
 * **本文を書き換えるので、何件変わるかを先に見せる。**
 */
export async function importRuby(): Promise<void> {
  const editor = await requireMarkdown();
  if (!editor) return;

  const selection = editor.selection;
  const range = selection.isEmpty
    ? new vscode.Range(
        0,
        0,
        editor.document.lineCount - 1,
        editor.document.lineAt(editor.document.lineCount - 1).text.length
      )
    : selection;
  const source = editor.document.getText(range);
  const converted = fromSiteNotation(source);

  if (converted === source) {
    void vscode.window.showInformationMessage(
      "投稿サイトのルビ記法は見つかりませんでした。"
    );
    return;
  }

  // 何件変わるかを数えて示す。黙って本文を書き換えない
  const count =
    (converted.match(/\{[^{}|\r\n]+\|[^{}|\r\n]*\}/g) ?? []).length -
    (source.match(/\{[^{}|\r\n]+\|[^{}|\r\n]*\}/g) ?? []).length;
  const answer = await vscode.window.showWarningMessage(
    `${count}件のルビを ｛漢字｜かんじ｝ の形へ直します。よろしいですか。`,
    { modal: true, detail: "取り消し（Ctrl+Z）で元へ戻せます。" },
    "直す"
  );
  if (answer !== "直す") return;

  await editor.edit((builder) => {
    builder.replace(range, converted);
  });
}

async function pickStyle(): Promise<RubyStyle | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...RUBY_STYLES.map((style) => ({
        label: style.label,
        detail: style.detail,
        style,
      })),
      cancelItem(),
    ],
    {
      title: "どの形で書き出しますか",
      placeHolder: "投稿する先に合わせて選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "style" in picked ? picked.style : undefined;
}
