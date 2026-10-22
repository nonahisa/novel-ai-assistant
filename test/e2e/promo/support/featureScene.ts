/**
 * Discord「機能紹介」用の広報素材を撮る共通の流れ（表題 → 操作 → 字幕 → 結び）。
 * 手本は aiAssignScene.promo.ts。**本物のAIは呼ばない**（偽の Ollama を立てるだけ）。
 *
 * 出力：`media/promo/features/<name>.mp4`（H.264）と `<name>.png`（動画の1こま）。
 */
import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeOllamaLaunch, startFakeOllama, type FakeOllamaRequest } from "../../support/fakeOllama";
import { resizeWindows, withVsCode, type E2ESession, type FixtureEpisode, type LaunchOptions } from "../../support/vscodeApp";
import { waitUntil } from "../../support/wait";
import { clearNotifications, dismissWorkbenchHover } from "../../support/workbenchDom";
import { durationSeconds, findFfmpeg, toMp4 } from "./encode";
import { hideCaption, hideTitleCard, showCaption, showTitleCard } from "./overlay";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const RELEASE_DIR = path.join(repositoryRoot, "release", "promo");
export const OUT_DIR = path.join(repositoryRoot, "media", "promo", "features");
export const SIZE = { width: 1280, height: 720 };
/** 字幕は下の真ん中 */
export const CAPTION = { left: "50%", bottom: "9%" };

export const PROMO_SETTINGS: Record<string, unknown> = {
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

export interface FeatureScene {
  /** 出力の名前（`new-work` など） */
  name: string;
  /** 表題の副題 */
  subtitle: string;
  workTitle: string;
  episodes: FixtureEpisode[];
  settings?: Record<string, unknown>;
  keybindings?: Record<string, unknown>[];
  prepareWork?: LaunchOptions["prepareWork"];
  /** 左の列を閉じて始めるか（既定 true） */
  closeSidebar?: boolean;
  /** 表題を出している間にやっておく操作（コマンドを走らせるなど） */
  open?: (session: E2ESession) => Promise<void>;
  /** 字幕つきの操作 */
  play: (session: E2ESession, caption: (text: string) => Promise<void>) => Promise<void>;
  /** 偽の Ollama が一覧に出すモデル名（実在の名前にする。省くと偽の既定名が出る） */
  fakeModels?: readonly string[];
  /** 偽の Ollama の答え（既定は "OK"） */
  fakeAnswer?: (request: FakeOllamaRequest) => string;
  /** 起動時の globalState に足すもの */
  globalState?: Record<string, unknown>;
  /** 画面ショットを抜く秒（動画の中） */
  snapAt: number;
}

export async function recordFeature(scene: FeatureScene): Promise<void> {
  await mkdir(RELEASE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const videoDir = path.join(RELEASE_DIR, `raw-${scene.name}`);
  await rm(videoDir, { recursive: true, force: true });
  const png = path.join(OUT_DIR, `${scene.name}.png`);
  const fake = await startFakeOllama(scene.fakeAnswer ?? (() => "OK"), scene.fakeModels ? { listedModels: scene.fakeModels } : {});
  let sceneStartedAt = 0;
  let videoStartedAt = 0;
  let sceneEndedAt = 0;
  try {
    const { videoPath } = await withVsCode(
      `広報・${scene.name}`,
      scene.episodes,
      async (session) => {
        const { page } = session;
        await showTitleCard(page, "統合小説執筆環境", scene.subtitle);
        await resizeWindows(session.app, SIZE);
        await waitUntil(
          async () =>
            (await session.app.evaluate(({ BrowserWindow }) => {
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
        if (scene.closeSidebar !== false) await page.keyboard.press("Control+Alt+Shift+F9");
        if (scene.open) await scene.open(session);
        const shown = Date.now() - sceneStartedAt;
        if (shown < 2_500) await page.waitForTimeout(2_500 - shown);
        await page.mouse.move(1200, 700);
        await dismissWorkbenchHover(page);
        await hideTitleCard(page);
        await scene.play(session, (text) => showCaption(page, text, CAPTION));
        await hideCaption(page);
        await showTitleCard(page, "統合小説執筆環境", "VS Code の拡張機能");
        await page.waitForTimeout(2_700);
        sceneEndedAt = Date.now();
      },
      fakeOllamaLaunch(fake, {
        settings: { ...PROMO_SETTINGS, ...(scene.settings ?? {}) },
        keybindings: [{ key: "ctrl+alt+shift+f9", command: "workbench.action.closeSidebar" }, ...(scene.keybindings ?? [])],
        recordVideo: { dir: videoDir, size: SIZE },
        windowSize: SIZE,
        workTitle: scene.workTitle,
        globalState: { ...(scene.fakeModels ? { "novelai.ai.model": scene.fakeModels[0] } : {}), ...(scene.globalState ?? {}) },
        prepareWork: scene.prepareWork,
      })
    );
    if (!videoPath) throw new Error("動画が録れていません");
    const raw = path.join(RELEASE_DIR, `${scene.name}-raw.webm`);
    await rm(raw, { force: true });
    await rename(videoPath, raw);
    await rm(videoDir, { recursive: true, force: true });
    const start = Math.max(0, (sceneStartedAt - videoStartedAt) / 1000 + 0.4);
    const length = (sceneEndedAt - sceneStartedAt) / 1000 - 0.7;
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) throw new Error(`ffmpeg が無いので変換できません: ${raw}`);
    const mp4 = path.join(OUT_DIR, `${scene.name}.mp4`);
    await toMp4(ffmpegPath, raw, mp4, start, length);
    await new Promise<void>((resolve, reject) =>
      execFile(ffmpegPath, ["-v", "error", "-y", "-ss", String(scene.snapAt), "-i", mp4, "-frames:v", "1", png], (e) => (e ? reject(e) : resolve()))
    );
    const seconds = await durationSeconds(ffmpegPath, mp4);
    process.stdout.write(`[広報] MP4: ${mp4}（${seconds?.toFixed(1)} 秒・${((await stat(mp4)).size / 1048576).toFixed(2)} MB）\n`);
  } finally {
    await fake.close();
  }
}
