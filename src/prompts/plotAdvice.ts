import {
  PLOT_SECTIONS,
  isBlankPlotSection,
  type PlotSections,
} from "../core/plotDoc";
import {
  describeWrittenPlot,
  isPlotDialogueSection,
  type PlotDialogueSection,
} from "../core/plotInterview";
import {
  PLOT_ADVICE_MAX_QUESTIONS,
  PLOT_ADVICE_SUGGESTION_MARK,
} from "../core/plotAdviceValidation";

/**
 * P-01 プロットモードのAI助言（設計書6.4.10、プロンプト設計書 P-01）
 *
 * プロットモードの画面で、作者が自由に話しかけ、AIが編集者としてプロットの
 * 組み立てを手伝う。対話式プロット作成（P-43）が**候補を選ぶ形**なのに対し、
 * こちらは**自由な会話とプロット全体の見直し**を受け持つ。
 *
 * ## 決まり（P-01 の節）
 *
 * - 作者の作りたいものを引き出すのが第一。AIのアイデアで上書きしない
 * - 1回の問いは1〜2個まで
 * - 未記入の項目があれば、次に考えるとよい項目を1つだけ勧める
 * - 曖昧さ・食い違いは否定せず問いの形で確かめる
 * - 答えは自然文。書き込み案があるときだけ末尾に区切りと JSON
 *
 * ## コードが受け持つところ
 *
 * - **次に勧める1項目はコードが決めて渡す**（`nextPlotAdviceField`）。P-43 で
 *   「頼むだけでは守られなかった」（目標の文字数を10本とも尋ねなかった）
 *   のと同じで、推奨順をAIに任せると飛ばしたり2つ挙げたりする
 * - 案の読み取り・作者の文の書き換えの見張りは `core/plotAdviceValidation.ts`
 * - 書くのは作者が［この案をプロットに書く］を押したときだけ（`features/plotAdvice.ts`）
 *
 * ## 指示語を返させない書き方
 *
 * 設計書の雛形にあった `{"field": "対象項目名", "value": "書き込む内容"}` は
 * **そのまま書かない**。雛形の言葉は答えの中身として返ってくる（CLAUDE.md の
 * 繰り返し起きた失敗3）。JSON の形は文で説明し、項目の名前は実在の見出しの
 * 一覧から選ばせる。曖昧さを確かめる例文（設計書の「復讐」の例）も書かない
 * ——例に作品固有の言葉を書くと、別の作品の答えに紛れ込む。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-01）
 * - 1.0: 初版（0.100.x）
 */
export const PLOT_ADVICE_VERSION = "1.0";

/** 温度。会話で引き出す場なので、相談・対話式プロット作成と同じだけ揺らす */
export const PLOT_ADVICE_TEMPERATURE = 0.7;

/** 渡す履歴の往復の数（P-01「直近10ターン」）。1往復＝作者の発言とAIの答え */
export const PLOT_ADVICE_HISTORY_TURNS = 10;

/**
 * 次に考えるとよい項目の推奨順（P-01）。
 *
 * 設計の節は「舞台・世界観」を1つに書いているが、plot.md では2つの見出し
 * なので、舞台 → 世界観の順に並べる。**タイトルは入れない**——作品を作る
 * ときに決めてあり（6.4.5）、書き込み案の対象にもしない
 * （`plotAdviceValidation.ts` の `sectionOf`）。
 */
export const PLOT_ADVICE_FIELD_ORDER: readonly PlotDialogueSection[] = [
  "logline",
  "theme",
  "protagonistMotive",
  "setting",
  "worldview",
  "outline",
  "mainCharacters",
  "motif",
  "narrativePerson",
];

/** 書き込み案に書いてよい項目の見出し（プロンプトに並べる一覧） */
const WRITABLE_HEADINGS = PLOT_SECTIONS.filter((entry) =>
  isPlotDialogueSection(entry.key)
).map((entry) => entry.heading);

export const PLOT_ADVICE_SYSTEM_PROMPT = `あなたは経験豊富な小説の編集者です。作者がプロットを組み立てるのを、会話で手伝います。

【振る舞い】
1. 作者の作りたいものを引き出すことを、いちばん大事にすること。あなたのアイデアで作者の考えを上書きしないこと。
2. 一度に多くを聞かないこと。問いは${PLOT_ADVICE_MAX_QUESTIONS}つまでにすること。
3. 依頼文に「次に考えるとよい項目」があり、作者の発言がほかの話でなければ、その項目を1つだけ勧めること。ほかのまだ書かれていない項目の名前は挙げないこと。
4. 作者の書いたことに曖昧なところや食い違うところがあれば、否定せずに、問いの形で確かめること。
5. ログラインは「誰が」「どんな状況で」「何を目指し」「何が障害か」の4つがそろっているかを見ること。
6. テーマとあらすじが噛み合っているかを気にかけ、ずれていれば問いの形で伝えること。
7. 中身の無い相づちだけで終えないこと。作者の書いたことの具体的なところに触れること。
8. 答えは普通の文で書くこと。見出しや箇条書きを並べた報告にしないこと。

【プロットへの書き込み案】
作者の発言から、ある項目へ書く中身がはっきり決まったときだけ、答えの最後に ${PLOT_ADVICE_SUGGESTION_MARK} の1行を書き、その次の行に JSON を1つだけ書くこと。
JSON の鍵は field と value の2つ。field には、書く項目の見出しを次の一覧から1つ選んで、そのまま書くこと：${WRITABLE_HEADINGS.join("、")}
value には、作者の言葉を生かして、その項目に書く文を書くこと。作者が言っていないことを足さないこと。
まだ決まっていないとき、作者が迷っているときは、${PLOT_ADVICE_SUGGESTION_MARK} も JSON も書かないこと。`;

/** 会話の1件 */
export interface PlotAdviceTurn {
  role: "author" | "assistant";
  text: string;
}

export interface PlotAdvicePromptInput {
  workTitle: string;
  /** いま plot.md に書いてある中身（項目ごと）と、作者が足した節 */
  sections: PlotSections;
  extra?: string;
  /** 今回の作者の発言 */
  userMessage: string;
  /** これまでの会話（古い順）。渡すのは末尾の `PLOT_ADVICE_HISTORY_TURNS` 往復だけ */
  history: readonly PlotAdviceTurn[];
}

/** まだ書かれていない、書いてよい項目（推奨順ではなく plot.md の並び） */
export function emptyPlotAdviceFields(sections: PlotSections): PlotDialogueSection[] {
  return PLOT_SECTIONS.filter(
    (entry) =>
      isPlotDialogueSection(entry.key) && isBlankPlotSection(sections[entry.key] ?? "")
  ).map((entry) => entry.key as PlotDialogueSection);
}

/** 次に考えるとよい項目（推奨順で最初のまだ書かれていない項目）。全部書いてあれば undefined */
export function nextPlotAdviceField(
  sections: PlotSections
): PlotDialogueSection | undefined {
  return PLOT_ADVICE_FIELD_ORDER.find((key) =>
    isBlankPlotSection(sections[key] ?? "")
  );
}

/**
 * 渡す履歴を切る。**往復で数える**（作者の発言1件＋AIの答え1件で1往復）。
 * 途中で切れて答えだけが先頭に残ると、何への答えか分からないので落とす。
 */
export function recentPlotAdviceHistory(
  history: readonly PlotAdviceTurn[],
  turns = PLOT_ADVICE_HISTORY_TURNS
): PlotAdviceTurn[] {
  const recent = history.slice(-turns * 2);
  while (recent.length > 0 && recent[0].role !== "author") recent.shift();
  return recent;
}

function headingOf(key: PlotDialogueSection): string {
  return PLOT_SECTIONS.find((entry) => entry.key === key)?.heading ?? key;
}

export function buildPlotAdvicePrompt(input: PlotAdvicePromptInput): string {
  const written = describeWrittenPlot(input.sections, input.extra ?? "");
  const empty = emptyPlotAdviceFields(input.sections).map(headingOf);
  const next = nextPlotAdviceField(input.sections);
  const history = recentPlotAdviceHistory(input.history)
    .map((turn) => `${turn.role === "author" ? "作者" : "編集者"}：${turn.text.trim()}`)
    .join("\n");

  return `# 作品
${input.workTitle}

【いまのプロット】
${written || "（まだ何も書かれていません）"}

【まだ書かれていない項目】
${empty.length > 0 ? empty.join("、") : "（ありません）"}

【次に考えるとよい項目】
${next ? headingOf(next) : "（ありません。書いてある項目どうしの噛み合いを見てください）"}

【これまでの会話】
${history || "（これが最初の発言です）"}

【作者の発言】
${input.userMessage.trim()}`;
}
