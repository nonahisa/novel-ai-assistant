/**
 * 相談の会話を、あとから読める形（Markdown）にする。
 *
 * **相談パネルの会話は、閉じると消える。** 「最初から」を押しても消える。
 * 実際に使ってみると、いい案が出た回ほど残しておきたくなるのに、
 * 手で写すしかなかった（作者の要望、2026-08-28）。
 *
 * ここは**組み立てだけ**を持つ。VS Code API に触れないので単体テストできる。
 * 実際の保存（置き場所を決める・新規作成で書く）は `workChatPanel.ts` が行う。
 *
 * `.aiwriter/logs/chat.md`（`chatLog.ts`）とは目的が違う。あちらは
 * **開発のための記録**で、Git除外の場所へ機械的に積む。こちらは
 * **作者が読み返すためのメモ**なので、設定フォルダーの中に、
 * 作者が選んだときだけ作る。
 */

import {
  formatDayTime,
  timestampedFileNameCandidates,
  TIMESTAMPED_NAME_TRIES,
} from "./timestampedFileName";

/**
 * 1往復の発言。
 *
 * `prompts/workChat.ts` の `WorkChatTurn` と同じ形だが、**こちらから
 * `prompts` を参照しない**（依存の向きは views/features → core → models）。
 * 構造が同じなので、呼び出し側はそのまま渡せる。
 */
export interface ChatNoteTurn {
  role: "author" | "assistant";
  text: string;
}

export interface ChatNoteMeta {
  workTitle: string;
  savedAt: Date;
}

/** 同名を避けるために試す名前の数。これを超えることは実際には起きない */
export const CHAT_NOTE_NAME_TRIES = TIMESTAMPED_NAME_TRIES;

/** 相談メモの置き場所（設定フォルダーからの相対） */
export const CHAT_NOTE_DIR = "相談メモ";

/**
 * 会話をMarkdownにする。
 *
 * **話者を見出しにする。** 引用（`>`）で畳むやり方も試せるが、
 * 相談の返事はそれ自体がMarkdown（箇条書き・強調）で返ってくるので、
 * 引用の中へ入れると読みにくくなる。見出しで区切って、本文はそのまま置く。
 *
 * 履歴が空でも壊れない（見出しだけのメモになる）。**空のときに
 * 保存するかどうかは呼び出し側が決める**——ここで例外を投げると、
 * 「まだ会話がありません」と穏やかに伝える道が塞がる。
 */
export function buildChatNoteMarkdown(
  turns: readonly ChatNoteTurn[],
  meta: ChatNoteMeta
): string {
  const lines: string[] = [
    "# 相談メモ",
    "",
    `- 作品: ${meta.workTitle}`,
    `- 保存: ${formatDayTime(meta.savedAt)}`,
    "",
    "---",
    "",
  ];

  for (const turn of turns) {
    lines.push(turn.role === "author" ? "## あなた" : "## AI", "");
    lines.push(turn.text.trim(), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 保存先の名前の候補を、試す順に並べる。
 *
 * 規則そのものは `timestampedFileName.ts` にある。**印刷用HTMLの
 * 書き出しも同じ規則を要る**ので、名前の作り方は1か所に置いた。
 */
export function chatNoteFileNameCandidates(
  savedAt: Date,
  tries: number = CHAT_NOTE_NAME_TRIES
): string[] {
  return timestampedFileNameCandidates("相談", savedAt, ".md", tries);
}
