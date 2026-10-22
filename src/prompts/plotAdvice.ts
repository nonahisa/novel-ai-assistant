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
  plotAdviceFieldsNamed,
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
 * - **渡すかどうかもコードが決める**（`plotAdviceFieldToRecommend`）。作者の
 *   発言が項目を名指ししている回と、編集者がもう勧めた項目は渡さない（1.1）
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
 * - 1.1: 勧める項目の段を「話が途切れたときに勧める項目（まだ勧めていません）」
 *   に改め、作者が項目を名指しした回・編集者がもう勧めた項目は渡さない。
 *   振る舞い3に「決めて書いてと頼まれたら書き込み案を先に」を足した。
 *   1.0 では空欄の先頭（主人公の行動原理）が毎回入り、gemma4:e4b が「前に勧めた
 *   こと」と読んで9問中5問で話を戻し、行動原理を決めて「入れて」と頼んでも
 *   案を出さずに問いを重ねた（2026-10-23、0.110.2）
 */
export const PLOT_ADVICE_VERSION = "1.1";

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
3. まだ書かれていない項目のうち、作者が話していない項目の名前は挙げないこと。依頼文に「話が途切れたときに勧める項目」があるときだけ、作者の発言に答えたうえで、話の続きが見えないときに、その項目を1つだけ勧めること。その項目はまだ勧めていないので、前に勧めたように書かないこと。作者がある項目の中身を決めて「書いて」「入れて」と頼んだときは、問いを重ねずに、その項目の書き込み案を出すことを先にすること。
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

/**
 * 推奨順で最初のまだ書かれていない項目。全部書いてあれば undefined。
 * 依頼文へ渡すかどうかは `plotAdviceFieldToRecommend` が決める。
 */
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

/**
 * 今回の依頼文で「話が途切れたときに勧める項目」として渡す項目。渡さない回は undefined。
 *
 * - **作者の今回の発言が、書いてよい項目をどれか名指ししていれば渡さない。**
 *   1.0 は空欄の先頭を毎回渡していたため、作者が世界観を相談しても、行動原理を
 *   決めて「入れて」と頼んでも、依頼文は「行動原理はまだ空・次に考えて」と
 *   言っていた。名指しした項目だけを外してほかを渡すと、作者の話からそらす
 *   勧めになるので、その回は何も渡さない。**見るのは今回の発言だけ**——履歴まで
 *   見ると、一度名指ししただけで10往復のあいだ勧めが止まる
 * - **編集者が履歴でもう勧めた項目は渡さない。** 見出しで「まだ勧めていません」
 *   と言うので、それが嘘にならないようにする（同じ項目を毎回勧め直さない）
 */
export function plotAdviceFieldToRecommend(
  input: Pick<PlotAdvicePromptInput, "sections" | "userMessage" | "history">
): PlotDialogueSection | undefined {
  if (plotAdviceFieldsNamed([input.userMessage]).length > 0) return undefined;
  const next = nextPlotAdviceField(input.sections);
  if (!next) return undefined;
  const heading = headingOf(next);
  const already = recentPlotAdviceHistory(input.history).some(
    (turn) => turn.role === "assistant" && turn.text.normalize("NFKC").includes(heading)
  );
  return already ? undefined : next;
}

/**
 * 勧める項目の段。**指示の言葉は答えとして返ってくる**（CLAUDE.md の繰り返し
 * 起きた失敗3）ので、返ってきても害の無い言い方にする。1.0 の「次に考えると
 * よい項目」は、e4b が「次に考えるとよい項目として〜を提案しましたが」と、
 * 前に勧めたことのように返した。「話が途切れたとき」で作者の話が先だと分かり、
 * 「まだ勧めていません」で前の勧めとして読まれないようにする。
 * 渡す項目が無く、名指しもされていない回（全部書いてある）は噛み合いを見させる。
 * 名指しがあった回は段ごと出さない（代わりの指示文を書くと、それが返ってくる）。
 */
function recommendBlock(input: PlotAdvicePromptInput): string {
  const field = plotAdviceFieldToRecommend(input);
  if (field) {
    return `【話が途切れたときに勧める項目（まだ勧めていません）】
${headingOf(field)}

`;
  }
  const named = plotAdviceFieldsNamed([input.userMessage]).length > 0;
  if (!named && !nextPlotAdviceField(input.sections)) {
    return `【話が途切れたときに勧める項目】
（ありません。書いてある項目どうしの噛み合いを見てください）

`;
  }
  return "";
}

export function buildPlotAdvicePrompt(input: PlotAdvicePromptInput): string {
  const written = describeWrittenPlot(input.sections, input.extra ?? "");
  const empty = emptyPlotAdviceFields(input.sections).map(headingOf);
  const history = recentPlotAdviceHistory(input.history)
    .map((turn) => `${turn.role === "author" ? "作者" : "編集者"}：${turn.text.trim()}`)
    .join("\n");

  return `# 作品
${input.workTitle}

【いまのプロット】
${written || "（まだ何も書かれていません）"}

【まだ書かれていない項目】
${empty.length > 0 ? empty.join("、") : "（ありません）"}

${recommendBlock(input)}【これまでの会話】
${history || "（これが最初の発言です）"}

【作者の発言】
${input.userMessage.trim()}`;
}
