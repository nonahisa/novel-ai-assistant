import { isPlaceholderText } from "./placeholderText";
import {
  PLOT_END_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_WRITE_OPTION,
  isPlaceholderContent,
  isPlotDialogueSection,
  isRequestLikeOption,
  PLOT_DIALOGUE_SECTIONS,
  type PlotAskedPoint,
  type PlotDialogueSection,
} from "./plotInterview";
import { stripCodeFence } from "./synopsisValidation";

/**
 * 対話式プロット作成（P-43、設計書6.4.7）のAIの答えを、コードで確かめる。
 *
 * **AIの出力を信用しない**（実装ルール3）。とくに問答では、確かめずに
 * 出すと次の失敗がそのまま作者の画面に出る。
 *
 * - **問いが2つ以上**：どれに答えればよいか分からない
 * - **候補が足りない・依頼文や伏せ字が混ざる**：押しても答えにならない
 *   （0.86.1 までのループの元。押した候補が依頼文だったので AI が聞き返した）
 * - **指示の言葉がそのまま返る**（CLAUDE.md の繰り返し起きた失敗3）
 * - **前に尋ねたことをまた尋ねる**：同じ問いの往復は、それ自体がループである。
 *   **AIに「繰り返さないで」と頼むだけでは足りない**ので、コードが止める
 */

/**
 * 字数の上限。**プロンプトへもここから埋め込む**（2か所に書かない）。
 * 検算は少しゆとりを持たせる（`HARD`）——1字超えただけで問いを捨てると、
 * 作者は待たされたうえに何も得られない。
 */
export const PLOT_DIALOGUE_LIMITS = {
  topic: 15,
  // 短い問いのほうが答えやすい（作者とリーダーの問答は「主人公は？」の長さだった）
  question: 80,
  why: 60,
  candidate: 60,
  confirm: 120,
  candidatesMin: 3,
  candidatesMax: 4,
} as const;

const HARD = {
  topic: 30,
  question: 180,
  why: 90,
  candidate: 100,
  confirm: 200,
} as const;

/** 画面に出す、確かめ済みの1回分 */
export interface PlotDialogueTurn {
  confirm: string;
  topic: string;
  question: string;
  why: string;
  candidates: string[];
  section: PlotDialogueSection;
}

export type PlotDialogueRejection =
  | "json"
  | "question"
  | "questions"
  | "echo"
  | "candidates"
  | "repeat";

export type PlotDialogueCheck =
  | {
      ok: true;
      turn: PlotDialogueTurn;
      /** 落とした候補の数（記録に残す） */
      droppedCandidates: number;
    }
  | { ok: false; reason: PlotDialogueRejection; detail?: string };

/**
 * プロンプトに書いた言葉。**答えとして返ってきたら中身が無い。**
 * 欄の名前（`question` など）も、小さいモデルは値として書いてくる。
 */
const INSTRUCTION_ECHOES = [
  "いま決めると話が一番広がる1点",
  "いま決めると話が一番広がる",
  "なぜそれを決めるのか",
  "決まったことの確かめ直し",
  "作者への問い",
  "候補の文",
  "決める1点の短い名前",
  "confirm",
  "topic",
  "question",
  "why",
  "candidates",
  "section",
];

/** 画面の札と同じ文言は、候補に混ぜない（押すと札として扱われて答えにならない） */
const RESERVED = new Set([
  PLOT_WRITE_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_END_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
]);

export function validatePlotDialogueAnswer(
  text: string,
  asked: readonly PlotAskedPoint[]
): PlotDialogueCheck {
  const record = parseJson(text);
  if (!record) return { ok: false, reason: "json" };

  const question = firstLines(stringOf(record.question), 3);
  if (!question || isEcho(question) || isPlaceholderText(question)) {
    return { ok: false, reason: question ? "echo" : "question" };
  }
  if (question.length > HARD.question) return { ok: false, reason: "question" };
  // 問いは1つ。「？」が2つあれば、2つ尋ねている
  if ((question.match(/[？?]/gu) ?? []).length > 1) {
    return { ok: false, reason: "questions" };
  }

  const topicRaw = firstLines(stringOf(record.topic), 1);
  // 名前が無い・指示の言葉なら、問いの頭から作る（捨てるほどの傷ではない）
  const topic = clip(
    topicRaw && !isEcho(topicRaw) ? topicRaw : question.replace(/[？?。].*$/su, ""),
    HARD.topic
  );

  /*
    **同じ問いを二度出さない**（ループ防止をコードで持つ）。名前が同じか、
    問いの文がほとんど同じなら繰り返しとみなす。飛ばした問いも含める——
    飛ばしたものをすぐまた尋ねられると、飛ばした意味が無い
  */
  const repeated = asked.find(
    (point) =>
      normalize(point.topic) === normalize(topic) ||
      similarity(point.question, question) >= 0.6
  );
  if (repeated) {
    return { ok: false, reason: "repeat", detail: repeated.topic };
  }

  const raw = Array.isArray(record.candidates) ? record.candidates : [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  let dropped = 0;
  for (const item of raw) {
    const candidate = typeof item === "string" ? firstLines(item, 2) : "";
    const key = normalize(candidate);
    if (
      !candidate ||
      candidate.length > HARD.candidate ||
      RESERVED.has(candidate) ||
      isEcho(candidate) ||
      isPlaceholderText(candidate) ||
      isPlaceholderContent(candidate) ||
      isRequestLikeOption(candidate) ||
      seen.has(key) ||
      normalize(question) === key
    ) {
      dropped++;
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
  }
  if (candidates.length < PLOT_DIALOGUE_LIMITS.candidatesMin) {
    return {
      ok: false,
      reason: "candidates",
      detail: `使える候補が${candidates.length}個でした`,
    };
  }
  if (candidates.length > PLOT_DIALOGUE_LIMITS.candidatesMax) {
    dropped += candidates.length - PLOT_DIALOGUE_LIMITS.candidatesMax;
    candidates.length = PLOT_DIALOGUE_LIMITS.candidatesMax;
  }

  const whyRaw = firstLines(stringOf(record.why), 1);
  const confirmRaw = firstLines(stringOf(record.confirm), 2);
  const sectionRaw = stringOf(record.section).trim();

  return {
    ok: true,
    turn: {
      // 確かめ直しと理由は、無くても問いは成り立つ。指示の言葉なら出さない
      confirm: confirmRaw && !isEcho(confirmRaw) ? clip(confirmRaw, HARD.confirm) : "",
      topic,
      question,
      why: whyRaw && !isEcho(whyRaw) ? clip(whyRaw, HARD.why) : "",
      candidates,
      /*
        書く先が一覧に無ければ「あらすじ」へ寄せる。**捨てない**——作者の
        答えそのものは正しく、置き場所をAIが言い間違えただけである
      */
      section: sectionOf(sectionRaw),
    },
    droppedCandidates: dropped,
  };
}

/**
 * 受け取れなかった理由を、**もう一度頼むときの一言**にする。
 * 何が駄目だったかを言わないと、同じ答えがもう一度返る。
 */
export function describeRetryNote(reason: PlotDialogueRejection, detail?: string): string {
  switch (reason) {
    case "repeat":
      return `前の答えは、すでに尋ねた「${detail ?? ""}」と同じ問いでした。まだ尋ねていない別の1点を選んでください。`;
    case "questions":
      return "前の答えには問いが2つ以上ありました。問いは1つだけにしてください。";
    case "candidates":
      return `前の答えの候補は、そのまま作者の答えになる文になっていませんでした（${detail ?? ""}）。依頼文・質問・伏せ字を使わず、具体的な中身の候補を${PLOT_DIALOGUE_LIMITS.candidatesMin}〜${PLOT_DIALOGUE_LIMITS.candidatesMax}個出してください。`;
    case "echo":
      return "前の答えには、指示の言葉がそのまま入っていました。作品の中身で答えてください。";
    case "question":
    case "json":
      return "前の答えは、決められた形になっていませんでした。指定のJSONで、問いを1つ出してください。";
  }
}

/** 作者へ言う、受け取れなかった理由 */
export function describePlotDialogueFailure(reason: PlotDialogueRejection): string {
  switch (reason) {
    case "repeat":
      return "AIが、前に尋ねたことと同じ問いを繰り返したので止めました。";
    case "questions":
      return "AIの問いが1つにまとまりませんでした。";
    case "candidates":
      return "AIの候補が、そのまま答えにできる形になっていませんでした。";
    case "echo":
      return "AIの答えに、指示の言葉がそのまま入っていました。";
    case "question":
    case "json":
      return "AIの答えを読み取れませんでした。";
  }
}

/**
 * 書く先の鍵を読む。**鍵のあとに説明が続いても、頭の鍵を取る**。
 *
 * スキーマで選択肢に縛っても、縛りを効かせない相手（`format` を持たない
 * AI）では「worldview（世界の仕組み）と…」のように説明ごと返る（手元の
 * gemma4:e4b、縛る前）。頭に鍵が無ければ、いちばん前に出てくる鍵を取り、
 * どれも無ければ「あらすじ」へ寄せる。
 */
function sectionOf(raw: string): PlotDialogueSection {
  const text = raw.trim();
  if (isPlotDialogueSection(text)) return text;
  let best: { key: PlotDialogueSection; at: number } | undefined;
  for (const { key } of PLOT_DIALOGUE_SECTIONS) {
    const at = text.indexOf(key);
    if (at >= 0 && (best === undefined || at < best.at)) best = { key, at };
  }
  return best?.key ?? "outline";
}

function isEcho(text: string): boolean {
  const bare = text.trim().replace(/[。．.:：]+$/u, "").toLowerCase();
  return INSTRUCTION_ECHOES.some(
    (phrase) => bare === phrase.toLowerCase() || (phrase.length >= 8 && bare.includes(phrase))
  );
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 先頭の数行だけ。改行で次の話を始める答えを、1つ分に切る */
function firstLines(text: string, count: number): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count)
    .join("\n");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 比べるための形。空白・句読点・括弧を落とし、全角半角を揃える */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s、。，．,.！!？?「」『』（）()【】・…ー\-]/gu, "");
}

/**
 * 2つの文の似かた（文字の2字組の重なり。0〜1）。
 *
 * **言い回しを変えただけの同じ問いを捕まえる。** 完全一致だけを見ると、
 * 「業者が最強なのはなぜですか」と「業者が最強である理由は何ですか」を
 * 別の問いとして通してしまう。
 */
export function similarity(a: string, b: string): number {
  const grams = (text: string): Map<string, number> => {
    const body = normalize(text);
    const out = new Map<string, number>();
    for (let i = 0; i < body.length - 1; i++) {
      const gram = body.slice(i, i + 2);
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  const total = [...left.values(), ...right.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return 0;
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / total;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stripCodeFence(text));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
