import { toNoteMarkdown, type NoteMarkdownResult } from "./noteMarkdown";
import type { PostingCopyTarget } from "./postingCopyTargets";
import { toSiteNotation } from "./ruby";
import { stripMemoLines } from "./sceneMemo";

/**
 * 「投稿サイト用に変換してコピー」の変換（設計書6.84）。
 *
 * ## 入口は3つ、変換は1つ
 *
 * 普通のエディタ（`features/ruby.ts`）・作品一覧の右クリック
 * （`features/episodeCopy.ts`）・原稿エディタ（`features/manuscriptEditor.ts`）が
 * 同じ関数を通る。**貼り付け先ごとの分岐を入口に書かない**——書くと、
 * noteへ貼ったときの形が入口によって違う、という直しにくい食い違いになる。
 *
 * ## noteだけ、記法の変換では足りない
 *
 * ほかの3サイトは「ルビと傍点をその site の書き方へ直す」だけで済む。
 * noteは**Markdownをそのまま解釈する**ので、noteが持っている形へ
 * 整え直す必要がある（見出しの段・引用の空行・埋め込み・画像の目印）。
 * その整えは `noteMarkdown.ts` が持ち、ここはどちらを通すかだけを決める。
 *
 * VS Code APIには依存しない。
 */

export interface PostingConversion {
  /** クリップボードへ入れるもの */
  text: string;
  /**
   * noteへ貼るときだけ付く、貼り付けでは入らないものの控え。
   * **知らせの文面はこれで変わる**（画像・埋め込み・題名）
   */
  note?: NoteMarkdownResult;
}

/**
 * 本文を、選んだ貼り付け先の形にする。
 *
 * **シーンメモはここで落とす**（設計書6.40.2）。入口が3つあるので、
 * 落とす場所を入口に置くと、いつか1つだけ抜ける。
 *
 * **前後の空行も落とす。** 投稿欄の先頭に空行が入ると、サイトによっては
 * 1行目が空いた状態で公開される。
 */
export function convertForPosting(
  source: string,
  target: PostingCopyTarget
): PostingConversion {
  if (target.site === "note") {
    // **メモを先に落とさない。** コードの中の `//` は付箋ではないので、
    // コードを読み分けられる `toNoteMarkdown` に任せる
    const note = toNoteMarkdown(source);
    return { text: note.body, note };
  }

  return {
    text: toSiteNotation(
      stripMemoLines(source),
      target.style,
      target.emphasis
    )
      .replace(/^\n+/, "")
      .replace(/\n+$/, ""),
  };
}

/**
 * noteへコピーしたあとの知らせ（設計書6.81の規則3）。
 *
 * **貼り付けでは入らないものを、その場で言う。** noteは本文だけを
 * 受け取るので、題名・画像・目次は作者が手で入れることになる。貼ってから
 * 気づくと、何が抜けたのかを探すところからやり直しになる。
 *
 * @param length クリップボードへ入れた字数
 */
export function noteCopyMessage(
  note: NoteMarkdownResult,
  length: number
): string {
  const parts = [
    `note用に整えてコピーしました（${length.toLocaleString("ja-JP")}字）。`,
  ];

  if (note.images.length > 0) {
    parts.push(
      `画像${note.images.length}枚は貼り付けでは入りません` +
        "（【画像：…】の行の位置へアップロードしてください）。"
    );
  }
  if (note.embeds.length > 0) {
    parts.push(
      `埋め込み${note.embeds.length}件は、URLの行末でEnterを押すと展開されます。`
    );
  }
  // **目次は毎回言う。** noteの目次は編集画面のスイッチで、本文には無い
  parts.push("目次は編集画面のスイッチで入れられます。");
  parts.push(...note.warnings);

  return parts.join("");
}
