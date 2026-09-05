import { locateChunkLine, segmentsOf, type Chunk } from "./chunker";
import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";
import { nonJouyouKanjiIn } from "./jouyouKanji";
import { isKeptWord, type KeepWord } from "../models/keepWord";
import {
  issueBudget,
  PROOFREAD_REASONS,
  type ProofreadReason,
} from "../prompts/proofread";

/**
 * 推敲の提案の検証（設計書6.9.1）。
 *
 * **この機能でいちばん危ないのは、出しすぎること。**
 * 誤字脱字には正解があるが、推敲には無い。AIはどの文にも何かしら言えるので、
 * 放っておくと**全部の文に提案が付く**。作者は読むだけで疲れて、
 * 機能ごと使わなくなる。
 *
 * したがってここでは、
 *
 * - **件数を機械的に切る**（1000字あたり3件）。プロンプトでも言うが守らない
 * - **確信度の高いものから残す。** 切るときに迷っている提案が残ると、
 *   質の低いものだけが手元に来る
 * - 決めた6種類以外の理由を弾く（文体への干渉が紛れ込む口を塞ぐ）
 * - **変わっていない提案を弾く。** 原文と同じものを「修正案」として返す
 *
 * VS Code APIに依存しない。
 */

export interface AcceptedProofreadIssue {
  line: number;
  original: string;
  /** 置き換える範囲。推敲では原文まるごと */
  target: string;
  suggestion: string;
  reason: ProofreadReason;
  explanation: string;
  confidence: "high" | "medium" | "low";
  /**
   * 語尾単調のときの、連続そのもの（設計書6.30.4）。
   *
   * **ここでは説明文を組まない。** 説明文には行範囲が入るが、`line` は
   * まだ**チャンクが振った番号**であって、ファイルの行番号ではない。
   * まとめたチャンク（`mergeAdjacentChunks`）ではこの2つが食い違うので、
   * 行が確定する `locateProofreadIssue` まで実体のまま持ち回る。
   */
  monotony?: MonotonousRun;
}

export interface RejectedProofreadIssue {
  raw: unknown;
  reason:
    | "shape"
    | "line_out_of_range"
    | "original_not_found"
    | "unknown_reason"
    | "no_change"
    /** 件数の上限を超えた */
    | "over_budget"
    /** 「長文」の札だが、当てはまる一文が無い */
    | "not_long"
    /** 「同語反復」の札だが、繰り返しが無い */
    | "not_repeated"
    /** 「語尾単調」の札だが、同じ語尾が4文以上続いていない */
    | "not_monotonous"
    /**
     * 「語尾単調」の札で、**すでに出した連続と同じまとまり**を指している。
     *
     * AIは同じ連続を別々の指摘として何枚も返してくる（作者の報告、
     * 2026-09-05。同じ並びに3枚並んだ）。連続は1つで1件なので畳む
     */
    | "monotony_duplicate"
    /** 作者が「直さない」と決めた語を含む */
    | "kept_word"
    /** 「同語反復」の札だが、台詞の中＝人物の話し方である */
    | "dialogue_voice"
    /** 説明が、禁じた観点（語彙・文体など）を語っている */
    | "forbidden_aspect";
}

const LEVELS = new Set(["high", "medium", "low"]);
const REASON_SET = new Set<string>(PROOFREAD_REASONS);

/**
 * 「長文」の目安（プロンプト設計書P-10）。**一文が80字を超え、読点が5個以上。**
 */
const LONG_SENTENCE_CHARS = 80;
const LONG_SENTENCE_COMMAS = 5;

/**
 * 「長文」の札が、本当に長文に貼られているか。
 *
 * **実データで、長文でない箇所に貼られていた**（2026-08-16）。
 * 「文の区切りが連続しており、流れがやや急ぎ足」のような**文体の話**に
 * この札が付いてくる。**禁じたはずの干渉が、許した札で入ってくる。**
 *
 * 長文だけは目安が数で決まっているので、コードで確かめられる。
 * 当てはまる一文が無ければ、それは長文の指摘ではない。
 */
export function hasLongSentence(text: string): boolean {
  for (const body of splitIntoSentences(text)) {
    if (body.length <= LONG_SENTENCE_CHARS) continue;
    const commas = (body.match(/[、，]/g) ?? []).length;
    if (commas >= LONG_SENTENCE_COMMAS) return true;
  }
  return false;
}

/**
 * 句点・感嘆符・疑問符で文に割る（閉じ括弧が続く場合はそこまで）。
 *
 * 長文と語尾単調の両方が同じ切り方を要る。**写しを作らない**ため、
 * ここに1つだけ置いて共用する。
 */
export function splitIntoSentences(text: string): string[] {
  return splitSentencesWithOffsets(text).map((sentence) => sentence.body);
}

/**
 * 文に割りつつ、**その文が元の文字列のどこから始まるか**も返す。
 *
 * 語尾単調は「どこの連続か」を作者へ示すので、行番号が要る。
 * 行番号は位置からしか出せないため、割ると同時に位置を持って回る。
 *
 * 割り方は `splitIntoSentences` と同じ（句点・感嘆符・疑問符で切り、
 * 直後の閉じ括弧はそこまでを1文に含めずに読み飛ばす）。**写しを作らない**ため、
 * `splitIntoSentences` はこちらを呼ぶ。
 */
function splitSentencesWithOffsets(
  text: string
): Array<{ body: string; start: number }> {
  const sentences: Array<{ body: string; start: number }> = [];
  const push = (piece: string, from: number): void => {
    const body = piece.trim();
    if (body.length === 0) return;
    // trim で落ちた先頭の空白ぶん、開始位置をずらす（行番号がずれる）
    sentences.push({
      body,
      start: from + (piece.length - piece.trimStart().length),
    });
  };

  let from = 0;
  let cursor = 0;
  while (cursor < text.length) {
    if (!"。！？".includes(text[cursor])) {
      cursor++;
      continue;
    }
    const end = cursor + 1;
    let next = end;
    while (next < text.length && "」』）".includes(text[next])) next++;
    push(text.slice(from, end), from);
    from = next;
    cursor = next;
  }
  push(text.slice(from), from);
  return sentences;
}

/**
 * 「語尾単調」の札が、本当に語尾の連続に貼られているか
 * （作者の報告、2026-09-04）。
 *
 * 画面には「『〜た。』で終わる文が5連続です」と出ていたが、実際の文末は
 * 「いる。／いた。／だろう。／ないわ」／だ。」で、**どこにも5連続は無かった。**
 * AIは数を数えられない。長文・同語反復と同じで、**連続は数えられるので
 * コードで確かめる。**
 *
 * 数え方は3つ決めてある。
 *
 * 1. **語尾は「文末の1文字＋句点」で見る**（「た。」「だ。」「る。」）。
 *    **「た。」と「だ。」は別**——濁点で意味が違うので、同じ語尾として
 *    数えると今回のような数え違いが素通りする
 * 2. **台詞は数えず、地の文の連続も切らない。** 台詞を挟んでも地の文の
 *    リズムは続いているが、台詞の語尾は人物の話し方であって地の文の
 *    単調さとは別物である（`isDialogueOnly` と同じ考え方）
 * 3. **AIの言う語尾とは突き合わせない。** 説明文の解析は壊れやすいので、
 *    「どの語尾であれ4連続以上が実在するか」だけを見る。語尾の言い違いは
 *    実害が小さい（作者が本文を見れば分かる）
 *
 * 見るのはチャンク全体で、指摘の位置とは照合しない。**語尾単調は範囲の
 * 指摘で、1行に錨を下ろせない**ためである。
 */
export const MONOTONOUS_ENDING_RUN = 4;

/**
 * 連続の実体。**画面に出すのはこれだけ**（AIの言い値は使わない）。
 */
export interface MonotonousRun {
  /** 続いている語尾（文末の1文字＋句点） */
  ending: string;
  /** 続いている文の数 */
  count: number;
  /**
   * 最初の文が始まる行。
   *
   * **`withLineNumbers` が振ったのと同じ番号**（`chunk.startLine + n + 1`）で、
   * ファイルの行番号とは限らない。まとめたチャンクではまとめた本文の
   * 通し番号になる——ファイルの行へ直すのは `locateChunkLine` の仕事で、
   * その1か所に寄せてある（設計書6.30.4）。
   */
  startLine: number;
  /** 最後の文が終わる行（`startLine` と同じ番号の付け方） */
  endLine: number;
  /** 各文の書き出し（長ければ `MONOTONOUS_HEAD_CHARS` 字＋「…」） */
  heads: string[];
  /**
   * 先頭の文（切っていないもの）。
   *
   * 画面の引用に使う。**`heads[0]` は「…」で切ってあるので使えない**——
   * 引用は本文に実在する文字列でなければならない（提案パネルは
   * 引用の当たる場所を本文から探す）
   */
  first: string;
}

/** 書き出しとして見せる字数。1文節ぶんあれば、どの文かは分かる */
const MONOTONOUS_HEAD_CHARS = 12;

/**
 * 語尾の連続を、**まとまりごとに取り出す**（作者の報告、2026-09-05）。
 *
 * `hasMonotonousEnding` は「チャンクのどこかに4連続があるか」しか
 * 答えないので、画面には**AIが選んだ1行**（「た。」で終わらない台詞のことも
 * あった）と**AIの言い値の連続数**が並んでいた。作者の言葉は
 * 「よくわからなかった」である。
 *
 * 数え方は `hasMonotonousEnding` と同じ（地の文だけ・台詞は連続を切らない・
 * 「た。」と「だ。」は別・句点で終わらない断片は数えない）。
 * 違うのは、**どこの・何文かまで返す**ところだけ。
 *
 * **台詞は消さずに空白へ置き換える。** 消すと後ろの行が繰り上がり、
 * 返す行番号が本文とずれる（改行はそのまま残す）。
 *
 * @param text 数える本文（チャンク、またはその内訳1つぶん）
 * @param firstLine その本文の1行目に付いている行番号（1始まり）
 */
export function findMonotonousRuns(
  text: string,
  firstLine: number
): MonotonousRun[] {
  const masked = maskDialogue(text);
  const lineOf = lineCounter(masked);

  // 語尾のある文だけを、位置つきで並べる。
  // **数えない文は落とすだけで、連続は切らない**（`hasMonotonousEnding` と同じ）
  const counted: Array<{ ending: string; start: number; end: number }> = [];
  for (const sentence of splitSentencesWithOffsets(masked)) {
    const ending = endingOf(sentence.body);
    if (!ending) continue;
    counted.push({
      ending,
      start: sentence.start,
      end: sentence.start + sentence.body.length,
    });
  }

  const runs: MonotonousRun[] = [];
  let from = 0;
  for (let cursor = 1; cursor <= counted.length; cursor++) {
    // 語尾が変わるまで（＝まとまりの終わりまで）伸ばす
    if (cursor < counted.length && counted[cursor].ending === counted[from].ending) {
      continue;
    }
    const group = counted.slice(from, cursor);
    from = cursor;
    if (group.length < MONOTONOUS_ENDING_RUN) continue;
    const last = group[group.length - 1];
    const sentenceOf = (sentence: { start: number; end: number }): string =>
      text.slice(sentence.start, sentence.end);
    runs.push({
      ending: group[0].ending,
      count: group.length,
      first: sentenceOf(group[0]),
      startLine: firstLine + lineOf(group[0].start),
      // 終わりの位置は句点の**次**を指しているので、句点そのものの行を見る
      endLine: firstLine + lineOf(last.end - 1),
      // **書き出しは元の本文から取る**（空白へ置き換えた側から取ると、
      // 台詞の抜けた穴がそのまま見えてしまう）
      heads: group.map((sentence) => headOf(sentenceOf(sentence))),
    });
  }
  return runs;
}

/** 文の書き出し。改行は畳む（1文が複数行にまたがることがある） */
function headOf(sentence: string): string {
  const body = sentence.replace(/\r?\n/g, "").trim();
  const chars = Array.from(body);
  return chars.length > MONOTONOUS_HEAD_CHARS
    ? `${chars.slice(0, MONOTONOUS_HEAD_CHARS).join("")}…`
    : body;
}

/**
 * 位置から「そこまでに改行がいくつあるか」を引く。
 *
 * 文の数だけ数え直すと本文の長さに対して二乗になるので、
 * 改行の位置を一度だけ集めて二分探索する。
 */
function lineCounter(text: string): (offset: number) => number {
  const breaks: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") breaks.push(index);
  }
  return (offset) => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (breaks[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

export function hasMonotonousEnding(text: string): boolean {
  // **判定は連続の実体から出す。** 数え方を2か所に置くと必ず食い違う
  return findMonotonousRuns(text, 1).length > 0;
}

/**
 * チャンクの中の連続を、**内訳（話）ごとに**数える（設計書6.30.4）。
 *
 * まとめたチャンク（`mergeAdjacentChunks`）をひとつながりの本文として
 * 数えると、**第1話の末尾2文と第2話の冒頭2文で「た。」の4連続ができる。**
 * 話が変われば語りも切れているので、それは地の文の単調さではない。
 * 内訳の切れ目で必ず数え直す。
 *
 * 返す行番号は `withLineNumbers` と同じ番号（チャンクの中での通し番号）に
 * 揃える。ファイルの行へ直すのは `locateChunkLine` の1か所だけである。
 */
export function findMonotonousRunsInChunk(chunk: Chunk): MonotonousRun[] {
  const runs: MonotonousRun[] = [];
  for (const segment of segmentsOf(chunk)) {
    const body = chunk.text.slice(segment.start, segment.end);
    // この内訳の1行目が、チャンクの中で何行目に当たるか
    const firstLine =
      chunk.startLine + countNewlines(chunk.text, segment.start) + 1;
    runs.push(...findMonotonousRuns(body, firstLine));
  }
  return runs;
}

/** `upto` の手前までにある改行の数 */
function countNewlines(text: string, upto: number): number {
  let count = 0;
  for (let index = 0; index < upto; index++) {
    if (text[index] === "\n") count++;
  }
  return count;
}

/**
 * 指摘の行から、いちばん近い連続を選ぶ。
 *
 * AIの錨は当てにならない（台詞の1行に下ろされていた）が、**どのあたりを
 * 見て言っているかの手掛かりにはなる。** チャンクに連続が2つ以上あるとき、
 * 遠いほうへ付け替えると別の場所の話になってしまうので、近いほうを選ぶ。
 * 範囲の中に入っていれば距離0。同じ距離なら先に出てくるほうを採る。
 */
export function nearestMonotonousRun(
  runs: MonotonousRun[],
  line: number
): MonotonousRun | undefined {
  let nearest: MonotonousRun | undefined;
  let shortest = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    const distance =
      line < run.startLine
        ? run.startLine - line
        : line > run.endLine
          ? line - run.endLine
          : 0;
    if (distance < shortest) {
      nearest = run;
      shortest = distance;
    }
  }
  // 行が読めない（範囲外・NaN）ときは、チャンクの最初の連続へ付ける
  return nearest ?? runs[0];
}

/** 説明文に並べる書き出しの数。多いと1行に収まらず、かえって読みにくい */
const MONOTONOUS_HEADS_SHOWN = 2;

/**
 * 語尾単調の説明文を、**コードが数えた実体から**組み立てる
 * （作者の報告、2026-09-05）。
 *
 * AIの `explanation`（「〜た。が5連続しています」）は使わない。
 * 数を数えるのはAIの苦手なことで、実際に連続していない数を言ってくる。
 * 語尾も文数も行範囲も、ここに来るのはコードが数えた値だけである。
 *
 * **直し方は書かない。** どう散らすかは文体そのものなので、決めるのは作者。
 * **「直し方は作者が決めてください」も書かない**——添えるのは提案パネルの
 * 1か所（修正案の無い指摘すべてに付く）で、ここでも書くと二重になる。
 *
 * **渡すのはファイルの行番号に直したあとの `run`**（設計書6.30.4）。
 * チャンクの通し番号のまま組むと、カードの見出し（ファイル行）と
 * 説明文の行範囲が食い違う。
 */
export function describeMonotonousRun(run: MonotonousRun): string {
  const shown = run.heads.slice(0, MONOTONOUS_HEADS_SHOWN).join(" ／ ");
  const rest = run.heads.length > MONOTONOUS_HEADS_SHOWN ? " ／ …" : "";
  const range =
    run.startLine === run.endLine
      ? `${run.startLine}行目`
      : `${run.startLine}〜${run.endLine}行目`;
  return (
    `「${run.ending}」で終わる地の文が${run.count}文続いています（${range}）：` +
    `${shown}${rest}`
  );
}

/**
 * 文末の1文字＋句点。句点で終わっていなければ語尾として数えない。
 *
 * **空白は飛ばす。** 台詞は同じ長さの空白へ置き換えてあるので
 * （`maskDialogue`）、「彼は跳ねた「うん」。」のように台詞が句点の直前に
 * あると、素直に1文字前を見ると語尾が「 。」になる。そのままだと
 * 前後の「た。」と別物になって連続が切れ、画面にも「 。」と出る。
 */
function endingOf(sentence: string): string | undefined {
  // 句点の手前に空白が挟まっていたら、それを飛ばして1文字前を見る。
  // `u` を付けた `\s` は全角空白（U+3000）も含むので、これで足りる
  const matched = /([^\s])\s*([。！？])$/u.exec(sentence);
  return matched ? matched[1] + matched[2] : undefined;
}

/**
 * 台詞（「」『』）。閉じていない台詞は、閉じ括弧が現れないまま
 * 終わる形（本文の切れ目）なので、そこまでを台詞と見る。
 */
const DIALOGUE = /[「『][^」』]*[」』]?/gu;

/** 台詞を取り除く */
function withoutDialogue(text: string): string {
  return text.replace(DIALOGUE, "");
}

/**
 * 台詞を、**同じ長さの空白へ置き換える**（改行は残す）。
 *
 * 行番号を返す処理は、消してしまうと後ろの行が繰り上がって本文とずれる。
 * 位置を保ったまま「無いことにする」ために、長さを変えずに潰す。
 */
function maskDialogue(text: string): string {
  // `u` を付けない。付けると代用対（サロゲートペア）を1文字として
  // 空白1つに置き換えてしまい、長さ＝位置が狂う
  return text.replace(DIALOGUE, (matched) => matched.replace(/[^\n]/g, " "));
}

/**
 * 「同語反復」の札が、本当に繰り返しに貼られているか。
 *
 * 長文と同じく、実データで**繰り返しの無い箇所に貼られていた**
 * （「『ばっちり』という表現が文脈に合わない」）。
 * 繰り返しは数えられるので、コードで確かめる。
 *
 * 3文字を境にするのは、日本語では2文字の並び（「して」「ている」）が
 * どの文にも出るためである。
 */
const REPEAT_MIN_LENGTH = 3;

/**
 * 修正案が、原文の**うしろを丸ごと落としていないか**（設計書6.60）。
 *
 * 推敲は**原文まるごとを置き換える**。だから修正案は、直した箇所だけでなく
 * 原文と同じ範囲を覆っていなければならない。ところがAIは、**直した断片だけ**を
 * 返すことがある。
 *
 * 作者の報告（2026-09-01、実データ）：
 *
 * - 原文　「悶絶しながらしながら沼ワニに近づくと、槍は中ほどからぽっきり折れていた。」
 * - 修正案「悶絶しながら」
 * - 理由　「冗長：『しながら』が重複しています」
 *
 * 指摘そのものは正しい。だが押すと、**一文が6文字になる**——沼ワニも槍も
 * 消える。作者の言う「適用すると変になります」はこれである。
 *
 * **見分け方は2つを重ねる。** 片方だけでは誤って弾く。
 *
 * 1. **半分以上が消えている**（`TAIL_KEEP_RATIO` 未満）。上の例は36字が6字で、
 *    17%しか残っていない
 * 2. **原文の末尾が、修正案のどこにも無い**。冗長を削っても、文の終わりは
 *    残るはずである
 *
 * **1つ目を厳しくしすぎない。** 最初 0.7 で書いたところ、
 * 「彼は静かに頷いたのであった。」→「彼は静かに頷いた。」（64%）という
 * **まっとうな語尾の直しまで弾いた**。末尾が変わるのは語尾を直す修正案では
 * 当たり前で、そこは2つ目の条件だけでは見分けられない。
 * **原稿を守るための網が、直してくれる案まで捨てては本末転倒である。**
 *
 * **弾くのは修正案だけで、指摘は残す**（`語尾単調` や「空文字」と同じ扱い）。
 * 「ここが重複している」は正しい情報なので、作者が手で直せばよい。
 * **原稿を壊すより、直し方を作者に委ねるほうがよい。**
 */
const TAIL_KEEP_RATIO = 0.5;
/** 末尾として見る長さ。1文節ぶんあれば、落ちたかどうかは分かる */
const TAIL_SAMPLE_LENGTH = 8;

export function dropsOriginalTail(
  original: string,
  suggestion: string
): boolean {
  if (!suggestion) return false;
  const from = normalizeForComparison(original);
  const to = normalizeForComparison(suggestion);
  if (!from || !to) return false;
  // 長さがさほど変わらないなら、断片だけを返したのではない
  if (to.length >= from.length * TAIL_KEEP_RATIO) return false;
  const tail = from.slice(-Math.min(TAIL_SAMPLE_LENGTH, from.length));
  return !to.includes(tail);
}

export function hasRepetition(text: string): boolean {
  const body = text.replace(/\s/g, "");
  for (let start = 0; start + REPEAT_MIN_LENGTH <= body.length; start++) {
    const piece = body.slice(start, start + REPEAT_MIN_LENGTH);
    if (body.indexOf(piece, start + REPEAT_MIN_LENGTH) >= 0) return true;
  }
  return false;
}

/**
 * 指摘の当たっている先が、まるごと台詞かどうか。
 *
 * **台詞の中の繰り返しは、文章の癖ではなく人物の話し方である。**
 * 作者の10作品で測ったところ（2026-08-17）、`同語反復` として挙がった
 * ものの多くが台詞だった。
 *
 * - 「あんた、クォーターやろ？　なんゆうてまんのや？」→ **関西弁**
 * - 「わた、く、しは、で　んかを、あいして　い ます……」→ **わざと崩した喋り**
 * - 「商人は帝国を打倒したりせぇへん。……商人は商人らしく」→ **強調の反復**
 *
 * どれも直したら人物が壊れる。地の文の重複とは別物なので、ここで切る。
 *
 * 地の文が少しでも混じっていれば台詞だけの指摘ではないので、通す。
 * 「ある者は……ある者は」のような**地の文の対句は作者に見せる**
 * （直すかどうかは作者が決めることで、機械が決めることではない）。
 */
export function isDialogueOnly(text: string): boolean {
  // 台詞を取り除いた残りに、意味のある文字が残るか
  const outside = withoutDialogue(text)
    // 閉じ括弧が先に来る形（台詞の途中を抜き出した場合）も落とす
    .replace(/^[^「『]*[」』]/u, "")
    .replace(/[\s　、。！？…―ー）\)]/gu, "");
  return outside.length === 0 && /[「『]/u.test(text);
}

/**
 * 説明が、禁じた観点を語っていないか。
 *
 * **実データで、語彙や文体の指摘が許した札を着て入ってきた**
 * （「『なんか』が口語的」に`係り受け`の札、「表現が文脈に合わない」に
 * `同語反復`の札）。**札だけ見ていると素通りする。**
 *
 * 矛盾検知で「矛盾していません」を弾いたのと同じ形の防ぎ方である。
 */
const FORBIDDEN_EXPLANATION =
  /(口語|文語|語彙|言い回しが|表現が|語感|リズム|テンポ|文体|描写|余韻|唐突|不自然|物足りな|くどい印象|やや古|硬い|柔らか)/;

/**
 * その札に限って許す語。
 *
 * 語尾単調はリズムの指摘**そのもの**なので、「リズムが単調」と説明されるのが
 * 自然である。漢字ひらきも「硬い・古い表記」と説明されうる。全部の札に
 * 開けると6.8.9以前（文体干渉が素通り）へ戻るので、**観点がその語を
 * 意味している札にだけ**穴を開ける（1.5。実モデルでの測定はこれから）。
 */
const ALLOWED_BY_REASON: Partial<Record<string, RegExp>> = {
  語尾単調: /(リズム|テンポ)/gu,
  漢字ひらき: /(やや古|硬い)/gu,
};

export function mentionsForbiddenAspect(
  explanation: string,
  reason?: string
): boolean {
  const allowed = reason ? ALLOWED_BY_REASON[reason] : undefined;
  const target = allowed ? explanation.replace(allowed, "") : explanation;
  return FORBIDDEN_EXPLANATION.test(target);
}

/**
 * 漢字ひらきの説明へ、常用漢字表との照合結果を参考として添える
 * （作者の指定、2026-08-28）。
 *
 * **判定はAIにさせない。** 表を正確に覚えていないので、注記が当てに
 * ならなくなる。コードで照合し、表に無い字だけを挙げる。
 * **注記は参考であって指示ではない**——ひらくかどうかは作者の判断が優先
 * （その一文は種類の決まり文句 `explainProofreadReason` 側に置く）。
 */
export function withNonJouyouNote(
  explanation: string,
  original: string
): string {
  const outside = nonJouyouKanjiIn(original);
  if (outside.length === 0) return explanation;
  const listed = outside.map((char) => `「${char}」`).join("");
  return (
    `${explanation}（参考：${listed}は常用漢字表` +
    "（平成22年内閣告示第2号）に無い字です）"
  );
}

export function parseProofreadResult(
  text: string
): { issues: unknown[] } | null {
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
        return { issues: parsed.issues };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

export function validateProofreadIssues(
  raw: unknown,
  chunk: Chunk,
  /**
   * 作者が「直さない」と決めた語（`設定/keep_words.json`）。
   *
   * **推敲は原文まるごとを置き換える**ので、守る語が原文に含まれていたら
   * その指摘ごと出さない。言い換えれば必ず巻き込むためである。
   */
  keepWords: KeepWord[] = []
): {
  accepted: AcceptedProofreadIssue[];
  rejected: RejectedProofreadIssue[];
} {
  const accepted: AcceptedProofreadIssue[] = [];
  const rejected: RejectedProofreadIssue[] = [];

  const list = isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : [];
  const normalizedChunk = normalizeForComparison(chunk.text);
  const lineCount = chunk.text.split("\n").length;
  const firstLine = chunk.startLine + 1;
  const lastLine = chunk.startLine + lineCount;

  // **語尾の連続はチャンクごとに1回だけ数える。** 指摘の数だけ数え直しても
  // 答えは同じで、長いチャンクでは無駄が積み上がる
  let monotonyInChunk: MonotonousRun[] | undefined;
  const monotonousRuns = (): MonotonousRun[] =>
    (monotonyInChunk ??= findMonotonousRunsInChunk(chunk));
  // **同じ連続に何枚も出さない**（作者の報告、2026-09-05）。
  // 錨を付け替えると、AIが別々に出した指摘が同じ1か所を指すことがある
  const shownRuns = new Set<string>();

  const passed: AcceptedProofreadIssue[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const original = asString(item.original);
    const suggestion = asString(item.suggestion);
    const reason = normalizeReason(asString(item.reason));
    const line = typeof item.line === "number" ? Math.round(item.line) : NaN;

    // **修正案が無くてもよい。** 長すぎる文をどう割るか、繰り返しをどう
    // 変えるかは文体の書き換えになる。**それは作者が決めること**なので、
    // 「ここが読みにくい」と指す指摘にも意味がある（実データで、
    // 「一閃っ一閃っ一閃っ！」のように直しようのない指摘が返ってきた）
    if (!original || !Number.isFinite(line)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (!reason) {
      // 決めた6種類以外は、文体への干渉が紛れ込む口になる
      rejected.push({ raw: item, reason: "unknown_reason" });
      continue;
    }
    // **作者が名指しで守った語を含むなら、この指摘は出さない。**
    // 推敲は原文まるごとを書き換えるので、含まれていれば必ず巻き込む。
    // **札が正しいかを調べる前に外す。** 作者が「触るな」と言ったものを、
    // こちらの都合で分類し直す意味は無い
    if (isKeptWord(original, keepWords)) {
      rejected.push({ raw: item, reason: "kept_word" });
      continue;
    }
    // **「長文」だけは数で決まるので、確かめられる。**
    // 当てはまる一文が無ければ、それは長文の指摘ではない
    if (reason === "長文" && !hasLongSentence(original)) {
      rejected.push({ raw: item, reason: "not_long" });
      continue;
    }
    // 「同語反復」も数えられる。繰り返しが無ければ、それは別の指摘である
    if (reason === "同語反復" && !hasRepetition(original)) {
      rejected.push({ raw: item, reason: "not_repeated" });
      continue;
    }
    // **台詞の中の繰り返しは人物の話し方である。** 方言も、わざと崩した
    // 喋りも、強調の反復も、直したら人物が変わってしまう
    if (reason === "同語反復" && isDialogueOnly(original)) {
      rejected.push({ raw: item, reason: "dialogue_voice" });
      continue;
    }
    // **「語尾単調」も数えられる。** AIは「〜た。が5連続」と言うが、実際は
    // 並んでいないことがある（作者の報告、2026-09-04）。**言い値を作者へ
    // 届けない。** 4連続がチャンクのどこにも無ければ、それは語尾の指摘ではない
    if (reason === "語尾単調" && monotonousRuns().length === 0) {
      rejected.push({ raw: item, reason: "not_monotonous" });
      continue;
    }
    // **札ではなく中身を見る。** 語彙や文体の話が、許した札を着て入ってくる。
    // ただし札そのものがリズム・表記の観点である場合は、その語だけ許す
    if (mentionsForbiddenAspect(asString(item.explanation), reason)) {
      rejected.push({ raw: item, reason: "forbidden_aspect" });
      continue;
    }
    // **語尾単調だけは、AIの錨を照合しない**（本体の判断、2026-09-05）。
    // この札の `line` と `original` は下で捨て、コードが数えた連続の
    // 先頭行と先頭の文へ差し替える。**捨てる値で指摘を落とすと、実在する
    // 連続の指摘がAIの言い間違いだけで消える。** 本文にあるかどうかは、
    // 連続そのものを本文から数えている時点で確かめ終えている
    const anchorFromAi = reason !== "語尾単調";
    if (anchorFromAi && (line < firstLine || line > lastLine)) {
      rejected.push({ raw: item, reason: "line_out_of_range" });
      continue;
    }
    // **原文が本文に実在するかを見る。** 言い換えた「原文」を返すことがあり、
    // そのまま適用すると本文のどこにも当たらない
    if (
      anchorFromAi &&
      !normalizedChunk.includes(normalizeForComparison(original))
    ) {
      rejected.push({ raw: item, reason: "original_not_found" });
      continue;
    }
    // **「空文字」という3文字を修正案として返してくる。**
    // プロンプトの「空文字にしてください」をそのまま書いたもので、
    // 押すと本文の一文がその3文字に置き換わる（2026-08-17、実データ）。
    // 中身が無いという意味なので、指摘としては残し、修正案だけ空にする
    // **語尾単調の修正案は、コードで必ず空にする。** どの文をどう散らすかは
    // 作者が決めること（プロンプトにも書いたが、守られない前提で切る）。
    // 原文は複数文で50字制限に収まらず途中で切れていることがあり、
    // そこへ修正案が付くと**切れた範囲がまるごと置き換わる**
    // **原文のうしろを落とした修正案は使わない**（設計書6.60）。
    // 推敲は原文まるごとを置き換えるので、直した断片だけを返されると
    // 残りが消える。指摘は残し、直し方は作者に委ねる
    const usableSuggestion =
      reason === "語尾単調" ||
      isPlaceholderText(suggestion, true) ||
      dropsOriginalTail(original, suggestion)
        ? ""
        : suggestion;
    // 原文と同じものを「修正案」として返してくる。押しても何も起きない。
    // **空は別物**（直し方を作者に委ねる指摘であって、間違いではない）
    if (
      usableSuggestion &&
      normalizeForComparison(original) ===
        normalizeForComparison(usableSuggestion)
    ) {
      rejected.push({ raw: item, reason: "no_change" });
      continue;
    }

    // **語尾単調だけは、錨も文言もコードの数えた実体へ差し替える**
    // （作者の報告、2026-09-05）。AIの `line` は連続と関係のない台詞行の
    // ことがあり、`explanation` の連続数は数え違えている。
    // 直したのは作者へ見せるものだけで、AIの出力そのものは変えていない
    const run =
      reason === "語尾単調"
        ? nearestMonotonousRun(monotonousRuns(), line)
        : undefined;
    if (run) {
      const key = `${run.startLine}|${run.ending}`;
      if (shownRuns.has(key)) {
        rejected.push({ raw: item, reason: "monotony_duplicate" });
        continue;
      }
      shownRuns.add(key);
    }
    // 連続の先頭の文を引用にする。`heads` は「…」で切ってあるので使えない
    // （引用は本文に実在する文字列でなければならない）
    const anchor = run?.first ?? "";

    passed.push({
      line: run ? run.startLine : line,
      original: anchor || original,
      // 推敲は原文まるごとを置き換える（誤字脱字のような部分置換ではない）
      target: anchor || original,
      suggestion: usableSuggestion,
      reason,
      // **語尾単調の説明文はここでは組まない**（設計書6.30.4）。行範囲が
      // 入るが、行はまだチャンクの通し番号である。実体だけを持ち回り、
      // ファイルの行が決まる `locateProofreadIssue` で組む
      explanation: run
        ? ""
        : reason === "漢字ひらき"
          ? // 漢字ひらきには、常用漢字表との照合結果を参考として添える
            withNonJouyouNote(asString(item.explanation), original)
          : asString(item.explanation),
      confidence: level(item.confidence),
      ...(run ? { monotony: run } : {}),
    });
  }

  // **件数を切る。** ここが無いと、全部の文に提案が付いた状態が作者へ届く
  const budget = issueBudget(chunk.text.length);
  const ordered = sortProofreadIssues(passed);
  accepted.push(...ordered.slice(0, budget));
  for (const extra of ordered.slice(budget)) {
    rejected.push({ raw: extra, reason: "over_budget" });
  }

  return { accepted, rejected };
}

/**
 * 指摘の行を、**チャンクの通し番号からファイルの行番号へ直す**
 * （設計書6.30.4）。
 *
 * まとめたチャンク（`mergeAdjacentChunks`）では `withLineNumbers` が振った
 * 番号がまとめた本文の通し番号になっている。ここを通さずに使うと、
 * 2話目以降の指摘が1話目のまったく違う行を指す。
 *
 * **語尾単調の説明文もここで組む。** 説明文には行範囲が入るので、
 * 行が確定する前に組むと、カードの見出し（ファイル行）と食い違ったまま
 * 凍る。**行の解決は `locateChunkLine` の1か所だけ**にする。
 *
 * 範囲の外を指していれば `undefined`（AIは平気で範囲外の行を返す）。
 */
export function locateProofreadIssue(
  chunk: Chunk,
  issue: AcceptedProofreadIssue
): (AcceptedProofreadIssue & { filePath: string }) | undefined {
  const at = locateChunkLine(chunk, issue.line);
  if (!at) return undefined;

  // 連続そのものは画面へ出す値ではないので、ここで落とす
  const { monotony, ...rest } = issue;
  if (!monotony) return { ...rest, line: at.line, filePath: at.filePath };

  // 連続は内訳ごとに数えてあるので、終わりも同じファイルに収まる。
  // それでも戻せなかったときは、始まりの行だけで言う（黙って捨てない）
  const end = locateChunkLine(chunk, monotony.endLine);
  const endLine = end && end.filePath === at.filePath ? end.line : at.line;
  return {
    ...rest,
    line: at.line,
    filePath: at.filePath,
    explanation: describeMonotonousRun({
      ...monotony,
      startLine: at.line,
      endLine,
    }),
  };
}

/**
 * 見せる順を決める。
 *
 * **確信度の高いものを先に。** 上限で切るとき、迷っている提案が残ると
 * 質の低いものだけが作者の手元に来る。
 */
export function sortProofreadIssues(
  items: AcceptedProofreadIssue[]
): AcceptedProofreadIssue[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return rank[left.confidence] - rank[right.confidence];
    }
    return left.line - right.line;
  });
}

/**
 * 理由を1つに決める。
 *
 * 矛盾検知と同じく、**選択肢をそのまま写して返してくる**ことがある
 * （実データで起きた。設計書6.10.1）。両方で受ける。
 */
export function normalizeReason(raw: string): ProofreadReason | undefined {
  const trimmed = raw.trim();
  if (REASON_SET.has(trimmed)) return trimmed as ProofreadReason;
  for (const candidate of PROOFREAD_REASONS) {
    if (trimmed.startsWith(candidate)) return candidate;
  }
  for (const candidate of PROOFREAD_REASONS) {
    if (trimmed.includes(candidate)) return candidate;
  }
  return undefined;
}

function level(raw: unknown): "high" | "medium" | "low" {
  const value = asString(raw);
  return LEVELS.has(value) ? (value as "high" | "medium" | "low") : "low";
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * 指摘の種類だけでは何が読みにくいのか分からないので、言葉を足す。
 *
 * **画面には「冗長」の一語しか出ていなかった。** どこが冗長なのかは
 * 差分を見れば分かることもあるが、「係り受け」「同語反復」は**何と何の
 * 関係の話なのかが言われないと分からない**（2026-08-22、作者の指摘）。
 *
 * AIの説明（`explanation`）が使えるならそちらを出し、空だったり
 * 種類の言葉をなぞっただけだったりしたときに、これを代わりに出す。
 * **「AIが説明を返さなかったから何も出ない」を作らない。**
 *
 * 6つの種類のどれでもなければ `undefined`（誤字脱字や表記ゆれの
 * `reason` はここへ来る。あちらは説明そのものが `reason` に入っている）。
 */
export function explainProofreadReason(reason: string): string | undefined {
  switch (reason) {
    case "冗長":
      return "同じ意味の言葉が重なっています";
    case "同語反復":
      return "近いところで同じ語が繰り返され、単調になっています";
    case "係り受け":
      return "どこに掛かるかが2通りに読めます";
    case "長文":
      return "一文が長く、意味を取りにくくなっています";
    case "漢字ひらき":
      // **判断は絶対ではない**（作者の指定、2026-08-28）。演出で漢字の
      // ままにする選択は正しい選択であり、注記も参考にすぎない
      return (
        "読みに詰まる漢字表記です。ひらがなにすると読みやすくなります" +
        "（ひらくかどうかは作者の判断が優先です）"
      );
    case "語尾単調":
      // **直し方は書かない。** どう散らすかは文体そのものなので、
      // 決めるのは作者である（修正案も空で返させている）
      return "同じ語尾が続いてリズムが単調です。どう散らすかは作者の判断です";
    default:
      return undefined;
  }
}
