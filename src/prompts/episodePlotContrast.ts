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
 *
 * ## 1.2 は 1.0 と同じ文面（版だけ上げた）
 *
 * 1.1 では「順序の食い違い」に入れ替わった相手（`swappedItem`・`swappedExcerpt`）を
 * 必須で書かせ、前後が本当に逆のときだけ通した。対照の誤検出は消えたが、
 * **本物の入れ替えを拾う数が落ちた**（26b 15/19 → 12/19、e4b 7/19 → 1/19）。
 * 作者の判断（2026-09-25）は「**拾う方**」——誤検出は残ってよいから、本物の
 * 入れ替えを落とさない。文面は 1.0 に戻し、**1.1 の答えをキャッシュから
 * 使わせないために版だけ上げた**（キャッシュの鍵に版が入る）。
 *
 * ## 1.3 で欄を4つにした（作者の裁定、2026-09-25 昼）
 *
 * 「出来事の欠落」「主筋の改変」を足す、が裁定。
 *
 *   - **「出来事の欠落」は、これまでの「起きていない」と同じ観点**なので、
 *     名前を付け替えて1つにした（箇条書きにある出来事が本文で起きていない、
 *     を2つの札に分けると、同じ行に2件並ぶだけで作者の判断が増えない）。
 *     古い言い方「起きていない」で返ってきても、検証が「出来事の欠落」として読む
 *   - **「主筋の改変」は新しい観点**：箇条書きの出来事は本文でも起きているが、
 *     結果や決断が逆になっている。「起きていない」とは違う（場面はある）。
 *     **「逆になったときだけ」と絞る。** 最初の文面（「違う方向へ進んでいる」だけ）
 *     では、e4b が箇条書きどおりの19話に27件挙げ（言い方・細部・前後の違い）、
 *     順序の指摘までこの札で返して、入れ替えを拾う数が 16/19 → 3/19 に落ちた
 *   - あわせて、**「箇条書きに無い」を出しすぎる**（e4b が箇条書きどおりの話に、
 *     箇条書きの行の中身を詳しく描いた場面を「箇条書きに無い」として挙げる）のを
 *     抑える一文を足した。箇条書きは要約で、本文には細部が必ずある
 */
export const EPISODE_PLOT_CONTRAST_VERSION = "1.3";

/**
 * 送るときの温度。突き合わせだが判断を伴うので、単話プロットの緩み（P-11）と同じに置く。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const EPISODE_PLOT_CONTRAST_TEMPERATURE = 0.2;

/**
 * 見る観点は4つ（設計書6.36.3）。
 *
 * **並びを変えない。** 検証とテストが添え字で引いている（[0] が出力例の種別、
 * [1] が「起きていない」を受け継いだ「出来事の欠落」）。足した「主筋の改変」は末尾。
 */
export const EPISODE_PLOT_CONTRAST_KINDS = [
  "箇条書きに無い",
  "出来事の欠落",
  "順序の食い違い",
  "主筋の改変",
] as const;

export type EpisodePlotContrastKind =
  (typeof EPISODE_PLOT_CONTRAST_KINDS)[number];

/**
 * 1.2 までの種別名。返ってきたら今の種別として読む（`normalizeKind`）。
 * 指示文から消しても、小さいモデルは前の言い方で返すことがある
 */
export const EPISODE_PLOT_CONTRAST_KIND_ALIASES: Readonly<
  Record<string, EpisodePlotContrastKind>
> = {
  起きていない: "出来事の欠落",
};

/**
 * 観点の説明（前半）と、指し方（後半のかっこ）。
 *
 * **前半は理由の欄にそのまま返ってくる前提**で、ヒント語にも入れる
 * （`EPISODE_PLOT_CONTRAST_HINTS`。失敗3「指示の言葉が答えに返る」）。
 */
const KIND_MEANINGS: Record<EpisodePlotContrastKind, string> = {
  箇条書きに無い: "箇条書きのどの行にも当たらない出来事が、本文で起きている",
  出来事の欠落: "箇条書きにある出来事が、本文で起きていない",
  順序の食い違い: "箇条書きの並びと、本文で起きる順番が入れ替わっている",
  主筋の改変:
    "箇条書きの出来事は本文でも起きているが、結果や決断が箇条書きと逆になっている",
};

const KIND_POINTING: Record<EpisodePlotContrastKind, string> = {
  箇条書きに無い: "（この場合 plotItem は null、excerpt に本文の引用を入れる）",
  出来事の欠落: "（この場合 excerpt は null、plotItem にその行を入れる）",
  順序の食い違い:
    "（plotItem に後に来るはずの行、excerpt にその場面の本文の引用を入れる）",
  主筋の改変:
    "（plotItem にその行、excerpt に逆になった場面の本文の引用を入れる）",
};

/** 出力例に書く、項目の言い換え。**プロンプトと検証で別々に書かない** */
const EXCERPT_HINT = "本文からそのまま写した短い引用";
const REASON_HINT = "そう言える理由";

export const EPISODE_PLOT_CONTRAST_HINTS: readonly string[] = [
  EXCERPT_HINT,
  REASON_HINT,
  ...Object.values(KIND_MEANINGS),
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
    (kind, index) =>
      `${index + 1}. ${kind}：${KIND_MEANINGS[kind]}${KIND_POINTING[kind]}`
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
- 一言も触れられていないときだけ「出来事の欠落」としてください。
  言い方が違うだけ・短く書かれているだけ・場所や経緯が書かれていないだけのものは、
  起きたものとして扱います。
- 「主筋の改変」は、場面はあるのに、結果や決断が箇条書きと逆になったときだけです
  （引き受けるはずが断る、成功するはずが失敗する、など）。
  言い方・細部・経緯が違うだけのもの、起きる順番が違うだけのものは「主筋の改変」にしないでください
  （順番が違うなら「順序の食い違い」です）。
- 箇条書きは話の要約です。本文には箇条書きより細かい会話・描写・説明が必ずあります。
  箇条書きの行の中身を本文が詳しく描いているだけなら「箇条書きに無い」にしないでください。
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
