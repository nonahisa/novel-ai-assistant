/**
 * 編集者モードで、原稿エディターの本文を選んでから詳細メニューの「修正を提案する」を押す（画面の自動テスト、
 * 設計書5.6・6.113。実機確認リスト 0.119.0 の「編集者モードで、本文を選んでから詳細メニュー →「作品管理」→
 * 「編集者連携」→「修正を提案する」を押すと…」のうち、e2e/editorModeMenus が素のエディターで見た残りの
 * 「原稿エディターで選んでから押したとき」を機械へ移した）。
 *
 * 見張ること：
 * - 原稿エディター（WebView）で本文の一部を選び、**左の列の木（詳細メニュー）を押す**——焦点が WebView から
 *   外れても、選んだ所が拡張機能に届いていて、入力欄「修正を提案する（1/2）：修正案」へ進む。欄の初めの字は
 *   選んだ所そのもの（`handProposal.ts` の `askHandProposal` が選んだ字を入れておく）
 * - 修正案と理由を入れて進めると、提案の台帳（`.aiwriter/proposals/proposals.jsonl`）に、選んだ所を的にした
 *   提案が1件置かれ、本文は変わらない（編集者は本文を書き換えない。設計書5.6）
 *
 * 選ばずに押したときの案内・作者モードで押したときの理由は e2e/editorModeMenus が見ている。
 * **GitHub は呼ばない**（作品は git にしない）。**AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode, selectText } from "./support/manuscriptFrame";
import { answerInput, quickInputMessage, waitForQuickInput, waitQuickInputClosed } from "./support/quickInput";
import { readJsonLines } from "./support/sampleFinding";
import { SIDEBAR_LAUNCH, expandTreeRow, scrollTreeUntilRow, showSidebar } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { notificationTexts, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = "　終電を逃した駅のホームに、雨の音だけが残っていた。\n";
const TARGET = "雨の音";
const SUGGESTION = "雨音";
const REASON = "音の字の重なりを避けたい";

/**
 * 左の列の区画を、見出しの左端（畳みの矢印）を押して開く・畳む（editorModeMenus と同じ押し方）。
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

test("編集者モードで原稿エディターの本文を選んでから詳細メニューの「修正を提案する」を押すと、選んだ字の入った修正案の入力へ進み、進めると選んだ所を的にした提案が台帳に置かれて本文は変わらない", async () => {
  await withVsCode(
    "編集者モードの原稿エディターから修正を提案する",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, workFolder, manuscriptFolder } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      // 木は見えている行しか描かないので、詳細メニューだけを開いて背を高くする（押す前に整えておく）
      for (const pane of ["作品一覧", "簡単ステップメニュー", "AIに相談"]) await setSidebarPane(page, pane, false);
      await setSidebarPane(page, "詳細メニュー", true);
      await scrollTreeUntilRow(page, "執筆データ", "作品管理");
      await expandTreeRow(page, "作品管理");
      await scrollTreeUntilRow(page, "執筆データ", "編集者連携");
      await expandTreeRow(page, "編集者連携");

      // 原稿エディターで選ぶ
      const frame = await openEpisode(page, EPISODE, TARGET);
      await selectText(frame, TARGET);
      // 選んだ所が拡張機能へ届く間（選択の便は WebView から送られる）
      await page.waitForTimeout(1_000);

      // 詳細メニューの「修正を提案する」を押す（焦点は WebView から木へ移る）
      const row = await scrollTreeUntilRow(page, "執筆データ", "修正を提案する");
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await waitForQuickInput(page, "修正を提案する（1/2）：修正案", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／入力欄の文：${JSON.stringify(await quickInputMessage(page))}）`);
      });
      // 欄の初めの字は、原稿エディターで選んだ所
      const initial = await page.locator(".quick-input-widget input").first().inputValue();
      expect(initial, `修正案の欄の初めの字が、選んだ所ではありません：${initial}`).toBe(TARGET);
      expect(await quickInputMessage(page), "入力欄の説明に選んだ所が出ていません").toContain(`「${TARGET}」`);

      // 進めて、提案を置く
      await answerInput(page, SUGGESTION);
      await waitForQuickInput(page, "修正を提案する（2/2）：理由・意見", 15_000);
      await answerInput(page, REASON);
      await waitQuickInputClosed(page, "修正を提案するの入力欄が閉じる");

      const ledgerFile = path.join(workFolder, ".aiwriter", "proposals", "proposals.jsonl");
      let rows: Array<Record<string, unknown>> = [];
      await waitUntil(
        async () => {
          rows = (await readJsonLines(ledgerFile)).filter((entry) => entry.kind === "proposal");
          return rows.length > 0;
        },
        "提案の台帳に1件置かれる",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／下の帯：${JSON.stringify(await statusBarTexts(page))}）`);
      });
      expect(rows.length, `提案の行：${JSON.stringify(rows)}`).toBe(1);
      expect(rows[0]?.target, `提案の行：${JSON.stringify(rows[0])}`).toBe(TARGET);
      expect(rows[0]?.suggestion).toBe(SUGGESTION);
      expect(rows[0]?.reason).toBe(REASON);
      expect(rows[0]?.file).toBe(`本文/${EPISODE}`);
      // 本文は変わらない
      expect((await readFile(path.join(manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT);
    },
    {
      settings: { ...SIDEBAR_LAUNCH.settings, "novelai.mode": "editor" },
      keybindings: SIDEBAR_LAUNCH.keybindings,
    }
  );
}, 180_000);
