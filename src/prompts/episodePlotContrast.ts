/**
 * P-28 単話プロットと本文の照合（設計書6.36.3）。
 *
 * 作者の指定：「展開の箇条書きレベル→書かれた箇条書きに対する矛盾検知」。
 *
 * ## P-11（プロット逸脱）との違い
 *
 * **物差しが違う。** P-11 は作品全体のプロット（`plot.md`）を相手にして
 * 「主筋から外れていないか」を見るので、プロットに無い展開でも伏線や
 * 掘り下げなら指摘しない。こちらの物差しは**その話の箇条書き**で、
 * 作者が「この話でこれを起こす」と決めたものと、実際に書いた本文が
 * 揃っているかだけを見る。だから、
 *
 *   - 主筋に効いているかどうかは判断しない（それは P-11 の仕事）
 *   - 箇条書きに無いことが起きていたら、良し悪しを言わずに並べる
 *     （**箇条書きのほうが古いこともある**。プロット逸脱と同じ）
 *
 * **書き直しの作文はさせない**（6.36.3）。修正案の欄を持たない。
 *
 * ## 見本の値の選び方
 *
 * P-27 と同じ分け方（`episodePlotCheck.ts` の説明を参照）。
 *
 *   - `plotItem` の見本は**実在する箇条書きの1行**（そのまま返っても、
 *     実在の行を指しただけになる）
 *   - `excerpt`・`reason` の見本は**項目の言い換え**。引用は本文との
 *     逐語照合で、理由はヒント語との突き合わせで、それぞれ弾かれる
 *
 * **行番号は言わせない。** どこの行かは引用から機械的に求まる
 * （`core/episodePlotValidation.ts`）。求まる値をAIに書かせると、
 * ずれた番号で「ここが違う」と言うことになる。
 *
 * プロンプトを変更したら version を上げること。
 */
export const EPISODE_PLOT_CONTRAST_VERSION = "1.0";

/** 見る観点は3つだけ（設計書6.36.3） */
export const EPISODE_PLOT_CONTRAST_KINDS = [
  "箇条書きに無い",
  "起きていない",
  "順序の食い違い",
] as const;

export type EpisodePlotContrastKind =
  (typeof EPISODE_PLOT_CONTRAST_KINDS)[number];

const KIND_ITEMS: Record<EpisodePlotContrastKind, string> = {
  箇条書きに無い:
    "箇条書きに書かれていない出来事が、本文で起きている" +
    "（この場合 plotItem は null、excerpt に本文の引用を入れる）",
  起きていない:
    "箇条書きにあるのに、本文で起きていない" +
    "（この場合 excerpt は null、plotItem にその行を入れる）",
  順序の食い違い:
    "箇条書きの並びと、本文で起きる順番が入れ替わっている" +
    "（plotItem に後に来るはずの行、excerpt にその場面の本文の引用を入れる）",
};

/** 出力例に書く、項目の言い換え。**プロンプトと検証で別々に書かない** */
const EXCERPT_HINT = "本文からそのまま写した短い引用";
const REASON_HINT = "そう言える理由";

export const EPISODE_PLOT_CONTRAST_HINTS: readonly string[] = [
  EXCERPT_HINT,
  REASON_HINT,
];

export const EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT = `あなたは日本語の小説を読み、作者が書いた1話ぶんの設計（箇条書き）と、
実際に書かれた本文とを照らし合わせる編集アシスタントです。

【絶対に守る原則】
1. 照らす相手は、渡された箇条書きだけです。作品全体の構成や、
   物語として良いかどうかは判断しないこと。
2. 食い違いは間違いとは限りません。箇条書きのほうが古いこともあります。
   どちらを直すかは作者が決めます。断定しないこと。
3. 書き直した文や、こうすべきという案を書かないこと。
4. 引用は本文からそのまま写すこと。言い換えたり、要約したりしないこと。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface EpisodePlotContrastInput {
  /** その話の見出し（「第3話」「投稿2026-08-16」） */
  chapterLabel: string;
  /** この話の目標。空なら節ごと落とす（**印を写されないため**） */
  goal: string;
  /** 展開の箇条書き。**この並びが順序そのもの**なので並べ替えない */
  items: readonly string[];
  /** その話の本文（行番号は振らない。上の但し書きを参照） */
  chapterText: string;
  /** 挙げてよい件数 */
  maxFindings: number;
}

export function buildEpisodePlotContrastPrompt(
  input: EpisodePlotContrastInput
): string {
  // 順序の食い違いを見るので、番号を振って渡す（「3番目」と言えるように）
  const list = input.items
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
  const sampleItem = JSON.stringify(input.items[0] ?? "");
  const kinds = EPISODE_PLOT_CONTRAST_KINDS.map(
    (kind, index) => `${index + 1}. ${kind}：${KIND_ITEMS[kind]}`
  ).join("\n");
  // **目標が無ければ節ごと落とす。** 「（書かれていません）」の印を置くと、
  // その言葉ごと写して返してくる（P-30で実際に起きた形）
  const goal = input.goal.trim()
    ? `\n【この話の目標】\n${input.goal.trim()}\n`
    : "";

  return `以下は、小説の${input.chapterLabel}について、作者が書いた展開の箇条書きと、
実際に書かれた本文です。**この箇条書きだけ**を物差しにして、
食い違っているところを指摘してください。
${goal}
【展開（箇条書き）】
${list}

【本文】
${input.chapterText}

【指摘の対象】
${kinds}

【判断の注意】
- plotItem には、上の箇条書きにある行をそのまま写してください（言い換えない）。
  番号だけを書かないでください。
- excerpt には、本文からそのまま写した引用を入れてください（30字以内）。
  本文に無い文を作らないこと。起きていないことを指すときは null にしてください。
- 一言も触れられていないときだけ「起きていない」としてください。
  言い方が違うだけ・短く書かれているだけのものは、起きたものとして扱います。
- 書き直した文や、こうすべきという案は書かないでください。
- 挙げてよいのは最大${input.maxFindings}件です。0件でも構いません。無理に探さないでください。

【出力形式】JSONのみ
kind には次のどれか1つだけを入れてください：${EPISODE_PLOT_CONTRAST_KINDS.join("、")}

{
  "findings": [
    {
      "kind": "${EPISODE_PLOT_CONTRAST_KINDS[0]}",
      "plotItem": ${sampleItem},
      "excerpt": "${EXCERPT_HINT}",
      "reason": "${REASON_HINT}（60字以内）"
    }
  ]
}`;
}

/**
 * 出力の形。
 *
 * **4つとも required にする。** 任意項目にすると、小さいモデルは埋めずに
 * 落とす。**指せないときは null を入れさせる**――項目ごと落とされると、
 * 「無い」のか「答えなかった」のかが分からない。
 */
export const EPISODE_PLOT_CONTRAST_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          plotItem: { type: ["string", "null"] },
          excerpt: { type: ["string", "null"] },
          reason: { type: "string" },
        },
        required: ["kind", "plotItem", "excerpt", "reason"],
      },
    },
  },
  required: ["findings"],
} as const;

/**
 * 挙げてよい件数。
 *
 * **箇条書きの数から決める**（P-27 と同じ考え方）。ただし本文との照合は
 * 「箇条書きに無い」も拾うので、少しだけ広く取る。
 */
export function episodePlotContrastBudget(itemCount: number): number {
  return Math.max(2, Math.min(6, Math.round(itemCount / 2) + 1));
}
