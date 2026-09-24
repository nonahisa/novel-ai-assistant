import { PLOT_DIALOGUE_LIMITS } from "../core/plotDialogueValidation";
import {
  PLOT_DIALOGUE_SECTIONS,
  type PlotAskedPoint,
  type PlotDecision,
} from "../core/plotInterview";

/**
 * P-43 対話式プロット作成（設計書6.4.7）
 *
 * 作者の着想から、**いま決めると話が一番広がる1点**を選んで問いを1つ出し、
 * 着想に根ざした具体的な候補を3〜4つ添える。作者が答えたら、決まったことを
 * 短く確かめ直して次の1点を尋ねる。
 *
 * ## 何をさせて、何をさせないか
 *
 * - **候補は出させる。決めさせない。** 0.86.1 までの原則「AIに筋書きを作らせ
 *   ない」は、決まった9項目を順に尋ね、どの作品でも同じ選択肢を出す形だった。
 *   作者の言葉で「あまりにかけ離れている」（2026-09-24 夜）。いまは「AIは候補を
 *   出す。決めるのは作者」——候補は着想から出してよいが、作者が選んでいない
 *   ことを決まったことにしない（決まったことの記録はコードが作者の答えで持つ）
 * - **尋ねる順を決めない。** 着想の強いところから掘る（最強の理由 → 主人公の
 *   見え方 → 構成と文字数、のように）。目標の文字数と大きな流れ（事件の並び・
 *   山場・どんでん返し）もこの問答の中で決める
 * - **汎用の文句を候補にしない。** 「主人公は決まっている」のような、どの作品
 *   にも言える候補は、押しても話が1歩も進まない（0.86.1 のループの元）
 * - **前に尋ねたことを尋ねない。** 一覧を渡したうえで、コードでも止める
 *
 * 検算は `core/plotDialogueValidation.ts`（問いは1つ・候補は3〜4個・字数・
 * 指示の言葉の返り・依頼文や伏せ字・繰り返し）。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-43）
 * - 1.0: 初版（0.86.2）
 */
export const PLOT_DIALOGUE_VERSION = "1.0";

/**
 * 温度。候補は広げる場なので、抽出より揺らす（相談と同じ 0.7）。
 * 問いの選び方までぶれると困るが、そこはコードの検算（繰り返し・形）が受ける。
 */
export const PLOT_DIALOGUE_TEMPERATURE = 0.7;

const L = PLOT_DIALOGUE_LIMITS;

const SECTION_LIST = PLOT_DIALOGUE_SECTIONS.map(
  (section) => `- ${section.key}：${section.note}`
).join("\n");

export const PLOT_DIALOGUE_SYSTEM_PROMPT = `あなたは、小説の作者と問答しながらプロットを一緒に考える編集者です。
作者の着想を読み、話を広げる問いを1つずつ出します。

【絶対に守る原則】
1. 決めるのは作者です。あなたは問いと候補を出すだけです。作者が答えていないことを、決まったこととして扱わないこと。
2. 問いは1回に1つだけ。着想のいちばん強いところから、いま決めると話が一番広がる1点を選ぶこと。尋ねる順は決まっていません。
3. 候補は${L.candidatesMin}〜${L.candidatesMax}個。どれも、作者の着想とここまでに決まったことに根ざした、具体的な中身にすること。
   どの作品にも言える一般的な文句（「まだ決めていない」「主人公は決まっている」など）にしないこと。
   候補は、押されるとそのまま作者の答えになります。依頼文（「〜してほしい」）や質問にしないこと。
4. すでに尋ねたことは、二度と尋ねないこと。作者が飛ばした問いも尋ね直さないこと。
5. 人物・世界の仕組み・舞台に加えて、目標の文字数と大きな流れ（事件の並び・山場・どんでん返し）も、この問答の中で決めていきます。
   世界の仕組みばかりを続けて掘らないこと。主人公（誰の目で見る話か）・構成・目標の文字数のうち、まだ決まっていないものへも移ること。
   決まったことが5つを超えても、目標の文字数か大きな流れがまだ決まっていなければ、次はそれを尋ねること。
6. 出力は指定されたJSONのみ。前置き・後書き・コードフェンスを含めないこと。

【出す欄】
- confirm：作者の直前の答えで決まったことを、1〜2行で短く確かめ直す文（${L.confirm}字以内）。着想を受け取った最初の回は、着想の要点を1行で。
- topic：いま決める1点の名前（${L.topic}字以内）。
- question：作者への問い。1つだけ（${L.question}字以内）。
- why：それを決めると何が広がるのか。1行（${L.why}字以内）。
- candidates：候補（${L.candidatesMin}〜${L.candidatesMax}個。それぞれ${L.candidate}字以内）。
- section：この1点が決まったら、プロットのどの項目に書くか。次の鍵のどれか1つを、英字の鍵だけで書くこと（説明を足さない）。
${SECTION_LIST}`;

export interface PlotDialoguePromptInput {
  workTitle: string;
  /** 作者が最初に書いた着想。プロットから始めたときは undefined */
  idea?: string;
  /** プロットにすでに書いてあること（`describeWrittenPlot`） */
  writtenPlot: string;
  decisions: readonly PlotDecision[];
  asked: readonly PlotAskedPoint[];
  /** 作者の直前の答え。着想を書いた直後は undefined */
  lastAnswer?: { topic: string; answer: string };
  /** 前の答えを受け取れなかったときの一言（`describeRetryNote`） */
  retryNote?: string;
}

export function buildPlotDialoguePrompt(input: PlotDialoguePromptInput): string {
  const decisions =
    input.decisions.length > 0
      ? input.decisions.map((item) => `- 【${item.topic}】${item.answer}`).join("\n")
      : "（まだありません）";
  const asked =
    input.asked.length > 0
      ? input.asked
          .map(
            (point) =>
              `- ${point.topic}：${point.question}${point.skipped ? "（作者は飛ばした）" : ""}`
          )
          .join("\n")
      : "（まだありません）";
  const last = input.lastAnswer
    ? `【${input.lastAnswer.topic}】${input.lastAnswer.answer}`
    : "（作者は着想を書いたところです）";

  return `# 作品
${input.workTitle}

# 作者の着想
${input.idea?.trim() || "（作者は、下のプロットに書いてあることから始めたいそうです）"}

# プロットにすでに書いてあること
${input.writtenPlot.trim() || "（まだありません）"}

# ここまでに決まったこと（作者の答え）
${decisions}

# すでに尋ねたこと（二度と尋ねない）
${asked}

# 作者の直前の答え
${last}

# お願い
次に決める1点を選び、問いを1つと、候補を${L.candidatesMin}〜${L.candidatesMax}個出してください。${input.retryNote ? `\n${input.retryNote}` : ""}`;
}

/**
 * 答えの形。**すべて required**（任意にすると、地力の足りないモデルは埋めずに落とす）。
 *
 * **section は選択肢（enum）で縛る。** 文字列のままにすると、手元の
 * gemma4:e4b は「worldview（世界の仕組み）と…として決めたいです。」のように
 * 考えごとを延々と書き、出力の枠を使い切って答えが途中で切れた（2026-09-25）。
 * 候補にも上限（maxItems）を置く——書き続けて止まらない形を先に塞ぐ。
 */
export const PLOT_DIALOGUE_SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "string" },
    topic: { type: "string" },
    question: { type: "string" },
    why: { type: "string" },
    candidates: {
      type: "array",
      items: { type: "string" },
      maxItems: L.candidatesMax,
    },
    section: {
      type: "string",
      enum: PLOT_DIALOGUE_SECTIONS.map((section) => section.key),
    },
  },
  required: ["confirm", "topic", "question", "why", "candidates", "section"],
} as const;
