import type { Chunk } from "./chunker";
import { summarizeReasons } from "./checkRunCounts";
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
  | "duplicates_context"
  /** 修正案が原文のまま。押しても何も変わらない */
  | "same_as_original"
  /** 修正案にMarkdownの記号が入っている（直しではなく注釈） */
  | "markdown_in_suggestion"
  /** 修正案が対象より大幅に長い（語の直しではなく、文の書き換え） */
  | "rewrites_span";

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
  /**
   * こちらで置き換える範囲を1字広げたか（`checkParticleRange`）。
   *
   * **AIの言い分をそのまま採らなかった、と分かるようにする。**
   * 作者が見る `reason` にも「（範囲を1字広げました）」と出す。
   */
  rangeExtended?: boolean;
}

export interface TypoValidationResult {
  accepted: AcceptedTypoIssue[];
  rejected: RejectedTypoIssue[];
}

/**
 * 不採用の理由を、作者が読める言葉にする。
 *
 * **操作ログは作者も読む。** 種別の名前（`target_not_in_original`）だけ
 * 残しても、なぜ指摘が減ったのかは伝わらない。
 * `Record` にしてあるのは、理由を足したときに書き忘れると型検査が
 * 落ちるようにするためである。
 */
const REJECT_REASON_LABELS: Record<TypoRejectionReason, string> = {
  invalid_shape: "形が違う",
  out_of_range: "行番号が範囲外",
  ungrounded: "本文に無い引用",
  target_not_in_original: "対象が引用の中に無い",
  protected_term: "固有名詞",
  kept_word: "直さないと決めた語",
  pronoun_change: "人称の入れ替え",
  placeholder_suggestion: "中身の無い修正案",
  no_change: "直しにならない",
  punctuation_only: "末尾の句読点だけ",
  script_only: "表記ゆれ",
  archaic_form: "文語・旧字",
  duplicates_context: "当てると本文が二重になる",
  same_as_original: "修正案が原文のまま",
  markdown_in_suggestion: "修正案にMarkdownの記号",
  rewrites_span: "文の書き換え",
};

/**
 * 不採用の内訳を1行にまとめる（設計書6.8）。
 *
 * **総数だけでは、消しすぎなのか本当に無いのかが分からない。**
 * 誤字脱字は実データで64件中62件が素通りしたことがあり、
 * 「何件除外した」だけを見ていると、そこが検証のせいなのか
 * AIのせいなのか切り分けられない。多い順に並べる。
 */
export function summarizeRejectReasons(
  rejected: readonly Pick<RejectedTypoIssue, "reason">[]
): string {
  return summarizeReasons(
    rejected.map((entry) => entry.reason),
    (reason) => REJECT_REASON_LABELS[reason as TypoRejectionReason] ?? reason
  );
}

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * 修正案が対象より何文字まで長くなってよいか。
 *
 * **実データ147件で測って決めた**（2026-08-21）。他の検査を通った80件では、
 * 伸びは75件が+3以内。そこから +7 / +12 / +18 / +23 / +26 と飛び、
 * **その5件すべてが本文を壊した**（文の書き換えを修正案に入れていた）。
 *
 * 観測した上限（+3）に2文字の余裕を足して5とする。
 */
const MAX_SUGGESTION_GROWTH = 5;

/**
 * 修正案に紛れ込むMarkdownの強調。
 *
 * AIが「足した箇所」を強調して返してくる（「先生たち＊＊は＊＊校門に…」）。
 * **これは注釈であって直しではない。** 当てると本文にアスタリスクが入る。
 *
 * 文字列ではなく正規表現で持つのは、画面に出す文字列へ記号を混ぜていないか
 * 見張るテスト（plainTextUi.test.ts）に、検出用の記号まで拾わせないためでもある。
 */
const MARKDOWN_EMPHASIS = /\*\*/;

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

    // **AIが「誤っている助詞」を範囲に含めず、挿入として返してくる。**
    // 本文「すでの僕」に target「すで」→ suggestion「すでに」。当てると
    // 「すでにの僕」になる（作者の実機で1件）。プロンプトでも指示したが、
    // 指示に従わないモデルのためにここでも手当てする。
    // **これ以降の検査は、伸ばした後の範囲で行う**
    let target = issue.target;
    let original = issue.original;
    let rangeExtended = false;
    const range = checkParticleRange(
      lineTextOf(chunk, issue.line) ?? issue.original,
      issue.original,
      issue.target,
      issue.suggestion
    );
    if (range.kind === "already-correct") {
      // 本文はすでに正しい。当てても同じ助詞が続くだけで、直しにならない
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "no_change",
      });
      continue;
    }
    if (range.kind === "extend") {
      target = range.target;
      original = range.original;
      rangeExtended = true;
    }

    // **同じ語を「修正案」として返してくる。**
    // 作者の10作品で測ったところ、通った62件のうち**25件がこれだった**
    // （「保険」→「保険」、「跨いだ」→「跨いだ」）。押しても何も起きないのに、
    // 作者は1件ずつ見て消さなければならない（2026-08-17）
    if (
      normalizeForComparison(target) === normalizeForComparison(issue.suggestion)
    ) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "no_change",
      });
      continue;
    }

    // **修正案が原文のままなら、見せる意味が無い。**
    // AIが「直したい語」ではなく「その周りの文」を修正案に入れると、
    // 画面には原文と修正案が同じ文で並ぶ。押しても何も変わらないうえ、
    // 当てれば二重になる（作者の指摘、2026-08-21）
    //
    //   原文  「相当なお金持ちらしく、恨みも」
    //   対象  「お金持ちらしく」
    //   修正案「相当なお金持ちらしく、恨みも」  ← 同じ
    //
    // **原文が対象そのものの場合は除く。** 脱字の直しは対象へ文字を足す
    // ので、そのときは修正案が対象を含むのが正しい
    if (
      normalizeForComparison(original) !== normalizeForComparison(target) &&
      normalizeForComparison(issue.suggestion).includes(
        normalizeForComparison(original)
      )
    ) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "same_as_original",
      });
      continue;
    }

    // **Markdownの記号が入った修正案は、直しではなく注釈である。**
    // 「先生たち**は**校門にいなかった」のように、足した箇所を
    // 強調して返してくる。当てると本文にアスタリスクが入る
    if (MARKDOWN_EMPHASIS.test(issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "markdown_in_suggestion",
      });
      continue;
    }

    // **誤字脱字の直しは、語を1つ直すものである。**
    // 対象より大幅に長い修正案は、語の直しではなく文の書き換えであり、
    // 当てると前後が二重に残る。
    //
    // **実データ147件で測って決めた**（2026-08-21）。ここまでの検査を
    // 通った80件のうち、伸びは75件が+3以内。そこから +7 / +12 / +18 /
    // +23 / +26 と飛び、**その5件すべてが本文を壊した。**
    if (issue.suggestion.length - target.length > MAX_SUGGESTION_GROWTH) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "rewrites_span",
      });
      continue;
    }

    // **当てると本文が二重になる指摘を、絶対に通さない。**
    // AIが `target`（直す語）と `original`（その周り）を取り違え、
    // 文まるごとの書き換えを修正案に入れてくることがある。
    // **実データで4か所の原稿が壊れた**（2026-08-21、作者が実機で発見）
    // **本文のその行で確かめる。** AIの抜粋は対象のすぐ後ろで切れて
    // いることがあり、それだけを見ると重なりを見つけられない
    if (
      wouldDuplicateContext(
        lineTextOf(chunk, issue.line) ?? original,
        original,
        target,
        issue.suggestion
      )
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
    if (onlyTrailingPunctuation(target, issue.suggestion)) {
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
    if (onlyScriptDifference(target, issue.suggestion)) {
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
    if (isArchaicForm(target)) {
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
      original,
      target,
      suggestion: issue.suggestion,
      // **範囲を広げたことを作者に見せる。** 黙って直すと、画面の
      // 「対象」がAIの言い分と違っている理由が分からない
      reason: rangeExtended
        ? `${issue.reason}（範囲を1字広げました）`
        : issue.reason,
      confidence: VALID_CONFIDENCE.has(issue.confidence)
        ? (issue.confidence as "high" | "medium" | "low")
        : "low",
      ...(rangeExtended ? { rangeExtended: true } : {}),
    });
  }

  return { accepted, rejected };
}

/**
 * 1文字の助詞。**この一覧に無いものは見ない**（「へ」「も」まで入れて9つ）。
 *
 * 実測の道具（`test/live/typoAcrossWorks.test.ts`）でも同じ一覧を使う。
 * 写しを作ると、片方だけ直したときに測定と製品がずれる。
 */
export const PARTICLE_CHARS = new Set([
  "の",
  "に",
  "は",
  "が",
  "を",
  "と",
  "で",
  "へ",
  "も",
]);

/**
 * 助詞1文字ぶんの範囲ずれの判定（設計書6.8）。
 *
 * `keep` はそのまま、`already-correct` は当てても意味が無い（弾く）、
 * `extend` は置き換える範囲を1字広げて採る。
 */
export type ParticleRangeCheck =
  | { kind: "keep" }
  | { kind: "already-correct" }
  | { kind: "extend"; target: string; original: string };

/**
 * AIが「誤っている助詞」を範囲に含めずに返してきたときの手当て。
 *
 * **プロンプトが効かないモデルのための保険である。** 実機で1件出た。
 *
 * ```
 * 本文:   すでの僕の理性は     （「すでに」の誤変換）
 * target:     すで
 * suggestion: すでに           ← 「の」を範囲に含めていない（挿入になる）
 * ↓ 当てると
 *         すでにの僕の理性は
 * ```
 *
 * `suggestion` が `target` で始まり、余りが助詞1文字で、本文で `target` の
 * 直後の1文字も助詞なら、AIは**置き換えのつもりで挿入を返している**とみる。
 *
 * - 直後の助詞が余りと**同じ**なら、本文はすでに正しい（当てると同じ字が続くだけ）
 * - **違う**なら、その1字を `target` に含める（「すで」→「すでの」）
 *
 * **`suggestion` が `target` で終わる型（前に助詞を足す）は扱わない。**
 * 実測に例が無く、直し方も一意に決まらないためである。
 */
export function checkParticleRange(
  /** 本文のその行。取れなければ呼び出し側が抜粋で代用する */
  lineText: string,
  /** AIが渡した抜粋 */
  original: string,
  target: string,
  suggestion: string
): ParticleRangeCheck {
  if (!suggestion.startsWith(target) || suggestion === target) {
    return { kind: "keep" };
  }
  const extra = suggestion.slice(target.length);
  if (extra.length !== 1 || !PARTICLE_CHARS.has(extra)) return { kind: "keep" };

  // **適用処理と同じ順で位置を決める**（`wouldDuplicateContext` と同じ理由）
  const originalAt = lineText.indexOf(original);
  const targetInOriginal = original.indexOf(target);
  if (originalAt < 0 || targetInOriginal < 0) return { kind: "keep" };

  const next = lineText[originalAt + targetInOriginal + target.length];
  if (!next || !PARTICLE_CHARS.has(next)) return { kind: "keep" };
  if (next === extra) return { kind: "already-correct" };

  const extendedTarget = target + next;
  // **抜粋が target のところで切れていることがある。** そのままだと
  // 伸ばした target が抜粋からはみ出し、適用側が位置を決められない。
  // 抜粋も同じ1字だけ伸ばす（本文から読んだ字なので、実在は確かめてある）
  // **`endsWith` では足りない。** 抜粋の中に target が2度あると、
  // 見ている場所（最初の1つ）と抜粋の終わりが別の場所になり、
  // 本文に無い抜粋を組み立ててしまう
  const targetEndsOriginal =
    targetInOriginal + target.length === original.length;
  const extendedOriginal = targetEndsOriginal ? original + next : original;
  // 伸ばした結果が、いま見ている場所と違うところを指すなら手を出さない
  if (extendedOriginal.indexOf(extendedTarget) !== targetInOriginal) {
    return { kind: "keep" };
  }
  return { kind: "extend", target: extendedTarget, original: extendedOriginal };
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
  /**
   * **本文のその行そのもの。** AIが渡す `original`（抜粋）ではない。
   *
   * 抜粋は対象のすぐ後ろで切れていることがある。実際に起きた
   * （2026-08-21、作者が実機で2度目の報告）。
   *
   * ```
   * 本文:   …それって取り憑くってこと？
   * 抜粋:   「それって取り」   ← ここで終わっている
   * 対象:   「取り」
   * 修正案: 「取り憑く」
   * ```
   *
   * 抜粋だけを見ると「後ろ」が空になり、重なりを見つけられない。
   * **当てるのは行に対してなので、確かめるのも行に対して行う。**
   */
  lineText: string,
  /** AIが渡した抜粋。当てる位置を決めるのに使う（適用処理と同じ手順） */
  original: string,
  target: string,
  suggestion: string
): boolean {
  // **適用処理と同じ順で位置を決める。** 違う決め方をすると、
  // 検査した場所と書き換える場所がずれる
  const originalAt = lineText.indexOf(original);
  const targetInOriginal = original.indexOf(target);
  if (originalAt < 0 || targetInOriginal < 0) return false;

  const at = originalAt + targetInOriginal;
  const before = lineText.slice(0, at);
  const after = lineText.slice(at + target.length);
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

/**
 * その本文が文語体で書かれているか（設計書6.8.14）。
 *
 * **`isArchaicForm` は語ひとつを見る。** こちらは作品全体を見て
 * 「この作品はそもそも文語体である」と言えるかを判定する。
 *
 * 言えるなら、**AIへ先に伝えられる。** 「然し」を「しかし」に直す提案が
 * そもそも生まれなくなり、こちらで弾く手間が減る。
 *
 * **数ではなく密度で見る。** 現代文の小説にも旧字が1つ2つ紛れることは
 * あるので、長さに対してどれだけ出るかで決める。
 */
/** これ以下なら、たまたま混ざっただけとみる */
const MIN_ARCHAIC_HITS = 5;

export function looksArchaicText(text: string): boolean {
  if (text.length < 500) return false;

  let hits = 0;
  for (const form of ARCHAIC_FORMS) {
    if (form.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(form, from);
      if (at < 0) break;
      hits++;
      from = at + form.length;
    }
  }
  for (const ch of text) {
    if (ARCHAIC_MARKS.test(ch)) hits++;
  }

  // **回数と密度の両方を見る。** 密度だけだと、短い本文に旧字が1つ
  // 混ざっただけで「文語体」と言ってしまう。現代文の小説にも
  // 「然し」が1度だけ現れることはある
  if (hits < MIN_ARCHAIC_HITS) return false;

  // 2,000字あたり1回以上。実データの自分史（戦前の文語体）で
  // 1,000字あたり2〜3回、現代文の作品で0〜0.2回だった
  return hits / (text.length / 2000) >= 1;
}

/**
 * チャンクから、その行の本文を取り出す。
 *
 * **`withLineNumbers` が振った番号と対で使う。** あちらは
 * `chunk.startLine + index + 1` を振るので、こちらは逆をたどる。
 *
 * 範囲の外なら undefined。呼び出し側が抜粋で代用できるようにする
 * （行が取れないことを理由に、検査そのものを飛ばさないため）。
 */
export function lineTextOf(chunk: Chunk, line: number): string | undefined {
  const index = line - chunk.startLine - 1;
  if (index < 0) return undefined;
  return chunk.text.split("\n")[index];
}
