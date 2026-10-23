import { PLOT_SECTIONS, isBlankPlotSection, type PlotSections } from "../core/plotDoc";
import type { PlotDialogueSection } from "../core/plotInterview";
import {
  isPlotAdviceWriteRequest,
  plotAdviceFieldsNamed,
  type PlotAdviceAnswer,
} from "../core/plotAdviceValidation";
import { recentPlotAdviceHistory, type PlotAdviceTurn } from "./plotAdvice";

/**
 * P-01b プロットの書き込み案（「書いて」と頼まれたときの2回目。設計書6.4.10 の12、
 * プロンプト設計書 P-01b。作者の裁定 2026-10-23「『書いて』のときだけ別に頼む」）
 *
 * P-01（会話）の答えに書き込み案が無く、作者が項目を1つ名指しして「書いて」
 * 「入れて」と頼んでいた回だけ、**その項目に書く文だけ**を別の呼び出しで頼む。
 *
 * ## なぜ別に頼むのか
 *
 * P-01 1.1 で、決めて「書いて」と頼む4問×3回を測ると、gemma4:26b は12回中11回
 * 案を出したが、gemma4:e4b は12回中0回で、毎回「もう少し詳しく」と問いを返した
 * （2026-10-23。入力は約690トークンで窓に収まっていた）。小さいモデルは
 * 「問いで引き出す」決まりを優先するので、会話の指示の中で「案を先に」と
 * 頼んでも効かない。**問いを返す場面ではない呼び出しを分け、形を決めて**頼む。
 *
 * ## コードが受け持つところ
 *
 * - **呼ぶかどうかはコードが決める**（`plotAdviceDraftTarget`）
 * - **項目はコードが持つ。** AIに書かせるのは value だけ（`PLOT_ADVICE_DRAFT_SCHEMA`）
 * - 中身の見張りは1回目と同じ（`core/plotAdviceValidation.ts` の `parsePlotAdviceDraft`）
 * - 書くのは作者が［この案をプロットに書く］を押したときだけ（1回目と同じ）
 *
 * ## 指示語を返させない書き方
 *
 * 指示の言葉は答えとして返ってくる（CLAUDE.md の繰り返し起きた失敗3）。
 * 値の雛形（「ここに文」のような言葉）は書かず、JSON の形は文で説明する。
 * 返ってきても見分けられるよう、指示に書いた「項目に入れる文」「そのまま載せられる文」
 * と段の見出しは、見張り（`ECHO_WORDS`）が落とす。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-01b）
 * - 1.0: 初版（0.110.4）
 */
export const PLOT_ADVICE_DRAFT_VERSION = "1.0";

/**
 * 温度。作者が決めた中身を項目の文へ写す仕事で、案を広げる場ではないので低くする
 * （会話の P-01 は 0.7）。0 にしないのは、作者の言葉を項目の文へ整える言い換えの
 * 余地は残すため（推敲の提案 P-09 と同じ 0.2）。
 */
export const PLOT_ADVICE_DRAFT_TEMPERATURE = 0.2;

/** 渡す会話の往復の数。今回の発言が主で、「これを」が指す直前の話だけ要る */
export const PLOT_ADVICE_DRAFT_HISTORY_TURNS = 3;

/**
 * 答えの形。**field は持たせない**——名指しした項目はコードが知っており、
 * AIに選ばせると別の項目へ書く案になる道ができる。
 */
export const PLOT_ADVICE_DRAFT_SCHEMA = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
} as const;

export const PLOT_ADVICE_DRAFT_SYSTEM_PROMPT = `あなたは小説の編集者です。作者がプロットのある項目の中身を決めて、その項目へ書くように頼みました。いまは問いを返す場面ではありません。作者の発言をもとに、その項目に入れる文を書きます。

【決まり】
1. 作者の言葉をできるだけそのまま使うこと。作者が言っていない名前・出来事・理由を足さないこと。
2. 作者への問いかけ・あいさつ・感想・説明は書かないこと。プロットにそのまま載せられる文だけを書くこと。
3. 作者が決めたことだけを、短くまとめること。ほかの項目の話は入れないこと。
4. 答えは JSON を1つだけにすること。鍵は value の1つで、その値に、その文を書くこと。`;

export interface PlotAdviceDraftPromptInput {
  workTitle: string;
  /** 書く項目（`plotAdviceDraftTarget` が返したもの） */
  section: PlotDialogueSection;
  /** 今回の作者の発言 */
  userMessage: string;
  /** これまでの会話（古い順）。渡すのは末尾の `PLOT_ADVICE_DRAFT_HISTORY_TURNS` 往復だけ */
  history: readonly PlotAdviceTurn[];
}

export interface PlotAdviceDraftTargetInput {
  /** 今回の作者の発言 */
  userMessage: string;
  /** いま plot.md に書いてある中身（項目ごと） */
  sections: PlotSections;
  /** 1回目（P-01）の答えを `parsePlotAdviceAnswer` で読んだもの */
  firstAnswer: Pick<PlotAdviceAnswer, "suggestion" | "dropped">;
}

/**
 * 2回目を呼ぶ項目。呼ばない回は undefined。
 *
 * 次の**すべて**を満たすときだけ呼ぶ。
 *
 * 1. **1回目に使える案が無い。** 案があれば呼ばない。1回目の案を見張りが落とした
 *    回のうち、形が壊れていた・雛形の言葉だった・項目が分からなかった・長すぎた
 *    ときは「案が無い」のと同じなので呼ぶ。**作者を守る見張り（書いてある中身と
 *    同じ `already_written`・作者の文の言い換え `rewrites_author`）で落とした回は
 *    呼ばない**——頼み直しても同じものが返る見込みが高く、見張りを回り道で
 *    越える形になる
 * 2. **今回の発言が、書いてよい項目をちょうど1つ名指ししている**（`plotAdviceFieldsNamed`。
 *    見るのは今回の発言だけ）。2つ以上なら、どちらへ書くかをコードが決められない
 * 3. **今回の発言が書く依頼の言い方を含む**（`isPlotAdviceWriteRequest`）。案を
 *    求めない相談では決して呼ばない
 * 4. **その項目がまだ空である。** 作者が書いた項目を置き換える案を、作者が
 *    1回目で受け取らなかった問い返しの裏で作らない（実装ルール2の考え方）。
 *    書いてある項目の書き換えは、1回目の案（置き換えの確認つき）の道に任せる
 */
export function plotAdviceDraftTarget(
  input: PlotAdviceDraftTargetInput
): PlotDialogueSection | undefined {
  const { firstAnswer } = input;
  if (firstAnswer.suggestion) return undefined;
  if (firstAnswer.dropped === "already_written" || firstAnswer.dropped === "rewrites_author") {
    return undefined;
  }
  const named = plotAdviceFieldsNamed([input.userMessage]);
  if (named.length !== 1) return undefined;
  if (!isPlotAdviceWriteRequest(input.userMessage)) return undefined;
  const section = named[0];
  if (!isBlankPlotSection(input.sections[section] ?? "")) return undefined;
  return section;
}

function headingOf(key: PlotDialogueSection): string {
  return PLOT_SECTIONS.find((entry) => entry.key === key)?.heading ?? key;
}

/**
 * 2回目の依頼文。**いまのプロットは渡さない**——ほかの項目の中身を渡すと、
 * それを混ぜた文が返る（決まり3）。渡すのは書く項目の見出し・直前の会話・
 * 今回の発言だけ。
 */
export function buildPlotAdviceDraftPrompt(input: PlotAdviceDraftPromptInput): string {
  const history = recentPlotAdviceHistory(input.history, PLOT_ADVICE_DRAFT_HISTORY_TURNS)
    .map((turn) => `${turn.role === "author" ? "作者" : "編集者"}：${turn.text.trim()}`)
    .join("\n");

  return `# 作品
${input.workTitle}

【書く項目】
${headingOf(input.section)}

【直前の会話】
${history || "（ありません）"}

【作者の発言】
${input.userMessage.trim()}`;
}
