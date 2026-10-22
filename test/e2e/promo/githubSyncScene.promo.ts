/**
 * Discord「機能紹介」用の広報素材：GitHubで持ち運ぶ（作者の依頼 2026-10-22）。
 * features.md の文：復元では、版を選ぶと、戻すと何が起きるかを先に見せる。いまの原稿は戻す前に履歴へ自動で残すので、やり直せる。
 *
 * **本物の GitHub には繋がない。** 送り先は同じ一時フォルダーの中の裸の置き場（`gitFixture.addLocalRemote`）。
 * 記録の名前は作り物（「画面テスト」）で、作者のアカウント名・URL・鍵は画面に出ない。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/githubSyncScene.promo.ts`
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { addLocalRemote, git, initRepoWithFirstCommit } from "../support/gitFixture";
import { openEpisode } from "../support/manuscriptFrame";
import { runCommand } from "../support/quickInput";
import { E2E_WORK_TITLE } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { dialogText, pickQuickPickRow, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { recordFeature } from "./support/featureScene";

const EP1 = "001_雨の駅.txt";
const EP2 = "002_朝の窓口.txt";
const TEXT1 = "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ホームの時計が、零時を指していた。\n";
const TEXT1_EDITED = "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ホームの時計が、零時を指していた。\n　男は傘を差し出した。\n";
const TEXT2 = "　翌朝の窓口で、駅員は切符を差し出した。\n";

test("GitHubで持ち運ぶの広報素材を撮る", async () => {
  await recordFeature({
    name: "github-sync",
    subtitle: "GitHubで持ち運ぶ — 戻す前に、何が起きるかを見せる",
    workTitle: E2E_WORK_TITLE,
    episodes: [{ name: EP1, text: TEXT1 }],
    // 自動の送り直し・取りに行きは切る（撮っている最中に記録が増えないように）
    settings: { "novelai.git.autoResend": false, "novelai.git.autoFetch": false },
    fakeModels: ["gemma4:e4b", "gemma4:26b"],
    snapAt: 7,
    open: async ({ page }) => {
      await openEpisode(page, EP1, "零時を指していた");
    },
    prepareWork: async ({ workFolder }) => {
      const root = path.dirname(path.dirname(workFolder));
      await initRepoWithFirstCommit(workFolder);
      await addLocalRemote(workFolder, path.join(root, "送り先.git"));
      // 版を増やす：2話目を足す → 1話を書き足す（戻すと「消えるファイル」が出る）
      await writeFile(path.join(workFolder, "本文", EP2), TEXT2, "utf8");
      await git(workFolder, ["add", "-A"]);
      await git(workFolder, ["commit", "--quiet", "-m", "2話目を足した"]);
      await writeFile(path.join(workFolder, "本文", EP1), TEXT1_EDITED, "utf8");
      await git(workFolder, ["commit", "--quiet", "-am", "1話を書き足した"]);
    },
    play: async ({ page }, caption) => {
      await caption("「過去の版に戻す」を選ぶ");
      await page.waitForTimeout(800);
      await runCommand(page, "過去の版に戻す（復元）");
      await waitUntil(
        async () => {
          const title = (await quickPickTitle(page)) ?? "";
          if (title.includes("同期する作品を選択") || title.includes("作品を選")) {
            await pickQuickPickRow(page, E2E_WORK_TITLE);
            return false;
          }
          return title.includes("どの版に戻しますか");
        },
        "戻す版の一覧が出る",
        30_000
      );
      await page.waitForTimeout(2_000);
      await caption("戻したい日時を選ぶ");
      const rows = await quickPickRows(page);
      const target = rows.find((row) => row.description.includes("最初")) ?? rows[rows.length - 2] ?? rows[0];
      await pickQuickPickRow(page, target.description || target.label);
      await waitUntil(async () => ((await dialogText(page)) ?? "").includes("に戻しますか"), "戻すと何が起きるかの確認が出る", 30_000);
      await caption("戻すと何が起きるかを、先に見せる");
      await page.waitForTimeout(4_000);
      // 戻さずに閉じる（見せるだけ）
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    },
  });
});
