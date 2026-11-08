// ログの書き先：呼ぶ側が向ける（リンクを開く共通の口で、作品を受け取らない）
import * as vscode from "vscode";
import {
  decideSiteLinkGuide,
  isHelperSiteUrl,
} from "../core/externalBrowser";
import { HELPER_DOWNLOAD_URL } from "../core/postingEnvelope";
import { canRunProcesses, isMacHost, isWindowsHost } from "../core/runtime";
import { logFailure, logStep } from "../core/logger";

/**
 * 投稿サイト・Narou.fun のリンクを開く口（作者の依頼 2026-10-12）。
 *
 * リンクは `openExternal` で**作者の既定のブラウザ**が開く。読者の反応を取り込む
 * ヘルパーは Chrome の拡張機能なので、既定が Edge などだと、開いた管理画面で
 * ヘルパーが働かない——その違いは作者には見えない。そこで、**Chrome でないと
 * 分かったときだけ、初回に1度**、開く前に案内を出す（判定は `core/externalBrowser.ts`）。
 *
 * - 案内のどのボタンを押しても（閉じても）リンクは開く。止める道は作らない
 * - 2回目からは黙って開く（覚えは globalState。`verifiedState` で包んだものを渡す）
 * - ブラウザ版・Windows と Mac 以外・登録簿（Mac は LaunchServices の記録）を読めないときは、案内を出さずにそのまま開く
 *   （推し量って Chrome を勧めない）
 * - ヘルパーと関わりの無いリンク（公募の要項など）は、案内を出さずにそのまま開く
 *
 * **開くだけ**で、ページの中身は読まない（6.68.1）。
 */

/** 案内を出したことの覚えの鍵（書く口は `markShown` の1か所。`mementoWrites.test.ts`） */
export const SITE_LINK_GUIDE_SHOWN_KEY = "novelai.siteLink.browserGuideShown";

/** 覚えの置き場（`vscode.Memento` のうち使う分だけ） */
export interface SiteLinkGuideMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** 案内のボタン */
export const USE_CHROME_LABEL = "Chrome で開くようにする";
export const OPEN_AS_IS_LABEL = "このまま開く";
export const ABOUT_HELPER_LABEL = "ヘルパーについて";

let memory: SiteLinkGuideMemory | undefined;
/**
 * 登録簿を読む口（試験で差し替える）。既定は Windows の登録簿を動的 import で読む
 */
let readProgId: () => Promise<string | undefined> = readWindowsProgId;
/** Mac の既定のブラウザの名札を読む口（試験で差し替える。既定は LaunchServices の記録を動的 import で読む） */
let readBundleId: () => Promise<string | undefined> = readMacBundleId;
/** 案内を出しているあいだに次のリンクが押されても、案内を2つ出さない */
let guiding: Promise<void> | undefined;

/** 起動時に覚えの置き場を渡す。渡されていなければ案内は出さない（試験・MCP） */
export function initSiteLinkGuide(
  state: SiteLinkGuideMemory,
  options?: {
    readProgId?: () => Promise<string | undefined>;
    readBundleId?: () => Promise<string | undefined>;
  }
): void {
  memory = state;
  readProgId = options?.readProgId ?? readWindowsProgId;
  readBundleId = options?.readBundleId ?? readMacBundleId;
}

/**
 * ヘルパーが働くサイトのリンクを開く。Chrome でないと分かれば、初回だけ案内してから開く。
 *
 * @param url 開く URL（http/https であることは呼ぶ側が確かめる）
 */
export async function openSiteLink(url: string): Promise<void> {
  try {
    await guideOnce(url);
  } catch (error) {
    // 案内で何が起きても、リンクを開くのは止めない
    logFailure("リンクを開く前の案内", { 内容: error instanceof Error ? error.message : String(error) });
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function guideOnce(url: string): Promise<void> {
  // ブラウザ版では、リンクはいま VS Code を開いているブラウザのタブで開く（設定も登録簿も効かない）
  if (!memory || !canRunProcesses() || !isHelperSiteUrl(url)) return;
  if (guiding) {
    // 先に押したリンクの案内が終わるのを待つ（2つ目の案内は出さない）
    await guiding;
    return;
  }
  const state = memory;
  if (state.get<boolean>(SITE_LINK_GUIDE_SHOWN_KEY, false)) return;
  guiding = (async () => {
    const setting = vscode.workspace
      .getConfiguration("workbench")
      .get<string>("externalBrowser");
    const hasSetting = typeof setting === "string" && setting.trim() !== "";
    // OS の既定は、設定が空のときだけ読む（Windows は登録簿、Mac は LaunchServices。ほかの OS では読まない）
    const progId = hasSetting ? undefined : await readProgId();
    const bundleId = hasSetting || progId !== undefined ? undefined : await readBundleId();
    const decision = decideSiteLinkGuide({ setting, progId, bundleId, shown: false });
    if (!decision.show) return;
    // **出す前に覚える。** 案内を出したまま置かれても、次のリンクで2度目を出さない
    await markShown(state);
    await showGuide(decision.browserName);
  })();
  try {
    await guiding;
  } finally {
    guiding = undefined;
  }
}

async function showGuide(browserName: string): Promise<void> {
  const answer = await vscode.window.showInformationMessage(
    `リンクは ${browserName} で開きます。`,
    {
      modal: true,
      detail:
        "読者の反応を取り込む「統合小説執筆環境ヘルパー」は Chrome の拡張機能なので、" +
        "Chrome で開くと続けて取り込めます。\n" +
        `［${USE_CHROME_LABEL}］を押すと、VS Code の設定（workbench.externalBrowser）を chrome にします。` +
        "どれを選んでもリンクは開きます。この案内は次から出しません。",
    },
    USE_CHROME_LABEL,
    OPEN_AS_IS_LABEL,
    ABOUT_HELPER_LABEL
  );
  if (answer === USE_CHROME_LABEL) {
    // **押したときだけ書く。** 作者のユーザー設定なので、黙って書き換えない
    await vscode.workspace
      .getConfiguration("workbench")
      .update("externalBrowser", "chrome", vscode.ConfigurationTarget.Global);
    logStep("リンクを Chrome で開くよう、設定 workbench.externalBrowser を chrome にしました。");
  } else if (answer === ABOUT_HELPER_LABEL) {
    await vscode.env.openExternal(vscode.Uri.parse(HELPER_DOWNLOAD_URL));
  }
}

async function markShown(state: SiteLinkGuideMemory): Promise<void> {
  await state.update(SITE_LINK_GUIDE_SHOWN_KEY, true);
}

/** Windows の既定のブラウザの ProgId。ブラウザ版・Windows 以外では読まない */
async function readWindowsProgId(): Promise<string | undefined> {
  if (!canRunProcesses() || !isWindowsHost()) return undefined;
  // Node 専用の部品なので動的 import（実装ルール7。`browserReach.test.ts`）
  const { readDefaultBrowserProgId } = await import("../core/externalBrowserWindows.js");
  return readDefaultBrowserProgId();
}

/** Mac の既定のブラウザの名札。ブラウザ版・Mac 以外では読まない */
async function readMacBundleId(): Promise<string | undefined> {
  if (!canRunProcesses() || !isMacHost()) return undefined;
  // Node 専用の部品なので動的 import（実装ルール7。`browserReach.test.ts`）
  const { readDefaultBrowserBundleId } = await import("../core/externalBrowserMac.js");
  return readDefaultBrowserBundleId();
}
