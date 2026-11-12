/**
 * Mac の画面の文に、「右クリック」の添え書き「（Mac は control＋クリック）」が付いているか
 * （画面の自動テスト、設計書2.4・6.113。0.148.0。作者の問い 2026-11-08「右クリックはMacではどう操作しますか？」）。
 *
 * 実機確認リスト 0.148.0 の〔Mac〕項目（画面の写真）を機械へ移したもの。文の組み立て（`keysForHost`・
 * 「文ごとに最初の1回だけ添える」）は単体テスト `keyLabelsOnMac.test.ts` が見ている。ここで見るのは
 * **本物の画面に出た文**。**Mac でだけ走らせる**（`process.platform !== "darwin"` なら飛ばす。
 * Windows では添え書きが付かないのが正しいので、見るものが無い）。
 *
 * 見る場所：
 * 1. 作品一覧のメモの行に指を置いたときの説明（「右クリックの「メモ追加」から増やせます。」）。
 *    **話の行の説明には「右クリック」の文が無い**（ファイル・種別・字数などの一覧）ので、「右クリック」を
 *    含む作品一覧の説明のうち、作品に置いた1つのメモから出るメモの枝の説明で確かめる
 * 2. 簡単ステップメニュー（編集者モードでは「編集者メニュー」）の「4. 直しを提案する・メモ（意見）を書く」の下の
 *    「修正を提案する」に指を置いたときの説明（「・右クリックからも出せる」）
 * 3. 使い方（マニュアル）：「右クリック」を含む行は、最初の「右クリック」の直後に添えてあり、
 *    同じ行の2回目の「右クリック」には添えていない
 * 4. EPUBエディターの右の並びの下の文（「ドラッグで並べ替え。右クリックで挿入・上へ・下へ・削除。」）
 *
 * **見るのは「右クリック」の直後に添え書きがあること・同じ行に1つだけであること**。読みやすさは作者。
 * 写真を `NOVELAI_E2E_PHOTOS`（無ければ一時フォルダーの `novelai-e2e-photos`）へ残す——Mac のセッションが
 * 画面を見て、文の位置・重なりを確かめられるように。
 *
 * **AI は呼ばない。**
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { RIGHT_CLICK_MAC_NOTE } from "../../src/core/keyLabels";
import { runCommand } from "./support/quickInput";
import { SHOW_SIDEBAR_KEY, expandTreeRow, showSidebar, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  dismissWorkbenchHover,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickPickTitle,
} from "./support/workbenchDom";

const isMac = process.platform === "darwin";

/** 写真の置き場（Mac のセッションが見る）。環境変数 `NOVELAI_E2E_PHOTOS`、無ければ一時フォルダーの下 */
function photoFolder(): string {
  return process.env.NOVELAI_E2E_PHOTOS || path.join(os.tmpdir(), "novelai-e2e-photos");
}

async function takePhoto(page: Page, name: string): Promise<string> {
  const folder = photoFolder();
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `右クリック添え書き-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** 「右クリック」の数と、添え書きの数 */
function countClicks(text: string): { clicks: number; notes: number } {
  return {
    clicks: (text.match(/右クリック/g) ?? []).length,
    notes: text.split(RIGHT_CLICK_MAC_NOTE).length - 1,
  };
}

/** 添え書きは「最初の右クリック」の直後（その行の1回目だけ） */
function expectNoteOncePerLine(text: string, where: string): void {
  const bad: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("右クリック")) continue;
    const { notes } = countClicks(line);
    const first = line.indexOf("右クリック");
    const note = line.indexOf(RIGHT_CLICK_MAC_NOTE);
    if (notes !== 1 || note !== first + "右クリック".length) bad.push(line.slice(0, 120));
  }
  expect(bad, `${where}：「右クリック」の直後に添え書きが1つだけ付いていない行`).toEqual([]);
}

/** 画面に出ている吹き出し（VS Code 本体の `.workbench-hover`。版によって `.monaco-hover`）の字 */
async function shownHover(page: Page): Promise<string> {
  return page.evaluate(() => {
    const shown = Array.from(document.querySelectorAll(".workbench-hover, .monaco-hover")).find((element) => {
      const box = (element as HTMLElement).getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !element.classList.contains("hidden");
    });
    return shown ? (shown as HTMLElement).innerText : "";
  });
}

/** 行に指を置いて、吹き出しの字を読む（写真を撮ってから払う） */
async function tooltipOf(page: Page, row: ReturnType<typeof treeRow>, label: string, photo: string): Promise<string> {
  await dismissWorkbenchHover(page);
  let text = "";
  for (let attempt = 1; attempt <= 3 && text === ""; attempt += 1) {
    await row.hover({ position: { x: 20 + attempt, y: 8 } });
    await waitUntil(async () => (text = await shownHover(page)).trim() !== "", `「${label}」の行に指を置くと説明が出る`, 5_000).catch(
      () => undefined
    );
  }
  if (text === "") throw new Error(`「${label}」の行の説明が出ません（aria-label：${(await row.getAttribute("aria-label").catch(() => "")) ?? ""}）`);
  await takePhoto(page, photo);
  await dismissWorkbenchHover(page);
  return text;
}

/** EPUBエディター（目印は「本の設定」の行 `#railBook` と並びの箱 `#blockList`） */
async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("blockList") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 拡張機能の保管庫から、いま組んだ「使い方」の写し（.md）を探す */
async function findManualFile(session: E2ESession): Promise<string | undefined> {
  const base = path.join(session.root, "user-data");
  const names = await readdir(base, { recursive: true }).catch(() => [] as string[]);
  const found = names.map(String).filter((name) => name.endsWith(".md") && path.basename(name).includes("使い方"));
  return found.length > 0 ? path.join(base, found[found.length - 1]) : undefined;
}

test.skipIf(!isMac)("Mac：作品一覧のメモの行・使い方（マニュアル）・EPUBエディターの右の並びの下の文の「右クリック」に添え書きが付き、同じ行の2回目には付かない", async () => {
  await withVsCode(
    "Mac 右クリックの添え書き",
    [{ name: "第1話_駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);

      /* ── 1. 作品一覧のメモの行（説明に「右クリック」がある） ── */
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);
      const memoRow = treeRow(page, "メモ");
      await waitUntil(async () => (await memoRow.count()) > 0, "作品の下に「メモ」の枝が出る", 20_000);
      const memoTip = await tooltipOf(page, memoRow, "メモ", "作品一覧のメモ");
      expect(memoTip, "メモの枝の説明").toContain("メモ追加");
      expect(countClicks(memoTip), `メモの枝の説明：${JSON.stringify(memoTip)}`).toEqual({ clicks: 1, notes: 1 });
      expect(memoTip).toContain(`右クリック${RIGHT_CLICK_MAC_NOTE}の「メモ追加」`);

      /* ── 3. 使い方（マニュアル） ── */
      await runCommand(page, "使い方（マニュアル）");
      let file: string | undefined;
      await waitUntil(async () => (file = await findManualFile(session)) !== undefined, "使い方（マニュアル）の写しが保管庫にできる", 30_000);
      const manual = await readFile(file ?? "", "utf8");
      expect(manual.length, "使い方の文").toBeGreaterThan(1000);
      expectNoteOncePerLine(manual, "使い方（マニュアル）");
      expect(countClicks(manual).clicks, "使い方に「右クリック」が1つも無い（確かめる行が無い）").toBeGreaterThan(0);
      await takePhoto(page, "使い方");

      /* ── 4. EPUBエディターの右の並びの下の文 ── */
      await runCommand(page, "EPUBエディター（試作）");
      await page.waitForTimeout(500);
      if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, E2E_WORK_TITLE);
      let epub: Frame | undefined;
      await waitUntil(async () => (epub = await epubFrame(page)) !== undefined, "EPUBエディターが開く", 30_000);
      if (!epub) throw new Error("EPUBエディターが見つかりません");
      const hint = epub.locator(".rail-hint").first();
      await hint.waitFor({ state: "visible", timeout: 15_000 });
      // 面の中の字は、描いたあとに WebView の台本が直すことがある。落ち着いた字を読む
      let hintText = "";
      await waitUntil(async () => (hintText = ((await hint.textContent()) ?? "").trim()).includes(RIGHT_CLICK_MAC_NOTE), "右の並びの下の文に添え書きが付く", 10_000).catch(
        () => undefined
      );
      expect(hintText, "右の並びの下の文").toBe(`ドラッグで並べ替え。右クリック${RIGHT_CLICK_MAC_NOTE}で挿入・上へ・下へ・削除。`);
      await takePhoto(page, "EPUBエディターの右の並び");
    },
    {
      // 作品に1つメモを置く（メモの枝は、メモが1つ以上あるときだけ作品の下に出る）
      prepareWork: async ({ workFolder }) => {
        const folder = path.join(workFolder, "設定", "メモ");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "見本のメモ.md"), "# 見本のメモ\n", "utf8");
      },
    }
  );
}, 300_000);

test.skipIf(!isMac)("Mac：編集者メニューの「修正を提案する」に指を置くと、説明の「右クリック」に添え書きが付き、同じ行の2回目には付かない", async () => {
  await withVsCode(
    "Mac 修正を提案するの説明",
    [{ name: "第1話_駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      // 編集者モードでは、簡単ステップメニューの代わりに「編集者メニュー」が一番上に出る（設計書5.6.6）
      const header = page.locator(".pane-header", { hasText: "編集者メニュー" }).first();
      await header.waitFor({ state: "visible", timeout: 20_000 });
      // 木は見えている行しか描かない。ほかの区画を畳んで、背を高くする
      for (const other of ["作品一覧", "詳細メニュー", "AIに相談"]) {
        const pane = page.locator(".pane-header", { hasText: other }).first();
        if ((await pane.count()) === 0 || (await pane.getAttribute("aria-expanded")) !== "true") continue;
        await pane.click({ position: { x: 8, y: 10 } });
      }
      const step = treeRow(page, "4. 直しを提案する");
      await waitUntil(async () => (await step.count()) > 0, "編集者メニューに「4. 直しを提案する」の行が出る", 20_000);
      if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
      const propose = treeRow(page, "修正を提案する");
      await waitUntil(async () => (await propose.count()) > 0, "「4. 直しを提案する」の下に「修正を提案する」が出る", 10_000);
      const tip = await tooltipOf(page, propose, "修正を提案する", "修正を提案する");
      expect(tip, "「修正を提案する」の説明").toContain("右クリック");
      expect(countClicks(tip), `説明：${JSON.stringify(tip)}`).toEqual({ clicks: 1, notes: 1 });
      expect(tip).toContain(`右クリック${RIGHT_CLICK_MAC_NOTE}からも出せる`);
    },
    {
      // 編集者モード（設定 `novelai.mode`）で起こす。簡単ステップメニューは作者モードだけに出る
      settings: { "novelai.mode": "editor" },
      keybindings: [{ key: SHOW_SIDEBAR_KEY, command: "workbench.view.extension.novelai" }],
    }
  );
}, 300_000);
