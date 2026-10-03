/**
 * 広報の動画、場面2「直す」を台本どおりに撮る（設計書6.114）。
 *
 * `npm run promo:record` で走らせる。**`npm run check` にも `test:e2e` にも入れない**
 * ——検査ではなく撮影で、ffmpeg が要り、1回に1分ほどかかる。
 *
 * 画面の自動テストの土台（`test/e2e/support/`）をそのまま使う：本物の VS Code を
 * 画面の外で起こし、一時フォルダーへ作った**見本の作品**を開き、Playwright で押す。
 * 片づけ（テスト用の Code.exe を残さない）も同じ仕組みに乗る。
 *
 * - **作者の原稿・確認用コピーは使わない。** 見本の作品は下の `EPISODES`（広報用の作り物）
 * - **AI は呼ばない。** 校正の指摘は `.aiwriter/findings.jsonl` へ見本を置く。
 *   毎回同じ指摘が出て、撮り直しても同じ絵になる
 * - **字幕は録る側で重ねる**（`support/overlay.ts`）。製品のコードは変えない
 *
 * 出力：
 * - `release/promo/fix-raw.webm`（録ったまま。起動の様子も入っている）
 * - `release/promo/fix.mp4`（X 用。頭を切ったもの）
 * - `media/promo/fix.gif`（Marketplace の説明用）
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { findingId } from "../../../src/models/finding";
import { caretPosition, manuscriptFrames, memoPanelFrame, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { resizeWindows, withVsCode, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications } from "../support/workbenchDom";
import { durationSeconds, findFfmpeg, toGif, toMp4 } from "./support/encode";
import {
  clickWithCursor,
  hideCaption,
  hideCursor,
  hideTitleCard,
  moveCursorTo,
  parkCursor,
  showCaption,
  showCursor,
  showKeyBadge,
  showTitleCard,
  type CaptionPlace,
} from "./support/overlay";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** 録ったままの動画と MP4 の置き場（`.gitignore` の `/release/` の下。repo に入れない） */
const RELEASE_DIR = path.join(repositoryRoot, "release", "promo");
/** GIF の置き場（README から参照するので repo に置く。VSIX には入れない——`.vscodeignore`） */
const MEDIA_DIR = path.join(repositoryRoot, "media", "promo");

/** 動画の画角。窓の中身の大きさと、録画の大きさを揃える（揃えないと縮んで字がぼける） */
const SIZE = { width: 1280, height: 720 };

const EPISODE_1 = "001_雨の駅.txt";
const EPISODE_2 = "002_翌朝.txt";

/**
 * 見本の作品（広報用の作り物）。
 *
 * 1話目に、メモ（`//`）2つと、直す誤字（「以外」→「意外」）を1つ。
 * 2話目に、メモ1つと表記ゆれ（「無い」→「ない」）を1つ。パネルには
 * 話の順・行の順に5件が並ぶ。**メモは指摘の前後に置く**——指摘を直したあと
 * F8 で「次のメモ」へ進む絵にするため
 */
const EPISODES: FixtureEpisode[] = [
  {
    name: EPISODE_1,
    text: [
      "　終電を逃した駅のホームに、雨の音だけが残っていた。",
      "　ミナは傘を持っていない。改札の向こうで、見知らぬ男が手を振っている。",
      "// ここで男の正体を匂わせる一文を足す",
      "　近づいてみると、男は以外にも若かった。",
      "　「待ってたよ」と彼は言った。声に聞き覚えがある。",
      "　ミナは一歩、後ずさった。",
      "// 雨の描写をもう一度入れて、場面を締める",
      "　ホームの時計が、零時を指していた。",
      "",
    ].join("\n"),
  },
  {
    name: EPISODE_2,
    text: [
      "　翌朝、ミナは同じ駅に立っていた。",
      "　昨夜の男の姿は無い。",
      "// 傘の色を第1話と揃える（青）",
      "　ベンチに、見覚えのある傘が立てかけてあった。",
      "",
    ].join("\n"),
  },
];

interface SampleFinding {
  episode: string;
  original: string;
  target: string;
  suggestion: string;
  message: string;
  category: "typo" | "notation";
  label: string;
}

/** 校正の指摘の見本。**どれも本文に一字違わず実在する**（パネルは原文で位置を探し直す） */
const FINDINGS: SampleFinding[] = [
  {
    episode: EPISODE_1,
    original: "男は以外にも若かった。",
    target: "以外",
    suggestion: "意外",
    message: "「思いのほか」の意味なら「意外」です",
    category: "typo",
    label: "誤字脱字",
  },
  {
    episode: EPISODE_2,
    original: "昨夜の男の姿は無い。",
    target: "無い",
    suggestion: "ない",
    message: "ほかの箇所は「ない」と書いています",
    category: "notation",
    label: "表記ゆれ",
  },
];

/** 見本の指摘を、製品が読む形（`.aiwriter/findings.jsonl`。models/finding.ts）で置く */
async function writeSampleFindings(workFolder: string): Promise<void> {
  const lines: string[] = [];
  for (const sample of FINDINGS) {
    const episode = EPISODES.find((candidate) => candidate.name === sample.episode);
    if (!episode) throw new Error(`見本の話がありません: ${sample.episode}`);
    const at = episode.text.indexOf(sample.original);
    if (at < 0) throw new Error(`見本の指摘の原文が本文にありません: ${sample.original}`);
    const file = `本文/${sample.episode}`;
    lines.push(
      JSON.stringify({
        kind: "finding",
        id: findingId(file, sample.original, sample.target, sample.suggestion, sample.category, sample.label),
        // 期限（既定3日）の起点。置くたびに今の時刻にする
        time: new Date().toISOString(),
        file,
        hintLine: episode.text.slice(0, at).split("\n").length,
        original: sample.original,
        target: sample.target,
        suggestion: sample.suggestion,
        before: episode.text.slice(Math.max(0, at - 12), at),
        after: episode.text.slice(at + sample.original.length, at + sample.original.length + 12),
        message: sample.message,
        category: sample.category,
        label: sample.label,
      })
    );
  }
  const folder = path.join(workFolder, ".aiwriter");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "findings.jsonl"), lines.join("\n") + "\n", "utf8");
}

/** 使い捨ての settings.json へ足す見た目（白地・要らない部分を隠す・字を大きく） */
const PROMO_SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": "Default Light Modern",
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.layoutControl.enabled": false,
  "workbench.editor.editorActionsLocation": "hidden",
  // **題の帯を OS の枠に任せる。** VS Code が描く題の帯は窓の中身に入るので録画に写り、
  // 開発中の拡張機能を載せた窓には「[Extension Development Host]」と出てしまう。
  // OS の枠は窓の中身の外なので、録画には写らない
  "window.titleBarStyle": "native",
  "window.commandCenter": false,
  "window.menuBarVisibility": "hidden",
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  // 1段ぶん大きく（約120%）。1280×720 の動画で字が読めるように
  "window.zoomLevel": 1,
};

/** 左の列（エクスプローラー）を閉じるキー。設定では閉じた状態で起こせない */
const CLOSE_SIDEBAR_KEY = "ctrl+alt+shift+f9";
const CLOSE_SIDEBAR_PRESS = "Control+Alt+Shift+F9";

/**
 * 見せる間を取る。
 *
 * 画面の自動テストでは固定の待ちを使わない（`support/wait.ts`）が、ここは**見ている人に
 * 読ませるための間**で、待つ相手は画面の状態ではない。状態を待つ所は `waitUntil` を使う
 */
function hold(page: Page, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

/** 組んで書く面で `needle` を選ぶ（打ち直す絵のため） */
async function selectText(frame: Frame, needle: string): Promise<void> {
  const ok = await frame.evaluate((text) => {
    const compose = document.getElementById("compose");
    if (!compose) return false;
    compose.focus();
    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    }
    return false;
  }, needle);
  if (!ok) throw new Error(`組んで書く面に「${needle}」が見つからず、選べません`);
}

/**
 * 窓の中身の大きさ（Electron の `getContentSize`。表示倍率や画面の拡大率に左右されない単位）。
 * 録画は中身を縦横比を保って 1280×720 へ縮めるので、**比が 16:9 からずれると帯が出る**
 */
async function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const [width, height] = win.getContentSize();
      return { width, height };
    }
    return { width: 0, height: 0 };
  });
}

/**
 * 字幕の帯の置き場：左の原稿エディターの真ん中、本文の下の空いた所。
 * 下の真ん中だと、原稿エディターの下のボタン（「最新話を書く」「保存」）にかかった。
 * 見本の本文は8行で、帯の高さまでは届かない
 */
const CAPTION_PLACE: CaptionPlace = { left: "25%", bottom: "16%" };

/**
 * 描いたカーソルの置き場（窓の幅・高さに対する割合）。キー操作のあいだはここへ退かす。
 * 右のパネルの下の空いた所——指摘の行にも、本文にも、字幕にも、右上のキーの札にもかからない
 */
const CURSOR_PARK = { x: 0.9, y: 0.93 };

/** 割合で指した点を、ワークベンチの文書の座標（Playwright と重ねる要素が使う単位）へ */
async function viewportPoint(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((at) => ({ x: Math.round(window.innerWidth * at.x), y: Math.round(window.innerHeight * at.y) }), at);
}

/**
 * 組んで書く面の `needle` の真ん中を、ワークベンチの文書の座標で返す（カーソルを字の上へ運ぶため）。
 * 原稿エディターは WebView の iframe の中なので、字の位置（iframe の中の座標）に、
 * iframe の左上（`frameElement().boundingBox()`。Playwright は入れ子でも一番外の座標で返す）を足す
 */
async function textCenter(frame: Frame, needle: string): Promise<{ x: number; y: number }> {
  const inner = await frame.evaluate((text) => {
    const compose = document.getElementById("compose");
    if (!compose) return undefined;
    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return undefined;
  }, needle);
  if (!inner) throw new Error(`組んで書く面に「${needle}」が見つかりません`);
  const box = await (await frame.frameElement()).boundingBox();
  if (!box) throw new Error("原稿エディターの枠の位置が取れません");
  return { x: box.x + inner.x, y: box.y + inner.y };
}

/** 原稿エディターのカーソルが、`text` を含む行へ来るまで待つ */
async function waitCaretOnLine(page: Page, text: string, label: string): Promise<void> {
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if (((await caretPosition(frame))?.lineText ?? "").includes(text)) return true;
      }
      return false;
    },
    label,
    15_000
  );
}

test("場面2「直す」を撮る", async () => {
  await mkdir(RELEASE_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  const videoDir = path.join(RELEASE_DIR, "raw");
  await rm(videoDir, { recursive: true, force: true });

  let videoStartedAt = 0;
  let sceneStartedAt = 0;
  let sceneEndedAt = 0;
  /** 見せ場の時刻（場面の頭から）。撮ったあと、カーソルと星が写ったこまを抜いて確かめるため */
  const marks: { label: string; ms: number }[] = [];

  const { videoPath } = await withVsCode(
    "広報・直す",
    EPISODES,
    async (session) => {
      const { page } = session;
      // **まず白い表題で覆う。** その下で、話を開く・パネルを出すなどの段取りを済ませる
      // （起動と作品の登録の様子は、あとで ffmpeg で切り落とす）
      await showTitleCard(page, "統合小説執筆環境", "直す — メモと校正の指摘を、話の順に");
      // **大きさを合わせ直す。** 起動の直後に合わせても、VS Code が窓を組み直して縦が
      // 少し伸びることがある（1280×762 になり、録画では縮められて右に灰色の帯が出た）
      await resizeWindows(session.app, SIZE);
      await waitUntil(
        async () => {
          const actual = await contentSize(session.app);
          return actual.width === SIZE.width && actual.height === SIZE.height;
        },
        `窓の中身が ${SIZE.width}×${SIZE.height} になる`,
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いま ${JSON.stringify(await contentSize(session.app))}）`);
      });
      sceneStartedAt = Date.now();
      videoStartedAt = session.videoStartedAt ?? sceneStartedAt;

      await writeSampleFindings(session.workFolder);
      await page.keyboard.press(CLOSE_SIDEBAR_PRESS);
      const frame = await openEpisode(page, EPISODE_1, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      await page.keyboard.press("Control+Alt+KeyM");
      let panel: Frame | undefined;
      await waitUntil(
        async () => {
          panel = await memoPanelFrame(page);
          return panel !== undefined && (await panel.locator("button.go").count()) >= 5;
        },
        "校正・メモパネルにメモ3件と指摘2件が並ぶ",
        30_000
      );
      if (!panel) throw new Error("校正・メモパネルが見つかりません");
      const memoPanel = panel;
      await clearNotifications(page);
      // カーソルを本文の頭へ戻しておく（パネルを開いた操作で焦点が右へ移っている）
      await placeCaretAfter(frame, "終電を逃した");
      // マウスは原稿の空いた所（本文の下）へ。メモの行の上に残ると、メモの吹き出しが写る
      await page.mouse.move(320, 600);
      // 描いた矢印は、表題の下で先に置いておく（表題が薄れるのと一緒に見えてくる）
      const park = await viewportPoint(page, CURSOR_PARK);
      await showCursor(page, park.x, park.y);
      const mark = (label: string) => marks.push({ label, ms: Date.now() - sceneStartedAt });

      // 表題は2.5秒は見せる
      const shown = Date.now() - sceneStartedAt;
      if (shown < 2_500) await hold(page, 2_500 - shown);
      await hideTitleCard(page);

      // 1. 一覧
      await showCaption(page, "メモと校正の指摘を、話の順に一覧", CAPTION_PLACE);
      await hold(page, 5_500);

      // 2. 押すと、その行へ
      const row = memoPanel.locator("button.go", { hasText: "以外" }).first();
      await showCaption(page, "押すと、その行へ", CAPTION_PLACE);
      await hold(page, 700);
      mark("パネルの行へカーソルが動き始める");
      await clickWithCursor(page, row);
      mark("パネルの行を押した（星）");
      // 押したあと、本当のマウスは原稿の空いた所へ逃がす。パネルの上に残ると、行が並び替わった
      // あとに別の行がなぞられた（下線の）ままに写る。描いた矢印は押した所に残す
      await page.mouse.move(320, 600);
      await waitCaretOnLine(page, "以外", "原稿エディターのカーソルが誤字の行へ動く");
      await hold(page, 3_400);

      // 3. 打ち直す
      await showCaption(page, "誤字を、その場で打ち直す", CAPTION_PLACE);
      await hold(page, 600);
      const typo = await textCenter(frame, "以外");
      mark("誤字の上へカーソルが動き始める");
      await moveCursorTo(page, typo.x, typo.y);
      mark("誤字の上にカーソル");
      await hold(page, 300);
      await selectText(frame, "以外");
      await hold(page, 500);
      // 字を打つあいだは、矢印を邪魔にならない所へ退かす
      await parkCursor(page, park.x, park.y);
      for (const char of "意外") {
        await page.keyboard.insertText(char);
        await hold(page, 360);
      }
      await page.keyboard.press("Control+KeyS");
      const file = path.join(session.manuscriptFolder, EPISODE_1);
      await waitUntil(
        async () => (await readFile(file, "utf8")).includes("男は意外にも若かった"),
        "打ち直した字がファイルに入る"
      );
      await hold(page, 1_500);
      // 直した指摘は、保存すると一覧から消える（原文が本文に無くなるため）
      await waitUntil(
        async () => (await memoPanel.locator("button.go", { hasText: "以外" }).count()) === 0,
        "直した指摘が一覧から消える"
      );
      await showCaption(page, "直した指摘は、一覧から消える", CAPTION_PLACE);
      await hold(page, 3_600);

      // 4. F8 で次のメモへ
      await showCaption(page, "F8 で、次のメモへ", CAPTION_PLACE);
      await hold(page, 900);
      await showKeyBadge(page, "F8");
      await page.keyboard.press("F8");
      await waitCaretOnLine(page, "雨の描写", "F8 で次のメモの行へ動く");
      await hold(page, 4_000);

      // 結び
      await hideCaption(page);
      await showTitleCard(page, "統合小説執筆環境", "VS Code の拡張機能");
      await hideCursor(page);
      await hold(page, 2_700);
      // ここで切る。このあと窓を閉じる途中のこま（大きさが崩れる）を動画に入れない
      sceneEndedAt = Date.now();
    },
    {
      settings: PROMO_SETTINGS,
      keybindings: [{ key: CLOSE_SIDEBAR_KEY, command: "workbench.action.closeSidebar" }],
      recordVideo: { dir: videoDir, size: SIZE },
      windowSize: SIZE,
      // パネルの見出し（「校正・メモパネル：雨の駅」）に写る
      workTitle: "雨の駅",
    }
  );

  expect(videoPath, "動画が録れていません").toBeTruthy();
  const raw = path.join(RELEASE_DIR, "fix-raw.webm");
  await rm(raw, { force: true });
  await rename(videoPath as string, raw);
  await rm(videoDir, { recursive: true, force: true });

  // 録り始めから表題を出したところまでを切る。録り始めの時刻は窓が開いた直後に取った
  // 近い値なので、表題の中へ0.4秒入った所から始める（ずれても表題の白の中に収まる）
  const startSeconds = Math.max(0, (sceneStartedAt - videoStartedAt) / 1000 + 0.4);
  // 結びの表題の中で終える（同じずれを見込んで、0.3秒手前で切る）
  const lengthSeconds = (sceneEndedAt - sceneStartedAt) / 1000 - 0.7;

  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) {
    console.error(`[広報] ffmpeg が見つからないので、変換を飛ばしました。録ったまま: ${raw}`);
    console.error(`[広報] 頭を切る位置: ${startSeconds.toFixed(2)} 秒`);
    return;
  }
  const mp4 = path.join(RELEASE_DIR, "fix.mp4");
  const gif = path.join(MEDIA_DIR, "fix.gif");
  await toMp4(ffmpegPath, raw, mp4, startSeconds, lengthSeconds);
  const gifInfo = await toGif(ffmpegPath, mp4, gif);
  const seconds = await durationSeconds(ffmpegPath, mp4);
  const megabytes = async (file: string) => ((await stat(file)).size / 1024 / 1024).toFixed(2);
  // console.log は vitest が預かって出さないことがあるので、直に書き出す
  process.stdout.write(
    [
      `[広報] 頭を切った位置: ${startSeconds.toFixed(2)} 秒`,
      `[広報] MP4: ${mp4}（${seconds?.toFixed(1) ?? "?"} 秒・${await megabytes(mp4)} MB）`,
      `[広報] GIF: ${gif}（${gifInfo.fps}fps・幅${gifInfo.width}px・${await megabytes(gif)} MB）`,
      // MP4 は場面の頭から 0.4 秒内側で始まるので、その分を引いた時刻（こまを抜くときに使う）
      ...marks.map((m) => `[広報] MP4 の ${Math.max(0, m.ms / 1000 - 0.4).toFixed(2)} 秒: ${m.label}`),
    ].join("\n") + "\n"
  );
});
