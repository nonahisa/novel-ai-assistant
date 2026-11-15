import { describe, expect, it } from "vitest";
import {
  SJIS_MARK_FINDING_LABEL,
  placeSjisMarkFindings,
  sjisMarkPlaces,
  type SjisMarkOccurrence,
} from "../../../src/core/sjisMarkFinding";
import type { FindingView } from "../../../src/models/finding";

/**
 * 〓の行の突き合わせ（`placeSjisMarkFindings`）を速くしても、**割り当ての答えが変わらない**ことを見張る
 * （実装の残り #128、1.0.14）。
 *
 * 速くする前の作り（行ごとに、空いている〓を全部見る）を、そのままここへ写して「正」とし、
 * 前後の字が重なりやすい小さな字の組で作った本文と行を、乱数で何百通りも作って比べる。
 * 同じ距離の〓が2つあるときの選び方（前のほう）・見送った行が〓を取っておくこと・3段の順も、
 * 写した作りと同じ答えになることで確かめる。
 */

const MARK = "〓";
const FILE = "本文/001.txt";

/** 速くする前の割り当て（1.0.13 の `placeSjisMarkFindings` をそのまま写したもの） */
function referencePlace(rows: readonly FindingView[], texts: ReadonlyMap<string, string>): Array<{ id: string; line: number; located: string }> {
  const byFile = new Map<string, Array<{ row: FindingView; order: number }>>();
  rows.forEach((row, order) => {
    if (row.label !== SJIS_MARK_FINDING_LABEL || !texts.has(row.file)) return;
    const list = byFile.get(row.file) ?? [];
    list.push({ row, order });
    byFile.set(row.file, list);
  });
  const placed: Array<{ id: string; line: number; located: string }> = [];
  for (const [file, list] of byFile) {
    const text = texts.get(file) ?? "";
    const occurrences = sjisMarkPlaces(text);
    const taken = new Set<number>();
    const assigned = new Map<number, SjisMarkOccurrence>();
    const ordered = [...list].sort(
      (a, b) => timeDesc(a.row.time, b.row.time) || a.row.hintLine - b.row.hintLine || a.order - b.order
    );
    const lines = text.split(/\r\n|\r|\n/u);
    const nearest = (from: number, step: -1 | 1): string => {
      for (let at = from - 1 + step; at >= 0 && at < lines.length; at += step) {
        if (lines[at].trim().length > 0) return lines[at];
      }
      return "";
    };
    const passes: Array<(row: FindingView, occurrence: SjisMarkOccurrence) => boolean> = [
      (row, occurrence) => row.original === occurrence.context,
      (row, occurrence) => oneSide(row.original, occurrence),
      (row, occurrence) =>
        (row.before.trim().length > 0 && row.before === nearest(occurrence.line, -1)) ||
        (row.after.trim().length > 0 && row.after === nearest(occurrence.line, 1)),
    ];
    for (const matches of passes) {
      for (const { row, order } of ordered) {
        if (assigned.has(order)) continue;
        let best: SjisMarkOccurrence | undefined;
        for (const occurrence of occurrences) {
          if (taken.has(occurrence.index) || !matches(row, occurrence)) continue;
          if (!best || Math.abs(occurrence.line - row.hintLine) < Math.abs(best.line - row.hintLine)) best = occurrence;
        }
        if (!best) continue;
        taken.add(best.index);
        assigned.set(order, best);
      }
    }
    for (const { row, order } of list) {
      const occurrence = assigned.get(order);
      if (!occurrence || row.status !== "pending") continue;
      placed.push({ id: row.id, line: occurrence.line, located: occurrence.line === row.hintLine ? "found" : "moved" });
    }
  }
  return placed;
}

function timeDesc(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
  return b - a;
}

function oneSide(original: string, occurrence: SjisMarkOccurrence): boolean {
  for (let at = original.indexOf(MARK); at >= 0; at = original.indexOf(MARK, at + MARK.length)) {
    const before = original.slice(0, at);
    const after = original.slice(at + MARK.length);
    if (before.length > 0 && before === occurrence.before) return true;
    if (after.length > 0 && after === occurrence.after) return true;
  }
  return false;
}

/** 決まった種から作る乱数（落ちたときに同じ本文を作り直せるように） */
function randomOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 前後の字がよく重なるよう、字を3つと〓と空行だけで本文を作る */
function textOf(random: () => number): string {
  const lineCount = 3 + Math.floor(random() * 25);
  const lines: string[] = [];
  for (let index = 0; index < lineCount; index++) {
    if (random() < 0.15) {
      lines.push(random() < 0.5 ? "" : "　");
      continue;
    }
    const length = Math.floor(random() * 7);
    let line = "";
    for (let at = 0; at < length; at++) line += random() < 0.3 ? MARK : "あいう"[Math.floor(random() * 3)];
    lines.push(line);
  }
  const eol = ["\n", "\r\n", "\r"][Math.floor(random() * 3)];
  return lines.join(eol);
}

/** 行を作る。いまの〓の前後をそのまま使うもの・片方だけ変えたもの・前後の行だけ合うもの・何も合わないもの */
function rowsOf(random: () => number, text: string, otherText: string): FindingView[] {
  const occurrences = [...sjisMarkPlaces(text), ...sjisMarkPlaces(otherText)];
  const lines = text.split(/\r\n|\r|\n/u);
  const count = Math.floor(random() * 14);
  const rows: FindingView[] = [];
  for (let index = 0; index < count; index++) {
    const source = occurrences.length > 0 ? occurrences[Math.floor(random() * occurrences.length)] : undefined;
    const kind = random();
    let original = source ? source.context : `い${MARK}う`;
    if (source && kind < 0.25) original = `${source.before}${MARK}え`;
    else if (source && kind < 0.4) original = `え${MARK}${source.after}`;
    else if (kind > 0.9) original = `えお${MARK}えお`;
    const pick = (): string => (lines.length > 0 && random() < 0.6 ? lines[Math.floor(random() * lines.length)] : "");
    rows.push({
      id: `f${index}`,
      // 同じ時刻の行も作る（並べ方の2つ目・3つ目の決め方まで比べる）
      time: random() < 0.1 ? "読めない" : new Date(Date.UTC(2026, 10, 1, 0, Math.floor(random() * 4))).toISOString(),
      file: random() < 0.85 ? FILE : "本文/002.txt",
      hintLine: 1 + Math.floor(random() * (lines.length + 2)),
      original,
      target: MARK,
      suggestion: "",
      before: pick(),
      after: pick(),
      message: "",
      category: "other",
      label: random() < 0.95 ? SJIS_MARK_FINDING_LABEL : "誤字脱字",
      status: random() < 0.7 ? "pending" : "dismissed",
    });
  }
  return rows;
}

describe("〓の行の突き合わせを速くしても答えが変わらない（#128）", () => {
  it("乱数で作った 2,000 通りの本文と行で、速くする前の作りと同じ行・同じ位置・同じ印になる", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const random = randomOf(seed);
      const text = textOf(random);
      const other = textOf(random);
      const rows = rowsOf(random, text, other);
      const texts = new Map([[FILE, text]]);
      if (random() < 0.5) texts.set("本文/002.txt", other);
      const actual = placeSjisMarkFindings(rows, texts).map(({ id, line, located }) => ({ id, line, located }));
      expect(actual, `種 ${seed}`).toEqual(referencePlace(rows, texts));
    }
  });
});
