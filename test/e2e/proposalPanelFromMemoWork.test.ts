/**
 * 校正・メモパネルの［提案パネル］は、押したパネルの作品へ提案パネルを切り替えて前に出す（画面の自動テスト、
 * 設計書6.96.5・6.113。実機確認リスト 0.122.0 の 370 行を機械へ移した。作者の実機 2026-11-02）。
 *
 * 1. 作品Aの校正・メモパネルの［提案パネル］で、提案パネルに作品Aの指摘が出る
 * 2. 提案パネルを出したまま、作品Bの校正・メモパネルの［提案パネル］を押すと、提案パネルが作品Bの中身に
 *    切り替わって前に出る（「作品」欄で選ばれているのも作品B。作品Aの指摘は並ばない）
 * 3. 作品Aの校正・メモパネルから押し直すと、作品Aの指摘が元のまま（未処理のまま）戻る
 *
 * 提案パネルの見出しの作品名は、作品が2つ以上あるときに出る「作品」欄（`#works select`）で読む。
 *
 * **AI は呼ばない。** 指摘は両方の作品の置き場（`.aiwriter/findings.jsonl`）へ製品が読む形で見本を置く。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { proposalPanelFrame, writeSampleFinding, type SampleFinding } from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeTabNames, clearNotifications } from "./support/workbenchDom";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

const EPISODE_A = "001_駅.txt";
const TEXT_A = "　朝の駅は静かだった。\n　近づいてみると、男は以外にも若かった。\n";
const EPISODE_B = "001_港.txt";
const TEXT_B = "　夜の港は静かだった。\n　灯台を見上げけて、息を吐いた。\n";

const SAMPLE_A: SampleFinding = { episode: EPISODE_A, text: TEXT_A, original: "男は以外にも若かった。", target: "以外", suggestion: "意外", message: "作品Aの指摘：意外の取り違え" };
const SAMPLE_B: SampleFinding = { episode: EPISODE_B, text: TEXT_B, original: "灯台を見上げけて、息を吐いた。", target: "見上げけて", suggestion: "見上げて", message: "作品Bの指摘：けが重なっている" };

/** 校正・メモパネル（見出しで始まる面）のうち、`marker` を含むもの。作品ごとに別のパネルになる */
async function memoFrameShowing(page: Page, marker: string): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const hit = await frame
      .evaluate((want) => {
        const text = document.body?.innerText ?? "";
        return text.trimStart().startsWith("校正・メモパネル") && text.includes(want);
      }, marker)
      .catch(() => false);
    if (hit) return frame;
  }
  return undefined;
}

/** 原稿の中から Ctrl+Alt+M で校正・メモパネルを開き、`marker`（その作品の指摘）と［提案パネル］が出るまで待つ */
async function openMemoFor(page: Page, marker: string, label: string): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoFrameShowing(page, marker);
      return memo !== undefined && (await memo.evaluate(() => !(document.getElementById("openProposals") as HTMLButtonElement).hidden).catch(() => false));
    },
    `${label}の校正・メモパネルに指摘と［提案パネル］が出る`,
    30_000
  );
  if (!memo) throw new Error(`${label}の校正・メモパネルが見つかりません`);
  return memo;
}

interface ProposalView {
  text: string;
  selectedWork: string | undefined;
  pendingButtons: number;
}

async function proposalView(frame: Frame): Promise<ProposalView> {
  return frame.evaluate(() => {
    const select = document.querySelector("#works select") as HTMLSelectElement | null;
    return {
      text: document.getElementById("list")?.innerText ?? "",
      selectedWork: select ? (select.selectedOptions[0]?.textContent ?? "") : undefined,
      pendingButtons: document.querySelectorAll('#list button[data-action="apply"]').length,
    };
  });
}

/** 提案パネルが `wanted` の作品の指摘を見せるまで待ち、そのときの中身を返す */
async function waitProposalsFor(page: Page, marker: string, label: string): Promise<{ frame: Frame; view: ProposalView }> {
  let last: ProposalView | undefined;
  let frame: Frame | undefined;
  await waitUntil(
    async () => {
      frame = await proposalPanelFrame(page);
      if (!frame) return false;
      last = await proposalView(frame).catch(() => undefined);
      return last !== undefined && last.text.includes(marker);
    },
    `${label}：提案パネルに「${marker}」が出る`,
    20_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（提案パネル：${JSON.stringify(last)}）`);
  });
  await waitUntil(async () => (await activeTabNames(page)).some((name) => name.startsWith("提案")), `${label}：提案パネルのタブが前に出る`, 10_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（前のタブ：${JSON.stringify(await activeTabNames(page))}）`);
    }
  );
  return { frame: frame as Frame, view: last as ProposalView };
}

test("作品Aの提案パネルを出したまま作品Bの校正・メモパネルの［提案パネル］を押すと作品Bの中身（作品欄もB）に切り替わり、作品Aから押し直すとAの指摘が元のまま戻る", async () => {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  await withVsCode(
    "メモパネルから提案パネルの作品を渡す",
    [{ name: EPISODE_A, text: TEXT_A }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE_A);
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);

      /* ── 1. 作品Aの校正・メモパネルから ── */
      const frameA = await openEpisode(page, EPISODE_A, "以外にも");
      await placeCaretAfter(frameA, "朝の駅");
      const memoA = await openMemoFor(page, "作品Aの指摘", "作品A");
      await memoA.locator("#openProposals").click();
      const first = await waitProposalsFor(page, "作品Aの指摘", "作品Aから押す");
      expect(first.view.text, "作品Aなのに作品Bの指摘が並んでいます").not.toContain("作品Bの指摘");

      /* ── 2. 提案パネルを出したまま、作品Bの校正・メモパネルから ── */
      const frameB = await openEpisode(page, EPISODE_B, "見上げけて");
      await placeCaretAfter(frameB, "夜の港");
      const memoB = await openMemoFor(page, "作品Bの指摘", "作品B");
      await memoB.locator("#openProposals").click();
      const second = await waitProposalsFor(page, "作品Bの指摘", "作品Bから押す");
      expect(second.view.text, `作品Bに切り替えたのに作品Aの指摘が残っています：${second.view.text}`).not.toContain("作品Aの指摘");
      expect(second.view.selectedWork, `「作品」欄（見出しの作品名）：${JSON.stringify(second.view)}`).toContain(OTHER_TITLE);

      /* ── 3. 作品Aの校正・メモパネルから押し直す ── */
      const backA = await openEpisode(page, EPISODE_A, "以外にも");
      await placeCaretAfter(backA, "朝の駅");
      const memoA2 = await openMemoFor(page, "作品Aの指摘", "作品A（2回目）");
      await memoA2.locator("#openProposals").click();
      const third = await waitProposalsFor(page, "作品Aの指摘", "作品Aから押し直す");
      expect(third.view.text, "作品Aへ戻したのに作品Bの指摘が並んでいます").not.toContain("作品Bの指摘");
      expect(third.view.selectedWork, `「作品」欄：${JSON.stringify(third.view)}`).not.toContain(OTHER_TITLE);
      // 元のまま（未処理）：［適用］が残っていて、適用済み・見送りの札は無い
      expect(third.view.pendingButtons, `作品Aの指摘が未処理のまま戻っていません：${JSON.stringify(third.view)}`).toBe(1);
      expect(third.view.text).not.toMatch(/適用済み|見送りました/);
    },
    {
      keybindings: [registerOther],
      prepareWork: async ({ workFolder }) => {
        const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
        await mkdir(path.join(otherFolder, "本文"), { recursive: true });
        await writeFile(path.join(otherFolder, "本文", EPISODE_B), TEXT_B, "utf8");
        await writeSampleFinding(otherFolder, SAMPLE_B);
        registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
      },
    }
  );
}, 240_000);
