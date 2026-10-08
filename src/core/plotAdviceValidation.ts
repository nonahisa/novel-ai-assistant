import { isPlaceholderText } from "./placeholderText";
import {
  PLOT_SECTIONS,
  isBlankPlotSection,
  type PlotSectionKey,
  type PlotSections,
} from "./plotDoc";
import {
  isPlaceholderContent,
  isPlotDialogueSection,
  type PlotDialogueSection,
} from "./plotInterview";
import { similarity } from "./plotDialogueValidation";
import { stripCodeFence } from "./synopsisValidation";

/**
 * プロットモードのAI助言（P-01、設計書6.4.10）の答えを、コードで確かめる。
 *
 * **AIの出力を信用しない**（実装ルール3）。P-01 の答えは自然文で、
 * プロットへの書き込み案があるときだけ末尾に区切りと JSON が付く。
 * ここで見るのは次のとおり。
 *
 * - **案の JSON が壊れている・項目が分からない・中身が雛形の写し**：
 *   案だけを捨てて、会話の文は出す（会話まで捨てると、作者は待たされた
 *   うえに何も受け取れない）
 * - **作者が書いた項目を、言い回しだけ変えて返した案**：落とす。作者の文を
 *   AIの言い回しで塗り替えることになる（実装ルール2の考え方）
 * - **書いてある項目を別の中身で埋める案**：落とさずに「上書きになる」と
 *   印を付ける。書く前に画面が確認を出す
 * - **作者の発言に無い言葉が多い案**：落とさずに印を付ける（作者の作りたい
 *   ものを引き出すのが第一で、AIのアイデアで上書きしない——P-01 の決まり。
 *   ただし作者が「それで」と言った案を落とすと困るので、見分けは作者に任せる）
 * - **問いが3つ以上・未記入の項目を2つ以上勧める**：会話は出したまま、
 *   ログにだけ残す（振る舞いの決まりを守れていないことを、あとで測れるように）
 *
 * VS Code API に依存しない。
 */

/** 書き込み案の前に置く区切り（プロンプトへもここから埋め込む） */
export const PLOT_ADVICE_SUGGESTION_MARK = "---SUGGESTION---";

/**
 * 1回の答えで許す問いの数（P-01「質問は1〜2個まで」）。
 * **これを超えても文は捨てない**——ログに残すだけ。
 */
export const PLOT_ADVICE_MAX_QUESTIONS = 2;

/**
 * 案の中身の上限。プロットの1項目としては長すぎる量が来たら、
 * 案ではなく下書きを書いている（「サポートは書かない」）ので落とす。
 */
export const PLOT_ADVICE_VALUE_MAX = 600;

/**
 * 作者が書いた文の言い換えとみなす似かた（2字組の重なり）。
 * これ以上似ていて同じでない案は、作者の文を書き換えたものとして落とす。
 */
const REWRITE_SIMILARITY = 0.6;

/**
 * 作者の発言に根ざしているとみなす割合（案の2字組のうち、作者の発言にも
 * あるもの）。下回れば「作者の発言に無い言葉が多い」と印を付ける。
 * 実接続で測っていない値なので、落とす線には使わない。
 */
const GROUNDED_RATIO = 0.5;

/**
 * 雛形の言葉。**プロンプトに書いた指示語は答えとして返ってくる**
 * （CLAUDE.md の繰り返し起きた失敗3）。設計書の雛形にあった
 * 「対象項目名」「書き込む内容」はプロンプトには書かないが、モデルが
 * 似た言葉で埋めてくる前提で名指しで落とす。
 */
const ECHO_WORDS = [
  "対象項目名",
  "項目名",
  "書き込む内容",
  "書き込む文",
  "項目へ書く文",
  "見出しの名前",
  // P-01 1.0 のプロンプトが JSON の形を説明する文の言葉（`prompts/plotAdvice.ts`）
  "項目の見出し",
  "その項目に書く文",
  "作者の言葉を生かして",
];

/** プロンプトの段の見出し。答えにそのまま写ってきたら、その行は捨てる */
export const PLOT_ADVICE_PROMPT_LABELS = [
  "【いまのプロット】",
  "【まだ書かれていない項目】",
  "【次に考えるとよい項目】",
  "【これまでの会話】",
  "【作者の発言】",
];

export type PlotAdviceDropReason =
  /** 区切りの後ろが JSON として読めない */
  | "broken_json"
  /** field が書いてよい項目の見出しにも鍵にも当たらない */
  | "unknown_field"
  /** value が空・伏せ字・雛形の言葉 */
  | "placeholder_value"
  /** value が長すぎる（下書きを書いている） */
  | "too_long"
  /** 作者が書いた中身と同じ（書く意味が無い） */
  | "already_written"
  /** 作者が書いた中身の言い換え */
  | "rewrites_author";

/** 画面へ出せる書き込み案 */
export interface PlotAdviceSuggestion {
  section: PlotDialogueSection;
  heading: string;
  value: string;
  /** 書いてある項目を別の中身で置き換える案（書く前に確認を出す） */
  overwrites: boolean;
  /** 作者の発言に根ざしているか（無い言葉が多ければ false。画面で一言添える） */
  grounded: boolean;
}

/** 読み取った答え */
export interface PlotAdviceAnswer {
  /** 作者に見せる会話の文。空なら答えが無かった */
  reply: string;
  suggestion?: PlotAdviceSuggestion;
  /** 案を捨てた理由（捨てていなければ無い） */
  dropped?: PlotAdviceDropReason;
  /** 振る舞いの決まりを守れていないところ（ログにだけ残す） */
  warnings: string[];
  /** 区切りの後ろの生の文字列（捨てたときにログへ残す） */
  rawSuggestion?: string;
}

export interface PlotAdviceCheckContext {
  /** いま plot.md に書いてある中身（項目ごと） */
  sections: PlotSections;
  /** 作者の発言（今回と、渡した履歴の作者の分）。根ざしているかを見る */
  authorTexts: readonly string[];
}

/**
 * AIの答えを読み取る。
 *
 * **案は区切りの後ろだけから取る。** 区切りが無ければ案は無い——本文の
 * 途中に JSON らしきものがあっても、作者が読む会話の一部として扱う
 * （拾うと、会話の例示をプロットへ書く道ができる）。
 */
export function parsePlotAdviceAnswer(
  text: string,
  context: PlotAdviceCheckContext
): PlotAdviceAnswer {
  const warnings: string[] = [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const at = normalized.indexOf(PLOT_ADVICE_SUGGESTION_MARK);
  const talk = at < 0 ? normalized : normalized.slice(0, at);
  const tail =
    at < 0 ? "" : normalized.slice(at + PLOT_ADVICE_SUGGESTION_MARK.length);

  const cleaned = stripPromptLabels(talk);
  if (cleaned.removed > 0) {
    warnings.push(`指示の見出しが答えに写っていたので ${cleaned.removed} 行を外しました`);
  }
  const reply = cleaned.text.trim();

  const questions = countQuestions(reply);
  if (questions > PLOT_ADVICE_MAX_QUESTIONS) {
    warnings.push(`問いが ${questions} 個ありました（決まりは${PLOT_ADVICE_MAX_QUESTIONS}個まで）`);
  }
  const named = emptyHeadingsNamed(reply, context.sections);
  if (named.length >= 2) {
    warnings.push(
      `未記入の項目を ${named.length} つ挙げていました（${named.join("・")}。決まりは1つだけ）`
    );
  }

  if (at < 0) return { reply, warnings };

  // 区切りが2回出たら、最初の区切りの後ろから次の区切りの前までを見る
  const raw = tail.split(PLOT_ADVICE_SUGGESTION_MARK)[0].trim();
  if (tail.includes(PLOT_ADVICE_SUGGESTION_MARK)) {
    warnings.push("区切りが2回以上ありました（最初の案だけを見ます）");
  }
  const result = readSuggestion(raw, context);
  if ("dropped" in result) {
    return { reply, warnings, dropped: result.dropped, rawSuggestion: raw };
  }
  return { reply, warnings, suggestion: result.suggestion };
}

function readSuggestion(
  raw: string,
  context: PlotAdviceCheckContext
): { suggestion: PlotAdviceSuggestion } | { dropped: PlotAdviceDropReason } {
  const parsed = parseObject(raw);
  if (!parsed) return { dropped: "broken_json" };

  const field = typeof parsed.field === "string" ? parsed.field : "";
  const section = sectionOf(field);
  if (!section) return { dropped: "unknown_field" };

  const value = typeof parsed.value === "string" ? parsed.value.trim() : "";
  if (isEchoOrPlaceholder(value)) return { dropped: "placeholder_value" };
  if (value.length > PLOT_ADVICE_VALUE_MAX) return { dropped: "too_long" };

  const current = context.sections[section] ?? "";
  const blank = isBlankPlotSection(current);
  if (!blank) {
    const now = stripComments(current);
    if (now === value) return { dropped: "already_written" };
    if (similarity(now, value) >= REWRITE_SIMILARITY) {
      return { dropped: "rewrites_author" };
    }
  }

  const heading =
    PLOT_SECTIONS.find((entry) => entry.key === section)?.heading ?? section;
  return {
    suggestion: {
      section,
      heading,
      value,
      overwrites: !blank,
      grounded: groundedRatio(value, context.authorTexts) >= GROUNDED_RATIO,
    },
  };
}

/** JSON の物を1つ読む。コードフェンス・前後の飾りは剥がす */
function parseObject(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const body = stripCodeFence(raw);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * field を書いてよい項目へ当てる。**見出し（ログライン）と鍵（logline）の
 * 両方を受ける**——プロンプトでは見出しで頼むが、モデルは鍵で返すことがある。
 *
 * 書いてよいのは対話式プロット作成と同じ項目（タイトル・形式・ジャンルを除く）。
 * タイトルは作品を作るときに決め、形式・ジャンルは作品の扱いを決める値なので、
 * 会話の流れで書き換えない（設計書6.4.5・6.4.7）。
 */
export function sectionOf(field: string): PlotDialogueSection | undefined {
  const name = field
    .normalize("NFKC")
    .trim()
    .replace(/^[【「『\[]|[】」』\]]$/gu, "")
    .replace(/^#+\s*/u, "")
    .trim();
  if (!name) return undefined;
  const byHeading = PLOT_SECTIONS.find((entry) => entry.heading === name);
  const key: PlotSectionKey | undefined =
    byHeading?.key ??
    PLOT_SECTIONS.find((entry) => entry.key.toLowerCase() === name.toLowerCase())?.key;
  return key && isPlotDialogueSection(key) ? key : undefined;
}

function isEchoOrPlaceholder(value: string): boolean {
  if (!value) return true;
  if (isPlaceholderContent(value) || isPlaceholderText(value)) return true;
  const flat = value.replace(/\s/gu, "");
  return ECHO_WORDS.some((word) => flat === word || flat.includes(`${word}を`) || flat.startsWith(word));
}

/** 指示の見出しだけの行を外す */
function stripPromptLabels(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split("\n").filter((line) => {
    const flat = line.trim();
    if (PLOT_ADVICE_PROMPT_LABELS.some((label) => flat.startsWith(label))) {
      removed++;
      return false;
    }
    return true;
  });
  return { text: kept.join("\n"), removed };
}

/**
 * 問いの数。「？」「?」で終わる文を数える。
 * 引用の中（「…？」）は作者の言葉の写しなので数えない。
 */
export function countQuestions(text: string): number {
  const outside = text.replace(/「[^」]*」|『[^』]*』/gu, "");
  return (outside.match(/[？?]+/gu) ?? []).length;
}

/** 答えの中で名前が出た、未記入の項目の見出し */
function emptyHeadingsNamed(text: string, sections: PlotSections): string[] {
  return PLOT_SECTIONS.filter(
    (entry) =>
      isPlotDialogueSection(entry.key) &&
      isBlankPlotSection(sections[entry.key] ?? "") &&
      text.includes(entry.heading)
  ).map((entry) => entry.heading);
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** 案の2字組のうち、作者の発言にもあるものの割合（0〜1） */
function groundedRatio(value: string, authorTexts: readonly string[]): number {
  const grams = bigrams(value);
  if (grams.length === 0) return 1;
  const source = new Set(bigrams(authorTexts.join("\n")));
  const hit = grams.filter((gram) => source.has(gram)).length;
  return hit / grams.length;
}

function bigrams(text: string): string[] {
  const body = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s、。，．,.！!？?「」『』（）()【】・…ー\-]/gu, "");
  const out: string[] = [];
  for (let i = 0; i < body.length - 1; i++) out.push(body.slice(i, i + 2));
  return out;
}

/**
 * 案を捨てた理由を、ログに残す言葉にする（画面には出さない。作者には
 * 「案は出せませんでした」程度で足りる）。
 */
export function describePlotAdviceDrop(reason: PlotAdviceDropReason): string {
  switch (reason) {
    case "broken_json":
      return "書き込み案の形が読めませんでした";
    case "unknown_field":
      return "書き込み案の項目が、書ける項目に当たりませんでした";
    case "placeholder_value":
      return "書き込み案の中身が空か、雛形の言葉でした";
    case "too_long":
      return "書き込み案が長すぎました（項目の案ではなく下書きでした）";
    case "already_written":
      return "書き込み案が、もう書いてある中身と同じでした";
    case "rewrites_author":
      return "書き込み案が、作者の書いた文の言い換えでした";
  }
}
