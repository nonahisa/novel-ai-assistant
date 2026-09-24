import { PLOT_DIALOGUE_LIMITS } from "../core/plotDialogueValidation";
import {
  PLOT_DIALOGUE_SECTIONS,
  type PlotAskedPoint,
  type PlotDecision,
} from "../core/plotInterview";
import {
  PLOT_FIELD_ORDER,
  plotStyleDef,
  type PlotDialogueStyle,
  type PlotFixedPoint,
  type PlotFrame,
} from "../core/plotDialogueStyles";
import { PLOT_SECTIONS } from "../core/plotDoc";

/**
 * P-43 対話式プロット作成（設計書6.4.7）
 *
 * 作者の答えを読み、次に決める1点について問いを1つ出し、着想に根ざした
 * 具体的な候補を3〜4つ添える。作者が答えたら、決まったことを短く確かめ直して
 * 次の1点を尋ねる。
 *
 * ## 型ごとに変わるところ（1.2）
 *
 * 作者は「これはプロット作成のパターンの一つ。これだけに固定しないで」と言い、
 * 4つの型を足すと選んだ（2026-09-25）。**型ごとにプロンプトを分けず、共通の
 * 決まりに「型の段」を差し込む。** 候補・繰り返し・確かめ直し・出す欄は全型で
 * 同じで、分けると片方だけ直る日が来る。型で変わるのは次の3つだけ。
 *
 * - 何を相手にするか（着想・書きたい場面・決めている結末）
 * - 次の1点の選び方（着想の強いところから／場面から外へ／結末からさかのぼる／
 *   **コードが決めた枠・項目1つだけ**）
 * - 流れの決まり（目標の文字数と大きな流れを、どこで尋ねるか）
 *
 * ## 何をさせて、何をさせないか
 *
 * - **候補は出させる。決めさせない。** 候補は着想から出してよいが、作者が
 *   選んでいないことを決まったことにしない（決まったことの記録はコードが
 *   作者の答えで持つ）
 * - **汎用の文句を候補にしない。** 「主人公は決まっている」のような、どの作品
 *   にも言える候補は、押しても話が1歩も進まない（0.86.1 のループの元）。
 *   **項目を順に埋める型でも同じ**——0.86.1 までの同じ順の用紙に戻すが、
 *   どの作品でも同じ前置きの選択肢には戻さない
 * - **前に尋ねたことを尋ねない。** 一覧を渡したうえで、コードでも止める
 *
 * 検算は `core/plotDialogueValidation.ts`（問いは1つ・候補は3〜4個・字数・
 * 指示の言葉の返り・依頼文や伏せ字・繰り返し・確かめ直しは1回まで）。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-43）
 * - 1.0: 初版（0.86.2）
 * - 1.1: 作者とリーダーが実際にやった問答を手本に足した（2026-09-25）。
 *   候補ごとに「選ぶと話がどう変わるか」（effect）を1行、答えが途中で切れて
 *   いる・どちらにも読めるときの確かめ直し（mode: clarify）、同じ問いの
 *   まま「ほかの案」を出す頼み、を足した
 * - 1.2: 型を足した（着想から掘る・場面から広げる・結末から逆算する・型に
 *   当てはめる・項目を順に埋める。2026-09-25）。共通の決まりに型の段を差し込む
 */
export const PLOT_DIALOGUE_VERSION = "1.2";

/**
 * 温度。候補は広げる場なので、抽出より揺らす（相談と同じ 0.7）。
 * 問いの選び方までぶれると困るが、そこはコードの検算（繰り返し・形）が受ける。
 */
export const PLOT_DIALOGUE_TEMPERATURE = 0.7;

const L = PLOT_DIALOGUE_LIMITS;

const SECTION_LIST = PLOT_DIALOGUE_SECTIONS.map(
  (section) => `- ${section.key}：${section.note}`
).join("\n");

/** 型ごとの段。**例に作品固有の言葉を書かない**（例がそのまま別の作品の候補に紛れ込む） */
const STYLE_PARTS: Record<
  PlotDialogueStyle,
  { intro: string; pick: string; flow: string }
> = {
  idea: {
    intro: "作者の着想を読み、話を広げる問いを1つずつ出します。",
    pick: "着想のいちばん強いところから、いま決めると話が一番広がる1点を選ぶこと。尋ねる順は決まっていません。",
    flow: `人物・世界の仕組み・舞台に加えて、目標の文字数と大きな流れ（事件の並び・山場・どんでん返し）も、この問答の中で決めていきます。
   世界の仕組みばかりを続けて掘らないこと。主人公（誰の目で見る話か）・構成・目標の文字数のうち、まだ決まっていないものへも移ること。
   決まったことが5つを超えても、目標の文字数か大きな流れがまだ決まっていなければ、次はそれを尋ねること。`,
  },
  scene: {
    intro: "作者には書きたい場面が1つあります。その場面を起点に、話を外へ広げる問いを1つずつ出します。",
    pick: "その場面に近いところから順に、話を外へ広げる1点を選ぶこと。場面の直前に何があったか、なぜ人物がその場面に至ったか、場面の直後に何が起きるか、その先どうなるか、のように。",
    flow: `場面の中の細部（台詞・描写・直前の心境・きっかけの小さな仕組み）は、1回尋ねたら続けて尋ねないこと。次は場面の外——人物がなぜそこにいるか・話の始まり・場面のあとの展開・話の終わり・目標の文字数——へ移ること。
   決まったことが5つを超えても、話の始まりか終わりか目標の文字数がまだ決まっていなければ、次はそれを尋ねること。`,
  },
  ending: {
    intro: "作者は話の終わり方を決めています。その結末から逆算して、そこへ至るのに必要な出来事を1つずつ尋ねます。",
    pick: "結末の直前から話の始まりへ向かってさかのぼり、その結末が成り立つのに欠かせない1点を選ぶこと。",
    flow: `結末は作者が決めたものです。結末を変える候補や、結末を疑う問いを出さないこと。
   候補は、決めている結末がそのまま成り立つものだけにすること。結末の意外さや意味を打ち消す候補（結末と食い違う理由づけ）を出さないこと。
   結末が響くために前もって置いておくこと（伏線）・主人公は誰か・話の始まり・目標の文字数も、さかのぼる中で決めていきます。
   決まったことが5つを超えても、話の始まりか目標の文字数がまだ決まっていなければ、次はそれを尋ねること。`,
  },
  structure: {
    intro: "作者が選んだ物語の型の枠を、決まった順に1つずつ埋める問いを出します。",
    pick: "尋ねるのは、依頼文の「次に埋める枠」に書いてある枠1つだけです。ほかの枠を先に尋ねないこと。",
    flow: `候補は、その枠に入る出来事を、作者の着想とここまでに決まったことから出すこと。前の枠で決まった出来事とつながるようにすること。
   枠の説明の文をそのまま問いや候補にしないこと。この作品ならどんな出来事になるかを書くこと。`,
  },
  fields: {
    intro: "プロットの項目を決まった順に1つずつ埋める問いを出します。",
    pick: "尋ねるのは、依頼文の「次に埋める項目」に書いてある項目1つだけです。ほかの項目を先に尋ねないこと。",
    flow: `候補は、その項目に入る中身を、作者の着想とここまでに決まったことから出すこと。
   どの作品にも同じになる候補（書き方の名前だけ、など）にせず、この作品ならどうなるかを添えること。`,
  },
};

/**
 * 型ごとのシステムの指示。共通の決まり（1・3・4・6・7）に、型の段（2・5）を差し込む。
 */
export function buildPlotDialogueSystemPrompt(style: PlotDialogueStyle): string {
  const part = STYLE_PARTS[style];
  return `あなたは、小説の作者と問答しながらプロットを一緒に考える編集者です。
${part.intro}

【絶対に守る原則】
1. 決めるのは作者です。あなたは問いと候補を出すだけです。作者が答えていないことを、決まったこととして扱わないこと。
2. 問いは1回に1つだけ。${part.pick}
3. 候補は${L.candidatesMin}〜${L.candidatesMax}個。どれも、作者の着想とここまでに決まったことに根ざした、具体的な中身にすること。
   どの作品にも言える一般的な文句（「まだ決めていない」「主人公は決まっている」など）にしないこと。
   候補は、押されるとそのまま作者の答えになります。依頼文（「〜してほしい」）や質問にしないこと。
   候補は叩き台です。作者は選ぶだけでなく、組み合わせたり、自分の言葉で書いたりします。
4. すでに尋ねたことは、二度と尋ねないこと。作者が飛ばした問いも尋ね直さないこと。
5. ${part.flow}
6. 作者の直前の答えが途中で切れている、またはどちらの意味にも読めるときは、推測で先へ進まないこと。
   そのときだけ mode を clarify にし、その答えの読み方を尋ね、解釈を候補に並べること（確かめ直しは1回まで）。
   それ以外は mode を ask にすること。
7. 出力は指定されたJSONのみ。前置き・後書き・コードフェンスを含めないこと。

【出す欄】
- mode：ask（次の1点を尋ねる）か clarify（直前の答えの読み方を確かめる）。
- confirm：作者の直前の答えで決まったことを、1〜2行で短く確かめ直す文（${L.confirm}字以内）。最初の回は、作者が書いたことの要点を1行で。
- topic：いま決める1点の名前（${L.topic}字以内）。
- question：作者への問い。1つだけ（${L.question}字以内）。
- why：それを決めると何が広がるのか。1行（${L.why}字以内）。
- candidates：候補（${L.candidatesMin}〜${L.candidatesMax}個）。それぞれ text（候補そのもの。${L.candidate}字以内）と effect（これを選ぶと話がどう変わるか。1行、${L.effect}字以内）。
- section：この1点が決まったら、プロットのどの項目に書くか。次の鍵のどれか1つを、英字の鍵だけで書くこと（説明を足さない）。
${SECTION_LIST}`;
}

/** 着想から掘る型の指示（0.86.2 からの名前。ほかの型は `buildPlotDialogueSystemPrompt`） */
export const PLOT_DIALOGUE_SYSTEM_PROMPT = buildPlotDialogueSystemPrompt("idea");

export interface PlotDialoguePromptInput {
  workTitle: string;
  /** 型。省けば「着想から掘る」 */
  style?: PlotDialogueStyle;
  /** 型に当てはめるときの型 */
  frame?: PlotFrame;
  /** コードが決めた次の1点（型に当てはめる・項目を順に埋める） */
  fixedPoint?: PlotFixedPoint;
  /** 作者が最初に書いたこと（着想・場面・結末）。プロットから始めたときは空 */
  idea?: string;
  /** プロットにすでに書いてあること（`describeWrittenPlot`） */
  writtenPlot: string;
  decisions: readonly PlotDecision[];
  asked: readonly PlotAskedPoint[];
  /** 作者の直前の答え。着想を書いた直後は undefined */
  lastAnswer?: { topic: string; answer: string };
  /**
   * 「ほかの案もほしい」と頼まれた問い。**問いは変えず**、見せた案と違う案を出させる
   */
  more?: { topic: string; question: string; shown: readonly string[] };
  /** 直前の答えを確かめ直してよい回か（確かめ直しへの答えには許さない） */
  mayClarify?: boolean;
  /** 前の答えを受け取れなかったときの一言（`describeRetryNote`） */
  retryNote?: string;
}

export function buildPlotDialoguePrompt(input: PlotDialoguePromptInput): string {
  const style = input.style ?? "idea";
  const def = plotStyleDef(style);
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
    : `（作者は${def.seedTopic}を書いたところです）`;

  // 型に当てはめる・項目を順に埋めるときは、全体の並びも見せる（前後のつながりのため）
  const outline: string[] = [];
  if (style === "structure" && input.frame) {
    outline.push(
      "# 型の枠（この順に埋める）",
      `${input.frame.label}：` +
        input.frame.beats.map((beat) => `${beat.name}（${beat.note}）`).join(" → ")
    );
  } else if (style === "fields") {
    outline.push(
      "# 項目の順",
      PLOT_FIELD_ORDER.map(
        (key) => PLOT_SECTIONS.find((item) => item.key === key)?.heading ?? key
      ).join(" → ")
    );
  }

  const fixed = input.fixedPoint;
  const fixedLabel = style === "structure" ? "次に埋める枠" : "次に埋める項目";
  const ask = fixed
    ? `【${fixed.topic}】について、問いを1つと、候補を${L.candidatesMin}〜${L.candidatesMax}個出してください（topic は「${fixed.topic}」）。`
    : style === "scene"
      ? `場面から外へ広げる次の1点を選び、問いを1つと、候補を${L.candidatesMin}〜${L.candidatesMax}個出してください。`
      : style === "ending"
        ? `結末からさかのぼって次に決める1点を選び、問いを1つと、候補を${L.candidatesMin}〜${L.candidatesMax}個出してください。`
        : `次に決める1点を選び、問いを1つと、候補を${L.candidatesMin}〜${L.candidatesMax}個出してください。`;

  const request = input.more
    ? [
        `作者は、いまの問い「【${input.more.topic}】${input.more.question}」について、ほかの案を求めています。`,
        "問いは変えずに、下の案とは違う候補を、多めに出してください（mode は ask、topic と question はそのまま）。",
        "もう見せた案：",
        ...input.more.shown.map((text) => `- ${text}`),
      ].join("\n")
    : ask + (input.mayClarify ? "" : "\nこの回は確かめ直しをしないこと（mode は ask）。");

  return [
    "# 作品",
    input.workTitle,
    "",
    "# 問答の型",
    def.label,
    "",
    ...(outline.length > 0 ? [...outline, ""] : []),
    `# ${def.seedHeading}`,
    input.idea?.trim() || "（作者は、下のプロットに書いてあることから始めたいそうです）",
    "",
    "# プロットにすでに書いてあること",
    input.writtenPlot.trim() || "（まだありません）",
    "",
    "# ここまでに決まったこと（作者の答え）",
    decisions,
    "",
    "# すでに尋ねたこと（二度と尋ねない）",
    asked,
    "",
    "# 作者の直前の答え",
    input.more ? "（作者は、いまの問いのほかの案を求めています）" : last,
    "",
    ...(fixed && !input.more
      ? [`# ${fixedLabel}（ここだけを尋ねる）`, `【${fixed.topic}】${fixed.note}`, ""]
      : []),
    "# お願い",
    request + (input.retryNote ? `\n${input.retryNote}` : ""),
  ].join("\n");
}

/**
 * 答えの形。**すべて required**（任意にすると、地力の足りないモデルは埋めずに落とす）。
 *
 * **section は選択肢（enum）で縛る。** 文字列のままにすると、手元の
 * gemma4:e4b は「worldview（世界の仕組み）と…として決めたいです。」のように
 * 考えごとを延々と書き、出力の枠を使い切って答えが途中で切れた（2026-09-25）。
 * 候補にも上限（maxItems）を置く——書き続けて止まらない形を先に塞ぐ。
 * 上限は「ほかの案」の多いほう（検算が普段の回を4つに切る）。
 */
export const PLOT_DIALOGUE_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["ask", "clarify"] },
    confirm: { type: "string" },
    topic: { type: "string" },
    question: { type: "string" },
    why: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          effect: { type: "string" },
        },
        required: ["text", "effect"],
      },
      maxItems: L.moreMax,
    },
    section: {
      type: "string",
      enum: PLOT_DIALOGUE_SECTIONS.map((section) => section.key),
    },
  },
  required: ["mode", "confirm", "topic", "question", "why", "candidates", "section"],
} as const;
