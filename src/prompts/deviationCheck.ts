/**
 * P-11 プロット逸脱・間延び検知（話単位）。
 *
 * **チャンク単位ではなく話ごとに見る。** 「この話がプロットから外れているか」
 * 「前へ進んでいるか」は、話をひとつながりで見ないと判断できない。
 * 途中で切ると、切れ目の前後がどちらも「進んでいない」ように見える。
 *
 * **プロットが無ければ実行しない。** 照らし合わせる相手が無いのに問うと、
 * AIは本文だけを見て「逸脱していそうなこと」を作り出す（矛盾検知で
 * 実際に起きた。設計書6.10.1）。
 *
 * **小さいモデルでは「間延び」を見ない**（プロンプト設計書1.3）。
 * 間延びは抽象的な判断で、的外れな指摘が混じりやすい。
 *
 * プロンプトを変更したら version を上げること。
 */
export const DEVIATION_CHECK_VERSION = "1.1";

export const DEVIATION_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説を読み、プロットとの食い違いを見つける編集アシスタントです。

**プロットにない展開が、必ずしも悪いわけではありません。** 伏線、人物の掘り下げ、
テーマの補強、背景の説明として働いているものは逸脱ではありません。
**意図的な緩急**（山場の前の静かな場面など）を間延びと呼ばないこと。

**断定しないこと。** 作者が読んで判断できる形で示します。

出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
マークダウンのコードフェンスを一切含めないこと。`;

export const DEVIATION_TYPES = ["逸脱", "間延び"] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];

/** 小さいモデルへ渡す観点。間延びは判定が難しく、的外れが増える */
export const LIGHT_DEVIATION_TYPES: readonly DeviationType[] = ["逸脱"];

const TYPE_ITEMS: Record<DeviationType, string> = {
  逸脱:
    "プロットのあらすじに記載のない展開が起き、かつ物語の主筋" +
    "（主人公の行動原理・テーマ）に寄与していないと判断される箇所",
  間延び:
    "物語が前進していない箇所。同じ情報が繰り返し説明されている、" +
    "会話や描写が続くのに状況・関係・情報のいずれも変わっていない、" +
    "主人公の目的に関わらない事象に長く紙幅が割かれている",
};

export interface DeviationCheckInput {
  /** その話の見出し（「第3話」「投稿2026-08-16」） */
  chapterLabel: string;
  /** プロットの全文 */
  plot: string;
  /** 行番号付きの本文（その話まるごと） */
  chapterTextWithLineNumbers: string;
  /** 前後の話のあらすじ。無ければ空文字 */
  surroundingSynopses: string;
  /** 見る観点 */
  types: readonly DeviationType[];
  /** この話で挙げてよい件数 */
  maxIssues: number;
}

export function buildDeviationCheckPrompt(
  input: DeviationCheckInput
): string {
  const items = input.types
    .map((type, index) => `${index + 1}. ${type}：${TYPE_ITEMS[type]}`)
    .join("\n");

  return `以下の小説の話と、作品のプロットを比べ、問題があれば指摘してください。

【プロット】
${input.plot}

【対象の話】（${input.chapterLabel}）
${input.chapterTextWithLineNumbers}

【前後の話のあらすじ】
${input.surroundingSynopses.trim() || "（登録されていません）"}

【問い】
**この話で起きることは、上のプロットで説明できますか。**

説明できない展開があり、**かつそれが主筋（主人公の目的・テーマ）に
繋がっていない**ときだけ、その箇所を挙げてください。

【指摘の対象】
${items}

【判断の注意】
- **プロットにない展開が必ずしも悪いとは限りません。** 伏線、人物の掘り下げ、
  テーマの補強として働いている場合は指摘しないこと。
- **意図的な緩急**（山場の前の静かな場面など）を間延びと判断しないこと。
- 指摘するときは、**プロットのどの部分と照らしてそう言えるか**を必ず示すこと。
  plot_reference には、**上のプロットに実際に書かれている語句をそのまま**写します。
- **断定的な物言いを避け**、作者が判断できる形で示すこと。
- **この話で挙げてよいのは最大${input.maxIssues}件です。**
  指摘が0件でも構いません。無理に探さないでください。

【出力形式】JSONのみ
type には次のどれか1つだけを入れてください：${input.types.join("、")}
excerpt は**本文からそのまま写して**ください（言い換えない）。

{
  "deviations": [
    {
      "lineStart": 40,
      "lineEnd": 78,
      "excerpt": "該当箇所の冒頭の引用（本文からそのまま写す。30字以内）",
      "type": "${input.types[0]}",
      "reason": "なぜそう判断したか（80字以内）",
      "plotReference": "照らしたプロットの語句（プロットからそのまま写す）",
      "severity": "high|medium|low",
      "confidence": "high|medium|low"
    }
  ]
}`;
}

/**
 * 出力の形。
 *
 * **すべて required にする。** 任意項目にすると、小さいモデルは
 * 埋めずに落とす（この作品で繰り返し起きた）。
 */
export const DEVIATION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    deviations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lineStart: { type: "number" },
          lineEnd: { type: "number" },
          excerpt: { type: "string" },
          type: { type: "string" },
          reason: { type: "string" },
          plotReference: { type: "string" },
          severity: { type: "string" },
          confidence: { type: "string" },
        },
        required: [
          "lineStart",
          "lineEnd",
          "excerpt",
          "type",
          "reason",
          "plotReference",
          "severity",
          "confidence",
        ],
      },
    },
  },
  required: ["deviations"],
} as const;

/**
 * その話で挙げてよい件数。
 *
 * **推敲より厳しくする。** 逸脱は「この話がプロットから外れているか」で、
 * 1つの話に何件もあるものではない。5件も出たら、それは
 * プロットのほうが古いか、AIが探しすぎている。
 */
export function deviationBudget(chars: number): number {
  return Math.max(1, Math.min(4, Math.round(chars / 2000)));
}
