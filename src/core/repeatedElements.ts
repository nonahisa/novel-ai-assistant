import { closeTruncatedJson } from "./truncatedResponse";

/**
 * AIが**同じ指摘を延々と繰り返す**応答を、流して受け取る途中で見つける部品
 * （2026-10-10。`docs/measurements/2026-10-10-typo-runaway.md`）。
 *
 * VS Code に依存しない。製品の Ollama の道（`ai/ollamaProvider.ts`）と
 * MCP の Ollama の道（`mcp/tools/ollama.ts`）が、どちらも流れてきた断片を
 * `ai/ollamaStream.ts` で組み立てるので、そこから呼ぶ。
 *
 * ## 何が起きたか
 *
 * gemma4:26b・温度0 の誤字脱字で、`issues` の配列に**まったく同じ要素**を
 * 157回書き続け、出力の上限（11,264 トークン）で JSON の途中で切れた。
 * 約290秒待ったうえ、閉じていない JSON は読めないので、**そのチャンクの
 * 指摘が全部捨てられた**（繰り返しの前に書いた分まで）。
 *
 * 温度0は毎回同じ答えを選ぶので、同じ要素を1つ書くと次も同じ要素を選ぶ
 * 輪に入る。上限を上げても同じ要素が増えるだけで、直らない。
 *
 * ## どう扱うか
 *
 * 配列の中で、**同じオブジェクトが続けて `REPEATED_ELEMENT_LIMIT` 回**
 * 出たら止める。止めたら、繰り返しの**1つ目**の終わりで本文を切り戻し、
 * 開いている括弧を閉じて、読める JSON にして渡す（検算は機能の側がいつも
 * どおり行う）。重複を残さないのは、同じ指摘が画面に何件も並ぶのを避ける
 * ため。
 *
 * **機能ごとの特別扱いはしない。** 誤字脱字・推敲・矛盾・逸脱など、
 * 配列で答える検知はどれも同じ形で崩れうる。見るのは JSON の形だけ。
 */

/**
 * 同じ要素が続けて何回出たら止めるか。
 *
 * **5回にした理由**：まっとうな答えでも、同じ要素が2回並ぶことはありうる
 * （同じ誤りを2度書く・2つの指摘がたまたま同じ形になる）。3回並ぶことは
 * 測った範囲では無い。5回まで待っても、1要素はおよそ70トークンなので
 * 余分は数百トークン（手元のAIで数秒）にとどまる。低くしすぎて正しい答えを
 * 切るほうが害が大きいので、余裕を持たせた。
 */
export const REPEATED_ELEMENT_LIMIT = 5;

/** 繰り返しで止めた位置 */
export interface RepetitionStop {
  /** 繰り返しの1つ目の要素の終わり（本文の字の位置。ここで切り戻す） */
  readonly cutAt: number;
  /** その時点で開いていた括弧を閉じる文字列（`]}` など） */
  readonly closing: string;
  /** 止めた要素が、その配列の何件目か（1始まり） */
  readonly stoppedAt: number;
  /** 切り戻したあとに残る、その配列の要素の数（繰り返しの1つ目まで） */
  readonly kept: number;
}

/** 開いている配列1つぶんの見張り */
interface ArrayFrame {
  readonly kind: "[";
  /** 完結した要素の数 */
  count: number;
  /** いま読んでいるオブジェクトの要素が始まった位置（無ければ -1） */
  elementStart: number;
  /** 直前の要素の比べる形（文字列の外の空白を落としたもの） */
  previous?: string;
  /** 直前の要素と同じものが何回続いているか（直前の要素を含む） */
  run: number;
  /** いまの繰り返しの1つ目の終わりと、そのときの閉じ方・件数 */
  runFirst?: { end: number; closing: string; index: number };
}

interface ObjectFrame {
  readonly kind: "{";
}

type Frame = ArrayFrame | ObjectFrame;

/**
 * 走査の途中の状態。**断片が届くたびに、続きから読む**（全文を毎回
 * 読み直すと、1万トークン書く応答で数億字を読むことになる）。
 */
export interface RepetitionWatch {
  /** ここまで読んだ（次に読む字の位置） */
  scanned: number;
  stack: Frame[];
  inString: boolean;
  escaped: boolean;
  /** 止めたら入る。以後は読まない */
  stop?: RepetitionStop;
}

export function newRepetitionWatch(): RepetitionWatch {
  return { scanned: 0, stack: [], inString: false, escaped: false };
}

/**
 * 増えた分を読み進める。繰り返しを見つけたら止めた位置を返す
 * （見つけたあとは、何度呼んでも同じ位置を返す）。
 *
 * @param content これまでに届いた本文の**全体**（増えた分だけではない）。
 *   要素の中身を比べるとき、始まりからの字を切り出すため
 */
export function watchRepetition(
  watch: RepetitionWatch,
  content: string,
  limit = REPEATED_ELEMENT_LIMIT
): RepetitionStop | undefined {
  if (watch.stop) return watch.stop;
  for (let i = watch.scanned; i < content.length; i++) {
    const ch = content[i];
    if (watch.inString) {
      if (watch.escaped) watch.escaped = false;
      else if (ch === "\\") watch.escaped = true;
      else if (ch === '"') watch.inString = false;
      continue;
    }
    if (ch === '"') {
      watch.inString = true;
      continue;
    }
    if (ch === "{") {
      const top = watch.stack[watch.stack.length - 1];
      // 配列の直下に来たオブジェクトだけを「要素」として数える
      if (top?.kind === "[" && top.elementStart === -1) top.elementStart = i;
      watch.stack.push({ kind: "{" });
      continue;
    }
    if (ch === "[") {
      watch.stack.push({ kind: "[", count: 0, elementStart: -1, run: 0 });
      continue;
    }
    if (ch === "}" || ch === "]") {
      // 閉じすぎ＝形が読めない。見張りをやめる（打ち切らない）
      if (watch.stack.length === 0) {
        watch.scanned = content.length;
        return undefined;
      }
      watch.stack.pop();
      if (ch !== "}") continue;
      const parent = watch.stack[watch.stack.length - 1];
      if (parent?.kind !== "[" || parent.elementStart === -1) continue;
      const stop = closeElement(parent, content, i, watch.stack, limit);
      if (stop) {
        watch.scanned = i + 1;
        watch.stop = stop;
        return stop;
      }
    }
  }
  watch.scanned = content.length;
  return undefined;
}

/** 配列の直下のオブジェクトが閉じたときに、直前の要素と比べる */
function closeElement(
  frame: ArrayFrame,
  content: string,
  end: number,
  stack: readonly Frame[],
  limit: number
): RepetitionStop | undefined {
  const shape = withoutOuterWhitespace(content.slice(frame.elementStart, end + 1));
  frame.elementStart = -1;
  frame.count += 1;
  if (frame.previous !== undefined && shape === frame.previous) {
    frame.run += 1;
  } else {
    frame.previous = shape;
    frame.run = 1;
    frame.runFirst = {
      end: end + 1,
      closing: closingFor(stack),
      index: frame.count,
    };
  }
  if (frame.run < limit || !frame.runFirst) return undefined;
  return {
    cutAt: frame.runFirst.end,
    closing: frame.runFirst.closing,
    stoppedAt: frame.count,
    kept: frame.runFirst.index,
  };
}

/**
 * 文字列の外の空白を落とす。**字下げや改行の違いだけで別の要素と
 * 見なさない**ため（中身の文字列の空白は残す）。
 */
function withoutOuterWhitespace(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (/\s/u.test(ch)) continue;
    out += ch;
  }
  return out;
}

/** 開いたままの括弧を、逆順に閉じる文字列 */
function closingFor(stack: readonly Frame[]): string {
  let out = "";
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i].kind === "{" ? "}" : "]";
  }
  return out;
}

/**
 * 本文全体から繰り返しを探す（流さずにまとめて受け取った応答の後始末用）。
 */
export function findRepetition(
  content: string,
  limit = REPEATED_ELEMENT_LIMIT
): RepetitionStop | undefined {
  return watchRepetition(newRepetitionWatch(), content, limit);
}

/**
 * 止めた位置で切り戻し、括弧を閉じた **読める JSON** を返す。読めなければ
 * `undefined`（呼ぶ側は、これまでどおり「途中で切れた応答」として扱う）。
 *
 * まず見張りが覚えた閉じ方で閉じる（いちばん確か）。読めなければ、
 * JSON の前に余計な字が付いている場合に備えて `closeTruncatedJson` の
 * 候補を順に試す。**無理に形を作らない**——読めないものを読めたことに
 * すると、中身の違う答えを機能へ渡してしまう。
 */
export function salvageRepetition(
  content: string,
  stop: RepetitionStop
): string | undefined {
  const head = content.slice(0, stop.cutAt);
  const candidates = [head + stop.closing, ...closeTruncatedJson(head)];
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 次の候補へ
    }
  }
  return undefined;
}

/**
 * 作品のログへ残す1行。**件数は「閉じて渡した要素の数」**——検算で
 * いくつ残ったかは機能の側が別の行で書く。
 */
export function repetitionStopMessage(stop: RepetitionStop): string {
  return (
    `AIが同じ指摘を繰り返したため、${stop.stoppedAt}件目で受け取りを止めました` +
    `（残せた指摘 ${stop.kept}件。このあと検算します）。`
  );
}
