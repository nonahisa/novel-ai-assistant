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
  | "rewrites_span"
  /**
   * 違いが空白だけで、取ってよい空白ではない
   * （行頭の字下げ・感嘆符のあと・行末・英字の間。または空白を足す直し）
   */
  | "whitespace_only"
  /** 当てると括弧が消える（閉じ括弧を句点に替えるなど） */
  | "bracket_removed";

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
  /**
   * 修正案が抱えていた前後の文を、こちらで外したか（`trimCarriedContext`）。
   *
   * `rangeExtended` と同じく、**AIの言い分をそのまま採らなかった**と分かるようにする。
   * 作者が見る `reason` にも「（修正案から前後の文を外しました）」と出す。
   */
  contextTrimmed?: boolean;
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
  whitespace_only: "空白だけの直し",
  bracket_removed: "括弧が消える",
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
    // 本文のその行。取れなければ抜粋で代用する（検査そのものを飛ばさないため）
    const lineText = lineTextOf(chunk, issue.line) ?? issue.original;
    const range = checkParticleRange(
      lineText,
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
    if (target === issue.suggestion) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "no_change",
      });
      continue;
    }

    // **括弧でくくった中身の無い言葉**（「（特に修正なし）」）。言い方の一覧
    // （下の `isPlaceholderText`）に無い言い方でも、形で落とす（失敗3）。
    // 前後の句を外す手当て（`trimCarriedContext`）より先に見る——外し方が
    // 本文と偶然ずれると、中身の無い言葉が別の形に化けて残るため
    if (isBracketedNonAnswer(lineText, target, issue.suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "placeholder_suggestion",
      });
      continue;
    }

    // **違いが空白だけのもの。** 以前は空白を消してから比べていたため、
    // 文中に紛れ込んだ全角空白を取る直し（「、　」→「、」）を**必ず**
    // 「直しにならない」として捨てていた（正解つきの台で測って見つかった、
    // 2026-09-26）。取ってよい空白かどうかを、本文のその行で決める
    const whitespaceOnly =
      normalizeForComparison(target) === normalizeForComparison(issue.suggestion);
    if (
      whitespaceOnly &&
      !isStraySpaceRemoval(lineText, original, target, issue.suggestion)
    ) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "whitespace_only",
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

    // **修正案が前後の句を抱えてくる。** 直した語だけでなく、その前後の
    // 本文まで修正案に入れてくるモデルがある（さくら gemma-4-31B-it：
    // 「身体をの」→「身体の緊張を無理やり」）。そのまま当てると抱えた句が
    // 二重に残るので、これまでは捨てていた——**正しく見つけた9件が
    // すべて捨てられていた**（正解つきの台、2026-09-26）。
    //
    // 抱えた句が本文と字どおり一致するなら、それを外した残りが本当の直しで
    // ある。**外して当てた結果は、修正案で前後の句ごと置き換えた結果と
    // 1字も違わない**ので、本文を壊さない。外した残りが誤字脱字の直しの形
    // （数字の足し引き・入れ替え）をしていなければ、言い換えなので捨てる
    let suggestion = issue.suggestion;
    let contextTrimmed = false;
    if (!whitespaceOnly) {
      const carried = trimCarriedContext(lineText, original, target, suggestion);
      if (carried.kind === "not_a_typo_fix") {
        rejected.push({
          line: issue.line,
          target: issue.target,
          reason: "duplicates_context",
        });
        continue;
      }
      if (carried.kind === "trimmed") {
        suggestion = carried.suggestion;
        contextTrimmed = true;
        // 外した残りに対して、先に済ませた検査をやり直す
        if (target === suggestion) {
          rejected.push({
            line: issue.line,
            target: issue.target,
            reason: "no_change",
          });
          continue;
        }
        if (isPronounSwap(target, suggestion)) {
          rejected.push({
            line: issue.line,
            target: issue.target,
            reason: "pronoun_change",
          });
          continue;
        }
      }
    }

    // **足す字が、本文のすぐ隣にもうある。** 「痛」→「痛い」と返ったが、
    // 本文はすでに「痛い。」で、当てると「痛いい」になる（さくら gpt-oss-120b。
    // 誤検出の確かめ、2026-09-26）。助詞1字の場合は `checkParticleRange` が
    // 同じことを見ている。ここはそれを字の種類を問わず広げたもの
    if (!whitespaceOnly && addsWhatIsAlreadyThere(lineText, original, target, suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "no_change",
      });
      continue;
    }

    // **当てると括弧が消える直しは通さない。** 台詞の閉じ括弧を句点に替える案
    // （「…だそうです」」→「…だそうです。」）が確信度「低」で返った
    // （gemma4:e4b。誤検出の確かめ、2026-09-26）。括弧は台詞の区切りで、
    // 消えると前後の地の文まで台詞に読める。**足すのは通す**（閉じ忘れの直し）
    if (removesBracket(target, suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "bracket_removed",
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
    if (suggestion.length - target.length > MAX_SUGGESTION_GROWTH) {
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
    // **前後の句を外したあとも、もう一度確かめる**（外し方が本文と
    // 偶然ずれた場合の保険。ここを通らないものは当てない）
    if (wouldDuplicateContext(lineText, original, target, suggestion)) {
      rejected.push({
        line: issue.line,
        target: issue.target,
        reason: "duplicates_context",
      });
      continue;
    }

    // **末尾の句読点を足すだけの指摘は誤字ではない。**
    // 台詞の終わりに「。」を足す提案が返るが、日本語の小説では
    // **台詞の末尾に句点を打たない**のが普通である。
    //
    // **ただし地の文の行末の句点抜けは、本物の入力ミスである**
    // （2026-09-26）。プロンプトは「明らかな入力ミス」を拾えと言いながら、
    // ここで一律に捨てていた。台詞の外で、行末に句点を1つ足すものだけ通す
    // （`isNarrationLineEndPeriod`）。**空白だけの直しはここを通さない**
    // ——句読点のあとの空白を取る直しが「末尾の句読点だけ」に見えるため
    if (
      !whitespaceOnly &&
      onlyTrailingPunctuation(target, suggestion) &&
      !isNarrationLineEndPeriod(
        textBeforeLine(chunk, issue.line),
        lineText,
        original,
        target,
        suggestion
      )
    ) {
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
    if (onlyScriptDifference(target, suggestion)) {
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
    if (isPlaceholderText(suggestion)) {
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
      suggestion,
      // **範囲を広げたこと・前後の文を外したことを作者に見せる。**
      // 黙って直すと、画面の「対象」「修正案」がAIの言い分と違っている
      // 理由が分からない
      reason:
        issue.reason +
        (rangeExtended ? "（範囲を1字広げました）" : "") +
        (contextTrimmed ? "（修正案から前後の文を外しました）" : ""),
      confidence: VALID_CONFIDENCE.has(issue.confidence)
        ? (issue.confidence as "high" | "medium" | "low")
        : "low",
      ...(rangeExtended ? { rangeExtended: true } : {}),
      ...(contextTrimmed ? { contextTrimmed: true } : {}),
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

/**
 * 前後の余分な空白を落とす。**全角空白は落とさない。**
 *
 * `trim()` は全角空白（U+3000）も落とす。文中に紛れた全角空白を取る直し
 * （target「、　」→ suggestion「、」）は、ここで target が「、」に削られ、
 * 修正案と同じになって必ず捨てられていた（正解つきの台、2026-09-26）。
 * 落とすのは、JSONの書き方で紛れる半角空白・タブ・改行だけにする。
 */
function cleanRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = decodeByteTokens(value).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  // 空白しか無いものは、中身が無いのと同じに扱う（全角空白だけ、も含む）
  return cleaned.trim() ? cleaned : null;
}

/**
 * 字の代わりに書かれたバイトの札（`<0xE3><0x80><0x80>`）を字へ戻す。
 *
 * **手元の小さいモデルが、全角空白をこの形で書いてくる**（`gemma4:e4b`、
 * 正解つきの台で第2話「角が、　パチパチと」を正しく見つけたのに、
 * target が「角が、<0xE3><0x80><0x80>パチパチと」だった。2026-09-26）。
 * 本文との照合（`normalizeForComparison`）はこの札を消してから比べるので
 * 引用は通るが、当てる段では字が合わず、空白の直しとしても読めなかった。
 *
 * **UTF-8 として読めるときだけ戻す。** 読めない並びはそのまま残す
 * （後の照合が「本文に無い引用」として落とす）。
 */
function decodeByteTokens(text: string): string {
  return text.replace(/(?:<0x[0-9A-Fa-f]{2}>)+/g, (run) => {
    const bytes = Uint8Array.from(
      run.match(/<0x([0-9A-Fa-f]{2})>/g) ?? [],
      (token) => parseInt(token.slice(3, 5), 16)
    );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return run;
    }
  });
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
 * 前後の句を抱えた修正案の見立て（`trimCarriedContext`）。
 *
 * - `none`：抱えていない。修正案は対象だけの直しとして、これまでどおり見る
 * - `trimmed`：抱えていた句を外した。`suggestion` が対象だけの直し
 * - `not_a_typo_fix`：抱えているが、外した残りが誤字脱字の直しの形をしていない
 *   （言い換え）。**そのまま当てると本文が二重になる**ので捨てる
 */
export type CarriedContextCheck =
  | { kind: "none" }
  | { kind: "trimmed"; suggestion: string }
  | { kind: "not_a_typo_fix" };

/**
 * 1字でも、重なれば必ず抱え込みだと言える記号。
 *
 * 句点・読点・括弧が二重になる直し（「行う。。」）を作者が望むことはない。
 * **三点リーダーとダッシュは入れない**——「……」「――」は2つ重ねて使う
 * のが普通で、1字の一致は偶然でありうる。
 */
const CARRY_MARKS = new Set([
  "。",
  "、",
  "，",
  "．",
  "！",
  "？",
  "!",
  "?",
  "「",
  "」",
  "『",
  "』",
  "（",
  "）",
  "(",
  ")",
]);

/**
 * 修正案が抱えてきた前後の句を外す（設計書6.8.11 の続き）。
 *
 * **さくらの gemma-4-31B-it が、直した語の前後まで修正案に書いてくる。**
 *
 * ```
 * 本文:   言い聞かせて、身体をの緊張を無理やり解いていく。
 * target:        身体をの
 * suggestion:    身体の緊張を無理やり        ← 後ろの「緊張を無理やり」を抱えている
 * ```
 *
 * 修正案の**先頭が対象の直前の本文と**、**末尾が対象の直後の本文と**
 * 字どおり一致するなら、その部分は抱えてきた句である。外した残り（「身体の」）
 * で対象を置き換えた結果は、**修正案で前後の句ごと置き換えた結果と
 * 1字も違わない**——だから外しても本文は壊れない。
 *
 * **2字以上の一致から抱え込みとみる**（`wouldDuplicateContext` と同じ理由。
 * 1字だと助詞の偶然の一致がある）。ただし句読点・括弧は1字でもみる。
 * どちらかの側で抱え込みと決まったら、もう片方は1字の一致でも外す
 * （片側に句を抱えるモデルは、反対側の句点も抱えてくる：「今は８歳である。」）。
 *
 * **外した残りが誤字脱字の直しの形でなければ捨てる**（`isTypoShapedEdit`）。
 * 実際に原稿を壊しかけた「会わすぐらい」→「夢で会わせるくらいのことは…」は、
 * 外しても「会わす→会わせる」「ぐらい→くらい」の言い換えである。
 */
export function trimCarriedContext(
  /** 本文のその行そのもの */
  lineText: string,
  /** AIの抜粋。当てる位置を決めるのに使う（適用処理と同じ手順） */
  original: string,
  target: string,
  suggestion: string
): CarriedContextCheck {
  const originalAt = lineText.indexOf(original);
  const targetInOriginal = original.indexOf(target);
  if (originalAt < 0 || targetInOriginal < 0) return { kind: "none" };

  const at = originalAt + targetInOriginal;
  const before = lineText.slice(0, at);
  const after = lineText.slice(at + target.length);

  const head = tailHeadOverlap(before, suggestion);
  // 後ろは、前で外した残りの中だけで探す（前後で同じ字を2度数えない）
  const tail = tailHeadOverlap(suggestion.slice(head), after);

  const headCarried =
    head >= MIN_DUPLICATE_OVERLAP ||
    (head === 1 && CARRY_MARKS.has(suggestion[0]));
  const tailCarried =
    tail >= MIN_DUPLICATE_OVERLAP ||
    (tail === 1 && CARRY_MARKS.has(suggestion[suggestion.length - 1]));
  if (!headCarried && !tailCarried) return { kind: "none" };

  const core = suggestion.slice(head, suggestion.length - tail);
  if (!core || !isTypoShapedEdit(target, core)) {
    return { kind: "not_a_typo_fix" };
  }
  return { kind: "trimmed", suggestion: core };
}

/** `left` の末尾と `right` の先頭が、最長で何字重なるか（1字から数える） */
function tailHeadOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let length = max; length >= 1; length--) {
    if (left.slice(left.length - length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

/**
 * 対象と修正案の違いが、誤字脱字の直しの形をしているか。
 *
 * 先頭と末尾の共通部分を除いた「消す字」「足す字」の数で見る。
 * 正解つきの台で、正しい直しは次の範囲に収まっていた（2026-09-26）。
 *
 * - 消すだけ（衍字）：4字まで（「いただいただける」→「いただける」で3字）
 * - 足すだけ（脱字）：2字まで（「くだい」→「ください」で1字）
 * - 入れ替え（誤字・誤変換）：消す字も足す字も2字まで（「拾い」→「離し」）
 *
 * **前後の句を外したときにだけ使う。** 句を抱えてくる答えは、こちらで
 * 解釈し直しているので、形のはっきりしたものだけを通す。
 */
export function isTypoShapedEdit(target: string, suggestion: string): boolean {
  const shorter = Math.min(target.length, suggestion.length);
  let prefix = 0;
  while (prefix < shorter && target[prefix] === suggestion[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    target[target.length - 1 - suffix] ===
      suggestion[suggestion.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = target.length - prefix - suffix;
  const inserted = suggestion.length - prefix - suffix;
  if (removed === 0 && inserted === 0) return true; // 同じ。後の検査が「直しにならない」で捨てる
  if (inserted === 0) return removed <= 4;
  if (removed === 0) return inserted <= 2;
  return removed <= 2 && inserted <= 2;
}

/**
 * 空白を取る直しのうち、取ってよい空白か。
 *
 * **文中に紛れ込んだ空白は、本物の入力ミスである**（第2話「角が、　パチパチと」）。
 * ただし空白には、作法として置くものがある。次の空白は取らない。
 *
 * - **行頭の字下げ**
 * - **感嘆符・疑問符のあと**（「！　」「？　」は作法。`writingStyleCheck.ts` が見る）
 * - **行末**（見えず、害も無い。直しても作者の手間が増えるだけ）
 * - **英字・数字の隣**（「画面に Hello World」の語の区切り）
 *
 * **空白を足す直しも通さない。** 空白の有無は書き方の選択であって、
 * 足さないと誤りになる空白は無い。
 */
export function isStraySpaceRemoval(
  lineText: string,
  original: string,
  target: string,
  suggestion: string
): boolean {
  if (suggestion.length >= target.length) return false;

  let prefix = 0;
  while (
    prefix < suggestion.length &&
    target[prefix] === suggestion[prefix]
  ) {
    prefix++;
  }
  // 残りは末尾どうしで揃っているはず（消した字だけが違う）
  if (target.slice(target.length - (suggestion.length - prefix)) !== suggestion.slice(prefix)) {
    return false;
  }
  const removed = target.slice(prefix, target.length - (suggestion.length - prefix));
  if (!removed || !/^[ 　\t]+$/u.test(removed)) return false;

  const originalAt = lineText.indexOf(original);
  const targetInOriginal = original.indexOf(target);
  if (originalAt < 0 || targetInOriginal < 0) return false;
  const from = originalAt + targetInOriginal + prefix;
  const before = lineText.slice(0, from);
  const after = lineText.slice(from + removed.length);

  // 行頭の字下げ・行末の空白
  if (!/\S/u.test(before) || !/\S/u.test(after)) return false;
  const previous = before[before.length - 1];
  const next = after[0];
  if ("！？!?".includes(previous)) return false;
  if (/[A-Za-z0-9]/.test(previous) || /[A-Za-z0-9]/.test(next)) return false;
  return true;
}

/**
 * 修正案が「対象＋字」または「字＋対象」で、足す字が本文のすぐ隣にもうあるか。
 *
 * そのまま当てると、同じ字が2度並ぶ（「痛い。」の「痛」→「痛い」で「痛いい。」）。
 * 本文はすでに直った形なので、直しにならない。
 */
export function addsWhatIsAlreadyThere(
  lineText: string,
  original: string,
  target: string,
  suggestion: string
): boolean {
  const originalAt = lineText.indexOf(original);
  const targetInOriginal = original.indexOf(target);
  if (originalAt < 0 || targetInOriginal < 0) return false;
  const at = originalAt + targetInOriginal;
  if (suggestion.length > target.length && suggestion.startsWith(target)) {
    const added = suggestion.slice(target.length);
    if (lineText.startsWith(added, at + target.length)) return true;
  }
  if (suggestion.length > target.length && suggestion.endsWith(target)) {
    const added = suggestion.slice(0, suggestion.length - target.length);
    if (lineText.slice(0, at).endsWith(added)) return true;
  }
  return false;
}

/** 数を減らしてはいけない括弧（台詞・引用・補足の区切り） */
const BRACKETS = ["「", "」", "『", "』", "（", "）", "(", ")", "【", "】", "〈", "〉", "《", "》"];

/** 修正案で、どれかの括弧が減るか（足すのは閉じ忘れの直しなので構わない） */
export function removesBracket(target: string, suggestion: string): boolean {
  const count = (text: string, mark: string) => text.split(mark).length - 1;
  return BRACKETS.some((mark) => count(suggestion, mark) < count(target, mark));
}

/**
 * 修正案まるごとをくくる括弧の対（`isBracketedNonAnswer`）。
 *
 * 鉤括弧（「」『』）は入れない。台詞の直しは台詞ごと返ってくるのが普通で、
 * 中の言葉が本文の言い換えになっていることもある（そちらは言い換えの検査が見る）。
 */
const ENCLOSING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["（", "）"],
  ["(", ")"],
  ["【", "】"],
  ["［", "］"],
  ["[", "]"],
  ["〔", "〕"],
  ["〈", "〉"],
  ["《", "》"],
];

/**
 * 括弧が無くても「直さない」と言っている形（**補助**。主は括弧の形で見る）。
 *
 * 「問題なし」「なし」は入れない。誤字の直しの答えとしてありうる
 * （「問題なひ」→「問題なし」）。直す対象を名指しする語（修正・誤字…）か
 * 「特に」を伴うものだけにする。
 */
const NON_ANSWER_PHRASE =
  /^(?:特に|とくに)?(?:修正|変更|訂正|誤字脱字|誤字|脱字|指摘|直し)(?:は|も)?(?:なし|無し|ありません|不要|しません|の必要なし|の必要はありません)$|^(?:特に|とくに)(?:なし|無し|ありません|問題なし|問題ありません)$/u;

/**
 * 修正案が「（特に修正なし）」のように、**括弧でくくった中身の無い言葉**か
 * （2026-09-26）。
 *
 * CLAUDE.md の失敗3（指示の言葉が答えとして返ってくる）の形である。
 * `placeholderText.ts` の一覧は括弧を外して言い方と突き合わせるが、言い方は
 * いくらでも変わる（「特に修正なし」は一覧に無く、通っていた）。そこで
 * **言い方ではなく形で見る**：修正案まるごとが括弧でくくられ、しかも
 * **中の言葉が本文のその行に無い**なら、本文から来た直しではない。
 *
 * 落とさないもの（本文の括弧を直す正しい直し）：
 *
 * - 対象そのものが同じ括弧を持つ（「（たぶんあ）」→「（たぶんな）」、
 *   抜けた閉じ括弧を足す「（笑いながら」→「（笑いながら）」）。括弧は本文から来ている
 * - 中の言葉が本文のその行にある（本文の語を括弧でくくる直し）
 *
 * 括弧でくくっていないものは、`NON_ANSWER_PHRASE` の形だけを補助として見る
 * （これも本文のその行にあれば落とさない）。
 */
export function isBracketedNonAnswer(
  lineText: string,
  target: string,
  suggestion: string
): boolean {
  const body = suggestion.trim();
  const haystack = normalizeForComparison(lineText);
  const inLine = (text: string): boolean =>
    haystack.includes(normalizeForComparison(text));

  const pair = ENCLOSING_PAIRS.find(
    ([open, close]) =>
      body.length >= open.length + close.length &&
      body.startsWith(open) &&
      body.endsWith(close)
  );
  if (pair) {
    const [open, close] = pair;
    // 対象が同じ括弧を持つなら、括弧は本文から来ている（括弧の直し）
    if (target.includes(open) || target.includes(close)) return false;
    const inner = body.slice(open.length, body.length - close.length).trim();
    // 中にも同じ括弧があるなら、まるごとくくった形ではない（「（a）と（b）」）
    if (inner.includes(open) || inner.includes(close)) return false;
    if (!normalizeForComparison(inner)) return true;
    return !inLine(inner);
  }
  return NON_ANSWER_PHRASE.test(body) && !inLine(body);
}

/** 台詞を開く括弧と閉じる括弧 */
const OPEN_QUOTES = "「『（(";
const CLOSE_QUOTES = "」』）)";

/**
 * 地の文の行末に、句点を1つ足す直しか。
 *
 * **台詞の末尾に句点を打たないのは日本語の小説の決まり**なので、
 * 句点を足す直しは `punctuation_only` として捨ててきた。ところが
 * 地の文の行末で句点が抜けているのは、**本物の入力ミス**である
 * （第10話「部下がそのまま移住してきたそうだ」）。
 *
 * 次をすべて満たすものだけを通す。
 *
 * - 修正案が、対象の後ろに「。」を1つ足しただけ
 * - 対象が行の終わりまで届いている（行の途中に句点を足す直しではない）
 * - 対象の最後の字が、文字（漢字・かな・英数字）。「……」「！」のあとには足さない
 * - **台詞の中ではない**：この行の手前（同じチャンクの前の行を含む）から数えて、
 *   開き括弧がすべて閉じている
 */
export function isNarrationLineEndPeriod(
  /** 同じチャンクの、この行より前の本文。台詞が行をまたいでいるかを見る */
  textBefore: string,
  lineText: string,
  original: string,
  target: string,
  suggestion: string
): boolean {
  if (suggestion !== `${target}。`) return false;

  const originalAt = lineText.indexOf(original);
  const targetInOriginal = original.indexOf(target);
  if (originalAt < 0 || targetInOriginal < 0) return false;
  const end = originalAt + targetInOriginal + target.length;
  if (/\S/u.test(lineText.slice(end))) return false;

  const last = target[target.length - 1];
  if (
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆A-Za-z0-9０-９Ａ-Ｚａ-ｚ]/u.test(
      last
    )
  ) {
    return false;
  }

  // 括弧の深さを数える。閉じすぎは0で止める（前の話の閉じ忘れなどを
  // 引きずらないため）。**この行の中で閉じすぎたら台詞の続き**とみる
  let depth = 0;
  for (const char of textBefore) {
    if (OPEN_QUOTES.includes(char)) depth++;
    else if (CLOSE_QUOTES.includes(char)) depth = Math.max(0, depth - 1);
  }
  for (const char of lineText.slice(0, end)) {
    if (OPEN_QUOTES.includes(char)) depth++;
    else if (CLOSE_QUOTES.includes(char)) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** チャンクの中で、その行より前の本文（台詞が行をまたぐかを見るため） */
function textBeforeLine(chunk: Chunk, line: number): string {
  const index = line - chunk.startLine - 1;
  if (index <= 0) return "";
  return chunk.text.split("\n").slice(0, index).join("\n");
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
