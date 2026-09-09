/**
 * P-33 表記ゆれのAI問い合わせ（設計書6.73）
 *
 * 表記ゆれ検知（P-13）は**機械判定だけ**で動いており、それは変えない
 * （AIに探させると見逃しの測定ができなくなる）。機械が答えられないのは
 * 「見つけたか」ではなく「**どちらに揃えるか**」のほうである。
 * 「良い」と「よい」はどちらも正しい日本語で、数の多寡だけでは決まらない。
 *
 * ## 1組について1問だけ訊く
 *
 * 作者が指摘を見て「AIに訊く」を押したときだけ走る。渡すのは**その組の
 * 情報だけ**（各表記・出現数・出現例）で、本文全体は送らない。
 * 1クリック1問なので、キャッシュも持たない。
 *
 * ## 答えは選択肢の中からしか受け取らない
 *
 * `choice` は**渡した表記のどれか、または「揃えない」**に限る。
 * 言い換えや新しい表記（「ひっこし」）を返してくることがあり、そのまま
 * 出すと、本文に一度も出ていない書き方へ揃えるよう勧めることになる。
 * 照合は `core/notationAdviceValidation.ts` が行う。
 *
 * ## 助言しかさせない
 *
 * 本文は書き換えない（設計書6.73）。直すのは作者であり、この機能が返すのは
 * 「どちらに揃えるか・なぜそう思うか」の2つだけである。
 *
 * プロンプトを変更したら version を上げること。
 */
export const NOTATION_ADVICE_VERSION = "1.0";

/**
 * 「揃えない」という答え。
 *
 * **指示の言葉と同じだが、ここでは中身のある答えである。** 方言・口癖・
 * 会話文と地の文の書き分けとして、わざと揺らしていることがある。
 * 選択肢から外すと、AIはどちらかを選ぶしかなくなり、
 * **作者の意図した揺れを「直すべきもの」に変えてしまう。**
 */
export const NOTATION_ADVICE_NO_UNIFY = "揃えない";

/**
 * 表記ごとに渡す出現例の数。
 *
 * 文体を読み取るのが目的なので、多くは要らない。増やすほど、1問あたりの
 * 送信量が表記の数だけ増える。
 */
export const NOTATION_ADVICE_EXCERPTS_PER_FORM = 3;

/** 出現例1つの上限。小説は1行が1段落のことがあるので、頭から切る */
export const NOTATION_ADVICE_EXCERPT_MAX_CHARS = 80;

/** 理由の長さの目安（プロンプトで指示する字数） */
export const NOTATION_ADVICE_REASON_MAX_CHARS = 100;

/**
 * 出力例に書く、項目の言い換え。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md の
 * 「繰り返し起きた失敗3」。`"suggestion": "空文字"` が実データで返った）。
 * ここに並べたものを検証側（`notationAdviceValidation.ts`）が弾くので、
 * **プロンプトの文言とこの定数を別々に書かないこと**——別々に書くと、
 * 指示を直したときに検査だけが古い言葉を見張り続ける。
 */
const REASON_HINT = "そう判断した理由";
const CHOICE_HINT = "揃える先の表記";

export const NOTATION_ADVICE_HINTS: readonly string[] = [
  REASON_HINT,
  CHOICE_HINT,
  // 指示文に出てくる短い語も、そのまま返ってくることがある
  "理由",
  "短く",
];

export const NOTATION_ADVICE_SYSTEM_PROMPT = `あなたは日本語の表記に詳しい編集者です。小説の本文に混在している2通り以上の書き方を見て、どちらに揃えるのがよいかを助言します。

【絶対に守る原則】
1. 本文を書き直さないこと。直すのは作者です。あなたが出すのは、どの表記に揃えるかの判断と、その理由だけです。
2. 揃える先には、提示された表記のいずれか、または「${NOTATION_ADVICE_NO_UNIFY}」だけを答えること。提示されていない書き方・言い換え・新しい表記を作らないこと。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

/** AIへ渡す、1つの表記とその出方 */
export interface NotationAdviceForm {
  /** 本文に出ている書き方 */
  surface: string;
  /** 作品全体での出現数 */
  count: number;
  /** 出現した行の抜粋（最大 NOTATION_ADVICE_EXCERPTS_PER_FORM 件） */
  excerpts: string[];
}

/**
 * 揺れの1組。
 *
 * 検知（`features/checkNotation.ts`）が組み立て、指摘（`ProposalViewItem`）に
 * 添えて提案パネルまで運ぶ。**画面から拡張機能へ送り返される**ので、
 * 文字列と数値だけで持てる形にしてある。
 */
export interface NotationAdviceGroup {
  /** 画面に出している見出し（例:「良い ↔ よい」） */
  label: string;
  /** 出現の多い順 */
  forms: NotationAdviceForm[];
}

export interface NotationAdvicePromptInput {
  /** 作品名。文体の手がかりとして添える（無ければ空でよい） */
  workTitle: string;
  group: NotationAdviceGroup;
}

export function buildNotationAdvicePrompt(
  input: NotationAdvicePromptInput
): string {
  const forms = input.group.forms
    .map((form, index) => {
      const examples =
        form.excerpts.length > 0
          ? form.excerpts.map((line) => `  - ${line}`).join("\n")
          : "  - （出現例を取れませんでした）";
      return `【表記${index + 1}】「${form.surface}」　本文に${form.count}回\n${examples}`;
    })
    .join("\n\n");

  return `次の小説では、同じ語が2通り以上の書き方で本文に出ています。どちらの表記に揃えるのがよいかを判断してください。

【作品】
${input.workTitle || "（題名は分かりません）"}

【揺れている組】
${input.group.label}

${forms}

【判断のしかた】
- 出現数の多さだけで決めないこと。公用文の送り仮名の付け方、出版・WEB小説での慣行、
  そしてこの作品の文体（出現例から読み取れる範囲）を踏まえて判断してください。
- 会話文と地の文で書き分けている、方言や口癖としてわざと揺らしている、
  同じ音でも意味が違う——このように読み取れる場合は「${NOTATION_ADVICE_NO_UNIFY}」を選び、
  何をもってそう読んだのかを理由に書いてください。
- 出現例から読み取れないことを、推測で補わないこと。

【答え方】
- choice には、上に挙げた表記のいずれかをそのまま写すか、「${NOTATION_ADVICE_NO_UNIFY}」と書いてください。
  ほかの言葉・言い換え・新しい表記を書かないこと。
- reason には、${REASON_HINT}を${NOTATION_ADVICE_REASON_MAX_CHARS}字以内で書いてください。
  「${REASON_HINT}」のような項目名をそのまま書かないこと。
- 本文の書き換え案・例文を書かないこと。`;
}

/**
 * 構造化出力のスキーマ。
 *
 * **`choice` は選択肢を列挙する。** 形式を強制できるモデルでは、これだけで
 * 「本文に無い表記」を防げる（守らないモデルのために、検証側でも照合する）。
 * 組ごとに選択肢が変わるので、定数ではなく組み立てて渡す。
 */
export function buildNotationAdviceSchema(group: NotationAdviceGroup): object {
  return {
    type: "object",
    properties: {
      choice: {
        type: "string",
        enum: [
          ...group.forms.map((form) => form.surface),
          NOTATION_ADVICE_NO_UNIFY,
        ],
      },
      reason: { type: "string" },
    },
    required: ["choice", "reason"],
    additionalProperties: false,
  };
}
