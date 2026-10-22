/**
 * Discord「機能紹介」用の広報素材：機能別AI割当（作者の依頼 2026-10-21）。
 *
 * `npm run promo:record` で走らせる（検査ではない。`npm run check` にも `test:e2e` にも入れない）。
 * 土台は fixScene.promo.ts と同じ。**本物のAIは呼ばない**——割当は globalState へ製品が読む形で
 * 置き、手元のAIは偽の Ollama。有料のAI（Gemini・Claude）は一覧に名前が出るだけで、鍵も通信も使わない。
 * 見本の作品は広報用の作り物（作者の原稿は使わない）。
 *
 * 出力：`media/promo/features/ai-assign.mp4`（Discord でその場で再生できる H.264）と
 *       `media/promo/features/ai-assign.png`（割当の一覧の画面ショット）。
 */
import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { fakeOllamaLaunch, startFakeOllama } from "../support/fakeOllama";
import { runCommand } from "../support/quickInput";
import { resizeWindows, withVsCode, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dismissWorkbenchHover, pickQuickPickRow, quickPickTitle } from "../support/workbenchDom";
import { durationSeconds, findFfmpeg, toMp4 } from "./support/encode";
import { hideCaption, hideTitleCard, showCaption, showTitleCard } from "./support/overlay";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RELEASE_DIR = path.join(repositoryRoot, "release", "promo");
const OUT_DIR = path.join(repositoryRoot, "media", "promo", "features");
const SIZE = { width: 1280, height: 720 };

const EPISODES: FixtureEpisode[] = [
  { name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ホームの時計が、零時を指していた。\n" },
];

/** 字幕は下の真ん中（選ぶ画面は上にあるので重ならない） */
const CAPTION = { left: "50%", bottom: "9%" };

const PROMO_SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": "Default Light Modern",
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.layoutControl.enabled": false,
  "workbench.editor.editorActionsLocation": "hidden",
  "window.titleBarStyle": "native",
  "window.commandCenter": false,
  "window.menuBarVisibility": "hidden",
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "window.zoomLevel": 1,
};

test("機能別AI割当の広報素材を撮る", async () => {
  await mkdir(RELEASE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const videoDir = path.join(RELEASE_DIR, "raw-ai-assign");
  await rm(videoDir, { recursive: true, force: true });
  const png = path.join(OUT_DIR, "ai-assign.png");

  const fake = await startFakeOllama(() => "OK", { listedModels: ["gemma4:e4b", "gemma4:26b"] });
  let sceneStartedAt = 0;
  let videoStartedAt = 0;
  let sceneEndedAt = 0;
  try {
    const { videoPath } = await withVsCode(
      "広報・機能別AI割当",
      EPISODES,
      async (session) => {
        const { page } = session;
        await showTitleCard(page, "統合小説執筆環境", "機能別AI割当 — 機能ごとに使うAIを選ぶ");
        await resizeWindows(session.app, SIZE);
        await waitUntil(
          async () =>
            (await session.app.evaluate(({ BrowserWindow }) => {
              // writeScene の contentSize と同じ形（find のコールバックは型が付かず落ちた）
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) return win.getContentSize();
              }
              return [0, 0];
            }))[0] === SIZE.width,
          "窓の幅が合う",
          10_000
        );
        sceneStartedAt = Date.now();
        videoStartedAt = session.videoStartedAt ?? sceneStartedAt;
        await clearNotifications(page);
        // 左の列（エクスプローラー）は英語表記で広報に向かないので閉じる（fixScene と同じ道）
        await page.keyboard.press("Control+Alt+Shift+F9");
        await runCommand(page, "機能別AI割当");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どの機能のAI"), "機能の一覧が出る", 20_000);
        const shown = Date.now() - sceneStartedAt;
        if (shown < 2_500) await page.waitForTimeout(2_500 - shown);
        await page.mouse.move(1200, 700);
        await dismissWorkbenchHover(page);
        await hideTitleCard(page);

        await showCaption(page, "機能ごとに、使うAIを選べる", CAPTION);
        await page.waitForTimeout(5_000);

        await showCaption(page, "たとえば「推敲」を選ぶと", CAPTION);
        await page.waitForTimeout(1_200);
        await pickQuickPickRow(page, "推敲");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").endsWith("で使うAI"), "「推敲 で使うAI」が出る", 15_000);
        await page.waitForTimeout(2_200);
        await showCaption(page, "割当を外して、既定のAIへ戻せる", CAPTION);
        await page.waitForTimeout(1_000);
        await pickQuickPickRow(page, "既定のAIを使う");

        // 戻したあと、もう一度開いて一覧の変化を見せる
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 15_000);
        await runCommand(page, "機能別AI割当");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どの機能のAI"), "機能の一覧が出る（2回目）", 20_000);
        await showCaption(page, "「推敲」が既定のAIに戻った", CAPTION);
        await page.waitForTimeout(3_800);

        await hideCaption(page);
        await showTitleCard(page, "統合小説執筆環境", "VS Code の拡張機能");
        await page.waitForTimeout(2_700);
        sceneEndedAt = Date.now();
      },
      fakeOllamaLaunch(fake, {
        settings: PROMO_SETTINGS,
        keybindings: [{ key: "ctrl+alt+shift+f9", command: "workbench.action.closeSidebar" }],
        recordVideo: { dir: videoDir, size: SIZE },
        windowSize: SIZE,
        workTitle: "雨の駅",
        globalState: {
          "novelai.ai.model": "gemma4:e4b",
          "novelai.ai.featureAssignments": {
            typo: { provider: "ollama", model: "gemma4:e4b" },
            proofread: { provider: "gemini", model: "gemini-2.5-flash" },
            contradiction: { provider: "claude", model: "claude-sonnet-4-5" },
            chat: { provider: "ollama", model: "gemma4:26b" },
          },
        },
      })
    );
    expect(videoPath, "動画が録れていません").toBeTruthy();
    const raw = path.join(RELEASE_DIR, "ai-assign-raw.webm");
    await rm(raw, { force: true });
    await rename(videoPath as string, raw);
    await rm(videoDir, { recursive: true, force: true });

    const start = Math.max(0, (sceneStartedAt - videoStartedAt) / 1000 + 0.4);
    const length = (sceneEndedAt - sceneStartedAt) / 1000 - 0.7;
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
      process.stdout.write(`[広報] ffmpeg が無いので変換を飛ばしました: ${raw}\n`);
      return;
    }
    const mp4 = path.join(OUT_DIR, "ai-assign.mp4");
    await toMp4(ffmpegPath, raw, mp4, start, length);
    // 画面ショットは動画の一覧の場面から抜く（窓の大きさ 1280x720 と揃い、字幕も入る）
    await new Promise<void>((resolve, reject) => execFile(ffmpegPath, ["-v", "error", "-y", "-ss", "4.5", "-i", mp4, "-frames:v", "1", png], (error) => (error ? reject(error) : resolve())));
    const seconds = await durationSeconds(ffmpegPath, mp4);
    process.stdout.write(`[広報] MP4: ${mp4}（${seconds?.toFixed(1)} 秒・${((await stat(mp4)).size / 1048576).toFixed(2)} MB）\n`);
  } finally {
    await fake.close();
  }
});

