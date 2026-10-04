import type { FindingView } from "../models/finding";

/**
 * 出先の原稿箱（設計書6.115）で、指摘の前後に添える行と範囲の行の組み方。
 *
 * **1つだけ置く。** パソコンから送る道（MCP `outbox.pack`）と、GitHub 経由のページ
 * （`media/outbox/outbox.html`。ページは GitHub から読んだ本文で同じ形を自分で作る）が
 * 同じ形を使う。ページの写しが core と同じ結果になることは
 * `test/unit/cross/outboxPageLogic.test.ts` が同じ見本で見張る。
 *
 * `vscode` にも `fs` にも触らない。
 */

/** 前後の文を組むのに要る、指摘の欄 */
export type OutboxContextSource = Pick<FindingView, "hintLine" | "message" | "compared">;

/**
 * 1指摘あたりに送る前後の文の上限（字）。**本文をまとめて claude.ai へ出さない**ため、
 * 範囲の全行と前後の行を合わせてここまでに収める（設計書6.115 の決まり4）
 */
export const OUTBOX_CONTEXT_CHARS = 2000;

/** 前後に添える、中身のある行の数（空行は数えずに飛ばす） */
const CONTEXT_NEIGHBOR_LINES = 2;

export interface OutboxContext {
  /** 範囲（範囲の無い指摘は指摘の行）の前の、中身のある行。本文の順 */
  before: string[];
  /**
   * 範囲の全行（範囲の無い指摘は指摘の行1行）。**範囲の中の空行も入れる**——
   * ［自分で直す］で範囲を直すとき、取り込みは本文と一字違わず比べるため
   */
  lines: string[];
  /** `lines` の最初の行（いまの本文の行番号） */
  startLine: number;
  /** 範囲の後ろの、中身のある行。本文の順 */
  after: string[];
  /** 範囲の指摘か（説明の「N〜M行目」・左右に並べる指摘の補足から読んだ） */
  range: boolean;
  /** 上限で何かを切ったか（ページは「…」で終わる行を出す） */
  clipped: boolean;
  /**
   * 範囲の行（`lines`）まで切ったか。**切った範囲は［自分で直す］に使えない**——
   * 切れた範囲を直して送ると、取り込みが一字違わず探せないか、末尾を消す
   */
  rangeClipped: boolean;
}

/**
 * 指摘の前後の文と範囲（`OutboxContext`）を組む。
 *
 * **範囲は、いまの位置から取る。** 説明の「N〜M行目」は検知したときの行番号なので、
 * 探し直した行（`line`）と検知したときの行（`hintLine`）の差だけずらす——数日たって
 * 上に行が増えていても、同じ連続を指す。語尾単調は連続の先頭の文を原文に持つ
 * （`core/proofreadValidation.ts`）ので、ずらした範囲の先頭がちょうど `line` になる
 *
 * **上限の配り方**：範囲の行を先に取り、残りを前後の近い行から交互に配る
 * （直すのに要るのは範囲そのもので、前後は読むための手がかり）
 */
export function outboxContextOf(
  text: string,
  line: number,
  view: OutboxContextSource
): OutboxContext {
  const all = text.split("\n");
  const range = outboxRangeOf(view);
  let start = line;
  let end = line;
  if (range) {
    const shift = line - view.hintLine;
    start = Math.max(1, Math.min(range.start + shift, line));
    end = Math.min(all.length, Math.max(range.end + shift, line));
  }

  let budget = OUTBOX_CONTEXT_CHARS;
  let clipped = false;
  let rangeClipped = false;
  const lines: string[] = [];
  for (let at = start; at <= end; at += 1) {
    const lineText = all[at - 1] ?? "";
    const size = [...lineText].length;
    if (size <= budget) {
      lines.push(lineText);
      budget -= size;
      continue;
    }
    lines.push(clip(lineText, budget));
    budget = 0;
    clipped = true;
    rangeClipped = true;
    break;
  }

  const beforeCandidates = neighborLines(all, start, -1);
  const afterCandidates = neighborLines(all, end, +1);
  const before: string[] = [];
  const after: string[] = [];
  // 近い行から交互に（前の1行目・後ろの1行目・前の2行目…）。入りきらない行は切って止める
  for (let index = 0; index < CONTEXT_NEIGHBOR_LINES && !clipped; index += 1) {
    for (const [candidates, into, atFront] of [
      [beforeCandidates, before, true],
      [afterCandidates, after, false],
    ] as const) {
      const candidate = candidates[index];
      if (candidate === undefined || clipped) continue;
      const size = [...candidate].length;
      const taken = size <= budget ? candidate : budget > 0 ? clip(candidate, budget) : undefined;
      if (size > budget) clipped = true;
      if (taken === undefined) continue;
      budget = Math.max(0, budget - size);
      if (atFront) into.unshift(taken);
      else into.push(taken);
    }
  }

  return { before, lines, startLine: start, after, range: range !== undefined, clipped, rangeClipped };
}

/**
 * 指摘の持つ範囲（検知したときの行番号）。語尾単調の説明の「（N〜M行目）」と、
 * 左右に並べる指摘（逸脱など）の補足の「N〜M行目」から読む。無ければ undefined
 */
export function outboxRangeOf(view: OutboxContextSource): { start: number; end: number } | undefined {
  for (const source of [view.message, view.compared?.note ?? ""]) {
    const matched = /(\d+)\s*[〜～~]\s*(\d+)\s*行目/u.exec(source);
    if (!matched) continue;
    const start = Number(matched[1]);
    const end = Number(matched[2]);
    if (start >= 1 && end >= start) return { start, end };
  }
  return undefined;
}

/** `from` 行の前（-1）か後ろ（+1）の、中身のある行を近い順に最大2つ（空行は飛ばす） */
function neighborLines(lines: readonly string[], from: number, step: -1 | 1): string[] {
  const found: string[] = [];
  for (let at = from - 1 + step; at >= 0 && at < lines.length; at += step) {
    if (lines[at].trim().length === 0) continue;
    found.push(lines[at]);
    if (found.length >= CONTEXT_NEIGHBOR_LINES) break;
  }
  return found;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
