import {
  PLOT_DIALOGUE_SECTIONS,
  PLOT_SUPPLEMENT_MARK,
  type PlotDecision,
} from "../core/plotInterview";

/**
 * P-44 対話式プロット作成のまとめ（設計書6.4.7）
 *
 * 問答で決まったことを、プロットの項目（ログライン・人物・世界・構成など）へ
 * まとめる。作者とリーダーが実際にやった問答（2026-09-25）の締めくくりと同じ
 * 形で、**つなぐためにAIが補った所には〔補い〕を付け**、作者が見分けて
 * 消せるようにする。構成には、目標の文字数が決まっていれば字数の区切りを付ける。
 *
 * - **作者の答えを削らない・言い換えすぎない。** 抜けていればコードが作者の
 *   言葉のまま戻す（`validatePlotSummary`。実装ルール3「マージはコード」）
 * - **補ったことを隠させない。** 印の無い補いは、作者が決めたことと見分けがつかない
 * - まとめは見せるだけ。書くのは作者が「このまとめでプロットに書く」を押したとき
 *
 * どの型の問答でも同じまとめを使う（型で違うのは尋ね方だけで、決まったことの
 * 形は同じ）。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-44）
 * - 1.0: 初版（0.86.5）
 */
export const PLOT_SUMMARY_VERSION = "1.0";

/** 温度。決まったことを並べ直すだけなので、揺らさない */
export const PLOT_SUMMARY_TEMPERATURE = 0.3;

const SECTION_LIST = PLOT_DIALOGUE_SECTIONS.map(
  (section) => `- ${section.key}：${section.note}`
).join("\n");

export const PLOT_SUMMARY_SYSTEM_PROMPT = `あなたは、小説の作者が問答で決めたことを、プロットの項目へまとめる係です。

【絶対に守る原則】
1. 作者が決めたことを削らないこと。言い回しは整えてよいが、意味を変えないこと。
2. 作者が決めていないことを書き足すのは、話をつなぐのにどうしても要るときだけにすること。
   書き足した文は、その文の頭に「${PLOT_SUPPLEMENT_MARK}」を付けること。作者はこの印で見分けて、要らなければ消します。
3. outline（あらすじ）には、事件の並び・山場・どんでん返しを順に箇条書きで並べること。
   目標の文字数が決まっていれば、それぞれの区切りに字数の目安（例：〜2万字）を付けること。
4. mainCharacters（主要登場人物）は、人物ごとに箇条書きにすること。
5. 決まったことが無い項目は、空文字にすること。
6. 出力は指定されたJSONのみ。前置き・後書き・コードフェンスを含めないこと。

【項目の鍵】
${SECTION_LIST}`;

export interface PlotSummaryPromptInput {
  workTitle: string;
  /** 作者が最初に書いたこと（着想・場面・結末） */
  idea?: string;
  /** その見出し（「作者の着想」「作者が書きたい場面」など） */
  ideaHeading?: string;
  writtenPlot: string;
  decisions: readonly PlotDecision[];
  retryNote?: string;
}

export function buildPlotSummaryPrompt(input: PlotSummaryPromptInput): string {
  const decisions = input.decisions
    .map((item) => `- 【${item.topic}】${item.answer}（書く先の目安：${item.section}）`)
    .join("\n");
  return `# 作品
${input.workTitle}

# ${input.ideaHeading ?? "作者の着想"}
${input.idea?.trim() || "（プロットに書いてあることから始めた）"}

# プロットにすでに書いてあること
${input.writtenPlot.trim() || "（まだありません）"}

# 問答で決まったこと（作者の答え）
${decisions || "（まだありません）"}

# お願い
決まったことを、項目ごとにまとめてください。${input.retryNote ? `\n${input.retryNote}` : ""}`;
}

/**
 * 答えの形。項目ごとの文字列で、**すべて required**（決まったことが無い項目は空文字）。
 * 任意にすると、地力の足りないモデルは埋めずに落とす。
 */
export const PLOT_SUMMARY_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    PLOT_DIALOGUE_SECTIONS.map((section) => [section.key, { type: "string" }])
  ),
  required: PLOT_DIALOGUE_SECTIONS.map((section) => section.key),
};
