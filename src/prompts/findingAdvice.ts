/**
 * P-47 推敲の指摘への短い助言（設計書6.96.5の［AIに相談］）
 *
 * 校正・メモパネルで、修正案の無い推敲の指摘の［AIに相談］を押したときに、
 * **その指摘1つだけ**を見て短い助言を返させる。
 *
 * ## 相談パネル（P-21）を通さない
 *
 * 0.98.12 までは相談パネルへ作者の問いとして送っていた。相談のシステム指示・
 * 材料・起動できる機能の一覧まで全部通るので、答えが長く、機能の案内や
 * 抽象的な選択肢（「Aの方向」「Bの方向」）まで混ざり、しかも離れた相談パネルに
 * 出た。作者の報告（2026-10-04）「AIに相談がくどすぎます」「選択肢の意味も
 * わかりません」。ここでは**何が引っかかっているか1文と、その箇所だけの
 * 言い換え例0〜2個**しか返させない。
 *
 * ## 言い換えは「本文のどこを → どう」の組で返させる
 *
 * 言い換えだけを返させると、本文のどこを言い換えたのかをコードで確かめられない
 * （規則3）。`from` に本文の一文から写した部分、`to` に言い換えを書かせ、
 * `from` が一文に無いものは検証（`core/findingAdviceValidation.ts`）で捨てる。
 *
 * プロンプトを変更したら version を上げること（キャッシュの鍵に入っている）。
 */
/**
 * 変更履歴
 * - 1.0: 初版（0.98.14）
 */
export const FINDING_ADVICE_VERSION = "1.0";

/**
 * 送るときの温度。言い換え例は少し揺れてよいが、指摘の読み取りは揺らさない。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const FINDING_ADVICE_TEMPERATURE = 0.3;

/** 「何が引っかかっているか」の字数の上限 */
export const FINDING_ADVICE_POINT_MAX_CHARS = 60;
/** 言い換え1つの字数の上限 */
export const FINDING_ADVICE_EXAMPLE_MAX_CHARS = 40;
/** 言い換えの数の上限 */
export const FINDING_ADVICE_EXAMPLES_MAX = 2;
/** 一文・前後の段落・指摘を渡すときの上限（合本の長い行で膨らませない） */
export const FINDING_ADVICE_MATERIAL_MAX_CHARS = 300;

/**
 * 指示に書く言葉のうち、そのまま答えとして返ってきうるもの。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md の
 * 「繰り返し起きた失敗3」）。プロンプトはこの定数から言葉を埋め込み、
 * 検証側（`findingAdviceValidation.ts`）は同じ定数で弾く。
 */
const POINT_HINT = "何が引っかかっているか";
const FROM_HINT = "本文の一文から写した部分";
const TO_HINT = "その部分の言い換え";
/** 直す必要が薄いと見たときの書き出し（画面で見分けるために持つ） */
export const FINDING_ADVICE_NO_NEED = "直す必要は薄い";

export const FINDING_ADVICE_HINTS: readonly string[] = [
  POINT_HINT,
  FROM_HINT,
  TO_HINT,
  "言い換え例",
  "言い換え",
  "該当部分",
  "本文の一文",
  "一文",
  `${FINDING_ADVICE_POINT_MAX_CHARS}字以内`,
  `${FINDING_ADVICE_EXAMPLE_MAX_CHARS}字以内`,
  "1文",
  "短く",
  "point",
  "from",
  "to",
];

export const FINDING_ADVICE_SYSTEM_PROMPT = `あなたは日本語の小説の推敲を手伝う編集者です。推敲の指摘が1つ付いた本文の一文を見て、作者へ短く助言します。

【絶対に守る原則】
1. 本文を書き直さないこと。直すかどうか、どう直すかは作者が決めます。
2. 作者の文体を尊重すること。あなたの好みで書き換えを勧めない。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
4. 機能の案内・挨拶・前置き・まとめを書かないこと。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

export interface FindingAdvicePromptInput {
  /** 指摘された本文の一文 */
  quote: string;
  /** 指摘の中身（「視点：…」など） */
  finding: string;
  /** 一文の前と後ろの段落（空の行とメモの行を飛ばした本文。無ければ省く） */
  before?: string;
  after?: string;
}

/** 改行を詰め、長すぎるものは頭から切る */
export function clipFindingMaterial(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > FINDING_ADVICE_MATERIAL_MAX_CHARS
    ? `${flat.slice(0, FINDING_ADVICE_MATERIAL_MAX_CHARS)}…`
    : flat;
}

export function buildFindingAdvicePrompt(input: FindingAdvicePromptInput): string {
  /*
    **前後の段落は「読むためだけ」と見出しで断る。** 推敲の指摘（視点・
    係り受け・つながり）は前後を見ないと判断できないが、答えに引用されると
    長くなる。引用されたものは検証側でも捨てる
  */
  const before = input.before?.trim()
    ? `【前の段落（読むためだけ。答えに引用しない）】\n${clipFindingMaterial(input.before)}\n\n`
    : "";
  const after = input.after?.trim()
    ? `\n\n【後ろの段落（読むためだけ。答えに引用しない）】\n${clipFindingMaterial(input.after)}`
    : "";
  return `次の本文の一文に、推敲の指摘が付いています。

${before}【本文の一文】
${clipFindingMaterial(input.quote)}${after}

【指摘】
${clipFindingMaterial(input.finding)}

【答え方】
- point には、${POINT_HINT}を、${FINDING_ADVICE_POINT_MAX_CHARS}字以内の1文で書いてください。
  読んで直す必要は薄いと判断したら、point を「${FINDING_ADVICE_NO_NEED}」で始めてその理由を続け、examples は空にしてください。
- examples には、言い換えの例を0〜${FINDING_ADVICE_EXAMPLES_MAX}個入れてください。
  from には${FROM_HINT}（本文の一文の中の、引っかかっている箇所だけ）を一字も変えずに書き、
  to には${TO_HINT}を${FINDING_ADVICE_EXAMPLE_MAX_CHARS}字以内で書いてください。
- 一文の全体を書き直さないこと。前後の段落を引用しないこと。
- 「Aの方向」「案1」のような、案の名前だけの選択肢を書かないこと。案は必ず具体的な言い換えで示すこと。
- 「${POINT_HINT}」のような項目名や、この指示の言葉をそのまま書かないこと。`;
}

/**
 * 構造化出力のスキーマ。
 *
 * `maxItems` は手元のモデルが例を並べ続けるのを止めるためのもの。受け付けない
 * サービス向けには変換側（`ai/jsonSchema.ts`・`claudeProvider.ts`）が落とすので、
 * 件数は検証側でも切る。
 */
export const FINDING_ADVICE_SCHEMA = {
  type: "object",
  properties: {
    point: { type: "string" },
    examples: {
      type: "array",
      maxItems: FINDING_ADVICE_EXAMPLES_MAX,
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["point", "examples"],
  additionalProperties: false,
} as const;
