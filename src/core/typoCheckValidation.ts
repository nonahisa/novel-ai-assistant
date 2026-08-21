import type { Chunk } from "./chunker";
import type { ExtractedTypoIssue, TypoCheckResult } from "../prompts/typoCheck";
import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";
import { isKeptWord, type KeepWord } from "../models/keepWord";

/**
 * P-09 誤字脱字検知のAI出力を検証する。
 *
 * これが最も誤検出を出しやすい機能のため、プロンプトで固有名詞を
 * 保護辞書として渡すだけでなく、ここでも二重に弾く。
 * 小さいモデルは指示を無視することがある、という既存の教訓を踏襲した。
 */

export type TypoRejectionReason =
  | "invalid_shape"
  | "out_of_range"
  | "ungrounded"
  | "target_not_in_original"
  | "protected_term"
  /** 作者が「直さない」と決めた語を含む */
  | "kept_word"
  /** 一人称・二人称を別のものへ入れ替えようとしている */
  | "pronoun_change"
  /** 修正案が「空文字」「なし」など、中身の無いことを書いた言葉 */
  | "placeholder_suggestion"
  /** 修正案が元の語と同じ。押しても何も起きない */
  | "no_change"
  /** 違いが末尾の句読点だけ。台詞の末尾に句点は打たない */
  | "punctuation_only"
  /** 読みが同じで書き方だけ違う。表記ゆれであって誤字ではない */
  | "script_only"
  /** 正しい文語・旧字を「誤変換」として直そうとしている */
  | "archaic_form"
  /** 当てると本文が二重になる（修正案が前後の文まで抱え込んでいる） */
  | "duplicates_context";

export interface RejectedTypoIssue {
  line: number | null;
  target: string | null;
  reason: TypoRejectionReason;
}

export interface AcceptedTypoIssue {
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface TypoValidationResult {
  accepted: AcceptedTypoIssue[];
  rejected: RejectedTypoIssue[];
}

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する。
 * `characterExtractionValidation.ts` の `parseResult` と同じ方式。
 */
export function parseTypoCheckResult(text: string): TypoCheckResult | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.issues)) {
        return parsed as unknown as TypoCheckResult;
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

/**
 * @param protectedNames 固有名詞辞書（人物・場所・能力・組織の name + aliases）。
 *   プロンプトでも渡しているが、指示に従わないモデルがあるため
 *   ここでも `target` が完全一致するものを弾く。
 */
export function validateTypoIssues(
  raw: unknown,
  chunk: Chunk,
  protectedNames: string[],
  /**
   * 作者が「直さない」と決めた語（`設定/keep_words.json`）。
   *
   * **固有名詞の辞書とは別に要る。** 方言・口癖は固有名詞ではないので、
   * 人物や場所をいくら抽出しても入ってこない（実データで確かめた）。
   */
  keepWords: KeepWord[] = []
): TypoValidationResult {
  const accepted: AcceptedTypoIssue[] = [];
  const rejected: RejectedTypoIssue[] = [];

  if (!isRecord(raw) || !Array.isArray(raw.issues)) {
    rejected.push({ line: null, target: null, reason: "invalid_shape" });
    return { accepted, rejected };
  }

  const protectedSet = new Set(
    protectedNames.map((name) => name.trim()).filter(Boolean)
  );
  const chunkLineCount = chunk.text.split("\n").length;
  const firstLine = chunk.startLine + 1;
  const lastLine = chunk.startLine + chunkLineCount;
  const normalizedChunk = normalizeForComparison(chunk.text);

  for (const candidate of raw.issues as unknown[]) {
    const issue = parseIssue(candidate);
    if (!issue) {
      rejected.push({ line: null, target: null, reason: "invalid_shape" });
      continue;
    }

    if (issue.line < firstLine || issue.line > lastLine) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "out_of_range",
      });
      continue;
    }

    // AIの幻覚を防ぐ：original が本文中に逐語で実在しない指摘は破棄する
    if (!normalizedChunk.includes(normalizeForComparison(issue.original))) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "ungrounded",
      });
      continue;
    }

    // target が original の中に含まれていないと、適用時に置換位置を特定できない
    if (!issue.original.includes(issue.target)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "target_not_in_original",
      });
      continue;
    }

    if (protectedSet.has(issue.target)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "protected_term",
      });
      continue;
    }

    // **作者が名指しで守った語は直さない。**
    // 完全一致ではなく含むかで見る。方言は活用するためである
    // （「急いどる」を登録したら「急いどるんやろ？」も守る）
    if (isKeptWord(issue.target, keepWords)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "kept_word",
      });
      continue;
    }

    // **一人称を入れ替えてくる。**
    // 実データで「僕が所属する」→「私が所属する」、「僕ら」→「私たち」が
    // 返った（2026-08-18）。**一人称は作品の根幹で、直されたら語り手が
    // 別人になる。** 方言と違ってどの小説にも必ずあるので、作者が
    // 登録するのを待たず、最初から守る
    if (isPronounSwap(issue.target, issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "pronoun_change",
      });
      continue;
    }

    // **同じ語を「修正案」として返してくる。**
    // 作者の10作品で測ったところ、通った62件のうち**25件がこれだった**
    // （「保険」→「保険」、「跨いだ」→「跨いだ」）。押しても何も起きないのに、
    // 作者は1件ずつ見て消さなければならない（2026-08-17）
    if (
      normalizeForComparison(issue.target) ===
      normalizeForComparison(issue.suggestion)
    ) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "no_change",
      });
      continue;
    }

    // **当てると本文が二重になる指摘を、絶対に通さない。**
    // AIが `target`（直す語）と `original`（その周り）を取り違え、
    // 文まるごとの書き換えを修正案に入れてくることがある。
    // **実データで4か所の原稿が壊れた**（2026-08-21、作者が実機で発見）
    if (
      wouldDuplicateContext(issue.original, issue.target, issue.suggestion)
    ) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "duplicates_context",
      });
      continue;
    }

    // **末尾の句読点を足すだけの指摘は誤字ではない。**
    // 台詞の終わりに「。」を足す提案が返るが、日本語の小説では
    // **台詞の末尾に句点を打たない**のが普通である
    if (onlyTrailingPunctuation(issue.target, issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "punctuation_only",
      });
      continue;
    }

    // **読みが同じで書き方だけ違うものは、表記ゆれであって誤字ではない。**
    // プロンプトで「表記ゆれは別機能で扱う」と断っているのに返ってくる
    // （「ハメになった」→「はめになった」、「2回転」→「二回転」）
    if (onlyScriptDifference(issue.target, issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "script_only",
      });
      continue;
    }

    // **正しい文語・旧字を「誤変換」として直してくる。**
    // 作者の作品に、戦前の文語体で書かれた自分史がある。そこで
    // 「然し」→「しかし」「聯隊」→「連隊」「与へて呉れた」→「与えてくれた」
    // が返った。**どれも正しい日本語で、直せば元の文書が壊れる**
    if (isArchaicForm(issue.target)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "archaic_form",
      });
      continue;
    }

    // **AIが「中身が無い」ことを中身として書いてくる。**
    // 推敲で `"suggestion": "空文字"` が返り、押すと本文がその3文字に
    // 置き換わるところだった（2026-08-17、実データ）。
    // 誤字脱字は直し方が必ずあるはずなので、指摘ごと落とす
    if (isPlaceholderText(issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "placeholder_suggestion",
      });
      continue;
    }

    accepted.push({
      line: issue.line,
      original: issue.original,
      target: issue.target,
      suggestion: issue.suggestion,
      reason: issue.reason,
      confidence: VALID_CONFIDENCE.has(issue.confidence)
        ? (issue.confidence as "high" | "medium" | "low")
        : "low",
    });
  }

  return { accepted, rejected };
}

/**
 * 違いが人称の入れ替えだけか。
 *
 * **一人称は作品の根幹である。** 「僕」で書かれた小説を「私」に直されたら、
 * 語り手が別人になる。誤字ではない。
 *
 * 実データで返ってきたもの（2026-08-18）：
 *
 *     「僕が所属する」→「私が所属する」
 *     「僕ら」→「私たち」
 *
 * **人称をすべて同じ印に置き換えて、残りが一致するかで見る。**
 * 一致するなら、違いは人称だけということになる。
 *
 * 複数形（「僕ら」「私たち」）も並べる。並べないと
 * 「僕ら」→「〓ら」、「私たち」→「〓たち」となって一致せず、素通りする。
 *
 * **長いものから当てる。** 「私」を先に当てると「私たち」の「たち」が残る。
 */
const PRONOUN_FORMS = [
  // 一人称（複数）
  "わたくしたち",
  "わたしたち",
  "あたしたち",
  "私たち",
  "僕たち",
  "俺たち",
  "我々",
  "吾々",
  "私達",
  "僕達",
  "俺達",
  "僕ら",
  "俺ら",
  "私ら",
  "我ら",
  // 一人称（単数）
  "わたくし",
  "わたし",
  "あたし",
  "自分",
  "小生",
  "拙者",
  "吾輩",
  "我輩",
  "私",
  "僕",
  "ぼく",
  "俺",
  "おれ",
  "儂",
  "わし",
  // 二人称
  "あなたたち",
  "あなた方",
  "あんたら",
  "君たち",
  "お前ら",
  "お前たち",
  "あなた",
  "あんた",
  "貴方",
  "お前",
  "おまえ",
  "君",
  "きみ",
];

/** 人称を1つの印に潰す。長いものから当てないと途中で切れる */
function maskPronouns(text: string): string {
  let masked = text;
  for (const form of PRONOUN_FORMS) {
    masked = masked.split(form).join("〓");
  }
  return masked;
}

export function isPronounSwap(target: string, suggestion: string): boolean {
  if (target === suggestion) return false;
  const a = maskPronouns(target);
  const b = maskPronouns(suggestion);
  // 潰す前は違うのに、潰したら同じ ＝ 違いは人称だけ
  return a === b && a !== target;
}

/**
 * 違いが末尾の句読点だけか。
 *
 * **台詞の末尾に句点を打たないのは日本語の小説の決まり**であって、
 * 脱字ではない。実データで「会頭だ」→「会頭だ。」のような提案が返った。
 */
export function onlyTrailingPunctuation(
  target: string,
  suggestion: string
): boolean {
  const strip = (text: string) => text.replace(/[。、．，\s]+$/u, "");
  const a = strip(target);
  const b = strip(suggestion);
  return a === b && target !== suggestion;
}

/**
 * 違いが「書き方」だけで、読みが変わらないか。
 *
 * **読みが同じなら、それは表記ゆれであって誤字ではない。**
 * P-09のプロンプトは「表記ゆれは別機能で扱う」と断っているが、
 * 実データでは返ってきた（「ハメになった」→「はめになった」、
 * 「2回転ほど」→「二回転ほど」）。
 *
 * **確実に読みが同じと言い切れる2つだけを見る。**
 *
 * - 片仮名と平仮名の違い
 * - 算用数字と漢数字の違い
 *
 * 「何故」→「なぜ」や「はじめる」→「始める」も読みは同じだが、
 * それを言うには読み仮名の辞書が要る。**ここでは見ない**
 * （通っても作者が「無視」を押せば済む。取りこぼしのほうが安全である）。
 */
const KANJI_DIGITS: Record<string, string> = {
  "〇": "0",
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
};

function toComparableScript(text: string): string {
  return (
    text
      // 片仮名を平仮名へ寄せる（長音符はそのまま）
      .replace(/[ァ-ヶ]/gu, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0x60)
      )
      // 全角の算用数字を半角へ
      .replace(/[０-９]/gu, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0)
      )
      // 漢数字を算用数字へ（十・百・千は桁を持つので触らない）
      .replace(/[〇一二三四五六七八九]/gu, (char) => KANJI_DIGITS[char] ?? char)
  );
}

export function onlyScriptDifference(
  target: string,
  suggestion: string
): boolean {
  if (target === suggestion) return false;
  return toComparableScript(target) === toComparableScript(suggestion);
}

/**
 * 文語・旧字の形か。
 *
 * **正しい日本語を「誤変換」として直されると、文書が壊れる。**
 * 作者の作品に、戦前の文語体で書かれた自分史（祖父の手記）があり、
 * `gemma4:e4b` が9か所を「誤変換」「送り仮名の誤り」として挙げた。
 *
 * **よく出る形だけを並べる。** 網羅はできないし、する必要もない。
 * ここに無いものが通っても、作者が「無視」を押せば済む。逆に、
 * ここに入れたものを取りこぼしても害は無い（**正しい語を直さないだけ**）。
 *
 * 文語の作品を書く作者のために、いずれ**作品ごとの「直さない語」**を
 * 持たせたい。この一覧はその代わりの、最低限の防ぎである。
 */
const ARCHAIC_FORMS = [
  // 接続詞・副詞
  "然し",
  "併し",
  "而して",
  "然るに",
  "可成り",
  "極く",
  "尚且つ",
  "且つ",
  "乃至",
  "曾て",
  "予て",
  "却って",
  "尤も",
  "殆ど",
  "凡そ",
  "略々",
  // 助詞・助動詞まわり
  "於いて",
  "於て",
  "就いて",
  "依って",
  "拠って",
  "迄",
  "位",
  "程",
  "毎に",
  "乍ら",
  // 旧仮名・旧字の動詞
  "呉れた",
  "呉れる",
  "与へて",
  "云う",
  "云った",
  "云われる",
  "居る",
  "居た",
  "為す",
  "為る",
  "有る",
  "無い",
  // 旧字体の語
  "聯隊",
  "聯合",
  "国鉄",
  "吾々",
  "我々",
  "彼処",
  "此処",
  "其処",
  "其の",
  "此の",
  "斯く",
  "何れ",
  "何処",
  "何時",
  "貴方",
  "貴女",
];
const ARCHAIC_SET = new Set(ARCHAIC_FORMS);

/**
 * 1文字でも、途中に混じっていれば文語と分かるもの。
 *
 * **「位」「程」は入れない。** 順位・程度のように、今の文章にも
 * 普通に出てくるためである（それらを弾くと本物の誤字を取りこぼす）。
 */
const ARCHAIC_MARKS = /[迄乍呉而尤曾已]/u;

export function isArchaicForm(target: string): boolean {
  const body = target.trim();
  if (ARCHAIC_SET.has(body)) return true;
  if (ARCHAIC_MARKS.test(body)) return true;
  // 「与へて呉れた」のように連なって返ることがある
  return ARCHAIC_FORMS.some((form) => form.length >= 2 && body.includes(form));
}

function parseIssue(raw: unknown): ExtractedTypoIssue | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.line !== "number" || !Number.isInteger(raw.line)) return null;
  const original = cleanRequiredString(raw.original);
  const target = cleanRequiredString(raw.target);
  const suggestion = cleanRequiredString(raw.suggestion);
  if (!original || !target || !suggestion) return null;
  return {
    line: raw.line,
    original,
    target,
    suggestion,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    confidence: typeof raw.confidence === "string" ? raw.confidence : "low",
  };
}

function cleanRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * その修正案を当てると、本文が二重になるか（設計書6.8.11）。
 *
 * **実際に原稿が壊れた**（2026-08-21、作者が実機で発見）。
 *
 * ```
 * 元:   「あんたが望むなら、夢で会わすぐらいのことはできるんだがね」
 * target:     会わすぐらい
 * suggestion: 夢で会わせるくらいのことはできるんだがね
 * ↓
 * 「あんたが望むなら、夢で夢で会わせるくらいのことはできるんだがねのことはできるんだがね」
 * ```
 *
 * **AIが `target` と `original` を取り違えている。** 直したい語だけを
 * `target` に入れるべきところへ、文まるごとの書き換えを `suggestion` に
 * 入れてくる。コードは `target` の位置だけを置き換えるので、
 * **修正案が抱え込んだ前後の文が、そのまま二重に残る。**
 *
 * 見分け方は単純である。`target` の**直前の文字列が修正案の先頭にも
 * ある**、または**直後の文字列が修正案の末尾にもある**なら、
 * 当てた時点で必ず重なる。
 *
 * **2文字から見る。** 1文字だと「の」「を」のような助詞でたまたま一致し、
 * 正しい修正案まで弾いてしまう。実データで壊れた4件は、いずれも
 * 2文字以上の重なりを持っていた（最短で「夢で」の2文字）。
 */
export function wouldDuplicateContext(
  original: string,
  target: string,
  suggestion: string
): boolean {
  const at = original.indexOf(target);
  if (at < 0) return false;
  const before = original.slice(0, at);
  const after = original.slice(at + target.length);
  return (
    overlapLength(before, suggestion, "tail") >= MIN_DUPLICATE_OVERLAP ||
    overlapLength(suggestion, after, "head") >= MIN_DUPLICATE_OVERLAP
  );
}

/** これ以上重なっていたら、偶然ではなく抱え込みと見る */
const MIN_DUPLICATE_OVERLAP = 2;

/**
 * 重なりの長さ。
 *
 * `"tail"` は「`left` の末尾と `right` の先頭」、
 * `"head"` は「`left` の末尾と `right` の先頭」を見る（引数の順が違うだけ）。
 */
function overlapLength(
  left: string,
  right: string,
  _kind: "tail" | "head"
): number {
  const max = Math.min(left.length, right.length);
  for (let length = max; length >= MIN_DUPLICATE_OVERLAP; length--) {
    if (left.slice(left.length - length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}
