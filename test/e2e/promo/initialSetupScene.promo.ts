/**
 * 広報素材：はじめての設定（作者の依頼 2026-10-25 未明）。
 * 入れたばかりの人が最初に見る声かけから、AI をつないで作品を1つ登録し、原稿エディターで開くまで。
 *
 * 流れ：作風診断の声かけ［あとで］→ AI の声かけ［AIを選ぶ］→ Ollama → gemma4:e4b →
 *       作品一覧の案内の［バックアップ取込］（投稿サイトのバックアップから作る。2026-11-14 に
 *       「フォルダー登録」から差し替え。作者の「作品を登録する所が分かりにくい」）→ ZIP を選ぶ →
 *       取り込む中身の確認 → 作品を置く場所 → 作品名 → 作品一覧 → 第1話を開く。
 *       バックアップは台本の中で作る作り物（カクヨムの形の3話。作者の原稿は使わない）。
 *
 * **撮るのは作品を登録する前**（`LaunchOptions.beforeRegister`）。`withVsCode` は本体の前に
 * 作品を登録して知らせを消すので、本体の中では「登録する所」も起動直後の声かけも撮れない。
 * 撮影のあとの土台の登録は、同じフォルダーなので「すでに登録されています」で断られ、1件のまま。
 *
 * **AI の声かけは「どのAIも決まっていない」ときだけ出る**（`features/firstRun.ts`）。偽の Ollama が
 * 起動の時点で応えると出ないので、Ollama の番地は「関所」（下の `startGate`）へ向け、声かけが出るまでは
 * 接続を切り、出たあとで偽の Ollama へ通す。LM Studio は誰も応えない番地へ向ける（firstRunGuide.test.ts と同じ）。
 *
 * **フォルダー選びは簡易の窓にする**（`files.simpleDialog.enable`）。OS の窓は Playwright から読めず、
 * 作者の画面の前面に出るため。簡易の窓には道が写るので、撮るときは一時フォルダーを使用者名の
 * 入らない場所へ向けて走らせる（TEMP を subst したドライブへ）。**その場所は git の置き場の外にする**——
 * 中にあると、登録した作品に「［記録待ち1］」が付き、入れたばかりの人の画面と違ってくる
 * （確認用コピーの下で撮って起きた。2026-10-25）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama が一覧に出すモデル名は実在の名前（作者の裁定、10-22）。
 * 大きさは gemma4:e4b の申告（8.0B）に合わせる——既定の 1B だと「軽量です」の注意が写るため。
 *
 * 走らせ方：`npm run promo:record -- initialSetupScene`
 * 出力：`media/promo/features/initial-setup.mp4` と `initial-setup.png`
 */
import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { waitForManuscriptFrame } from "../support/manuscriptFrame";
import { startFakeOllama } from "../support/fakeOllama";
/**
 * バックアップから新しく作品を作るときの、ファイルを選ぶ窓の題（`features/importWorkFromZip.ts`）。
 * `support/importFlow.ts` の `BACKUP_DIALOG_TITLE` は、登録済みの作品へ話を足すときの別の窓の題
 */
const BACKUP_DIALOG_TITLE = "取り込むバックアップを選ぶ（ZIP／テキスト）";
import { fillInput, waitForQuickInput } from "../support/quickInput";
import { SIDEBAR_LAUNCH, collapseSidebarPane, expandTreeRow, showSidebar, treeRow, treeRowLabels } from "../support/sidebar";
import { withVsCode, type FixtureEpisode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, dismissWorkbenchHover, notificationTexts, pressWorkbenchKey, quickInputWaitContext, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { durationSeconds, findFfmpeg, toMp4 } from "./support/encode";
import { PROMO_SETTINGS } from "./support/featureScene";
import { clickWithCursor, hideCaption, hideTitleCard, parkCursor, showCaption, showTitleCard } from "./support/overlay";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RELEASE_DIR = path.join(repositoryRoot, "release", "promo");
const OUT_DIR = path.join(repositoryRoot, "media", "promo", "features");
const NAME = "initial-setup";
const SIZE = { width: 1280, height: 720 };
/** 字幕は下の真ん中（選ぶ画面は上、知らせは右下なので、どちらにもかからない） */
const CAPTION = { left: "45%", bottom: "9%" };

const WORK_TITLE = "雨の駅";
const EPISODES: FixtureEpisode[] = [
  { name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ホームの時計が、零時を指していた。\n" },
  { name: "002_始発.txt", text: "　始発を待つあいだ、ベンチの端で切符を握りしめていた。\n" },
  { name: "003_改札.txt", text: "　改札の向こうで、駅員がこちらに手を振った。\n" },
];

/**
 * 見せるのは、投稿サイト（カクヨム）のバックアップから作る作品。作者の原稿は使わず、台本の中で作る作り物
 * （カクヨムのバックアップの形：about.txt と、話ごとの episode_NNNN.txt を ZIP に固めたもの。
 * 形は `test/unit/core/workZip.test.ts` の見本と同じ）。
 * 土台の作品（上の WORK_TITLE）は、撮影のあとの登録のために残る（撮影の中では登録されていない）
 */
const IMPORTED_TITLE = "ゆきどけ通りの時計屋";
const BACKUP_NAME = `${IMPORTED_TITLE}.zip`;
const DOWNLOAD_FOLDER_NAME = "ダウンロード";
const encoder = new TextEncoder();
const backupEpisode = (title: string, lines: string[]) => encoder.encode(["【タイトル】", title, "", `【本文（${lines.length}行）】`, ...lines, ""].join("\n"));
const BACKUP_ZIP = zipSync({
  "about.txt": encoder.encode(
    [
      "【タイトル】",
      IMPORTED_TITLE,
      "",
      "【ジャンル】",
      "現代ドラマ",
      "",
      "【キャッチコピー】",
      "止まった時計が、春をつれてくる。",
      "",
      "【紹介文（2行）】",
      "　雪どけの街の小さな時計屋に、ふしぎな客が訪ねてくる。",
      "　時計と人をめぐる、ささやかな連作。",
      "",
      "【タグ】",
      "- 現代ドラマ",
      "- 日常",
      "",
    ].join("\n")
  ),
  "episode_0001.txt": backupEpisode("第1話　春いちばんの客", [
    "　雪どけの朝、ゆきどけ通りの古い時計屋に、小さな客が訪ねてきた。",
    "　「この時計、動かなくなっちゃったの」",
  ]),
  "episode_0002.txt": backupEpisode("第2話　止まった針", [
    "　祖父の形見だという懐中時計の針は、三時十分で止まっていた。",
    "　店主はふたを開け、小さなねじをそっと回した。",
  ]),
  "episode_0003.txt": backupEpisode("第3話　動き出す音", [
    "　かちり、と小さな音がして、秒針が動き出した。",
    "　少女の顔に、ゆっくり笑みが広がっていった。",
  ]),
});

/** 簡易の窓の入力欄の値（いま開いているフォルダーの道）。窓が出ていなければ空 */
async function dialogPath(page: Page): Promise<string> {
  return page.locator(".quick-input-widget input").first().inputValue().catch(() => "");
}

/** 誰も応えない番地（discard のポート） */
const DEAD_ENDPOINT = "http://127.0.0.1:9";

/**
 * 関所：開くまでは来た接続をすぐ切り（Ollama が「動いていない」に見える）、開いたあとは
 * 偽の Ollama へそのまま流す。偽の Ollama の口は `listen(0)` で決まるので、口を替えずに
 * 「あとから起きた」形を作るために挟む
 */
async function startGate(upstreamPort: number): Promise<{ endpoint: string; open: () => void; close: () => Promise<void> }> {
  let opened = false;
  const server: Server = createServer((socket) => {
    if (!opened) {
      socket.destroy();
      return;
    }
    const upstream = connect(upstreamPort, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    open: () => {
      opened = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 右下の知らせのうち、`head` を含むもの */
function toast(page: Page, head: string) {
  return page.locator(".notification-toast", { hasText: head }).first();
}

async function waitToast(page: Page, head: string, label: string, timeoutMs = 90_000): Promise<void> {
  await waitUntil(async () => (await toast(page, head).count()) > 0, label, timeoutMs).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（出ている知らせ：${JSON.stringify(await notificationTexts(page))}）`);
  });
}

/** 選ぶ画面の行（名前に `label` を含むもの） */
function quickPickRow(page: Page, label: string) {
  return page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: label }).first();
}

async function waitRow(page: Page, label: string, what: string): Promise<void> {
  await waitUntil(async () => (await quickPickRow(page, label).count()) > 0, what, 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（行：${JSON.stringify(await quickPickRows(page))}）${await quickInputWaitContext(page)}`);
  });
}

test("はじめての設定の広報素材を撮る", async () => {
  await mkdir(RELEASE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const videoDir = path.join(RELEASE_DIR, `raw-${NAME}`);
  await rm(videoDir, { recursive: true, force: true });
  const png = path.join(OUT_DIR, `${NAME}.png`);

  const fake = await startFakeOllama(() => "OK", {
    // 1つだけにする。偽の Ollama は大きさをどのモデルにも同じ値で申告するので、並べると 26b まで「8.0B」と写る
    listedModels: ["gemma4:e4b"],
    parameterSize: "8.0B",
    contextLength: 131072,
  });
  const gate = await startGate(Number(new URL(fake.endpoint).port));
  let workFolder = "";
  /** バックアップの ZIP を置いたフォルダー（作品とワークスペースの外。作者の「ダウンロード」に当たる） */
  let downloadFolder = "";
  let sceneStartedAt = 0;
  let sceneEndedAt = 0;
  let videoStartedAt = 0;

  const play = async (page: Page): Promise<void> => {
    await showTitleCard(page, "統合小説執筆環境", "はじめての設定 — AIをつないで、作品を登録するまで");
    sceneStartedAt = Date.now();
    // 左の列（エクスプローラー）は英語表記で広報に向かないので閉じる（ほかの場面と同じ）
    await page.keyboard.press("Control+Alt+Shift+F9");
    // 作風診断の声かけは、起動の直後に出る（AI の声かけはこの答えを待ってから出る）
    await waitToast(page, "はじめまして", "作風診断の声かけが出る");
    const shown = Date.now() - sceneStartedAt;
    if (shown < 2_800) await page.waitForTimeout(2_800 - shown);
    await page.mouse.move(1200, 700);
    await dismissWorkbenchHover(page);
    await hideTitleCard(page);

    // 1. 診断の声かけ
    await showCaption(page, "はじめて開くと、右下で声をかけます", CAPTION);
    await page.waitForTimeout(3_200);
    await showCaption(page, "書き方の診断は、あとからでも受けられます", CAPTION);
    await page.waitForTimeout(1_600);
    await clickWithCursor(page, toast(page, "はじめまして").locator(".monaco-button", { hasText: "あとで" }).first(), "診断の声かけの［あとで］");

    // 2. AI の声かけ（ここで関所を開ける：選ぶ画面で Ollama のモデル一覧を引くため）
    await waitToast(page, "小説執筆へようこそ", "AI の声かけが出る", 30_000);
    gate.open();
    await showCaption(page, "続いて、使うAIを選ぶ案内", CAPTION);
    await page.waitForTimeout(3_000);
    await clickWithCursor(page, toast(page, "小説執筆へようこそ").locator(".monaco-button", { hasText: "AIを選ぶ" }).first(), "AI の声かけの［AIを選ぶ］");

    // 3. AI を選ぶ
    await waitForQuickInput(page, "使用するAIを選んでください", 20_000);
    await waitRow(page, "Ollama", "AI の一覧に Ollama が並ぶ");
    await showCaption(page, "手元のAIも、クラウドのAIも選べます", CAPTION);
    await page.waitForTimeout(3_500);
    await showCaption(page, "ここでは手元の Ollama を選ぶと", CAPTION);
    await page.waitForTimeout(1_200);
    await clickWithCursor(page, quickPickRow(page, "Ollama"), "AI の一覧の Ollama");
    await waitForQuickInput(page, "使用するモデルを選んでください", 30_000);
    await waitRow(page, "gemma4:e4b", "モデルの一覧に gemma4:e4b が並ぶ");
    await showCaption(page, "入っているモデルの一覧から選べます", CAPTION);
    await page.waitForTimeout(3_000);
    await clickWithCursor(page, quickPickRow(page, "gemma4:e4b"), "モデルの一覧の gemma4:e4b");
    await waitUntil(async () => (await quickPickTitle(page)) === undefined, "モデルを選ぶと選ぶ画面が閉じる", 20_000);
    await parkCursor(page, SIZE.width * 0.5, SIZE.height * 0.45);
    await showCaption(page, "これで、AIの準備ができました", CAPTION);
    await page.waitForTimeout(3_000);

    // 4. 作品を登録する（投稿サイトのバックアップから。作者2026-11-14「作品を登録する所が分かりにくい」）
    // 作品が1つも無いので、左の列の作品一覧には案内（バックアップ取込・フォルダー登録…）が出る。その［バックアップ取込］を押す
    // 選んだあとに出る「まだ測っていません（AIチューニング）」の知らせは、絵に重なるので閉じる
    await clearNotifications(page);
    await showCaption(page, "すでに投稿サイトで書いているなら、バックアップから始められます", CAPTION);
    await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
    const importButton = page.locator(".welcome-view-content :is(a, .monaco-button)", { hasText: "バックアップ取込" }).first();
    await waitUntil(async () => (await importButton.count()) > 0, "作品一覧の案内に［バックアップ取込］が出る", 20_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（行：${(await treeRowLabels(page)).join(" / ")}）`);
    });
    /*
      作品一覧の区画は低く、案内のボタンが下の区画（簡単ステップメニュー）の見出しに隠れる
      （2026-11-14 の試し撮りで、カーソルの先が見出しに当たって落ちた）。下の区画を畳んで、
      作品一覧に高さを渡してから押す。畳むのは画面に写るが、カーソルは出さない
    */
    for (const pane of ["AIに相談", "簡単ステップメニュー", "詳細メニュー"]) await collapseSidebarPane(page, pane).catch(() => undefined);
    await importButton.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2_000);
    await clickWithCursor(page, importButton, "作品一覧の［バックアップ取込］");

    // 4-1. バックアップのファイルを選ぶ（簡易の窓。ダウンロードのフォルダーを開いて、ZIP を押す）
    await waitForQuickInput(page, BACKUP_DIALOG_TITLE, 20_000);
    await waitUntil(async () => (await dialogPath(page)).length > 0, "ファイルを選ぶ窓の入力欄に道が入る", 10_000);
    await showCaption(page, "サイトから落としたバックアップ（ZIP）を選ぶ", CAPTION);
    await fillInput(page, `${downloadFolder}${path.sep}`);
    await waitRow(page, BACKUP_NAME, `ファイルを選ぶ窓に「${BACKUP_NAME}」が並ぶ`);
    await page.waitForTimeout(1_200);
    await clickWithCursor(page, quickPickRow(page, BACKUP_NAME), `ファイルを選ぶ窓の「${BACKUP_NAME}」`);
    // 簡易の窓は、行を押しただけでは決まらないことがある。題が消えるまで（3回まで）Enter で決める
    for (let attempt = 0; attempt < 3 && ((await quickPickTitle(page)) ?? "").includes(BACKUP_DIALOG_TITLE); attempt++) {
      await page.keyboard.press("Enter");
      await waitUntil(async () => !((await quickPickTitle(page)) ?? "").includes(BACKUP_DIALOG_TITLE), "ファイルを選ぶ窓が閉じる", 3_000).catch(() => undefined);
    }

    // 4-2. 取り込む中身の確かめ（上の選ぶ窓「この内容で作品を作りますか？」。話数と文字数が並ぶ）
    await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("この内容で作品を作りますか"), "取り込む中身の確かめの窓が出る", 30_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（選ぶ窓：${JSON.stringify((await quickPickTitle(page)) ?? null)}／真ん中の窓：${JSON.stringify((await dialogText(page)) ?? null)}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
    });
    await showCaption(page, "話数と文字数を確かめて、取り込む", CAPTION);
    await page.waitForTimeout(3_000);
    await clickWithCursor(
      page,
      page.locator(".quick-input-widget .monaco-list-row", { hasText: "取り込む" }).filter({ hasNotText: "取り込む元" }).first(),
      "確かめの窓の［取り込む］"
    );

    // 4-3. 作品を置く場所（作品が1つも無いので訊かれる。開いたままの場所をそのまま受ける）
    await waitForQuickInput(page, "作品を置く場所を選択", 30_000);
    await showCaption(page, "作品を置く場所を選ぶ", CAPTION);
    await page.waitForTimeout(1_500);
    const place = page.locator(".quick-input-widget .monaco-button", { hasText: "ここに作品を置く" }).first();
    if ((await place.count()) > 0 && (await place.isVisible())) {
      await clickWithCursor(page, place, "［ここに作品を置く］");
    } else {
      await page.keyboard.press("Enter");
    }

    // 4-4. 作品名（バックアップの題が入っている。そのまま受ける）
    await waitUntil(
      async () => ((await page.locator(".quick-input-widget").first().innerText().catch(() => "")) ?? "").includes("作品名を確かめてください"),
      "作品名の入力欄が出る",
      30_000
    );
    await showCaption(page, "作品名を確かめて、決める", CAPTION);
    await page.waitForTimeout(1_800);
    await page.keyboard.press("Enter");
    await waitToast(page, "話を取り込みました", "「取り込みました」の知らせが出る", 60_000);
    await showCaption(page, "話と文字数を数えて、作品として登録します", CAPTION);
    await page.waitForTimeout(1_800);

    // 5. 作品一覧に並び、話を押すと原稿エディターで開く
    await clearNotifications(page);
    await showSidebar(page, IMPORTED_TITLE);
    await expandTreeRow(page, IMPORTED_TITLE);
    await waitUntil(async () => (await treeRow(page, "第1話").count()) > 0, "作品の下に第1話の行が出る").catch(async (error: unknown) => {
      throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
    });
    await showCaption(page, "作品一覧から、話を押して書き始められます", CAPTION);
    await page.waitForTimeout(1_500);
    await clickWithCursor(page, treeRow(page, "第1話"), "作品一覧の第1話");
    await waitForManuscriptFrame(page, "古い時計屋", "第1話が原稿エディターで開く");
    await parkCursor(page, SIZE.width * 0.92, SIZE.height * 0.9);
    await page.waitForTimeout(1_200);
    await showCaption(page, "これで、書き始められます", CAPTION);
    await page.waitForTimeout(2_500);

    await hideCaption(page);
    await showTitleCard(page, "統合小説執筆環境", "VS Code の拡張機能");
    await page.waitForTimeout(2_700);
    sceneEndedAt = Date.now();
  };

  try {
    const { videoPath } = await withVsCode(
      "広報・はじめての設定",
      EPISODES,
      async (session) => {
        // 撮影は登録の前に済んでいる。ここでは録り始めの時刻だけ受け取る
        videoStartedAt = session.videoStartedAt ?? sceneStartedAt;
        expect(sceneEndedAt, "撮影が終わる前に本体へ来ました").toBeGreaterThan(0);
      },
      {
        settings: {
          ...PROMO_SETTINGS,
          ...SIDEBAR_LAUNCH.settings,
          // 「設定しました」と登録の知らせを見せたいので、下の帯は出す
          "workbench.statusBar.visible": true,
          "files.simpleDialog.enable": true,
          "novelai.ollama.endpoint": gate.endpoint,
          "novelai.lmstudio.endpoint": DEAD_ENDPOINT,
        },
        keybindings: [{ key: "ctrl+alt+shift+f9", command: "workbench.action.closeSidebar" }, ...SIDEBAR_LAUNCH.keybindings],
        recordVideo: { dir: videoDir, size: SIZE },
        windowSize: SIZE,
        workTitle: WORK_TITLE,
        // 作品は撮影の中でバックアップから作る。見本の作品まで登録すると2件になる
        skipRegister: true,
        prepareWork: async (folders) => {
          workFolder = folders.workFolder;
          downloadFolder = path.join(path.dirname(path.dirname(folders.workFolder)), DOWNLOAD_FOLDER_NAME);
          await mkdir(downloadFolder, { recursive: true });
          await writeFile(path.join(downloadFolder, BACKUP_NAME), BACKUP_ZIP);
        },
        // 作風診断の声かけは出す（「はじめまして」の印〔novelai.writerWelcome〕は置かない）
        beforeRegister: play,
      }
    );
    expect(workFolder, "作品フォルダーの道を受け取れていません").not.toBe("");
    expect(videoPath, "動画が録れていません").toBeTruthy();
    const raw = path.join(RELEASE_DIR, `${NAME}-raw.webm`);
    await rm(raw, { force: true });
    await rename(videoPath as string, raw);
    await rm(videoDir, { recursive: true, force: true });

    const start = Math.max(0, (sceneStartedAt - videoStartedAt) / 1000 + 0.4);
    const length = (sceneEndedAt - sceneStartedAt) / 1000 - 0.7;
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) throw new Error(`ffmpeg が無いので変換できません: ${raw}`);
    const mp4 = path.join(OUT_DIR, `${NAME}.mp4`);
    await toMp4(ffmpegPath, raw, mp4, start, length);
    // 画面ショットはモデルの一覧の場面から抜く
    await new Promise<void>((resolve, reject) =>
      execFile(ffmpegPath, ["-v", "error", "-y", "-ss", "20", "-i", mp4, "-frames:v", "1", png], (error) => (error ? reject(error) : resolve()))
    );
    const seconds = await durationSeconds(ffmpegPath, mp4);
    process.stdout.write(`[広報] MP4: ${mp4}（${seconds?.toFixed(1)} 秒・${((await stat(mp4)).size / 1048576).toFixed(2)} MB）\n`);
  } finally {
    await gate.close();
    await fake.close();
  }
});
