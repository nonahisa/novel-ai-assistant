import { isPlaceholderText } from "./placeholderText";
import { PLOT_SECTIONS } from "./plotDoc";
import {
  PLOT_CONTINUE_OPTION,
  PLOT_END_OPTION,
  PLOT_MORE_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_SUMMARY_OPTION,
  PLOT_SUPPLEMENT_MARK,
  PLOT_WRITE_OPTION,
  PLOT_WRITE_SUMMARY_OPTION,
  isPlaceholderContent,
  isPlotDialogueSection,
  isRequestLikeOption,
  PLOT_DIALOGUE_SECTIONS,
  type PlotAskedPoint,
  type PlotDecision,
  type PlotDialogueSection,
} from "./plotInterview";
import { PLOT_DIALOGUE_STYLES, PLOT_FRAMES } from "./plotDialogueStyles";
import { stripCodeFence } from "./synopsisValidation";

/**
 * 対話式プロット作成（P-43・P-44、設計書6.4.7）のAIの答えを、コードで確かめる。
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
 * - **確かめ直しが続く**：確かめ直しへの答えをまた確かめ直すと、往復が終わらない
 * - **まとめ（P-44）から決まったことが抜ける**：抜けたものはコードが戻す
 *
 * **どの型（`plotDialogueStyles.ts`）でも同じ検算を通す。** 型ごとに違うのは、
 * コードが次の1点を決める型（型に当てはめる・項目を順に埋める）で、名前と
 * 書く先をこちらが持つことだけ（`PlotTurnRequest.fixed`）。
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
  /** 候補ごとの「これを選ぶと話がどう変わるか」 */
  effect: 40,
  confirm: 120,
  candidatesMin: 3,
  candidatesMax: 4,
  /**
   * 「ほかの案もほしい」のときの上限。作者とリーダーの問答では、作者が
   * 「もっとアイデアを」と求め、8案から2案を組み替えて選んだ（2026-09-25）
   */
  moreMax: 8,
} as const;

const HARD = {
  topic: 30,
  question: 180,
  why: 90,
  candidate: 100,
  effect: 70,
  confirm: 200,
} as const;

/** 候補1つ。**押されると text がそのまま作者の答えになる** */
export interface PlotCandidate {
  text: string;
  /** これを選ぶと話がどう変わるか（1行）。無いこともある */
  effect: string;
}

/**
 * 1回分の問いの種類。
 * - `ask`：次の1点を尋ねる
 * - `clarify`：**作者の直前の答えを確かめる**。答えが途中で切れている
 *   （「元アイデアを」）・どちらにも読めるとき、推測で進めずに解釈の候補を
 *   出す（作者とリーダーの問答で気づいたこと、2026-09-25）
 */
export type PlotTurnMode = "ask" | "clarify";

/** 画面に出す、確かめ済みの1回分 */
export interface PlotDialogueTurn {
  mode: PlotTurnMode;
  confirm: string;
  topic: string;
  question: string;
  why: string;
  candidates: PlotCandidate[];
  section: PlotDialogueSection;
}

export type PlotDialogueRejection =
  | "json"
  | "question"
  | "questions"
  | "echo"
  | "candidates"
  | "repeat"
  | "clarify";

export type PlotDialogueCheck =
  | {
      ok: true;
      turn: PlotDialogueTurn;
      /** 落とした候補の数（記録に残す） */
      droppedCandidates: number;
    }
  | { ok: false; reason: PlotDialogueRejection; detail?: string };

/** 問いの続きとして頼んだこと。検算の決まりがそれぞれ違う */
export interface PlotTurnRequest {
  asked: readonly PlotAskedPoint[];
  /**
   * 「ほかの案もほしい」：**同じ問いのまま**、出した候補と違う案を出させる。
   * 名前と問いと書く先はこちらが持っているものを使い、繰り返しの判定はしない
   */
  more?: {
    topic: string;
    question: string;
    section: PlotDialogueSection;
    shown: readonly string[];
  };
  /**
   * 確かめ直してよい答え。直前の答えを受けた回だけ渡す。**同じ答えを2度
   * 確かめ直させない**——確かめ直しが続くと、それ自体が往復のループになる
   */
  clarifyFor?: { topic: string; section: PlotDialogueSection };
  /**
   * コードが決めた「次に尋ねる1点」（型に当てはめる・項目を順に埋める）。
   * 名前と書く先はこちらのものを使う。`note` はAIへ渡した枠の説明で、
   * **答えとして返ってきたら中身が無い**（CLAUDE.md の繰り返し起きた失敗3）
   */
  fixed?: { topic: string; section: PlotDialogueSection; note: string };
}

/**
 * プロンプトに書いた言葉。**答えとして返ってきたら中身が無い。**
 * 欄の名前（`question` など）も、小さいモデルは値として書いてくる。
 * 8字以上のものは、文の中に含まれているだけでも指示の言葉とみなす。
 */
const INSTRUCTION_ECHOES = [
  "いま決めると話が一番広がる1点",
  "いま決めると話が一番広がる",
  "なぜそれを決めるのか",
  "決まったことの確かめ直し",
  "これを選ぶと話がどう変わるか",
  "作者への問い",
  "候補の文",
  "決める1点の短い名前",
  "解釈の候補",
  // 型ごとの指示（P-43 1.2）
  "話を外へ広げる1点",
  "外へ広げる1点",
  "結末が成り立つのに欠かせない1点",
  "欠かせない1点",
  "次に埋める枠",
  "次に埋める項目",
  "その枠に入る出来事",
  "その項目に入る中身",
  "confirm",
  "topic",
  "question",
  "why",
  "candidates",
  "section",
  "effect",
  "text",
  "mode",
];

/**
 * 画面の札と同じ文言は、候補に混ぜない（押すと札として扱われて答えにならない）。
 * **型と枠の札も入れる**——候補に「起承転結」が出て押されると、型の選び直しと
 * 取り違える余地を残さない
 */
const RESERVED = new Set([
  PLOT_WRITE_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_END_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_MORE_OPTION,
  PLOT_SUMMARY_OPTION,
  PLOT_WRITE_SUMMARY_OPTION,
  PLOT_CONTINUE_OPTION,
  ...PLOT_DIALOGUE_STYLES.map((style) => style.label),
  ...PLOT_FRAMES.map((frame) => frame.label),
]);

export function validatePlotDialogueAnswer(
  text: string,
  request: PlotTurnRequest
): PlotDialogueCheck {
  const record = parseJson(text);
  if (!record) return { ok: false, reason: "json" };

  const more = request.more;
  const mode: PlotTurnMode =
    !more && stringOf(record.mode).trim() === "clarify" ? "clarify" : "ask";
  // 確かめ直してよい答えが無いのに確かめ直してきたら、受け取らない
  if (mode === "clarify" && !request.clarifyFor) {
    return { ok: false, reason: "clarify" };
  }
  // 確かめ直しは直前の問いについての回。コードが決めた次の1点は、そのあとで尋ねる
  const fixed = mode === "ask" ? request.fixed : undefined;
  const fixedNote = fixed ? normalize(fixed.note) : undefined;
  const isFixedEcho = (value: string): boolean =>
    fixedNote !== undefined && fixedNote.length > 0 && normalize(value) === fixedNote;

  /*
    **ほかの案のときは、問いはこちらが持っているものを使う。** AIに問いを
    書き直させると、同じ問いの言い換え（＝繰り返し）か、別の問いに化ける
  */
  const question = more ? more.question : firstLines(stringOf(record.question), 3);
  if (!more) {
    if (!question || isEcho(question) || isFixedEcho(question) || isPlaceholderText(question)) {
      return { ok: false, reason: question ? "echo" : "question" };
    }
    if (question.length > HARD.question) return { ok: false, reason: "question" };
    // 問いは1つ。「？」が2つあれば、2つ尋ねている
    if ((question.match(/[？?]/gu) ?? []).length > 1) {
      return { ok: false, reason: "questions" };
    }
  }

  const topicRaw = firstLines(stringOf(record.topic), 1);
  const topic = more
    ? more.topic
    : mode === "clarify" && request.clarifyFor
      ? request.clarifyFor.topic
      : fixed
        ? fixed.topic
        : // 名前が無い・指示の言葉なら、問いの頭から作る（捨てるほどの傷ではない）
          clip(
            topicRaw && !isEcho(topicRaw) ? topicRaw : question.replace(/[？?。].*$/su, ""),
            HARD.topic
          );

  /*
    **同じ問いを二度出さない**（ループ防止をコードで持つ）。名前が同じか、
    問いの文がほとんど同じなら繰り返しとみなす。飛ばした問いも含める——
    飛ばしたものをすぐまた尋ねられると、飛ばした意味が無い。
    ほかの案・確かめ直しは、もともと同じ1点についての回なので見ない。

    **コードが次の1点を決める型では、文の似かたで止めない。** 何を尋ねるかは
    コードが「まだ尋ねていない枠」から選んでおり、名前が同じになることは無い。
    文の似かたで見ると「起では何が起きますか」「承では何が起きますか」の
    ように**枠の名前だけ違う正しい問い**を繰り返しと取り違え、先へ進めなくなる。
    ただし前と**同じ文そのもの**を返したら（枠を無視した）、繰り返しとして止める
  */
  if (!more && mode === "ask") {
    const repeated = request.asked.find((point) =>
      fixed
        ? normalize(point.question) === normalize(question)
        : normalize(point.topic) === normalize(topic) ||
          similarity(point.question, question) >= 0.6
    );
    if (repeated) {
      return { ok: false, reason: "repeat", detail: repeated.topic };
    }
  }

  const max = more ? PLOT_DIALOGUE_LIMITS.moreMax : PLOT_DIALOGUE_LIMITS.candidatesMax;
  const shown = new Set((more?.shown ?? []).map(normalize));
  const raw = Array.isArray(record.candidates) ? record.candidates : [];
  const seen = new Set<string>();
  const candidates: PlotCandidate[] = [];
  let dropped = 0;
  for (const item of raw) {
    const candidate = candidateOf(item);
    const key = normalize(candidate.text);
    if (
      !candidate.text ||
      candidate.text.length > HARD.candidate ||
      RESERVED.has(candidate.text) ||
      isEcho(candidate.text) ||
      isFixedEcho(candidate.text) ||
      isPlaceholderText(candidate.text) ||
      isPlaceholderContent(candidate.text) ||
      isRequestLikeOption(candidate.text) ||
      seen.has(key) ||
      // ほかの案なのに、もう見せた案を返してきた
      shown.has(key) ||
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
  if (candidates.length > max) {
    dropped += candidates.length - max;
    candidates.length = max;
  }

  const whyRaw = firstLines(stringOf(record.why), 1);
  const confirmRaw = firstLines(stringOf(record.confirm), 2);
  const sectionRaw = stringOf(record.section).trim();

  return {
    ok: true,
    turn: {
      mode,
      // 確かめ直しと理由は、無くても問いは成り立つ。指示の言葉なら出さない
      confirm: confirmRaw && !isEcho(confirmRaw) ? clip(confirmRaw, HARD.confirm) : "",
      topic,
      question,
      why:
        whyRaw && !isEcho(whyRaw) && !isFixedEcho(whyRaw) ? clip(whyRaw, HARD.why) : "",
      candidates,
      /*
        書く先が一覧に無ければ「あらすじ」へ寄せる。**捨てない**——作者の
        答えそのものは正しく、置き場所をAIが言い間違えただけである。
        ほかの案・確かめ直しは、もとの1点の書く先を引き継ぐ。
        コードが決めた1点は、こちらの書く先を使う
      */
      section: more
        ? more.section
        : mode === "clarify" && request.clarifyFor
          ? request.clarifyFor.section
          : fixed
            ? fixed.section
            : sectionOf(sectionRaw),
    },
    droppedCandidates: dropped,
  };
}

/**
 * 候補1つを読む。**文字列だけの候補も受け取る**（「変わること」の欄を
 * 落とすモデルがいる。落としても候補そのものは使える）。
 */
function candidateOf(item: unknown): PlotCandidate {
  if (typeof item === "string") return { text: firstLines(item, 2), effect: "" };
  if (typeof item !== "object" || item === null) return { text: "", effect: "" };
  const record = item as Record<string, unknown>;
  const text = firstLines(stringOf(record.text), 2);
  const effectRaw = firstLines(stringOf(record.effect), 1);
  return {
    text,
    effect:
      effectRaw && !isEcho(effectRaw) && !isPlaceholderText(effectRaw)
        ? clip(effectRaw, HARD.effect)
        : "",
  };
}

/**
 * 受け取れなかった理由を、**もう一度頼むときの一言**にする。
 * 何が駄目だったかを言わないと、同じ答えがもう一度返る。
 *
 * @param fixedTopic コードが決めた1点。繰り返しのとき「別の1点を選んで」と
 *   言うと、決まった枠から外れた問いを誘う
 */
export function describeRetryNote(
  reason: PlotDialogueRejection,
  detail?: string,
  fixedTopic?: string
): string {
  switch (reason) {
    case "repeat":
      return fixedTopic
        ? `前の答えは、すでに尋ねた「${detail ?? ""}」の問いと同じ文でした。【${fixedTopic}】について、中身に合った問いを書いてください。`
        : `前の答えは、すでに尋ねた「${detail ?? ""}」と同じ問いでした。まだ尋ねていない別の1点を選んでください。`;
    case "questions":
      return "前の答えには問いが2つ以上ありました。問いは1つだけにしてください。";
    case "candidates":
      return `前の答えの候補は、そのまま作者の答えになる文になっていませんでした（${detail ?? ""}）。依頼文・質問・伏せ字・前に見せた案を使わず、具体的な中身の候補を出してください。`;
    case "echo":
      return "前の答えには、指示の言葉がそのまま入っていました。作品の中身で答えてください。";
    case "clarify":
      return "作者の答えはもう確かめ直しました。mode は ask にして、次の1点を尋ねてください。";
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
    case "clarify":
      return "AIが、同じ答えの確かめ直しを繰り返したので止めました。";
    case "question":
    case "json":
      return "AIの答えを読み取れませんでした。";
  }
}

export type PlotSummaryCheck =
  | {
      ok: true;
      /** 項目 → 書く中身（空の項目は入れない） */
      contents: Map<PlotDialogueSection, string>;
      /** まとめから抜けていたので、作者の言葉のまま戻した決まったこと */
      restored: PlotDecision[];
      /** AIが印を付けずに補っていたので、コードが〔補い〕を付けた行の数 */
      marked: number;
    }
  | { ok: false; reason: "json" | "empty" };

/**
 * まとめ（P-44）を確かめる。
 *
 * - **鍵の名前・項目の説明・伏せ字・印だけ**の値は中身にしない（CLAUDE.md の
 *   繰り返し起きた失敗3。欄の名前 `outline` がそのまま値に返る）
 * - **印の無い補いに、コードが印を付ける。** 手元の gemma4:e4b は、作者が
 *   一度も決めていない人称・テーマ・モチーフを印なしで埋めてきた（2026-09-25）。
 *   そのまま書くと、作者が選んでいない筋が「決まったこと」の顔で plot.md に
 *   入る（6.4.7「作者が選ばないまま筋を確定させない」）。決まったこと・着想・
 *   プロットに書いてあることのどれにも根ざさない行は補いとみなす
 * - **決まったことが抜けていたら、コードが作者の言葉のまま書く先へ戻す**
 *   （実装ルール3「マージはAIでなくコードが行う」）。まとめは言い回しを整えて
 *   よいので、完全一致では見ない。作者の答えの2字組が**その決まったことの
 *   書く先の項目に**7割以上あれば入っているとみなす。まとめ全体で見ると、
 *   起承転結の「起」が人物の欄へ移っただけで、あらすじの並びから抜けても
 *   戻らなかった（手元の gemma4:e4b、2026-09-25）。**迷ったら戻す側に倒す**
 *   ——重ねて書かれた文は作者が消せるが、消えた決まったことに作者は気づけない
 * - 中身が1つも残らなければ受け取らない（頼み直す）
 *
 * @param grounds 決まったことのほかに、根ざしてよいもの（着想・プロットに書いてあること）
 */
export function validatePlotSummary(
  text: string,
  decisions: readonly PlotDecision[],
  grounds: readonly string[] = []
): PlotSummaryCheck {
  const record = parseJson(text);
  if (!record) return { ok: false, reason: "json" };

  const contents = new Map<PlotDialogueSection, string>();
  for (const { key, note } of PLOT_DIALOGUE_SECTIONS) {
    const value = stringOf(record[key]).trim();
    if (!value) continue;
    // 印と箇条書きの記号を落としても中身が残るか
    const bare = value
      .split(/\r?\n/u)
      .map((line) =>
        line.replace(/^\s*[-・*]\s*/u, "").split(PLOT_SUPPLEMENT_MARK).join("").trim()
      )
      .filter(Boolean)
      .join("\n");
    if (!bare) continue;
    const lower = bare.toLowerCase();
    const heading = PLOT_SECTIONS.find((item) => item.key === key)?.heading ?? key;
    if (
      PLOT_DIALOGUE_SECTIONS.some((section) => section.key.toLowerCase() === lower) ||
      bare === heading ||
      bare === note ||
      isEcho(bare) ||
      isPlaceholderText(bare) ||
      isPlaceholderContent(bare)
    ) {
      continue;
    }
    contents.set(key, value);
  }

  // 印の無い補いに印を付ける（戻す前に行う。戻すのは作者の言葉なので印は要らない）
  const sources = [...decisions.map((item) => item.answer), ...grounds]
    .map((item) => item.trim())
    .filter(Boolean);
  const pool = sources.join("\n");
  let marked = 0;
  for (const [key, value] of contents) {
    const lines = value.split(/\r?\n/u).map((line) => {
      const head = /^\s*(?:[-・*]\s*)?/u.exec(line)?.[0] ?? "";
      const body = line.slice(head.length);
      if (!body.trim() || body.includes(PLOT_SUPPLEMENT_MARK)) return line;
      const grounded =
        coverage(body, pool) >= 0.5 || sources.some((source) => coverage(source, body) >= 0.6);
      if (grounded) return line;
      marked++;
      return `${head}${PLOT_SUPPLEMENT_MARK}${body}`;
    });
    contents.set(key, lines.join("\n"));
  }

  const restored: PlotDecision[] = [];
  for (const decision of decisions) {
    const answer = decision.answer.trim();
    // 文末の言い回し（「〜から」「〜こと」）は、まとめで整えられて消えるのが普通なので比べない
    const core = answer.replace(/(から|ので|ため|こと|である|です|だ)[。．.]?$/u, "") || answer;
    if (!answer || coverage(core, contents.get(decision.section) ?? "") >= RESTORE_COVERAGE) {
      continue;
    }
    restored.push(decision);
    const list = PLOT_SECTIONS.find((item) => item.key === decision.section)?.list ?? false;
    const heading = PLOT_SECTIONS.find((item) => item.key === decision.section)?.heading;
    const body = decision.topic === heading ? answer : `${decision.topic}：${answer}`;
    const line = list ? `- ${body}` : body;
    const before = contents.get(decision.section);
    contents.set(decision.section, before ? `${before}\n${line}` : line);
  }

  if (contents.size === 0) return { ok: false, reason: "empty" };
  return { ok: true, contents, restored, marked };
}

/**
 * 決まったことが「まとめに入っている」とみなす重なり（2字組）。
 *
 * **高めに置く。** 7割にしていたとき、手元の gemma4:26b のまとめは着想
 * 「現代にダンジョンが出現。配信のために通信線を敷く業者が実は最強」を
 * 「…通信線を敷設する業者が存在する世界」と書き、**着想の芯（実は最強）が
 * 消えたのに7割を超えて戻らなかった**（重なりは約0.76。2026-09-25）。芯は
 * たいてい短い言葉なので、割合を下げるほど落ちても気づけない。重ねて書かれた
 * 文は作者が消せるので、戻す側に倒す。文末の言い回しは比べる前に落とす
 * （「回線が魔力も運ぶから」→「回線が魔力も運ぶ世界」を抜けと取り違えない）
 */
const RESTORE_COVERAGE = 0.85;

/** `part` の2字組のうち、`whole` にもあるものの割合（0〜1） */
function coverage(part: string, whole: string): number {
  const target = normalize(part);
  const body = normalize(whole);
  if (target.length < 2) return body.includes(target) ? 1 : 0;
  let found = 0;
  let total = 0;
  for (let i = 0; i < target.length - 1; i++) {
    total++;
    if (body.includes(target.slice(i, i + 2))) found++;
  }
  return found / total;
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
