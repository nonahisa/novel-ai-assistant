import type { Chunk } from "./chunker";
import type { AcceptedTypoIssue } from "./typoCheckValidation";

/**
 * 文章作法のチェック（三点リーダー・ダッシュの偶数使用、鉤括弧内文末の句点、
 * 感嘆符・疑問符後の空白）。
 *
 * 縦書き原稿の伝統的な作法だが、Web小説では人に強制すべきものではない
 * （参考：https://creative-story.net/rule-novel/ 、作者の指摘）。
 * パターンが機械的に確定できるものだけを対象にし、AIには判断させない
 * （「AIの出力を信用しない」方針。判定ミスの余地がそもそも無い）。
 *
 * 誤りとして断定せず、作者の意図的な表現である可能性を必ず文言に添える。
 * confidence は "medium"（誤字脱字検知の "high" ほど断定的でなく、
 * 既定で隠れる "low" ほど埋もれさせない）に統一する。
 *
 * 数字の漢数字化・行頭/行末禁則は対象外にした。
 * 前者はゲームのステータス表記など算用数字が一般的な作品も多く機械的に
 * 「誤り」と言えない。後者は紙面へ組版する工程の制約であり、画面幅に応じて
 * 折り返すWeb小説のテキストファイルには当てはまらない。
 */

/**
 * ダッシュに使われる2つの文字。
 *
 * **見た目はほとんど同じだが、別の文字である。** エディタで並べても
 * 見分けが付かないので、**ソースには字を直に書かず、符号で書く**
 * （下の文言もこの定数から組み立てる。直に打つと、どちらを書いたのか
 * 読む人にも書いた本人にも分からない）。
 *
 * 作者の原稿で実際に混ざっていた（実機の報告、2026-08-29
 * 「主従の悪だくみが始まった――」の2本の間に隙間が見える）。
 */
/** 欧文のダッシュ（U+2014 EM DASH）。和文書体では字形が短く、隣と連結しない */
const EM_DASH = String.fromCodePoint(0x2014);
/** 和文のダッシュ（U+2015 HORIZONTAL BAR）。作法で使うのはこちら */
const HORIZONTAL_BAR = String.fromCodePoint(0x2015);

const REASON_ELLIPSIS =
  "文章作法：三点リーダー「…」は偶数個続けて使う書き方が一般的です。意図的な表現であれば無視してください。";
const REASON_DASH =
  `文章作法：ダッシュ「${HORIZONTAL_BAR}」は偶数個続けて使う書き方が一般的です。意図的な表現であれば無視してください。`;
const REASON_DASH_MIXED =
  `文章作法：ダッシュの字が混ざっています（欧文の「${EM_DASH}」と和文の「${HORIZONTAL_BAR}」）。` +
  `同じ「${HORIZONTAL_BAR}」に揃えると、表示の隙間も消えます。意図的な表現であれば無視してください。`;
const REASON_CLOSING_QUOTE_PERIOD =
  "文章作法：鉤括弧の文末には句点を付けない書き方が一般的です。意図的な表現であれば無視してください。";
const REASON_MARK_SPACING =
  "文章作法：感嘆符・疑問符の後に全角スペースを入れる書き方が一般的です。意図的な表現であれば無視してください。";

/** original に含める前後の文字数。target を一意に特定しやすくする程度でよい */
const CONTEXT_RADIUS = 8;

export function checkWritingStyle(chunk: Chunk): AcceptedTypoIssue[] {
  const findings: AcceptedTypoIssue[] = [];
  const lines = chunk.text.split("\n");
  lines.forEach((lineText, index) => {
    const lineNumber = chunk.startLine + index + 1;
    findings.push(...findOddRuns(lineText, lineNumber, "…", REASON_ELLIPSIS));
    findings.push(...findDashRuns(lineText, lineNumber));
    findings.push(...findClosingQuotePeriods(lineText, lineNumber));
    findings.push(...findMissingSpaceAfterMark(lineText, lineNumber));
  });
  return findings;
}

function contextAround(line: string, start: number, end: number): string {
  const from = Math.max(0, start - CONTEXT_RADIUS);
  const to = Math.min(line.length, end + CONTEXT_RADIUS);
  return line.slice(from, to);
}

/**
 * ダッシュの連なりを見る。**2つの文字をまとめて1つの連なりとして数える。**
 *
 * ## なぜ字の種類をまたいで数えるのか（実機の報告、2026-08-29）
 *
 * 作者の原稿に「始まった――」があり、**画面では隙間が見え、作法チェックは
 * 偶数個なのに「1個だから奇数」と指摘した。** 2本のうち片方が欧文の
 * U+2014、もう片方が和文の U+2015 だったためである。片方だけを数えると、
 * 見た目に2本ある連なりが「1個ずつの連なりが2つ」に割れる。
 *
 * ## 何を指摘するか
 *
 * 1. **字が混ざっている**（連なりに U+2014 が1つでもある）——個数が偶数でも
 *    指摘する。**隙間が見えるのはこちらが原因**であり、個数の問題ではない。
 *    直し方は U+2015 へ揃えること（奇数なら偶数に足しておく）
 * 2. **U+2015 だけで奇数個**——これまでどおり、1つ足して偶数にする
 *
 * どちらでもない（U+2015 だけで偶数個）ときは、何も言わない。
 */
function findDashRuns(
  line: string,
  lineNumber: number
): AcceptedTypoIssue[] {
  const findings: AcceptedTypoIssue[] = [];
  // 2つの文字を区別せず、続いているかぎり1つの連なりとして拾う
  const pattern = new RegExp(`[${EM_DASH}${HORIZONTAL_BAR}]+`, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const run = match[0];
    const mixed = run.includes(EM_DASH);
    // 揃っていて偶数個なら、作法どおりなので何も言わない
    if (!mixed && run.length % 2 === 0) continue;

    // 何個が正しいかは決められないため、最小限の変更（足りなければ1個足して
    // 偶数にする）に留める。字が混ざっているときは、そのうえで字を揃える
    const evenLength = run.length % 2 === 0 ? run.length : run.length + 1;
    findings.push({
      line: lineNumber,
      original: contextAround(line, match.index, match.index + run.length),
      target: run,
      suggestion: mixed
        ? HORIZONTAL_BAR.repeat(evenLength)
        : run + HORIZONTAL_BAR,
      reason: mixed ? REASON_DASH_MIXED : REASON_DASH,
      confidence: "medium",
    });
  }
  return findings;
}

/** 「…」が奇数個連続している箇所を検出する */
function findOddRuns(
  line: string,
  lineNumber: number,
  char: string,
  reason: string
): AcceptedTypoIssue[] {
  const findings: AcceptedTypoIssue[] = [];
  const pattern = new RegExp(`${escapeRegExp(char)}+`, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const run = match[0];
    if (run.length % 2 === 0) continue;
    findings.push({
      line: lineNumber,
      original: contextAround(line, match.index, match.index + run.length),
      target: run,
      // 何個が正しいかは決められないため、最小限の変更（1個足して偶数にする）に留める
      suggestion: run + char,
      reason,
      confidence: "medium",
    });
  }
  return findings;
}

/** 鉤括弧「」『』の文末（閉じ括弧の直前）に句点があれば検出する */
function findClosingQuotePeriods(
  line: string,
  lineNumber: number
): AcceptedTypoIssue[] {
  const findings: AcceptedTypoIssue[] = [];
  const pattern = /。[」』]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const full = match[0];
    const closingChar = full[1];
    findings.push({
      line: lineNumber,
      original: contextAround(line, match.index, match.index + full.length),
      // 句点＋閉じ括弧をひとまとまりで対象にする。句点1文字だけを対象にすると、
      // 同じ行に他の句点がある場合に適用位置を取り違える恐れがあるため
      target: full,
      suggestion: closingChar,
      reason: REASON_CLOSING_QUOTE_PERIOD,
      confidence: "medium",
    });
  }
  return findings;
}

/** 感嘆符・疑問符の直後にスペースが無い箇所を検出する */
function findMissingSpaceAfterMark(
  line: string,
  lineNumber: number
): AcceptedTypoIssue[] {
  const findings: AcceptedTypoIssue[] = [];
  // **閉じ括弧類・句読点・リーダー類が続くときはアキ不要**（日本語組版の
  // 作法どおり。「！》」に「1マス空けて」と出た——作者の指摘、2026-09-04。
  // 漏れていたのは 》 など「」』）以外の閉じ）
  const noSpaceNeededAfter = new Set([
    "　",
    " ",
    "」",
    "』",
    "）",
    ")",
    "》",
    "〉",
    "】",
    "〕",
    "｝",
    "}",
    "］",
    "]",
    "”",
    "’",
    "！",
    "？",
    "!",
    "?",
    "、",
    "。",
    "，",
    "．",
    ",",
    ".",
    "…",
    "‥",
    "―",
    "—",
  ]);
  for (let i = 0; i < line.length; i++) {
    const mark = line[i];
    if (mark !== "！" && mark !== "？") continue;
    const next = line[i + 1];
    if (next === undefined) continue; // 行末はそのままでよい
    if (noSpaceNeededAfter.has(next)) continue;
    const target = mark + next;
    findings.push({
      line: lineNumber,
      original: contextAround(line, i, i + target.length),
      target,
      suggestion: `${mark}　${next}`,
      reason: REASON_MARK_SPACING,
      confidence: "medium",
    });
  }
  return findings;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
