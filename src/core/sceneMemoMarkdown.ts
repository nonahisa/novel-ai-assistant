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

/** 書き出す文書の呼び名（置き場と掃除は 6.17.7 に乗る） */
export const SCENE_MEMO_TITLE = "シーンメモ";

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
  /** その話の呼び名を引く。引けなければファイル名などを返すこと */
  placeOf(filePath: string): SceneMemoPlace;
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
    const place = input.placeOf(memo.filePath);
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
