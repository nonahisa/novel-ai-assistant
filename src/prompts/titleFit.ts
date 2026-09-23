import { READER_TYPES, type ReaderTypeId } from "../core/readerTarget";
import {
  TITLE_FIT_COMMENT_MAX,
  type TitleFitTarget,
} from "../core/titleFit";

/**
 * P-41 タイトルとサブタイトルのターゲット読者適合度（設計書6.108.6）
 *
 * 作者の指摘③（2026-09-22 未明）：タイトル・サブタイトルの
 * **ターゲット読者適合度**を足す。
 *
 * ## 何を頼み、何を頼まないか
 *
 * - **頼む**：狙いの読者層（無ければ実像の層）に対して、その題が
 *   **引かれる言い方か**の見立て（0〜100）と、その理由の一言
 * - **頼まない**：題の書き換え案。サブタイトルの案は P-07（各話あらすじ）が
 *   読者像を考えて出す（0.75.2）。ここで案まで出させると、2つの機能が
 *   同じ題に別々の案を出す
 * - **頼まない**：題や作品の良し悪し。見立てるのは「その読者層に届く
 *   言い方か」だけで、上手い下手ではない
 *
 * ## 読者層の説明は1つだけ渡す
 *
 * 11の層を全部渡すと、「短く引きの強い題」と「余韻のある題」を両方
 * 褒めてくる（P-38 の `READER_TYPE_PROMPTS` と同じ理由）。渡すのは
 * 測る相手の層1つの名前・一言・効くこと・離れるところだけで、
 * 文は `READER_TYPES` から組む（写しを作らない）。
 *
 * ## 数字は目安
 *
 * 点は順位づけに使わない（設計書6.108.6）。コードは低い順に並べて
 * 「直す候補」を示すだけである。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-41）
 * - 1.0: 初版（0.82.0）。実データでは未確認
 */
export const TITLE_FIT_VERSION = "1.0";

export const TITLE_FIT_SYSTEM_PROMPT = `あなたは、小説のタイトルと各話のサブタイトルが、指定された読者層に「読んでみたい」と思わせる言い方になっているかを見立てる装置です。

【絶対に守る原則】
1. **題や作品の良し悪しを言わないこと。** 上手い・下手ではなく、指定された読者層に届く言い方かどうかだけを見てください。
2. **題の書き換え案を出さないこと。** 見立てと、その理由だけを答えてください。
3. **点数は目安です。** 0〜100の整数で、その読者層が一覧でその題を見たときに開きたくなる度合いを表してください。
4. **渡された題それぞれに、1回だけ答えること。** 渡されていない題を作らないこと。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

export interface TitleFitPromptInput {
  readonly readerType: ReaderTypeId;
  readonly targets: readonly TitleFitTarget[];
}

/** 測る相手の読者層の説明。**この1層だけ**を渡す */
function readerBlock(type: ReaderTypeId): string {
  const info = READER_TYPES[type];
  return [
    `【狙う読者層】${info.label}`,
    info.summary,
    `- この層に効くこと：${info.works}`,
    `- この層が離れるところ：${info.loses}`,
  ].join("\n");
}

export function buildTitleFitPrompt(input: TitleFitPromptInput): string {
  const list = input.targets
    .map((target) => `- ${target.id}（${target.label}）：${target.text}`)
    .join("\n");

  return `次の読者層に対して、下の題それぞれが「読んでみたい」と思わせる言い方になっているかを見立ててください。

${readerBlock(input.readerType)}

【答え方】
- 題ごとに、id・点数（0〜100の整数）・理由を返してください。
- 理由は${TITLE_FIT_COMMENT_MAX}字以内で、その題のどこがこの読者層に届くか、届きにくいかを具体的に書いてください。
- 題の書き換え案は書かないでください。
- 作品の中身は分からなくてかまいません。題の言い方だけで見立ててください。

【題の一覧】（id（場所）：題）
${list}`;
}

/**
 * 受け取る形。
 *
 * **理由の欄の名前は comment にする。** 「一言」をそのまま欄名にすると、
 * 中身として「一言」が返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）。
 * 返りは `core/titleFit.ts` の検算が捨てる。
 */
export const TITLE_FIT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          comment: { type: "string" },
        },
        required: ["id", "score", "comment"],
      },
    },
  },
  required: ["items"],
} as const;
