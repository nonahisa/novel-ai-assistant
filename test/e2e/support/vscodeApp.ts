/**
 * 画面の自動テスト（E2E）の土台：本物の VS Code を起こして、作り物の作品を開く（設計書6.113）。
 *
 * **作者が開発ホストで押して確かめていたこと**（新しいキー・2枚目が開かない・
 * 表示倍率・右クリックの名前）を、機械で毎回見張るためのもの。
 * 拡張機能ホストの中から叩く統合テスト（`npm run test:integration`）では
 * **画面（WebView）の中を押せない**ので、外から Playwright の Electron モードで
 * VS Code そのものを動かす。
 *
 * - **新しい道具は足さない。** `playwright-core` は `@vscode/test-web` の連れとして
 *   既に入っている（`npm run test:web` が使う）。テスト用の VS Code も
 *   統合テストと同じ `.vscode-test/` のものを使い、無ければ同じ関数で取り寄せる
 * - **作者の原稿には触らない。** 作品は一時フォルダーへ毎回作り、終わったら消す
 * - **起こした VS Code は必ず止める。** 失敗・時間切れ・途中で止めたときも残さない
 *   （`cleanup.ts`。1件ごとの片づけと、走りの最初と最後の片づけの2段）
 * - **1件ごとに作品も VS Code も作り直す。** 遅くても、前の件の残り（開いたタブ・
 *   保管庫の札）に引きずられないほうを取る
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { recordLaunch, stopLaunch } from "./cleanup";
import { waitUntil } from "./wait";
import { CLEAR_NOTIFICATIONS_KEY, clearNotifications, closeDialog, dialogText } from "./workbenchDom";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * どの版の VS Code で回すか。**既定は 1.141.0**（作者の VS Code と同じ版。2026-10-10）。
 *
 * 統合テストの既定（対応の下限の 1.90.0）と違えたのは、ここで見張るのが
 * **作者がいま使っている VS Code の画面の動き**（タブの列・WebView の作り直し）
 * だからである。1.90 で通っても、作者の画面で2枚目ができては意味が無い。
 * 環境変数 `NOVELAI_E2E_VSCODE` で替えられる（`VSCODE_` で始めない——
 * 起動の前に `VSCODE_*` を全部落とすため）。前の既定 1.138.0 で回すなら
 * `NOVELAI_E2E_VSCODE=1.138.0`。
 *
 * 1.138.0 から上げたのは、拡張機能ホストの再起動をまたぐ件（`hostRestartDisconnect.test.ts`）の
 * ため。1.138 では再起動すると「拡張機能の出したエディターが閉じる」確かめが出て、押すと
 * 原稿のタブが閉じたが、作者の 1.141.0 ではタブが残った（2026-10-10）。**上げた時点では
 * 1.141.0 で全件を走らせていない**——部品の冒頭の「確かめた版」は 1.138.0 のまま残す
 * （走らせて通ったら書き換える）。`.vscode-test/` に無ければ初回に取り寄せる
 */
export const E2E_VSCODE_VERSION = process.env.NOVELAI_E2E_VSCODE || "1.141.0";

/**
 * 作品を登録するためのキー。**製品のキーと重ならない組み合わせ**にする。
 *
 * 作品の登録（`novelai.addWork`）は、作者が押すとフォルダーを選ぶ画面
 * （OS のダイアログ）が出て、Playwright からは押せない。ブラウザ版の実動テストと
 * 同じく「場所と作品名を引数で渡す道」（設計書5.8.13）を使い、その引数を
 * **使い捨ての keybindings.json に書いたキー**から渡す。製品のコードに
 * テスト専用の口を足さずに済む。
 */
const REGISTER_WORK_KEY = "ctrl+alt+shift+f12";
/** 同じキーの Playwright での書き方（VS Code と名前の付け方が違う） */
const REGISTER_WORK_PRESS = "Control+Alt+Shift+F12";

/**
 * 「版を表示」のキー。拡張機能を起こすのと、登録簿の読み返しに使う
 * （知らせに、登録簿から引いた作品名が添えられる）。
 */
const SHOW_VERSION_KEY = "ctrl+alt+shift+f10";
const SHOW_VERSION_PRESS = "Control+Alt+Shift+F10";

/** 作り物の作品の題（作者の作品と取り違えない名前にする） */
export const E2E_WORK_TITLE = "画面テストの作品";

export interface FixtureEpisode {
  /** 本文フォルダーの中のファイル名 */
  name: string;
  text: string;
}

export interface E2ESession {
  app: ElectronApplication;
  page: Page;
  /** 一時フォルダーの根（作品・user-data・写真をすべてこの下に置く） */
  root: string;
  /** 作品フォルダー */
  workFolder: string;
  /** 本文フォルダー */
  manuscriptFolder: string;
  /**
   * 録画を始めたとみなす時刻（`Date.now()`。録画するときだけ）。
   * 窓が開いた直後に取るので、本当の録り始めとは1秒足らずずれることがある
   */
  videoStartedAt?: number;
}

/**
 * 起こし方の追加の指定。**どれも省けば、画面の自動テストの既定のまま**
 * （広報の動画を撮る台本 `test/e2e/promo/` が使う。設計書6.114）。
 */
export interface LaunchOptions {
  /** 使い捨ての settings.json へ足す（同じ名前は上書き） */
  settings?: Record<string, unknown>;
  /** 使い捨ての keybindings.json へ足す行 */
  keybindings?: readonly Record<string, unknown>[];
  /**
   * 録画する（Playwright の `recordVideo`）。**`dir` は一時フォルダーの外にする**
   * ——片づけで一時フォルダーごと消えるため
   */
  recordVideo?: { dir: string; size: { width: number; height: number } };
  /** 窓の中身の大きさを固定する（録画の画角を揃えるため） */
  windowSize?: { width: number; height: number };
  /** 作品の題（既定は `E2E_WORK_TITLE`）。動画ではパネルの見出しに写る */
  workTitle?: string;
  /**
   * この拡張機能の globalState へ、起こす前に置く値（鍵 → 値）。
   *
   * **AIの選択（`novelai.ai.provider`・`novelai.ai.model`）は globalState にしか無く**、
   * コマンドの引数で選ばせる道も無い（選ぶのはウィザードだけで、モデル一覧を
   * 引く通信を伴う）。キャッシュだけで済む抽出のように「AIは選ばれているが
   * 呼ばない」状態を作るには、VS Code が読む置き場（下の `seedGlobalState`）へ
   * 先に書いておくしかない。製品にテスト専用の口を足さずに済む
   */
  globalState?: Record<string, unknown>;
  /**
   * 作品フォルダーへ、**起こす前に**ファイルを置く（話の本文を置いたあとに呼ぶ）。
   *
   * 起きている VS Code の下で設定資料を書くと、見張り（`features/watchSettings.ts`）が
   * 「拡張機能の外で変更されました」の知らせを出す。知らせ自体は止めないが、出る時機が
   * 揺れて、その間に送ったキーが届かないことがあった（2026-10-03）。起こす前に置けば、
   * 見張りが張られる前なので知らせは出ない
   */
  prepareWork?: (folders: { workFolder: string; manuscriptFolder: string }) => Promise<void>;
}

/** package.json の `publisher.name`。globalState はこの名前の行に1つの JSON で入る */
const EXTENSION_ID = "nonahisa.novel-ai-assistant";

/**
 * VS Code の globalState の置き場（`User/globalStorage/state.vscdb`。SQLite）へ、
 * この拡張機能の値を書く。**起こす前に呼ぶ**（起きている VS Code は手元の写しを
 * 持っていて、あとから書いても読み直さない）。
 *
 * 表の形は VS Code が作るものと同じ（`ItemTable(key, value)`）。VS Code は
 * `CREATE TABLE IF NOT EXISTS` で開くので、先に作ってあっても壊さない。
 * `node:sqlite` は Node 24 の標準（新しい道具は足さない）。動的に読むのは、
 * これを使わない件で読み込みの警告を出さないため
 */
async function seedGlobalState(userData: string, values: Record<string, unknown>): Promise<void> {
  const folder = path.join(userData, "User", "globalStorage");
  await mkdir(folder, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(folder, "state.vscdb"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(EXTENSION_ID, JSON.stringify(values));
  } finally {
    db.close();
  }
}

/** 開き直し（`restartVsCode`）のために控える、起こしたときの引数（一時フォルダーの根で引く） */
const relaunchContexts = new Map<
  string,
  { executablePath: string; args: string[]; windowSize?: { width: number; height: number } }
>();

/**
 * 作品を一時フォルダーへ作り、VS Code を起こして作品を登録するところまで。
 * 呼び手は `withVsCode` を使う（片づけと失敗時の写真を引き受けるため）。
 */
async function launch(episodes: readonly FixtureEpisode[], options: LaunchOptions = {}): Promise<E2ESession> {
  const root = await mkdtemp(path.join(tmpdir(), "novelai-e2e-"));
  // **起こす前に台帳へ載せる。** 起動の途中で時間切れになっても、走りの最後の
  // 片づけ（globalSetup）が引数の一時フォルダー名で拾って止める
  await recordLaunch({ root });
  // 書庫の形（書庫の中に作品が1つ）。作品フォルダーそのものを開くと、
  // 本文フォルダーが作品に見えて「作品か書庫か」を訊かれることがある
  const library = path.join(root, "書庫");
  const workTitle = options.workTitle ?? E2E_WORK_TITLE;
  const workFolder = path.join(library, workTitle);
  const manuscriptFolder = path.join(workFolder, "本文");
  await mkdir(manuscriptFolder, { recursive: true });
  for (const episode of episodes) {
    await writeFile(path.join(manuscriptFolder, episode.name), episode.text, "utf8");
  }
  if (options.prepareWork) await options.prepareWork({ workFolder, manuscriptFolder });

  const userData = path.join(root, "user-data");
  await mkdir(path.join(userData, "User"), { recursive: true });
  await writeFile(
    path.join(userData, "User", "settings.json"),
    JSON.stringify(
      {
        // **原稿は横書きの原稿エディターで開く**（作者の既定と同じ入口）。
        // 拡張機能の側は `priority: "option"` なので、関連付けで選ばせる
        "workbench.editorAssociations": {
          "*.txt": "novelai.manuscriptEditorHorizontal",
          "*.md": "novelai.manuscriptEditorHorizontal",
        },
        // 起動のたびに出る画面・知らせを止める（焦点を奪われると打鍵が迷子になる）
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "workbench.enableExperiments": false,
        "security.workspace.trust.enabled": false,
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "telemetry.telemetryLevel": "off",
        "chat.disableAIFeatures": true,
        // 右の補助の列（チャット）を最初から開かない。列の数え方が揺れる
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        // **Ctrl+S で保存したことを確かめる**ので、自動保存は切る
        "files.autoSave": "off",
        // 仮のタブ（斜体）は、次に開いたものと入れ替わってタブの数え方が揺れる
        "workbench.editor.enablePreview": false,
        "window.restoreWindows": "none",
        // 確認の画面（モーダル）を OS のダイアログでなく VS Code の中に描かせる。
        // OS のダイアログは Playwright から読めず、作者の画面の前面にも出てしまう
        "window.dialogStyle": "custom",
        ...options.settings,
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(userData, "User", "keybindings.json"),
    JSON.stringify(
      [
        {
          key: REGISTER_WORK_KEY,
          command: "novelai.addWork",
          args: { folderPath: workFolder, title: workTitle },
        },
        { key: SHOW_VERSION_KEY, command: "novelai.showVersion" },
        { key: CLEAR_NOTIFICATIONS_KEY, command: "notifications.clearAll" },
        ...(options.keybindings ?? []),
      ],
      null,
      2
    ),
    "utf8"
  );
  if (options.globalState) await seedGlobalState(userData, options.globalState);

  const executablePath = await downloadAndUnzipVSCode({
    version: E2E_VSCODE_VERSION,
    cachePath: path.join(repositoryRoot, ".vscode-test"),
  });

  const args = [
      // **開く場所は先頭に置く。** VS Code の引数の読み方では、知らない名前の旗
      // （下の `--disable-renderer-backgrounding` など）のすぐ後ろの語は、
      // その旗の値として食われる（実際に書庫が開かれず、空の窓になった）
      library,
      `--extensionDevelopmentPath=${repositoryRoot}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(root, "extensions")}`,
      // `--disable-extensions` は付けない。拡張機能の置き場は空の一時フォルダーなので
      // ほかの拡張機能は入っておらず、付けると「拡張機能を止めています」の知らせが
      // 右下に出て、押す場所を塞ぐ
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--new-window",
      // 窓が画面の外や裏にあっても、描くのと時計を止めさせない（下の keepOutOfTheWay）。
      // Windows は「隠れた窓」を見分けて描くのをやめるので、WebView の中が更新されなくなる
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
  ];
  // 開き直し（`restartVsCode`）が同じ引数で起こせるよう控える
  relaunchContexts.set(root, { executablePath, args, windowSize: options.windowSize ?? windowSizeFromEnv() });

  const app = await _electron.launch({
    executablePath,
    args,
    env: cleanEnv(),
    timeout: 60_000,
    ...(options.recordVideo ? { recordVideo: options.recordVideo } : {}),
  }).catch(async (error: unknown) => {
    await stopLaunch({ root });
    throw error;
  });
  const pid = app.process().pid;
  if (pid !== undefined) await recordLaunch({ root, pid });

  let page: Page | undefined;
  let videoStartedAt: number | undefined;
  const session = (): E2ESession => {
    if (!page) throw new Error("VS Code の窓がまだ開いていません");
    return { app, page, root, workFolder, manuscriptFolder, videoStartedAt };
  };
  try {
    await keepOutOfTheWay(app);
    page = await app.firstWindow();
    if (options.recordVideo) videoStartedAt = Date.now();
    // 窓が裏にあっても、画面の中では「焦点がある」として振る舞わせる（下の説明）
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // ワークベンチが組み上がるまで待つ（ここまでは拡張機能と関係が無い）
    await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
    await keepOutOfTheWay(app);
    const windowSize = options.windowSize ?? windowSizeFromEnv();
    if (windowSize) await resizeWindows(app, windowSize);
    await registerWork(session(), workTitle);
  } catch (error) {
    // 呼び手（withVsCode）の片づけはまだ始まっていないので、ここで写真を残して閉じる
    const shot = page ? await saveScreenshot(page, "起動と作品の登録") : undefined;
    if (shot && error instanceof Error) error.message += `\n画面の写真: ${shot}`;
    await closeAndStop(app, { root, pid });
    throw error;
  }
  return session();
}

/**
 * 閉じて、**残ったものをプロセスの木ごと止め**、一時フォルダーを消す。
 * `app.close()` は VS Code が応えないと戻らないことがあるので、待つのは20秒まで
 */
async function closeAndStop(app: ElectronApplication, entry: { root: string; pid?: number }): Promise<void> {
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  await stopLaunch(entry);
}

/**
 * VS Code の窓を閉じて、**同じ一時フォルダー・同じ引数で起こし直す**（作者が VS Code を
 * 閉じて開き直したのと同じ。拡張機能ホストも作り直される）。
 *
 * 作品・設定・globalState（`user-data`）は一時フォルダーに残るので、「開き直したあとも覚えているか」
 * を見られる。**起こし直したあとは `session.app`・`session.page` が新しいものに替わる**
 * （前の `page` や面は使えない）。登録は済んでいるので、やり直さない。
 */
export async function restartVsCode(session: E2ESession): Promise<void> {
  const context = relaunchContexts.get(session.root);
  if (!context) throw new Error("開き直しの控えがありません（withVsCode の外では使えません）");
  const old = session.app;
  // 閉じたあとは `process()` が読めないので、先に掴んでおく
  const oldProcess = old.process();
  await Promise.race([old.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  // 閉じきれなかった分は止める（一時フォルダーは消さない）
  if (oldProcess.exitCode === null) oldProcess.kill();
  const app = await _electron.launch({ executablePath: context.executablePath, args: context.args, env: cleanEnv(), timeout: 60_000 });
  const pid = app.process().pid;
  if (pid !== undefined) await recordLaunch({ root: session.root, pid });
  await keepOutOfTheWay(app);
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
  await keepOutOfTheWay(app);
  if (context.windowSize) await resizeWindows(app, context.windowSize);
  session.app = app;
  session.page = page;
  // 起動のときの案内などが残っていれば閉じる
  await clearNotifications(page);
}

/**
 * **テスト用の窓が、作者の前面を取らないようにする**（2026-10-03、作者が同じ機械で
 * 作業しながら走らせるため）。
 *
 * - **入力は Playwright の合図（Chrome DevTools Protocol）で送る。** 本物のマウス・
 *   キーボード（OS への入力の注入）は使わないので、窓が前に無くても届く
 * - 窓は**画面の外へ置き**、`show`・`focus` を「焦点を取らずに出す」へ差し替える
 *   （Electron の本体側へ `evaluate` で入れる）。起動の直後に一瞬だけ見えることはある
 *   ——窓を作る前に差し替えが間に合うかは、Playwright が本体へ繋がる時機しだい
 * - 窓に焦点が無いと、画面の中の `document.hasFocus()` が偽になり、VS Code の
 *   「どこに焦点があるか」の判定（キー割り当ての when）が狂う。そこで
 *   `Emulation.setFocusEmulationEnabled` で「焦点がある」として振る舞わせる
 *
 * 窓を見ながら直したいときは、環境変数 `NOVELAI_E2E_SHOW=1` で差し替えを止める。
 */
async function keepOutOfTheWay(app: ElectronApplication): Promise<void> {
  if (process.env.NOVELAI_E2E_SHOW === "1") return;
  /*
    **1回目が「結果が回収された（garbage collected）」で落ちることがある**
    （起動の直後、本体側の準備が終わる前）。窓を外へ置くのは検査の中身では
    ないので、2回まで試し、それでも駄目なら窓が見えたまま続ける
  */
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await moveWindowsAway(app);
      return;
    } catch (error) {
      if (attempt === 2) console.error(`[E2E] 窓を画面の外へ置けませんでした: ${String(error)}`);
    }
  }
}

async function moveWindowsAway(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, app: electronApp }) => {
    // **一度だけ差し替える**（2回目以降は窓を外へ置き直すだけ）
    const marker = "__novelaiE2EPatched";
    const proto = BrowserWindow.prototype as unknown as Record<string, unknown>;
    const away = (win: InstanceType<typeof BrowserWindow>) => {
      if (win.isDestroyed()) return;
      win.setPosition(-20000, -20000);
      // タスクバーにも並べない（作者の Alt+Tab・タスクバーに紛れ込ませない）
      win.setSkipTaskbar(true);
      win.webContents.setBackgroundThrottling(false);
      // 差し替えが間に合わず焦点を取っていたら、手放す（前にいた窓へ焦点が戻る）
      if (win.isFocused()) win.blur();
    };
    if (!proto[marker]) {
      proto[marker] = true;
      const showInactive = BrowserWindow.prototype.showInactive;
      BrowserWindow.prototype.show = function (this: InstanceType<typeof BrowserWindow>) {
        away(this);
        showInactive.call(this);
      };
      BrowserWindow.prototype.focus = function () {
        // 焦点を取りに行かない（作者がいま使っている窓から奪わない）
      };
      BrowserWindow.prototype.moveTop = function () {};
      // VS Code は窓の位置を覚えて置き直すので、動いたら外へ戻す
      const created = (_event: unknown, win: InstanceType<typeof BrowserWindow>) => {
        away(win);
        win.on("move", () => {
          const [x, y] = win.getPosition();
          if (x > -10000 || y > -10000) away(win);
        });
      };
      electronApp.on("browser-window-created", created);
    }
    for (const win of BrowserWindow.getAllWindows()) away(win);
  });
}

/**
 * 環境変数 `NOVELAI_E2E_WINDOW`（例 `1024x640`）で、全件の窓の中身の大きさを決める。
 *
 * 指定が無ければ VS Code の既定の大きさ（**機械の画面で変わる**）で起きる。ノートPCの
 * 狭い窓でだけ、本体の吹き出しが隣の列のボタンに重なって押せない落ち方があった
 * （2026-10-04。こちらの機械では 1434×897 で起き、重ならずに通っていた）。
 * 狭い窓の落ち方を手元で写すために使う。テストごとの `windowSize` が先に効く
 */
function windowSizeFromEnv(): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/.exec(process.env.NOVELAI_E2E_WINDOW ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

/**
 * 窓の**中身**の大きさを固定する（録画の画角。枠や題の帯の厚みに左右されないよう
 * `setContentSize` を使う）。位置には触らないので、上の「外へ置き直す」とぶつからない
 */
export async function resizeWindows(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  /*
    **頼んだ大きさにならないことがある。** 画面の外（-20000）に置いた窓へ
    `setContentSize(1280, 720)` を頼むと、1302×776 になった（2026-10-03。画面の
    拡大率が違う2枚の画面がある機械で）。そこで、なった大きさを測り、ずれの分だけ
    頼む値を足し引きして、何度か合わせ直す
  */
  await app.evaluate(({ BrowserWindow }, wanted) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (win.isMaximized()) win.unmaximize();
      let ask = { ...wanted };
      for (let attempt = 0; attempt < 6; attempt++) {
        win.setContentSize(ask.width, ask.height);
        const [width, height] = win.getContentSize();
        if (width === wanted.width && height === wanted.height) break;
        ask = { width: ask.width + (wanted.width - width), height: ask.height + (wanted.height - height) };
      }
    }
  }, size);
}

/**
 * **`ELECTRON_RUN_AS_NODE` を外した環境。** VS Code のターミナルから走らせると
 * 親から引き継ぎ、起こした `Code.exe` が Electron ではなく Node として立ち上がって
 * 即終了する（統合テスト・ブラウザ版テストと同じ罠。実際に踏んでいる）。
 * 他の `VSCODE_*` も、親のウィンドウへ繋ぎに行かせないために落とす。
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("VSCODE_")) continue;
    env[name] = value;
  }
  return env;
}

/**
 * 「版を表示」を押して、確認の画面の文を読んで閉じる。
 * 拡張機能がまだ起きていなければ（画面が出なければ）押し直す。
 */
async function readVersionDialog(page: Page, label: string, timeoutMs = 60_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await page.keyboard.press(SHOW_VERSION_PRESS);
    let text: string | undefined;
    try {
      await waitUntil(async () => (text = await dialogText(page)) !== undefined, label, 5_000);
    } catch (error) {
      if (Date.now() > until) throw error;
      continue;
    }
    await closeDialog(page);
    return text ?? "";
  }
}

/** 知らせ（右下）に `text` を含むものが出るまで、`press` を押しながら待つ */
async function pressUntilToast(
  page: Page,
  press: string,
  text: string,
  label: string,
  timeoutMs = 60_000
): Promise<string> {
  const toast = page.locator(".notification-toast", { hasText: text });
  const until = Date.now() + timeoutMs;
  for (;;) {
    await page.keyboard.press(press);
    try {
      await waitUntil(async () => (await toast.count()) > 0, label, 5_000);
      return await toast.first().innerText();
    } catch (error) {
      // キーが早すぎて、キー割り当てや拡張機能がまだ起きていなかった。押し直す
      if (Date.now() > until) throw error;
    }
  }
}

/**
 * 作り物の作品を登録する（使い捨ての keybindings.json に書いたキーを押す）。
 *
 * **登録のキーで拡張機能を起こす**（先に起こして待つ、をしない）。起動のときの
 * globalState への書き込み（「はじめまして」の案内の状態など）と、登録簿への保存が
 * 同じ瞬間に並ぶ形をわざと通す。
 *
 * 0.97.2 までは、4回に1回ほど**「登録しました」と出たのに登録簿から
 * 消えていた**（2026-10-03。VS Code の globalState が、先に書いた別の鍵の送り返しで
 * 手元の塊を丸ごと差し替えるため。設計書5.7.8）。0.97.3 で登録簿は書いたあと
 * 読み返して確かめるようにしたので、**ここで消えていたら製品の不具合として落とす**
 * （やり直して隠さない。再発の見張り）。
 *
 * 登録できたことは、登録簿を読み返して確かめる——「版を表示」
 * （`novelai.showVersion`）の確認の画面は、登録簿から引いた作品名を「（作品: …）」と
 * 添える。確認の画面と知らせは本文を塞ぐので、読んだら閉じる。
 */
async function registerWork(session: E2ESession, workTitle: string): Promise<void> {
  const { page } = session;
  const config = path.join(session.workFolder, ".aiwriter", "config.json");
  // 拡張機能がまだ起きていなければ、知らせが出るまで押し直す（登録はすでにあれば
  // 断るので、何度押しても1件のはず。断りの知らせも「登録」を含む）。
  // **「はず」を信じない**——押し直しが重なると二重に入った（2026-10-04）ので、
  // 下で登録簿が1件であることまで読み返す
  await pressUntilToast(page, REGISTER_WORK_PRESS, "登録", "作品の登録");
  await waitUntil(() => existsSync(config), `${config} ができる`);
  // 登録のあと、遅れて消える形の見張り（製品側は2秒まで見張る）を待ってから読み返す
  await page.waitForTimeout(2_500);
  await clearNotifications(page);
  const version = await readVersionDialog(page, "登録簿の読み返し");
  /*
    作品フォルダーの名前も同じなので、登録簿から引いた形「（作品: …）」で見る。
    **1件だけであることまで確かめる**（2026-10-04）。登録のキーは知らせが出るまで
    押し直すので、同じフォルダーが2回登録されると「作品: 題・題」になる
    （ノートPCの実機確認で、50ミリ秒おきの2回の登録が2件になった）。
    含まれるかだけを見ていると、この二重を見逃す
  */
  const registered = /（作品: ([^）]*)）/.exec(version)?.[1]?.split("・") ?? [];
  if (!registered.includes(workTitle)) {
    throw new Error(
      `作品を登録したのに登録簿に入っていません（登録が消える不具合の再発。設計書5.7.8）。版の知らせ：${version}`
    );
  }
  if (registered.length !== 1) {
    throw new Error(
      `この窓の作品が1件ではありません（${registered.length}件。同じフォルダーの二重登録の再発）。版の知らせ：${version}`
    );
  }
  // 起動のときの案内（はじめまして）などが残っていれば閉じる
  await clearNotifications(page);
}

/** 写真を残す場所。一時フォルダーの根は片づけで消すので、別に取る */
const SCREENSHOT_DIR = path.join(tmpdir(), "novelai-e2e-screenshots");

/** 画面の写真を残して道を返す。撮れなければ undefined（失敗の報告そのものは止めない） */
async function saveScreenshot(page: Page, name: string): Promise<string | undefined> {
  const shot = path.join(
    SCREENSHOT_DIR,
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${name.replace(/[\\/:*?"<>|\s]/g, "_")}.png`
  );
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: shot });
    console.error(`[E2E] 失敗した画面の写真: ${shot}`);
    return shot;
  } catch {
    return undefined;
  }
}

/**
 * VS Code を起こして `body` を走らせ、必ず閉じて一時フォルダーを消す。
 *
 * **失敗したときは画面の写真を残し、その道を例外の文に足す。**
 * 画面のテストは「どこで止まったか」が文だけでは分からないことが多い。
 */
export async function withVsCode(
  name: string,
  episodes: readonly FixtureEpisode[],
  body: (session: E2ESession) => Promise<void>,
  options: LaunchOptions = {}
): Promise<{ videoPath?: string }> {
  const session = await launch(episodes, options);
  // 動画の道は閉じる前に控える（閉じたあとに書き終わる。置き場は一時フォルダーの外）
  try {
    await body(session);
    return { videoPath: await session.page.video()?.path() };
  } catch (error) {
    const shot = await saveScreenshot(session.page, name);
    const note = shot ? `\n画面の写真: ${shot}` : "\n（写真を撮れませんでした）";
    if (error instanceof Error) {
      error.message += note;
      throw error;
    }
    throw new Error(String(error) + note);
  } finally {
    // 閉じたあと、残ったプロセスを木ごと止めて一時フォルダーを消す（cleanup.ts）。
    // ここが届かない時間切れ・途中で止めたときは、走りの最後の片づけが拾う
    relaunchContexts.delete(session.root);
    // 開き直し（restartVsCode）の途中で落ちると、手元の app は閉じたあとのもの。PID は読めなくてよい
    // （片づけは一時フォルダー名の引数でも拾う）。ここで投げると、本当の失敗が隠れる
    let pid: number | undefined;
    try {
      pid = session.app.process().pid;
    } catch {
      pid = undefined;
    }
    await closeAndStop(session.app, { root: session.root, pid });
  }
}
