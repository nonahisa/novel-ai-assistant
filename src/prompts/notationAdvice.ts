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
 * ## 数字・英字の幅の組は「半角」「全角」で訊く（1.1）
 *
 * 0〜9 の半角・全角をまとめた1組（`digit_width`）は、表記が最大20個ある。
 * 1.0 は表記そのものを選ばせていたので、手元の gemma4:26b は揃え先に「2」と
 * 答え、画面には「「2」に揃える」と出た（2026-09-25 夜）。理由の「半角が多い」
 * も事実と逆だった（表記ごとの数しか渡しておらず、幅ごとの合計が無かった）。
 * 幅だけが違う組（`isWidthNotationGroup`）は、**「半角」「全角」「揃えない」
 * から選ばせ、幅ごとの合計を渡す**。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴
 * - 1.0: 初版（0.32.3）
 * - 1.1: 数字・英字の幅の組は「半角」「全角」「揃えない」から選ばせ、幅ごとの合計を渡す
 */
export const NOTATION_ADVICE_VERSION = "1.1";

/**
 * 送るときの温度。判断であって創作ではない。揺らす理由がない。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const NOTATION_ADVICE_TEMPERATURE = 0.0;

/**
 * 「揃えない」という答え。
 *
 * **指示の言葉と同じだが、ここでは中身のある答えである。** 方言・口癖・
 * 会話文と地の文の書き分けとして、わざと揺らしていることがある。
 * 選択肢から外すと、AIはどちらかを選ぶしかなくなり、
 * **作者の意図した揺れを「直すべきもの」に変えてしまう。**
 */
export const NOTATION_ADVICE_NO_UNIFY = "揃えない";

/** 幅の組の答え。**表記ではなく幅を選ばせる**（「「2」に揃える」には意味が無い） */
export const NOTATION_ADVICE_HALF = "半角";
export const NOTATION_ADVICE_FULL = "全角";

/** 半角・全角の数字と英字だけでできているか */
const ALNUM = /^[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]+$/u;

/**
 * 表記の違いが**幅（半角・全角）だけ**の組か。
 *
 * - 数字の組（0〜9 をまとめた1組）：どの表記も1文字の数字・英字。数字ごとに
 *   置き換え先が違うので、表記そのものは揃え先にならない。**全角が本文に
 *   1度も出ていない組（半角だけ）もここに入る**——検知は「半角のままなら全角に
 *   するよう促す」ためにこの組を返している（`notationVariants.ts`）
 * - 英字の組（「AI」↔「ＡＩ」）：幅をそろえると同じ綴りになる
 *
 * **綴りが違う英字（「AI」↔「Ai」）は入れない。** 「半角に揃える」では指すものが
 * 決まらない。組の種類（`kind`）ではなく表記から判定する——外から呼ぶ道
 * （MCP の `novel.run`）には種類が渡らないため。
 */
export function isWidthNotationGroup(group: NotationAdviceGroup): boolean {
  const surfaces = group.forms.map((form) => form.surface);
  if (surfaces.length === 0 || !surfaces.every((surface) => ALNUM.test(surface))) return false;
  if (surfaces.every((surface) => surface.length === 1)) return true;
  return new Set(surfaces.map((surface) => surface.normalize("NFKC"))).size === 1;
}

/** 揃え先として選べるもの（「揃えない」は含めない）。幅の組は「半角」「全角」 */
export function notationAdviceChoices(group: NotationAdviceGroup): string[] {
  return isWidthNotationGroup(group)
    ? [NOTATION_ADVICE_HALF, NOTATION_ADVICE_FULL]
    : group.forms.map((form) => form.surface);
}

/** 表記全体が半角か全角か（混ざった表記は、どちらにも数えない） */
function widthOf(surface: string): "half" | "full" | undefined {
  if (/^[0-9A-Za-z]+$/u.test(surface)) return "half";
  if (/^[０-９Ａ-Ｚａ-ｚ]+$/u.test(surface)) return "full";
  return undefined;
}

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
2. 揃える先には、依頼文で示された選択肢（提示された表記のいずれか、数字・英字の幅の組では「${NOTATION_ADVICE_HALF}」か「${NOTATION_ADVICE_FULL}」）、または「${NOTATION_ADVICE_NO_UNIFY}」だけを答えること。提示されていない書き方・言い換え・新しい表記を作らないこと。
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

/** 幅ごとの出現数の合計 */
function widthTotals(group: NotationAdviceGroup): { half: number; full: number } {
  let half = 0;
  let full = 0;
  for (const form of group.forms) {
    const width = widthOf(form.surface);
    if (width === "half") half += form.count;
    if (width === "full") full += form.count;
  }
  return { half, full };
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

  const width = isWidthNotationGroup(input.group);
  /*
    **幅の組は、幅ごとの合計を先に渡す。** 1.0 は表記ごとの数だけで、
    gemma4:26b は「半角が多い」と事実と逆の理由を書いた（2026-09-25 夜）。
    20個の数を足し合わせるのはAIに任せない
  */
  const totals = width ? widthTotals(input.group) : undefined;
  const intro = width
    ? "次の小説では、数字・英字が半角と全角の両方の書き方で本文に出ています（全角が1度も出ていないこともあります）。半角と全角のどちらに揃えるのがよいかを判断してください。"
    : "次の小説では、同じ語が2通り以上の書き方で本文に出ています。どちらの表記に揃えるのがよいかを判断してください。";
  /*
    どちらが多いかも言葉で添える。合計の数だけでは、手元の gemma4:e4b は
    半角173回・全角628回を見ても「半角の使用頻度が圧倒的に高い」と書いた（2026-09-25 夜）
  */
  const more = !totals
    ? ""
    : totals.half === totals.full
      ? "（合計の数は同じです）"
      : `（合計では${totals.full > totals.half ? NOTATION_ADVICE_FULL : NOTATION_ADVICE_HALF}のほうが多い）`;
  const summary = totals
    ? `\n${NOTATION_ADVICE_HALF}：合わせて${totals.half}回　${NOTATION_ADVICE_FULL}：合わせて${totals.full}回${more}\n`
    : "";
  const widthHint = width
    ? "\n- 縦書きでは、半角の数字・英字は横に寝ます（全角なら寝ません）。横書きで読まれる作品では半角で書くことも多くあります。"
    : "";
  const answerLine = width
    ? `- choice には、「${NOTATION_ADVICE_HALF}」「${NOTATION_ADVICE_FULL}」「${NOTATION_ADVICE_NO_UNIFY}」のどれかを書いてください。
  数字や英字そのもの（上に挙げた表記）を書かないこと。`
    : `- choice には、上に挙げた表記のいずれかをそのまま写すか、「${NOTATION_ADVICE_NO_UNIFY}」と書いてください。
  ほかの言葉・言い換え・新しい表記を書かないこと。`;

  return `${intro}

【作品】
${input.workTitle || "（題名は分かりません）"}

【揺れている組】
${input.group.label}
${summary}
${forms}

【判断のしかた】
- 出現数の多さだけで決めないこと。公用文の送り仮名の付け方、出版・WEB小説での慣行、
  そしてこの作品の文体（出現例から読み取れる範囲）を踏まえて判断してください。
- 会話文と地の文で書き分けている、方言や口癖としてわざと揺らしている、
  同じ音でも意味が違う——このように読み取れる場合は「${NOTATION_ADVICE_NO_UNIFY}」を選び、
  何をもってそう読んだのかを理由に書いてください。
- 出現例から読み取れないことを、推測で補わないこと。${widthHint}

【答え方】
${answerLine}
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
        // 幅の組は「半角」「全角」だけ（表記そのものは選ばせない。1.1）
        enum: [...notationAdviceChoices(group), NOTATION_ADVICE_NO_UNIFY],
      },
      reason: { type: "string" },
    },
    required: ["choice", "reason"],
    additionalProperties: false,
  };
}
