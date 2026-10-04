/**
 * 校正の指摘の見本と、提案パネルの面を探す口（設計書6.113）。
 *
 * **AI は呼ばない。** 指摘は製品が読む形（`.aiwriter/findings.jsonl`。
 * `models/finding.ts`）で置く。提案パネルの［適用］の見張り（`proposalApply.test.ts`）と
 * 校正・メモパネルの［直す］の見張り（`memoFixOneStep.test.ts`）が同じ見本を使う。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { findingId, type FindingCategory } from "../../../src/models/finding";

export interface SampleFinding {
  /** 話のファイル名（作品の `本文/` の下） */
  episode: string;
  /** その話の本文 */
  text: string;
  original: string;
  target: string;
  suggestion: string;
  message: string;
  /** 出したAI。渡すと、採った数が `history/ai-verdicts.jsonl` に残る（6.49.7） */
  producer?: { providerId: string; model: string };
  /**
   * 指摘の種類と分類名。**省けば誤字脱字**（`typo`／「誤字脱字」）。
   * 修正案の無い指摘（［本文へ］の行）を作るときに、推敲・矛盾などを渡す
   */
  category?: FindingCategory;
  label?: string;
}

/** 見本の指摘の番号（置き場の判断の行が指す番号） */
export function sampleFindingId(sample: SampleFinding): string {
  return findingId(
    `本文/${sample.episode}`,
    sample.original,
    sample.target,
    sample.suggestion,
    sample.category ?? "typo",
    sample.label ?? "誤字脱字"
  );
}

/** 見本の指摘を、製品が読む形で置く */
export async function writeSampleFinding(workFolder: string, sample: SampleFinding): Promise<void> {
  const at = sample.text.indexOf(sample.original);
  if (at < 0) throw new Error("見本の指摘の原文が本文にありません");
  const line = JSON.stringify({
    kind: "finding",
    id: sampleFindingId(sample),
    // 期限（既定3日）の起点。置くたびに今の時刻にする
    time: new Date().toISOString(),
    file: `本文/${sample.episode}`,
    hintLine: sample.text.slice(0, at).split("\n").length,
    original: sample.original,
    target: sample.target,
    suggestion: sample.suggestion,
    before: sample.text.slice(Math.max(0, at - 12), at),
    after: sample.text.slice(at + sample.original.length, at + sample.original.length + 12),
    message: sample.message,
    category: sample.category ?? "typo",
    label: sample.label ?? "誤字脱字",
    ...(sample.producer ? { producer: sample.producer } : {}),
  });
  const folder = path.join(workFolder, ".aiwriter");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "findings.jsonl"), line + "\n", "utf8");
}

/**
 * 見本の指摘に、判断の行を1行足す（`writeSampleFinding` のあとに呼ぶ）。
 *
 * 原稿箱の取り込み（`mcp/tools/outbox.ts`、設計書6.115）は、本文を直したあとで
 * この形の行を足す。覚え書き（`note`）は `OUTBOX_DECISION_NOTES` の値を渡す。
 */
export async function appendSampleDecision(
  workFolder: string,
  sample: SampleFinding,
  decision: { status: "accepted" | "dismissed" | "pending"; note: string }
): Promise<void> {
  const line = JSON.stringify({
    kind: "decision",
    findingId: sampleFindingId(sample),
    time: new Date().toISOString(),
    status: decision.status,
    note: decision.note,
  });
  await appendFile(path.join(workFolder, ".aiwriter", "findings.jsonl"), line + "\n", "utf8");
}

/** 置き場（`.aiwriter/` の下の1行1件のファイル）の行。無ければ空 */
export async function readJsonLines(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * 提案パネルを開くキー（`novelai.openProposals`）。使い捨ての keybindings.json に書く。
 *
 * **ほかのキーと重ねない**——F10 は版の確認、F11 は知らせを閉じる、F12 は作品の登録、
 * F9 は広報の台本が使う。重ねると登録の途中で提案パネルが開き、起動で止まる（実際に踏んだ）。
 */
export const OPEN_PROPOSALS_KEY = "ctrl+alt+shift+f8";
export const OPEN_PROPOSALS_PRESS = "Control+Alt+Shift+F8";
export const OPEN_PROPOSALS_LAUNCH = {
  keybindings: [{ key: OPEN_PROPOSALS_KEY, command: "novelai.openProposals" }],
};

/** 提案パネル（右の列の WebView）。目印は［まとめて適用］（`#applyAll`）——この面にしか無い */
export async function proposalPanelFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame.evaluate(() => document.getElementById("applyAll") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}
