/**
 * 右クリック「ファイル名にサブタイトルを付ける」で名前を変えても、原稿エディターの見た目がついてくる
 * （画面の自動テスト、設計書6.25.5・6.12.1・6.113。0.127.0）。実機確認リストの 0.127.0 の項目
 * 「縦書き・組んで書く・文字の大きさを変えたまま…名前を変えると、古い名前の面が閉じ、新しい名前で開いた面が
 * 同じ見た目で出る（未保存なら閉じない）」を機械へ移したもの。単体テスト renameSubtitleCarriesAppearance は
 * 配線の順（持ち越し → 改名 → 閉じる）をソースの形で押さえているだけなので、ここでは本物の面で見る：
 *
 * 1. 話を開き、［縦書きにする］と［＋］2回で見た目を変える → 右クリックで改名 →
 *    古い名前のタブが閉じる → 新しい名前で開くと、縦書き・同じ字の大きさ・組んで書く面で出る
 * 2. 1字打って**保存しないまま**改名すると、先に保存を訊く（中止なら何も変わらず、保存して実行なら打った字を残して名前が変わる。
 *    前は訊かずに名前を変え、未保存の面が古い名前に残って、保存すると同じ話が2つに割れた。2026-11-27）
 *
 * 「組んで書く」は切り替えのボタンが無い（既定で入り）ので、既定の入りのまま付いてくることだけを見る。
 * サブタイトル案の採用（AI の案）の道は AI を呼ぶので、ここでは押さない。AI・GitHub は呼ばない。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { clickToolButton, frontFrameShowing, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { SIDEBAR_LAUNCH, showSidebar, treeContextMenu, treeRow, treeRowLabels, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  countTabsNamed,
  dialogText,
  editorGroupTabs,
  notificationTexts,
  pressDialogButton,
  readTabState,
  statusBarTexts,
  tabIsDirty,
  tabNamesInclude,
} from "./support/workbenchDom";

const OLD_NAME = "第1話_旧題.txt";
const NEW_NAME = "第1話_はじまり.txt";
const MARKER = "朝の駅は静かだった";
// 名前の題は「旧題」、中の【タイトル】は「はじまり」（名前に題が無い話は「既に付いています」で止まる既知の件を踏まない）
const TEXT = `【タイトル】\nはじまり\n\n【本文】\n　${MARKER}。\n`;

/** 面の見た目（縦書きか・字の大きさ px・組んで書く面か） */
async function faceLook(frame: Frame): Promise<{ vertical: boolean; size: number; compose: boolean }> {
  return frame.evaluate(() => ({
    vertical: document.body.classList.contains("vertical"),
    size: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--novelai-size")) || 0,
    compose: document.body.classList.contains("compose"),
  }));
}

async function allTabs(page: Page): Promise<string[]> {
  return (await editorGroupTabs(page)).flat();
}

async function readActionLogs(session: E2ESession): Promise<string> {
  const files: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 7) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === "actions.log") files.push(full);
    }
  };
  await walk(path.join(session.workFolder, ".aiwriter"), 0);
  await walk(path.join(session.root, "user-data", "User", "globalStorage"), 0);
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")));
  return texts.join("\n");
}

/** 作品の行を開いて、話の行が並ぶまで待つ */
async function expandWork(page: Page): Promise<void> {
  await showSidebar(page, E2E_WORK_TITLE);
  const workRow = page.locator(`.monaco-list-row[aria-expanded][aria-label*="${E2E_WORK_TITLE}"]`).first();
  await waitUntil(async () => (await workRow.count()) > 0, "作品の行が出る");
  if ((await workRow.getAttribute("aria-expanded")) !== "true") await workRow.click();
  await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第1話")), "作品の下に話が並ぶ");
  await waitTreeSettled(page);
}

/** 右クリック「ファイル名にサブタイトルを付ける」→ 確認の窓で［変える］ */
async function renameFromTree(page: Page): Promise<void> {
  await expandWork(page);
  await treeContextMenu(page, "第1話", "ファイル名にサブタイトルを付ける");
  await waitUntil(async () => ((await dialogText(page)) ?? "").includes("ファイル名を変えます"), "名前を変える確認の窓が出る", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（窓：${(await dialogText(page)) ?? "なし"}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
    }
  );
  await pressDialogButton(page, "変える");
}

async function waitRenamedOnDisk(session: E2ESession): Promise<void> {
  await waitUntil(
    async () => {
      const names = await readdir(session.manuscriptFolder).catch(() => [] as string[]);
      return names.includes(NEW_NAME) && !names.includes(OLD_NAME);
    },
    `ディスクで「${NEW_NAME}」に名前が変わる`,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（本文フォルダー：${JSON.stringify(await readdir(session.manuscriptFolder).catch(() => []))}／知らせ：${JSON.stringify([
        ...(await statusBarTexts(session.page)),
        ...(await notificationTexts(session.page)),
      ])}）`
    );
  });
}

test("縦書き・字の大きさを変えた話を右クリック「ファイル名にサブタイトルを付ける」で改名すると、古い名前の面が閉じ、新しい名前で開いた面が同じ見た目（縦書き・同じ大きさ・組んで書く）で出る", async () => {
  await withVsCode(
    "改名で見た目がついてくる",
    [{ name: OLD_NAME, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, OLD_NAME, MARKER);
      const original = await faceLook(frame);
      expect(original.vertical, `横書きの入口で開く ${JSON.stringify(original)}`).toBe(false);
      expect(original.size, `字の大きさが読める ${JSON.stringify(original)}`).toBeGreaterThan(0);
      expect(original.compose, `組んで書く面で開く（既定）${JSON.stringify(original)}`).toBe(true);

      await clickToolButton(frame, "dir");
      await waitUntil(async () => (await faceLook(frame)).vertical, "［縦書きにする］で縦書きになる", 10_000);
      await clickToolButton(frame, "bigger");
      await clickToolButton(frame, "bigger");
      await waitUntil(async () => (await faceLook(frame)).size > original.size, "［＋］で字が大きくなる", 10_000);
      const changed = await faceLook(frame);
      // 見た目の知らせ（appearance）が拡張機能へ届くのを待つ（持ち越す値はそれで決まる。restartAndDisconnect と同じ理由）
      await page.waitForTimeout(1_000);

      await renameFromTree(page);
      await waitRenamedOnDisk(session);

      // 古い名前のタブが閉じ、戻ってこない
      await waitUntil(async () => !tabNamesInclude(await allTabs(page), OLD_NAME), "古い名前のタブが閉じる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
        }
      );
      await holdsFor(async () => !tabNamesInclude(await allTabs(page), OLD_NAME), "閉じた古い名前のタブが戻ってきた", 2_000);
      /*
        2026-11-06 母艦（1.141.0）では、改名の直後にもう新しい名前のタブがあった（VS Code が開いていた面を
        新しい名前へ移す）。操作ログに「名前が変わったため … の面を閉じます」は残らなかった。どちらの道でも
        作者に見えるのは「古い名前が消え、新しい名前が同じ見た目で1枚」なので、テストはそこを見る
      */

      // 新しい名前で開く（作者は作品一覧の行から開く。Ctrl+P の候補が空のまま揺れることがあるので、そのときは行から）
      let renamed: Frame;
      try {
        renamed = await openEpisode(page, NEW_NAME, MARKER);
      } catch (error) {
        console.warn(`renameSubtitleAppearance: Ctrl+P で開けなかったので作品一覧の行から開きます（${String(error)}）`);
        await page.keyboard.press("Escape");
        await expandWork(page);
        await treeRow(page, "第1話").first().click();
        renamed = await frontFrameShowing(page, MARKER, "作品一覧の行から開いた新しい名前の面が本文を描く", 30_000);
      }
      await waitUntil(
        async () => {
          const look = await faceLook(renamed);
          return look.vertical && look.size === changed.size && look.compose;
        },
        "新しい名前の面が、縦書き・同じ字の大きさ・組んで書く面で出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（新しい面の見た目：${JSON.stringify(await faceLook(renamed))}／変えた見た目：${JSON.stringify(changed)}` +
            `／操作ログ：${JSON.stringify((await readActionLogs(session)).split(/\r?\n/).filter((line) => line.includes("原稿エディタ") || line.includes("見た目")).slice(-6))}）`
        );
      });
      expect(countTabsNamed(await allTabs(page), NEW_NAME), "新しい名前のタブは1枚だけ").toBe(1);
    },
    SIDEBAR_LAUNCH
  );
}, 240_000);

test("1字打って保存しないまま右クリックで改名すると、先に保存を訊く。中止なら名前も打ちかけもそのまま、保存して実行なら打った字を残して名前が変わり、古い名前のファイルは戻らない", async () => {
  await withVsCode(
    "改名の前に保存を訊く",
    [{ name: OLD_NAME, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, OLD_NAME, MARKER);
      await placeCaretAfter(frame, `${MARKER}。`);
      await page.keyboard.insertText("【打ちかけ】");
      await waitUntil(async () => tabIsDirty(page, OLD_NAME), "タブが未保存の印（●）になる", 10_000);

      /* ── 中止：名前も打ちかけもそのまま ── */
      await clearNotifications(page);
      await expandWork(page);
      await treeContextMenu(page, "第1話", "ファイル名にサブタイトルを付ける");
      await waitForSaveQuestion(page);
      await pressNoticeButton(page, "中止");
      await holdsFor(
        async () => {
          const names = await readdir(session.manuscriptFolder).catch(() => [] as string[]);
          return names.includes(OLD_NAME) && !names.includes(NEW_NAME);
        },
        "中止したのに名前が変わった",
        3_000
      );
      expect(await tabIsDirty(page, OLD_NAME), "中止しても打ちかけは残っている").toBe(true);

      /* ── 保存して実行：打った字を残して名前が変わり、古い名前は戻らない ── */
      await clearNotifications(page);
      await treeContextMenu(page, "第1話", "ファイル名にサブタイトルを付ける");
      await waitForSaveQuestion(page);
      await pressNoticeButton(page, "保存して実行");
      await waitUntil(async () => ((await dialogText(page)) ?? "").includes("ファイル名を変えます"), "名前を変える確認の窓が出る", 20_000);
      await pressDialogButton(page, "変える");
      await waitRenamedOnDisk(session);
      const renamed = await readFile(path.join(session.manuscriptFolder, NEW_NAME), "utf8");
      expect(renamed, "打った字が新しい名前のファイルに入っている").toContain("【打ちかけ】");
      // 保存してから変えたので、古い名前の面は閉じ、古い名前のファイルは戻ってこない（同じ話が2つに割れない）
      await waitUntil(async () => !tabNamesInclude(await allTabs(page), OLD_NAME), "古い名前のタブが閉じる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
        }
      );
      await holdsFor(
        async () => !(await readdir(session.manuscriptFolder).catch(() => [] as string[])).includes(OLD_NAME),
        "古い名前のファイルが戻ってきた",
        3_000
      );
    },
    SIDEBAR_LAUNCH
  );
}, 240_000);

/** 右下の「未保存の変更が N 件あります」の知らせを待つ */
async function waitForSaveQuestion(page: Page): Promise<void> {
  await waitUntil(
    async () => (await noticeTexts(page)).some((text) => text.includes("未保存の変更が 1 件あります")),
    "名前を変える前に保存を訊く知らせが出る",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeTexts(page))}）`);
  });
}

/** 右下の知らせの本文（上から） */
async function noticeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast")).map((toast) => (toast as HTMLElement).innerText)
  );
}

/** 知らせの中のボタンを名前で押す */
async function pressNoticeButton(page: Page, label: string): Promise<void> {
  await page.locator(".notification-toast .monaco-button", { hasText: label }).first().click();
}
