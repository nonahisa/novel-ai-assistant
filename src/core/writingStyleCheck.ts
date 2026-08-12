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

const REASON_ELLIPSIS =
  "文章作法：三点リーダー「…」は偶数個続けて使う書き方が一般的です。意図的な表現であれば無視してください。";
const REASON_DASH =
  "文章作法：ダッシュ「―」は偶数個続けて使う書き方が一般的です。意図的な表現であれば無視してください。";
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
    findings.push(...findOddRuns(lineText, lineNumber, "―", REASON_DASH));
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

/** 「…」「―」等が奇数個連続している箇所を検出する */
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
  const noSpaceNeededAfter = new Set([
    "　",
    " ",
    "」",
    "』",
    "）",
    ")",
    "！",
    "？",
    "!",
    "?",
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
