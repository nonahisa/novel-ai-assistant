import fs from "node:fs";
import nodePath from "node:path";
import { describe, expect, test } from "vitest";
import {
  SJIS_MARK_FINDING_LABEL,
  placeSjisMarkFindings,
  sjisMarkPlaces,
} from "../../../src/core/sjisMarkFinding";
import { findingPanelStatesOf } from "../../../src/core/findingPanelState";
import type { FindingView } from "../../../src/models/finding";

/**
 * 〓の行の突き合わせの重さを測る台本（実装の残り 116行。直すかはこの数字を見て決める）。
 *
 * 校正・メモパネルを開くたび（と MCP の pending.list のたび）に、〓の行を本文の〓と1対1で
 * 突き合わせる（`placeSjisMarkFindings`）。〓の行は日付で消さないので、見送った行・直して
 * 出なくなった行が置き場に溜まるほど重くなる。割り当ては「行ごとに、空いている〓を全部見る」を
 * 3段するので、行の数×〓の数に比例すると見込む。
 *
 * **ふだんの `npm run check` では走らせない**（時間の断言を入れない。機械で揺れる）。
 * 走らせ方（PowerShell）：
 *   $env:NOVELAI_SJIS_BENCH = "<要約を書くファイルの絶対パス>"
 *   npx vitest run test/unit/core/sjisMarkPlacementBench.test.ts
 * 要約はそのファイルへ書く（vitest では console が見えないため）。
 * 測る前に「比べる相手の数」（合本の字数・〓の数・行の数と内訳）を1行ずつ書く。
 *
 * 試すファイルは台本の中で作った文字列だけで、ディスクの本文は読まない（書き戻しの途中の
 * 一時ファイルに当たって揺れることが無い）。
 */
const OUT = process.env.NOVELAI_SJIS_BENCH;

const FILE = "本文/合本.txt";
const EPISODE_CHARS = 4000;
const LINE_CHARS = 40;
const KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";

/** 本文の1行（40字）。行ごとに字を変え、〓の前後4字がほとんど重ならないようにする */
function lineOf(index: number): string {
  let line = "";
  for (let at = 0; at < LINE_CHARS; at++) line += KANA[(index * 7 + at * 3 + Math.floor(index / 13)) % KANA.length];
  return line;
}

/**
 * 合本を作る。`marks` 個の〓を、本文の行に均して置く（行の真ん中の1字を〓にする）
 */
function buildText(totalChars: number, marks: number): string {
  const lineCount = Math.ceil(totalChars / LINE_CHARS);
  const every = Math.max(1, Math.floor(lineCount / Math.max(1, marks)));
  const lines: string[] = [];
  let placed = 0;
  for (let index = 0; index < lineCount; index++) {
    let line = lineOf(index);
    if (placed < marks && index % every === 0) {
      line = `${line.slice(0, 20)}〓${line.slice(21)}`;
      placed++;
    }
    lines.push(line);
    // 話の区切りの空行（4,000字ごと）
    if ((index + 1) % (EPISODE_CHARS / LINE_CHARS) === 0) lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function row(id: string, line: number, original: string, status: FindingView["status"]): FindingView {
  return {
    id,
    time: new Date(Date.UTC(2026, 10, 1, 0, 0, Number(id.slice(1)) % 86400)).toISOString(),
    file: FILE,
    hintLine: line,
    original,
    target: "〓",
    suggestion: "",
    before: "",
    after: "",
    message: "",
    category: "other",
    label: SJIS_MARK_FINDING_LABEL,
    status,
  };
}

/**
 * 置き場の〓の行を作る。
 * - 〓が残る行のうち 3/4 は未決、1/4 は見送った（自分の〓を取っておく）
 * - `resolved` 行は〓を直して出なくなった行（どの〓とも合わない。いちばん重い：3段とも全部の〓を見て外れる）
 */
function buildRows(text: string, resolved: number): FindingView[] {
  const rows: FindingView[] = [];
  sjisMarkPlaces(text).forEach((occurrence, index) => {
    rows.push(row(`f${index}`, occurrence.line, occurrence.context, index % 4 === 3 ? "dismissed" : "pending"));
  });
  for (let index = 0; index < resolved; index++) {
    // 本文に無い前後の字（ゃゅょ は本文の行に使っていない）
    rows.push(row(`f${100000 + index}`, 1 + index * 3, `ゃゅ${index}〓ょゃ`, "pending"));
  }
  return rows;
}

/** 5回測った中央値（ミリ秒）。先に1回空回しする */
function median(run: () => void): number {
  run();
  const times: number[] = [];
  for (let count = 0; count < 5; count++) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[2];
}

describe.skipIf(!OUT)("〓の行の突き合わせの重さ（測る台本）", () => {
  test("合本の字数・〓の数・置き場の行の数を変えて測る", () => {
    const out = OUT as string;
    const lines: string[] = [];
    const write = (line: string): void => {
      lines.push(line);
      fs.mkdirSync(nodePath.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
    };
    write(`# 〓の行の突き合わせの重さ（${new Date().toISOString()}、Node ${process.version}）`);

    const cases: Array<{ chars: number; marks: number; resolved: number }> = [];
    for (const chars of [830_000, 3_100_000]) {
      for (const marks of [200, 1000, 5000]) {
        for (const resolved of [0, marks]) cases.push({ chars, marks, resolved });
      }
    }

    // 比べる相手の数を先に書く
    for (const item of cases) {
      write(
        `相手: 合本 ${item.chars.toLocaleString()}字・〓 ${item.marks}個・置き場の〓の行 ${item.marks + item.resolved}行` +
          `（〓が残る ${item.marks}＝未決 ${item.marks - Math.floor(item.marks / 4)}・見送り ${Math.floor(item.marks / 4)}、直して出なくなった ${item.resolved}）`
      );
    }
    write("");
    write("| 合本の字数 | 〓 | 置き場の〓の行 | 〓を拾う（sjisMarkPlaces） | 突き合わせ（placeSjisMarkFindings） | pending.list の決め方（findingPanelStatesOf） | 並んだ行 |");
    write("|---:|---:|---:|---:|---:|---:|---:|");

    for (const item of cases) {
      const text = buildText(item.chars, item.marks);
      const found = sjisMarkPlaces(text).length;
      expect(found).toBe(item.marks);
      const rows = buildRows(text, item.resolved);
      const texts = new Map([[FILE, text]]);
      let shown = 0;
      const scan = median(() => {
        sjisMarkPlaces(text);
      });
      const place = median(() => {
        shown = placeSjisMarkFindings(rows, texts).length;
      });
      const states = median(() => {
        findingPanelStatesOf(rows, texts, 3);
      });
      write(
        `| ${item.chars.toLocaleString()} | ${item.marks} | ${rows.length} | ${scan.toFixed(1)}ms | ${place.toFixed(1)}ms | ${states.toFixed(1)}ms | ${shown} |`
      );
    }
  }, 600_000);
});
