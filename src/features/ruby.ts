import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import * as path from "../core/paths";
import { isPlainTextManuscript } from "../core/markdownConversion";
import { convertFolder, convertOne } from "./markdownConvert";
import {
  describeSiteNotation,
  findRubyAt,
  fromSiteNotation,
  rubyEditReplacement,
  validateEmphasis,
  validateRuby,
} from "../core/ruby";
import {
  postingCopyTargets,
  type PostingCopyTarget,
} from "../core/postingCopyTargets";
import type { PostingSiteId } from "../models/posting";
import {
  collectedEpisodeAt,
  sourceForPostingCopy,
} from "../core/episodeCopy";
// 合本の見出しの作り方は1か所に置く（写しを作らない）
import { collectedEpisodeLabel } from "./pickCollectedEpisode";
import type { WorkFormatKey } from "../core/workFormat";
// 貼り付け先ごとの分岐は、入口ではなく変換の側に置く（設計書6.84）
import { convertForPosting } from "../core/postingConvert";
import { showPostingCopyNotice } from "./postingCopyNotice";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { notifyDone } from "../views/notify";
// 「本文が見つからない」ときの文言は1か所に置く（`extension.ts` と共用）
import { warnManuscriptNotOpen } from "./manuscriptTab";

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
    /*
      **ここは `TextEditor` が要る。** ルビ・傍点は `editor.edit` を通して
      作者自身の編集として本文へ入れる（だからCtrl+Zで戻せる）。
      VS Code 1.131 の新しいMarkdown編集画面（hybrid Markdown editor）は
      `TextEditor` を持たないので、当て先が無く、ここで断るしかない
      ——ファイルへ直接書けば、画面が抱えている未保存の内容と食い違う。

      断るのは変えないが、**言い方は変える。** 本文を開いている作者に
      「本文を開いてから」と言うと打つ手が無くなるので、状況で文言を分ける
      （`manuscriptNotOpenMessage`）。開くだけの操作（縦書き・横書き・
      組んで書く）はこの制限を受けない。
    */
    warnManuscriptNotOpen();
    return undefined;
  }

  const filePath = fromUri(editor.document.uri);
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
        "中身は1文字も変えず、名前だけを .md に変えます。" +
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
    path.toUri(converted)
  );
  return vscode.window.showTextDocument(document, {
    selection: editor.selection,
  });
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

  /*
    **すでにルビがあるところで押されたら、重ねるのではなく直す**
    （設計書6.34.2）。判定は `findRubyAt` の1か所で、組んで書く面と同じ。
    記法は行をまたがないので、選択が1行に収まっているときだけ見る。

    **編集にするのは、選択が記法の内側に収まっているときだけ。**
    はみ出して選ぶと、編集にすれば選んだ平文が黙って落ち、新規に振れば
    記法が入れ子になる。どちらも原稿を壊すので、そこは何もせずに断る。
  */
  const nearby =
    range.start.line === range.end.line
      ? findRubyAt(
          document.lineAt(range.start.line).text,
          range.start.character,
          range.end.character
        )
      : undefined;
  if (nearby && !nearby.contained) {
    void vscode.window.showInformationMessage(
      "ルビの上には重ねられません。ルビを1つだけ選ぶと読みを直せます。"
    );
    return;
  }
  const editing = nearby;
  if (editing) {
    const target = new vscode.Range(
      range.start.line,
      editing.start,
      range.start.line,
      editing.end
    );
    const reading = await askText({
      title: `「${editing.base}」の読みを直す`,
      prompt: "空にして確定すると、ルビを外します",
      // いまの読みを入れておく。直したいのは多くの場合1文字である
      value: editing.reading,
      placeHolder: "よみがな",
      // **空だけは通す**（ルビを外す道）。それ以外の検算は今までどおり
      validateInput: (value) =>
        value.trim()
          ? (validateRuby(editing.base, value) ?? undefined)
          : undefined,
    });
    // Esc（undefined）は何もしない。空文字は「外す」なので通す
    if (reading === undefined) return;
    await editor.edit((builder) => {
      builder.replace(target, rubyEditReplacement(editing.base, reading));
    });
    return;
  }

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
export async function copyForPosting(
  /**
   * 投稿状態の台帳に登録してある投稿先（設計書6.68.2）。
   * **選択肢の並びを決めるためだけ**に使うので、読めなければ空でよい
   */
  registered: readonly PostingSiteId[] = [],
  /** 見出しの数え方（「第◯話」「◯本目」）。引けなければ渡さない */
  format?: WorkFormatKey
): Promise<void> {
  const editor = await requireMarkdown();
  if (!editor) return;

  const target = await pickPostingTarget(registered);
  if (!target) return;

  const selection = editor.selection;
  /*
    **合本（1ファイルに全話）なら、カーソルの居る話だけを渡す**
    （設計書6.12.1）。以前は全話が区切り行と頭書きごと入っていた。
    いま居る話の決め方は、原稿エディタの「前の話・次の話」と同じ
    規則を通る（`collectedEpisodeAt`）。

    **選んであるときは、いままでどおり選択が優先。** 範囲を選んだのは
    作者の意思であり、話の切れ目より強い。
  */
  const collected = selection.isEmpty
    ? collectedEpisodeAt(editor.document.getText(), selection.active.line + 1)
    : undefined;

  // 選択が無いときは、カクヨム形式の頭書きを外した本文だけを渡す
  // （`sourceForPostingCopy`）——ヘッダーごと貼ると題名が二重に入る。
  // **シーンメモを落とすのは変換の側**（`convertForPosting`）
  // ——noteではコードの中の `//` を落としてはいけないので、
  // 記法を読み分けられるところでだけ落とす
  const source = sourceForPostingCopy(
    editor.document.getText(),
    selection.isEmpty ? undefined : editor.document.getText(selection),
    collected?.body
  );

  /*
    **傍点の有無で、訊かれる回数を変えない**（作者の裁定、2026-09-06）。

    以前は「傍点が入っているときだけ、貼り付け先を訊く」形だった。
    訊いても答えが変わらないなら訊かない、という筋は通っていたが、
    **同じ操作なのに原稿の中身によって手順が変わる**——作者からは
    「なぜ今日は2回訊かれるのか」が分からない。貼り付け先を1度だけ
    訊き、記法はそこから引く。
  */
  const conversion = convertForPosting(source, target);

  await vscode.env.clipboard.writeText(conversion.text);
  // **何をコピーしたかを出す**（設計書6.12.1）。合本は取り違えに
  // その場で気づけるよう、話が分かる言い方にする。**それ以外の文言は
  // 変えない**——覚えている言葉を一緒に変えない
  const scope = !selection.isEmpty
    ? "選んだ範囲"
    : collected
      ? `${collectedEpisodeLabel(collected, format)}（${conversion.text.length.toLocaleString(
          "ja-JP"
        )}字）`
      : "本文全体";
  await showPostingCopyNotice({
    conversion,
    sourcePath: fromUri(editor.document.uri),
    otherwise: () =>
      notifyDone(
        `${scope}を${target.label}の書き方に変換して、` +
          "クリップボードへ入れました。原稿はそのままです。"
      ),
  });
}

/**
 * どこへ貼るかを訊く（設計書6.12.4）。
 *
 * **1段しか訊かない。** サイトを選べば記法も傍点の書き方も決まるので、
 * 記法を先に訊く画面は要らない（`core/postingCopyTargets.ts`）。
 */
export async function pickPostingTarget(
  registered: readonly PostingSiteId[]
): Promise<PostingCopyTarget | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...postingCopyTargets(registered).map((target) => ({
        label: target.label,
        // **上に来ている理由を、その場に出す。** 並びだけを変えると
        // 「なぜこの順なのか」が作者に分からない
        description: target.registered ? "投稿先に登録済み" : "",
        detail: target.detail,
        target,
      })),
      cancelItem(),
    ],
    {
      title: "どこへ貼りますか",
      placeHolder: "選んだ先の書き方に変換して、クリップボードへ入れます",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "target" in picked ? picked.target : undefined;
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
      "投稿サイトのルビ・傍点の記法は見つかりませんでした。"
    );
    return;
  }

  // 何件変わるかを数えて示す。黙って本文を書き換えない
  const answer = await vscode.window.showWarningMessage(
    `${describeSiteNotation(source)}を、この拡張機能の書き方へ直します。よろしいですか。`,
    { modal: true, detail: "取り消し（Ctrl+Z）で元へ戻せます。" },
    "直す"
  );
  if (answer !== "直す") return;

  await editor.edit((builder) => {
    builder.replace(range, converted);
  });
}

/**
 * 選んだ文字に傍点を付ける。
 *
 * **ルビと違い、選択が要る。** ルビは漢字の直後という手がかりがあるが、
 * 傍点は「どこを強調したいか」が作者にしか分からない。
 */
export async function addEmphasis(): Promise<void> {
  const editor = await requireMarkdown();
  if (!editor) return;

  const range = editor.selection;
  if (range.isEmpty) {
    void vscode.window.showInformationMessage(
      "傍点を付ける文字を選んでから実行してください。"
    );
    return;
  }

  const base = editor.document.getText(range);
  const problem = validateEmphasis(base);
  if (problem) {
    void vscode.window.showWarningMessage(problem);
    return;
  }

  await editor.edit((builder) => {
    builder.replace(range, `{{${base}}}`);
  });
}
