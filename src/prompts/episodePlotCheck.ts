/**
 * P-27 単話プロットの展開の検査（設計書6.36.3）。
 *
 * 作者の指定：「その話の目標→ストーリー展開に緩みがないか判定」。
 *
 * **本文は渡さない。** これは**書く前に**掛けられる検査で、材料は作者が
 * 書いた3節（視点・目標・展開の箇条書き）だけである。短いのでチャンクにも
 * 割らない。
 *
 * **書き直しの作文はさせない**（6.36.3）。出力の形に修正案の欄を置かない
 * ――欄があれば埋めてくるし、埋まっていれば作者は読む。単話プロットは
 * 作者のものであって、AIの筋書きに置き換えるための機能ではない
 * （6.21.2「作者のものではない話」の教訓）。
 *
 * ## 見本の値の選び方
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md の
 * 「繰り返し起きた失敗3」）。そこで出力例の値は2つに分ける。
 *
 *   - `item` の見本は**実在する箇条書きの1行**。そのまま返ってきても
 *     「その行が気になる」という、ごく普通の指摘にしかならない
 *     （「対象の箇条書き」のような言い換えを置くと、検証で必ず捨てられ、
 *     なぜ0件なのかが分からなくなる）
 *   - `reason` の見本は**項目の言い換え**。これが返ってきたら中身が無いので、
 *     検証側（`core/episodePlotValidation.ts`）が `EPISODE_PLOT_CHECK_HINTS`
 *     と突き合わせて弾く
 *
 * プロンプトを変更したら version を上げること。
 */
export const EPISODE_PLOT_CHECK_VERSION = "1.0";

/**
 * 見る観点は3つだけ（設計書6.36.3）。
 *
 * **増やさない。** 「描写が薄い」「盛り上がりに欠ける」まで見させると、
 * 作者の書き方そのものへの注文になる（推敲で語彙や文体に触れないのと
 * 同じ線引き）。
 */
export const EPISODE_PLOT_CHECK_KINDS = [
  "目標に向かっていない",
  "停滞・重複",
  "目標と矛盾",
] as const;

export type EpisodePlotCheckKind = (typeof EPISODE_PLOT_CHECK_KINDS)[number];

const KIND_ITEMS: Record<EpisodePlotCheckKind, string> = {
  目標に向かっていない:
    "その展開が、この話の目標に近づく働きをしていない" +
    "（起きても目標との距離が変わらない）",
  "停滞・重複":
    "前の項目と同じことが起きている、または場面・情報が変わらないまま" +
    "項目だけが増えている",
  目標と矛盾:
    "その展開が起きると、この話の目標が成り立たなくなる" +
    "（目標と逆を向いている）",
};

/** 出力例に書く、項目の言い換え。**プロンプトと検証で別々に書かない** */
const REASON_HINT = "そう言える理由";

export const EPISODE_PLOT_CHECK_HINTS: readonly string[] = [REASON_HINT];

/** 節が空のときに書く言葉。**無いものを埋めさせない** */
export const EPISODE_PLOT_BLANK_MARK = "（書かれていません）";

export const EPISODE_PLOT_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説の構成を読む編集アシスタントです。
作者が書いた「この1話の設計図」を読み、気になるところを指摘します。

【絶対に守る原則】
1. 渡された箇条書きに書かれていることだけを扱うこと。
   本文は渡していないので、書かれていない出来事を推測して補わないこと。
2. 書き直した文や、こうすべきという案を書かないこと。
   この機能は指摘までで、直すのは作者です。
3. 箇条書きに無いものを足すよう求めないこと（不足の指摘は求めていません）。
4. 断定を避け、作者が読んで判断できる形で示すこと。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface EpisodePlotCheckInput {
  /** その話の見出し（「第3話」「投稿2026-08-16」） */
  chapterLabel: string;
  /** 視点。空なら「書かれていません」と断る */
  viewpoint: string;
  /** この話の目標。空なら「書かれていません」と断る */
  goal: string;
  /** 展開の箇条書き。**この並びが順序そのもの**なので並べ替えない */
  items: readonly string[];
  /** 挙げてよい件数 */
  maxFindings: number;
}

export function buildEpisodePlotCheckPrompt(
  input: EpisodePlotCheckInput
): string {
  const list = input.items.map((item) => `- ${item}`).join("\n");
  // 見本の対象は実在する1行（上の「見本の値の選び方」）。引用符を含む
  // 行でも壊れないよう、JSONの値として組み立てる
  const sampleItem = JSON.stringify(input.items[0] ?? "");
  const kinds = EPISODE_PLOT_CHECK_KINDS.map(
    (kind, index) => `${index + 1}. ${kind}：${KIND_ITEMS[kind]}`
  ).join("\n");

  return `以下は、小説の${input.chapterLabel}のために作者が書いた単話プロットです。
展開の箇条書きに緩みがないかを見て、気になるところを指摘してください。

【視点】
${input.viewpoint.trim() || EPISODE_PLOT_BLANK_MARK}

【この話の目標】
${input.goal.trim() || EPISODE_PLOT_BLANK_MARK}

【展開（箇条書き）】
${list}

【問い】
上の展開は、この話の目標に向かっていますか。

【指摘の対象】
${kinds}

【判断の注意】
- item には、上の箇条書きにある行をそのまま写してください（言い換えない）。
  写せない指摘（どの行のことか言えない指摘）は書かないでください。
- 目標が書かれていないときは、「目標に向かっていない」「目標と矛盾」は
  判断できません。停滞・重複だけを見てください。
- 順番を入れ替える案・足りないものを補う案は書かないでください。
- 意図的な緩急（山場の前の静かな場面）を停滞と呼ばないこと。
- 挙げてよいのは最大${input.maxFindings}件です。0件でも構いません。無理に探さないでください。

【出力形式】JSONのみ
kind には次のどれか1つだけを入れてください：${EPISODE_PLOT_CHECK_KINDS.join("、")}

{
  "findings": [
    {
      "item": ${sampleItem},
      "kind": "${EPISODE_PLOT_CHECK_KINDS[0]}",
      "reason": "${REASON_HINT}（60字以内）"
    }
  ]
}`;
}

/**
 * 出力の形。
 *
 * **3つとも required にする。** 任意項目にすると、小さいモデルは埋めずに
 * 落とす（この作品で繰り返し起きた）。**修正案の欄は置かない**――
 * 欄があれば埋めてくる。
 */
export const EPISODE_PLOT_CHECK_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          kind: { type: "string" },
          reason: { type: "string" },
        },
        required: ["item", "kind", "reason"],
      },
    },
  },
  required: ["findings"],
} as const;

/**
 * 挙げてよい件数。
 *
 * **箇条書きの数から決める。** 5項目の設計に5件の指摘が付いたら、それは
 * 検査ではなく作り直しの要求である（逸脱検知の `deviationBudget` と
 * 同じ考え方）。
 */
export function episodePlotCheckBudget(itemCount: number): number {
  return Math.max(1, Math.min(5, Math.round(itemCount / 2)));
}
