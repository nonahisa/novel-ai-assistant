/**
 * 作者モード／編集者モードで、左の列のメニューに描かれる並び（画面の自動テスト、設計書5.6・6.113。
 * 実機確認リスト 0.119.0〜0.121.0 の 317・320・321・325・326・333 行のうち、メニューと押して起きることを
 * 機械へ移した。作者の判断 2026-11-01「作者の段は作者の操作だけ」「同期の入口は保存・同期1つ」）。
 *
 * メニューの組み（どの段に何が載るか）は単体テスト `menuVisible.test.ts`・`stepMenu.test.ts`・
 * `stepMenuEditorMode.test.ts` が見ている。ここで見るのは、**本物の VS Code の木に描かれた並び**と、
 * **モードを切り替えた瞬間に描き直されるか**（再読み込みなしで）である。
 *
 * 1. 作者モード（333・317・321）：簡単ステップメニュー「6. 編集者校正・校閲」が「編集者へ渡す」
 *    「編集者の提案を見る」「編集者連携を解除」「編集履歴」「作者／編集者切替」「編集者として参加」の順で、
 *    「5. 投稿脱稿」に「編集者へ渡す」が無い。詳細メニュー「作品管理」→「編集者連携」に「編集者の提案を見る」が
 *    1つだけあり（「編集者提案取込」「編集者提案確認」は無い）、「校閲開始／終了」「修正を提案する」
 *    「校閲を終えて返す」も無い。「GitHub作品管理」は「GitHub初期設定」「保存・同期」「復元」の3つだけ。
 *    作品一覧の見出しのボタンは「保存・同期」。どの行にも「編集部」が残っていない（320）
 * 2. 編集者モードへ切り替えた瞬間（326）：簡単ステップメニューが「1. 編集者として参加」〜「7. 作者モードへ戻る」
 *    とヘルプに替わり、最上段は作品の名前だけで、押しても作品の選び直しが出ない。詳細メニューの「編集者連携」に
 *    「校閲開始／終了」「修正を提案する」「校閲を終えて返す」と「編集者提案確認」が出て、「編集者の提案を見る」は無い
 *    （333・317）。「修正を提案する」（325）：本文を選ばずに押すと「修正したい所を本文で選んでから押してください
 *    （右クリックからも出せます）。」、素のエディターで選んでから押すと入力欄「修正を提案する（1/2）：修正案」へ進む。
 *    素のエディターの右クリックにも「修正を提案する」が出る（320）
 * 3. 作者モードへ戻すと、簡単ステップメニューが「1. 作品登録」〜の並びに戻り（再読み込みなし）、詳細メニューから
 *    「修正を提案する」を…押す道は消えるので、コマンドを直に呼ぶと「編集者モードで使う操作です」と理由が出る（325）
 *
 * **このテストでは .txt を素のテキストエディターで開く**（`workbench.editorAssociations`）。原稿エディターから
 * 「修正を提案する」へ進む道は作者の手に残す。GitHub は呼ばない（同期の窓・「未記録 N」を押したときの窓は見ない）。
 * **AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { findAction } from "../../src/core/actionTree";
import { quickInputMessage, waitForQuickInput } from "./support/quickInput";
import { SIDEBAR_LAUNCH, scrollTreeUntilRow, showSidebar, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  dismissWorkbenchHover,
  focusTextEditor,
  notificationTexts,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickOpen,
  quickPickTitle,
  textEditorVisibleText,
} from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", ""].join("\n");

/** 作者モードで「修正を提案する」をコマンドとして直に押すキー（詳細メニューからは消えるので） */
const PROPOSE_KEY = { key: "ctrl+alt+shift+y", command: "novelai.proposeEditByHand" };
const PROPOSE_PRESS = "Control+Alt+Shift+KeyY";

const LAUNCH = {
  settings: {
    ...SIDEBAR_LAUNCH.settings,
    "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" },
  },
  keybindings: [...SIDEBAR_LAUNCH.keybindings, PROPOSE_KEY],
};

function labelOf(command: string): string {
  const label = findAction(command)?.label;
  if (!label) throw new Error(`actionTree に ${command} がありません`);
  return label;
}

/**
 * 左の列の区画を、見出しの左端（畳みの矢印）を押して開く・畳む。
 * 見出しの真ん中を押すと、指を載せて出たボタン（作品一覧の「保存・同期」など）に当たることがある
 */
async function setSidebarPane(page: Page, title: string, expanded: boolean): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const now = async () => (await header.getAttribute("aria-expanded")) === "true";
  if ((await now()) === expanded) return;
  await header.click({ position: { x: 8, y: 10 } });
  await waitUntil(async () => (await now()) === expanded, `左の列の「${title}」を${expanded ? "開く" : "畳む"}`, 5_000);
}

/** 1つの区画だけを開き、ほかを畳む（木は見えている行しか描かないので、背を高くする） */
async function focusPane(page: Page, title: string): Promise<void> {
  for (const other of ["作品一覧", "簡単ステップメニュー", "詳細メニュー", "AIに相談"]) {
    if (other !== title) await setSidebarPane(page, other, false);
  }
  await setSidebarPane(page, title, true);
}

async function expandSidebarPane(page: Page, title: string): Promise<void> {
  await setSidebarPane(page, title, true);
}

/** 区画の中の行の名前（見えている名前。添え書きは除く）と深さを、並びの順に */
async function paneRows(page: Page, title: string): Promise<Array<{ label: string; level: number; expanded: string | null }>> {
  return page.evaluate((paneTitle) => {
    const pane = Array.from(document.querySelectorAll(".pane")).find((node) =>
      (node.querySelector(".pane-header")?.textContent ?? "").includes(paneTitle)
    );
    if (!pane) return [];
    return Array.from(pane.querySelectorAll(".monaco-list-row"))
      .sort((a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index))
      .map((row) => ({
        label: (row.querySelector(".label-name")?.textContent ?? row.getAttribute("aria-label") ?? "").trim(),
        level: Number(row.getAttribute("aria-level") ?? "0"),
        expanded: row.getAttribute("aria-expanded"),
      }));
  }, title);
}

/** 区画の中で `head` の行を開き、その直下の子の名前を並びの順に返す */
async function childrenOf(page: Page, paneTitle: string, anchor: string, head: string): Promise<string[]> {
  const row = await scrollTreeUntilRow(page, anchor, head);
  await row.scrollIntoViewIfNeeded();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `「${head}」が開く`, 10_000);
  let children: string[] = [];
  await waitUntil(
    async () => {
      const rows = await paneRows(page, paneTitle);
      const index = rows.findIndex((entry) => entry.label === head);
      if (index < 0) return false;
      const level = rows[index].level;
      const next: string[] = [];
      for (const entry of rows.slice(index + 1)) {
        if (entry.level <= level) break;
        if (entry.level === level + 1) next.push(entry.label);
      }
      children = next;
      return next.length > 0;
    },
    `「${head}」の子の行が描かれる`,
    10_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（区画の行：${JSON.stringify(await paneRows(page, paneTitle))}）`);
  });
  return children;
}

/** 簡単ステップメニューの段の行（「1. …」とヘルプ）を並びの順に */
async function stepLabels(page: Page): Promise<string[]> {
  return (await paneRows(page, "簡単ステップメニュー"))
    .map((row) => row.label)
    .filter((label) => /^\d\. /.test(label) || label === "ヘルプ");
}

/** 画面に描かれているすべての木の行と、出ている知らせのうち「編集部」を含むもの */
async function editorialWords(page: Page): Promise<string[]> {
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".monaco-list-row")).map((row) => row.getAttribute("aria-label") ?? "")
  );
  return [...rows, ...(await notificationTexts(page))].filter((text) => text.includes("編集部"));
}

async function waitDialog(page: Page, includes: string, label: string): Promise<void> {
  let text = "";
  await waitUntil(async () => (text = (await dialogText(page)) ?? "").includes(includes), label, 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
  });
}

/** 素のテキストエディターで話を開き、本文が見えるまで待つ */
async function openPlain(session: E2ESession): Promise<void> {
  await quickOpen(session.page, EPISODE);
  await waitUntil(async () => (await textEditorVisibleText(session.page)).includes("終電を逃した"), "素のテキストエディターに本文が出る", 20_000);
}

const AUTHOR_STEPS = ["1. 作品登録", "2. 新作構想", "3. 作品執筆", "4. 自己校正", "5. 投稿脱稿", "6. 編集者校正・校閲", "7. 電子出版等", "ヘルプ"];
const EDITOR_STEPS = [
  "1. 編集者として参加",
  "2. 校閲する範囲を押さえる",
  "3. 検知で探す",
  "4. 修正を提案する",
  "5. 置いた提案を見る",
  "6. 校閲を終えて返す",
  "7. 作者モードへ戻る",
  "ヘルプ",
];
const EDITOR_ONLY = ["校閲開始／終了", "修正を提案する", "校閲を終えて返す"];

test("作者モードのメニューは作者の操作だけで、編集者モードへ切り替えた瞬間に簡単ステップメニューと詳細メニューの編集者連携が描き直され、「修正を提案する」は選ばずに押すと案内・選んで押すと修正案の入力へ進み、作者モードへ戻すと元の並びに戻る", async () => {
  await withVsCode(
    "作者と編集者のメニュー",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, root } = session;
      await showSidebar(page, E2E_WORK_TITLE);

      /* ── 1. 作者モード：簡単ステップメニュー ── */
      await focusPane(page, "簡単ステップメニュー");
      expect(await stepLabels(page)).toEqual(AUTHOR_STEPS);
      const step6 = await childrenOf(page, "簡単ステップメニュー", "1. 作品登録", "6. 編集者校正・校閲");
      expect(step6, "作者の「6. 編集者校正・校閲」の並び").toEqual([
        "編集者へ渡す",
        "編集者の提案を見る",
        "編集者連携を解除",
        "編集履歴",
        "作者／編集者切替",
        "編集者として参加",
      ]);
      const step5 = await childrenOf(page, "簡単ステップメニュー", "1. 作品登録", "5. 投稿脱稿");
      expect(step5, `「5. 投稿脱稿」に「編集者へ渡す」が残っています：${JSON.stringify(step5)}`).not.toContain("編集者へ渡す");

      /* ── 1. 作者モード：詳細メニュー ── */
      await focusPane(page, "詳細メニュー");
      await childrenOf(page, "詳細メニュー", "執筆データ", "作品管理");
      const github = await childrenOf(page, "詳細メニュー", "執筆データ", "GitHub作品管理");
      expect(github, "「GitHub作品管理」の並び").toEqual(["GitHub初期設定", "保存・同期", "復元"]);
      const editorial = await childrenOf(page, "詳細メニュー", "執筆データ", "編集者連携");
      expect(editorial, "作者の「編集者連携」の並び").toEqual(["作者／編集者切替", "編集者へ渡す", "編集者として参加", "編集者の提案を見る", "編集者連携を解除"]);
      for (const gone of ["編集者提案取込", "編集者提案確認", ...EDITOR_ONLY]) {
        expect(editorial, `作者の「編集者連携」に「${gone}」があります`).not.toContain(gone);
      }

      /* ── 1. 作品一覧の見出しのボタンは「保存・同期」 ── */
      await expandSidebarPane(page, "作品一覧");
      const worksHeader = page.locator(".pane-header", { hasText: "作品一覧" }).first();
      await worksHeader.hover();
      const headerActions = await worksHeader.evaluate((node) =>
        Array.from(node.querySelectorAll(".actions .action-label")).map((el) => el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "")
      );
      expect(headerActions.some((label) => label.startsWith("保存・同期")), `作品一覧の見出しのボタン：${JSON.stringify(headerActions)}`).toBe(true);
      for (const gone of ["全作品同期", "分岐合流", "競合解決"]) {
        expect(headerActions.some((label) => label.includes(gone)), `作品一覧の見出しに「${gone}」があります：${JSON.stringify(headerActions)}`).toBe(false);
      }
      expect(await editorialWords(page), "作者モードのメニューに「編集部」が残っています").toEqual([]);

      /* ── 2. 編集者モードへ切り替える（簡単ステップメニューの「作者／編集者切替」） ── */
      await clearNotifications(page);
      await focusPane(page, "簡単ステップメニュー");
      const switchRow = await scrollTreeUntilRow(page, "6. 編集者校正・校閲", labelOf("novelai.switchMode"));
      await switchRow.click();
      await waitDialog(page, "この環境を「編集者」として使いますか。", "「編集者」として使うかの確認の窓が出る");
      await pressDialogButton(page, "編集者にする");
      const settingsFile = path.join(root, "user-data", "User", "settings.json");
      await waitUntil(async () => /"novelai\.mode"\s*:\s*"editor"/.test(await readFile(settingsFile, "utf8").catch(() => "")), "設定 novelai.mode が editor になる", 15_000);

      // 再読み込みせずに、簡単ステップメニューが編集者の並びに替わる
      await waitUntil(async () => JSON.stringify(await stepLabels(page)) === JSON.stringify(EDITOR_STEPS), "簡単ステップメニューが編集者の並びに替わる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの段：${JSON.stringify(await stepLabels(page))}）`);
        }
      );
      /*
        最上段は作品の名前を出すだけ。押しても作品の選び直しは出ない。行の字は作者モードと同じ
        「選択作品：〈作品名〉」のまま（単体テスト `stepMenuEditorMode.test.ts` の「編集者モードの最上段」も
        名前を含むことと、押す口が無いことを見ている）。項目の「名前だけ」は押す口が無いことと読む
      */
      const rows = await paneRows(page, "簡単ステップメニュー");
      expect(rows[0]?.label, `最上段：${JSON.stringify(rows.slice(0, 2))}`).toContain(E2E_WORK_TITLE);
      await treeRow(page, "選択作品：").click();
      await holdsFor(async () => (await quickPickTitle(page)) === undefined, "編集者モードの最上段を押しても作品の選び直しが出ない", 3_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（選ぶ画面：${JSON.stringify(await quickPickTitle(page))}）`);
      });

      // 詳細メニューの編集者連携に、編集者の操作が出る
      await focusPane(page, "詳細メニュー");
      await childrenOf(page, "詳細メニュー", "執筆データ", "作品管理");
      const editorEditorial = await childrenOf(page, "詳細メニュー", "執筆データ", "編集者連携");
      for (const shown of [...EDITOR_ONLY, "編集者提案確認"]) {
        expect(editorEditorial, `編集者の「編集者連携」に「${shown}」がありません：${JSON.stringify(editorEditorial)}`).toContain(shown);
      }
      expect(editorEditorial, "編集者の「編集者連携」に「編集者の提案を見る」があります").not.toContain("編集者の提案を見る");
      expect(await editorialWords(page), "編集者モードのメニュー・知らせに「編集部」が残っています").toEqual([]);

      /* ── 2. 「修正を提案する」（325・320） ── */
      // 選ばずに押す → 案内
      await clearNotifications(page);
      await openPlain(session);
      const propose = await scrollTreeUntilRow(page, "執筆データ", "修正を提案する");
      await propose.click();
      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("修正したい所を本文で選んでから押してください（右クリックからも出せます）。")),
        "選ばずに押すと、本文で選んでから押す案内が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      await clearNotifications(page);

      // 素のエディターで1行を選んでから、右クリックにも「修正を提案する」があることを見る
      await focusTextEditor(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("Shift+End");
      await dismissWorkbenchHover(page);
      await page.locator(".monaco-editor .view-lines").first().click({ button: "right", position: { x: 40, y: 8 } });
      const menuItem = page.locator(".monaco-menu .action-label", { hasText: "修正を提案する" }).first();
      await waitUntil(async () => (await menuItem.count()) > 0 && (await menuItem.isVisible()), "素のエディターの右クリックに「修正を提案する」が出る", 10_000);
      await page.keyboard.press("Escape");

      // 選び直して、詳細メニューから押す → 修正案の入力へ進む
      await focusTextEditor(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("Shift+End");
      await (await scrollTreeUntilRow(page, "執筆データ", "修正を提案する")).click();
      await waitForQuickInput(page, "修正を提案する（1/2）：修正案", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／入力欄の文：${JSON.stringify(await quickInputMessage(page))}）`);
      });
      await page.keyboard.press("Escape");
      // 取りやめたので、本文も提案も変わらない
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT);

      /* ── 3. 作者モードへ戻す ── */
      await clearNotifications(page);
      await focusPane(page, "詳細メニュー");
      await (await scrollTreeUntilRow(page, "執筆データ", labelOf("novelai.switchMode"))).click();
      await waitDialog(page, "この環境を「作者」に戻しますか。", "「作者」に戻すかの確認の窓が出る");
      await pressDialogButton(page, "作者に戻す");
      await focusPane(page, "簡単ステップメニュー");
      await waitUntil(async () => JSON.stringify(await stepLabels(page)) === JSON.stringify(AUTHOR_STEPS), "作者モードへ戻すと元の並びに戻る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの段：${JSON.stringify(await stepLabels(page))}）`);
        }
      );

      // 作者モードで「修正を提案する」を直に呼ぶと、理由が出る
      await clearNotifications(page);
      await openPlain(session);
      await pressWorkbenchKey(page, PROPOSE_PRESS);
      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("「修正を提案する」は、編集者モードで使う操作です。")),
        "作者モードで押すと「編集者モードで使う操作です」と理由が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
    },
    LAUNCH
  );
}, 300_000);
