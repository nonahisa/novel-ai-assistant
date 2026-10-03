import type { SceneMemo } from "./sceneMemo";

/**
 * シーンメモを、読めるMarkdownの1枚にする（設計書6.40.4）。
 *
 * **Markdownの記法を書く場所を1か所にまとめる**（`chronicleMarkdown.ts`・
 * `foreshadowMarkdown.ts` と同じ置き方）。画面の文言を持つ feature 側へ
 * 記法を混ぜると、そのファイルのすべての文字列が「記号を含んでよいもの」に
 * なってしまう（`plainTextUi.test.ts` が見張っている境目である）。
 *
 * VS Code APIに依らない純粋関数として置く。
 */

/**
 * 書き出す文書の呼び名（置き場と掃除は 6.17.7 に乗る）。見出し・紙の名前
 * （`校正・メモ_<日付>.md`）・片づけの鍵を兼ねる。
 *
 * 画面の名前（校正・メモパネル。0.96.6）に揃えた（作者の裁定、2026-10-03）。
 * 「・」（U+30FB）は Windows・Git・ブラウザ版の置き場のどれでもファイル名に使える
 */
export const SCENE_MEMO_TITLE = "校正・メモ";

/**
 * 前に使っていた呼び名。**片づけのためだけに覚えておく**——新しい名前では
 * 古い名前の写しを拾えず、置き場に残り続けるため（`openGeneratedMarkdown`
 * の `formerKinds`）
 */
export const SCENE_MEMO_FORMER_TITLES: readonly string[] = ["シーンメモ"];

/** 話の呼び名（「第3話」＋題）。どちらも無ければ空でよい */
export interface SceneMemoPlace {
  label: string;
  title: string;
}

export interface SceneMemoMarkdownInput {
  workTitle: string;
  /** 出すメモ。**並びはそのまま使う**（絞り込みも並べ替えも呼び出し側） */
  memos: readonly SceneMemo[];
  /** 作品ぜんたいの件数（絞り込んで減っていることを断るために出す） */
  totalCount: number;
  /**
   * その話の呼び名を引く。引けなければファイル名などを返すこと。
   *
   * **メモ1件を渡す。** 合本（1ファイルに複数話）では、同じファイルの中でも
   * 行によって話が変わるので、ファイル名だけでは引けない。
   */
  placeOf(memo: SceneMemo): SceneMemoPlace;
}

export function sceneMemoToMarkdown(input: SceneMemoMarkdownInput): string {
  const lines: string[] = [`# ${SCENE_MEMO_TITLE}：${input.workTitle}`, ""];

  // **絞り込んだ結果であることを断る。** 件数だけ見て「これで全部」と
  // 読まれると、消し忘れた付箋が残ったまま投稿されかねない
  lines.push(
    input.memos.length === input.totalCount
      ? `メモ ${input.memos.length}件`
      : `メモ ${input.memos.length}件（絞り込み前は ${input.totalCount}件）`,
    ""
  );

  if (input.memos.length === 0) {
    lines.push("（出ているメモはありません）", "");
    return lines.join("\n");
  }

  let section = "";
  for (const memo of input.memos) {
    const place = input.placeOf(memo);
    const heading = [place.label, place.title].filter(Boolean).join(" ");
    if (heading !== section) {
      section = heading;
      lines.push(`## ${heading}`, "");
    }
    const body = memo.text.trim() || "（中身がありません）";
    lines.push(`- ${memo.line}行目：**${memo.tag}** ${body}`);
  }
  lines.push("");
  return lines.join("\n");
}
