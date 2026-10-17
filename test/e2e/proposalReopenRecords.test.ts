/**
 * 実機確認リスト A-1 の「修正済み・要実機再確認」の2件を、画面の自動テストで再現し直す（2026-10-18）。
 *
 * 1. 0.34.3：「適用」→「戻す」で、**戻す側が同じ行の別の一致を書き換えた**（同じ行に、直した後の字
 *    〔かもしれない〕が指摘の箇所より前にもう1つあると、戻すときに1つ目を「かもしれあい」にしてしまった）
 * 2. 0.50.2：推敲を1件直す（複数行を1行にするなど、本文の行数が変わる直し）と、そのあとの
 *    ［本文を見る］が古い行番号のままずれた（飛ぶ直前に、いまの本文から引用を探し直すようにした）
 *
 * **AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` へ製品が読む形で置く。提案パネルは使い捨ての
 * keybindings のキーで開く。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  sampleFindingId,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";

async function fileText(session: E2ESession): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "");
  return raw.replace(/\r\n/g, "\n");
}

async function openProposals(page: Page, ready: (frame: Frame) => Promise<boolean>, what: string): Promise<Frame> {
  await clearNotifications(page);
  await page.keyboard.press(OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await ready(proposals));
    },
    what,
    15_000
  );
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

/** 見本の指摘を何件か、1つの置き場の中に並べる（`writeSampleFinding` は1件ずつ上書きするので、行を集める） */
async function writeSampleFindings(workFolder: string, samples: SampleFinding[]): Promise<void> {
  const file = path.join(workFolder, ".aiwriter", "findings.jsonl");
  const lines: string[] = [];
  for (const sample of samples) {
    await writeSampleFinding(workFolder, sample);
    lines.push((await readFile(file, "utf8")).trim());
  }
  await writeFile(file, lines.join("\n") + "\n", "utf8");
}

/* ── 1. 0.34.3 ── */
const UNDO_LINE = "　虎の威を借りても、返されるかもしれないし、それ以上の威を返されるかもしれあい。";
const UNDO_TEXT = ["　朝の駅は静かだった。", UNDO_LINE, "　ホームの時計が零時を指していた。", ""].join("\n");
const UNDO_SAMPLE: SampleFinding = {
  episode: EPISODE,
  text: UNDO_TEXT,
  original: "それ以上の威を返されるかもしれあい。",
  target: "かもしれあい",
  suggestion: "かもしれない",
  message: "「かもしれない」の打ち間違いです",
};

test("0.34.3の再現：同じ行に直した後の字が前にもあっても、［適用］→［戻す］で指摘の箇所だけが元へ戻る", async () => {
  await withVsCode(
    "適用と戻すの同じ行",
    [{ name: EPISODE, text: UNDO_TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, UNDO_SAMPLE);
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "朝の駅");
      const proposals = await openProposals(page, async (f) => (await f.locator('button[data-action="apply"]').count()) > 0, "提案パネルに［適用］が並ぶ");

      await proposals.locator('button[data-action="apply"]').first().click();
      const applied = UNDO_TEXT.replace("返されるかもしれあい。", "返されるかもしれない。");
      await waitUntil(async () => (await fileText(session)) === applied, "［適用］で、指摘の箇所（2つ目）だけが直る").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
      });

      await waitUntil(async () => (await proposals.locator('button[data-action="undo"]').count()) > 0, "［戻す］が出る", 10_000);
      await proposals.locator('button[data-action="undo"]').first().click();
      // 書き込みは「退避 → 新規作成」なので、その合間はファイルが空に見える。空のあいだは待つ
      await waitUntil(async () => {
        const now = await fileText(session);
        return now !== "" && now !== applied;
      }, "［戻す］でファイルが動く", 10_000);
      const undone = await fileText(session);
      expect(undone, `［戻す］で別の箇所が書き換わっています（ファイル：${JSON.stringify(undone)}）`).toBe(UNDO_TEXT);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});

/* ── 2. 0.50.2 ── */
const JUMP_TEXT = [
  "　朝の駅は静かだった。",
  "　彼は走った。彼は走った。彼は走った。",
  "　雨は降り続いていた。",
  "　近づいてみると、男は以外にも若かった。",
  "　ホームの時計が零時を指していた。",
  "",
].join("\n");
/** 1行を3行に分ける直し。本文の行数が2行増える（そのあとの指摘の行番号が2つずれる） */
const SHRINK: SampleFinding = {
  episode: EPISODE,
  text: JUMP_TEXT,
  original: "　彼は走った。彼は走った。彼は走った。",
  target: "彼は走った。",
  suggestion: "　彼は走った。\n　彼は止まった。\n　彼は座った。",
  message: "同じ文末が続きます",
  category: "proofread",
  label: "推敲",
};
const LATER: SampleFinding = {
  episode: EPISODE,
  text: JUMP_TEXT,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
  // 提案パネルは分類ごとの束で出る。同じ束（推敲）に並べて、1つの画面で押せるようにする
  category: "proofread",
  label: "推敲",
};

test("0.50.2の再現：複数行の直しで行数が変わっても、そのあとの指摘の［本文を見る］は引用のある行へ飛ぶ", async () => {
  await withVsCode(
    "推敲のあとの本文を見る",
    [{ name: EPISODE, text: JUMP_TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFindings(session.workFolder, [SHRINK, LATER]);
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "朝の駅");
      const shrinkId = sampleFindingId(SHRINK);
      const laterId = sampleFindingId(LATER);
      const proposals = await openProposals(
        page,
        async (f) => (await f.locator(`button[data-action="apply"][data-id="${shrinkId}"]`).count()) > 0 && (await f.locator(`.location[data-action="jump"][data-id="${laterId}"]`).count()) > 0,
        "提案パネルに2件の指摘が並ぶ"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（提案パネルの字：${JSON.stringify(await (await proposalPanelFrame(page))?.evaluate(() => document.body.innerText.slice(0, 400)))}）`);
      });

      await proposals.locator(`button[data-action="apply"][data-id="${shrinkId}"]`).click();
      await waitUntil(async () => (await fileText(session)).includes("彼は座った"), "推敲の直しがファイルに入る", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
      });
      const after = await fileText(session);
      expect(after.split("\n").length, `行数が増えていない（見張りにならない）：${JSON.stringify(after)}`).toBeGreaterThan(JUMP_TEXT.split("\n").length);

      // 古い行番号のままなら外れる位置にある、あとの指摘へ飛ぶ
      await proposals.locator(`.location[data-action="jump"][data-id="${laterId}"]`).click();
      await waitUntil(
        async () => ((await caretPosition(frame))?.lineText ?? "").includes("以外にも"),
        "［本文を見る］で、カーソルが引用のある行（以外にも…）へ動く",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（カーソルの行：${JSON.stringify((await caretPosition(frame))?.lineText)}）`);
      });
    },
    OPEN_PROPOSALS_LAUNCH
  );
});
