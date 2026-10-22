/**
 * Discord「機能紹介」用の広報素材：編集部の方と一緒に使う（作者の依頼 2026-10-22）。
 * features.md の文：編集部は本文を書き換えず、提案として置く。作者が1件ずつ採るか見送るかを決める。
 * 作者は「作品管理 → 編集部連携 → 編集部提案確認」で提案を見られる。
 *
 * 編集部からの提案は、製品が読む形（`.aiwriter/proposals/proposals.jsonl`）で前もって置く（広報用の作り物。
 * 提案者の名前は「編集部A」＝実在しない名前）。**AIは呼ばない。**
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/editorialScene.promo.ts`
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { composeText, manuscriptFrames, openEpisode } from "../support/manuscriptFrame";
import { runCommand } from "../support/quickInput";
import { proposalPanelFrame } from "../support/sampleFinding";
import { waitUntil } from "../support/wait";
import { clearNotifications, pickQuickPickRow, quickPickTitle } from "../support/workbenchDom";
import { E2E_WORK_TITLE } from "../support/vscodeApp";
import { recordFeature } from "./support/featureScene";

const EPISODE = "001_雨の駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　近づいてみると、男は以外にも若かった。",
  "　ホームの時計が、零時をさしていた。",
  "",
].join("\n");

const PROPOSER = "編集部A";
const PROPOSALS = [
  { id: "p1", line: 2, original: "男は以外にも若かった。", target: "以外", suggestion: "意外", reason: "「思いのほか」の意味なら「意外」です" },
  { id: "p2", line: 3, original: "零時をさしていた。", target: "さして", suggestion: "指して", reason: "針などが示す意味なら「指す」です" },
];

test("編集部の方と一緒に使うの広報素材を撮る", async () => {
  await recordFeature({
    name: "editorial",
    subtitle: "編集部の方と一緒に使う — 提案を、作者が1件ずつ決める",
    workTitle: E2E_WORK_TITLE,
    episodes: [{ name: EPISODE, text: TEXT }],
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 7,
    prepareWork: async ({ workFolder }) => {
      const lines = PROPOSALS.map((proposal) =>
        JSON.stringify({
          kind: "proposal",
          ...proposal,
          time: new Date().toISOString(),
          proposer: PROPOSER,
          file: `本文/${EPISODE}`,
          category: "typo",
        })
      );
      const dir = path.join(workFolder, ".aiwriter", "proposals");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "proposals.jsonl"), `${lines.join("\n")}\n`, "utf8");
    },
    open: async ({ page }) => {
      await openEpisode(page, EPISODE, "零時を");
    },
    play: async ({ page }, caption) => {
      await caption("編集部は本文を書き換えず、提案として置く");
      await page.waitForTimeout(2_000);
      await caption("作者は「編集部提案確認」で、届いた提案を見る");
      await runCommand(page, "編集部提案確認");
      await waitUntil(
        async () => {
          const title = (await quickPickTitle(page)) ?? "";
          if (title.includes("作品を選")) {
            await pickQuickPickRow(page, E2E_WORK_TITLE);
            return false;
          }
          const panel = await proposalPanelFrame(page);
          return panel !== undefined && (await panel.locator('[data-action="apply"]').count()) > 0;
        },
        "提案パネルに編集部の提案が並ぶ",
        30_000
      );
      await clearNotifications(page);
      await page.waitForTimeout(3_000);
      const panel = (await proposalPanelFrame(page)) as NonNullable<Awaited<ReturnType<typeof proposalPanelFrame>>>;
      await caption("作者が1件ずつ、採るか見送るかを決める");
      await page.waitForTimeout(1_500);
      await panel.locator('[data-action="apply"]').first().click();
      await waitUntil(
        async () => {
          for (const candidate of await manuscriptFrames(page)) {
            if ((await composeText(candidate)).includes("男は意外にも若かった")) return true;
          }
          return false;
        },
        "採った提案が本文に入る",
        15_000
      );
      await page.waitForTimeout(1_500);
      const dismiss = panel.locator('[data-action="dismiss"]').first();
      if ((await dismiss.count()) > 0) await dismiss.click();
      await page.waitForTimeout(2_500);
    },
  });
});
