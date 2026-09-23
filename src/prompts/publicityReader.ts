import { READER_TYPES } from "../core/readerTarget";
import type { PublicityReader } from "../core/publicityReader";
import { buildReaderTypePrompt } from "./readerTarget";

/**
 * 作品紹介文（P-06）・キャッチコピー（P-08）・更新告知文（P-30）へ添える
 * 「この作品の読者」の塊（設計書6.6.5・6.41.2。作者の問い、2026-09-23）。
 *
 * ## 何を足すか
 *
 * **「その層に届く言い方で」だけを足す。** 中身（何を書くか）は今までの
 * 方針のままで、変えるのは言い方の向き先だけ。サブタイトルの案（P-07 2.1）と
 * 同じ足し方である。
 *
 * ## 塊の組み方は、材料で分ける
 *
 * - **読者像**（狙いが無いとき）：サブタイトルと**同じ部品**
 *   `buildReaderTypePrompt` をそのまま使う（写しを作らない）
 * - **狙い**：その部品は点数（読者像）から組むので、層の名前から組めない。
 *   層ごとの名前・一言・効くこと・離れるところを `READER_TYPES` から組む
 *   （P-41 の適合度と同じ材料。文章をここへ書き写さない）。**選んだ層だけ**
 *   ——11層を並べると、どの層にも効く言い方が決まらない
 *
 * ## 層の名前を文章に書かせない
 *
 * プロンプトには「考察層」と書いて渡すので、**そのまま答えに返ってくる**
 * （CLAUDE.md の失敗3）。条件の行で禁じ、出力は `findReaderTypeLabels` が
 * 見張る（紹介文・告知文は注意、キャッチコピーは落とす）。
 */

/**
 * 条件の欄へ足す1行（塊を添える回だけ）。
 *
 * **行として持つ**（synopsis の `READER_SUBTITLE_RULE` と同じ理由）——
 * 1行の文字列にすると、画面文言の見張り（`plainTextUi.test.ts`）に
 * 「画面へ出す強調」と見なされる。ここはAIへ送るプロンプトである。
 */
export const PUBLICITY_READER_RULE = `- **【この作品の読者】に書かれた読者層に届く言い方を選ぶこと。**
  読者層の呼び名や説明の言葉は、文章に書かないこと（読者が見る文章です）。
`;

/** 狙いの塊の前置き。**この文章そのものを話題にさせない**（6.86 と同じ） */
const AIM_NOTE = `以下は、作者が「この読者に読んでもらいたい」と選んだ読者層です（作者の狙い）。
言い方を選ぶ目安にだけ使ってください。どの読者層にも上下はありません。
この文章そのものを話題にしないでください（読者はこれを見ません）。`;

/** 2つ選んだときの一言。片方へ寄せきると、もう片方の狙いが消える */
const TWO_AIMS_NOTE = "2つとも狙いです。片方に寄せきらず、どちらにも届く言い方を選んでください。";

/**
 * 塊を組む。**材料が無ければ `undefined`**（何も足さない）。
 */
export function buildPublicityReaderPrompt(
  reader: PublicityReader | undefined
): string | undefined {
  if (!reader) return undefined;
  if (reader.source !== "aim") return buildReaderTypePrompt(reader.profile);

  const types = reader.types.map((type) => {
    const info = READER_TYPES[type];
    return [
      info.label,
      info.summary,
      `- この層に効くこと：${info.works}`,
      `- この層が離れるところ：${info.loses}`,
    ].join("\n");
  });
  const reason = reader.reason.trim();

  return [
    "【この作品の読者】",
    AIM_NOTE,
    "",
    types.join("\n\n"),
    ...(types.length > 1 ? ["", TWO_AIMS_NOTE] : []),
    // **作者の理由はそのまま渡す**（作者の文。言い方を選ぶ手がかりになる）
    ...(reason ? ["", `作者が挙げた理由：${reason}`] : []),
  ].join("\n");
}

/**
 * 各プロンプトが使う、条件の1行と塊の組。無ければどちらも空文字。
 *
 * 3つのプロンプトで同じ置き方にするため、ここで1回だけ組む。
 */
export function publicityReaderSections(reader: PublicityReader | undefined): {
  rule: string;
  block: string;
} {
  const block = buildPublicityReaderPrompt(reader);
  return block
    ? { rule: PUBLICITY_READER_RULE, block: `\n${block}\n` }
    : { rule: "", block: "" };
}
