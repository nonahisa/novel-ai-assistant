/**
 * 作品一覧の右クリックから始める2つ——章立てとプロットモード
 * （画面の自動テスト、設計書6.113。実機確認リスト F-60・F-71 を 2026-10-04 に移した）。
 *
 * 何を見張るか：
 * - **章を始める**（6.66.1）：話の右クリック「ここから章を始める」→ 名前を打つと、
 *   章より前の話は作品の直下に残り、章の行に「第3話〜第4話・2話」が添えられ、
 *   台帳（`設定/章立て.json`）にその話から始まる章が入る
 * - **プロットモード**（6.4.8）：作品の右クリック「プロットモード」で、左に plot.md・
 *   右にパネルが並び、入力の場所（焦点）は左に残る。左で見出しを書いて保存すると、
 *   右の目次が開き直さずに追いつく
 *
 * 表示の形（範囲と件数の書き方・並び）は単体テスト `workTreeChapters.test.ts` が見ている。
 * ここで見るのは「右クリック → 入力 → 一覧が描き直される」の道が通ること。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { answerInput, waitForQuickInput } from "./support/quickInput";
import {
  expandTreeRow,
  showSidebar,
  SIDEBAR_LAUNCH,
  treeContextMenu,
  treeRowLabels,
} from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeGroupIndex, editorGroupTabs, focusTextEditor } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
  { name: "第3話_山場.txt", text: "三話の本文。\n" },
  { name: "第4話_おわり.txt", text: "四話の本文。\n" },
];

const CHAPTER_NAME = "第二章　旅立ち";

/** プロットモードのパネル（目印は「主要登場人物の名前」の見出し `#namesHeading`） */
async function plotPanelFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("namesHeading") !== null && document.getElementById("headings") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

test("話の右クリック「ここから章を始める」で名前を入れると章の行が範囲つきで出て台帳に入り、作品の右クリック「プロットモード」で左に plot.md・右にパネルが並び、見出しを足して保存すると目次が追いつく", async () => {
  await withVsCode(
    "章立てとプロットモード",
    EPISODES,
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);
      await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第4話")), "作品の下に話が並ぶ");

      /* ── 章を始める（F-60） ── */
      await treeContextMenu(page, "第3話", "ここから章を始める");
      await waitForQuickInput(page, "ここから章を始める");
      await answerInput(page, CHAPTER_NAME);

      // 一覧が描き直され、章の行に範囲と件数が添えられる（行の名前に添え書きも入る）
      await waitUntil(
        async () => (await treeRowLabels(page)).some((label) => label.startsWith(CHAPTER_NAME)),
        "作品一覧に章の行が出る"
      );
      const labels = await treeRowLabels(page);
      const chapterRow = labels.find((label) => label.startsWith(CHAPTER_NAME)) ?? "";
      expect(chapterRow, `章の行：${chapterRow}`).toContain("第3話〜第4話・2話");
      // 章より前の話（第1・2話）は、章の行より上に作品の直下として並ぶ
      const indexOf = (head: string) => labels.findIndex((label) => label.startsWith(head));
      expect(indexOf("第1話"), `並び：${labels.join(" / ")}`).toBeGreaterThanOrEqual(0);
      expect(indexOf("第1話")).toBeLessThan(indexOf(CHAPTER_NAME));
      expect(indexOf("第2話")).toBeLessThan(indexOf(CHAPTER_NAME));

      // 台帳に、第3話から始まる章として入る
      const ledger = JSON.parse(
        await readFile(path.join(session.workFolder, "設定", "章立て.json"), "utf8")
      ) as { chapters: Array<{ name: string; startEpisodePath: string }> };
      expect(ledger.chapters).toEqual([{ name: CHAPTER_NAME, startEpisodePath: "本文/第3話_山場.txt" }]);

      /* ── プロットモード（F-71） ── */
      await treeContextMenu(page, E2E_WORK_TITLE, "プロットモード");
      let panel: Frame | undefined;
      await waitUntil(async () => (panel = await plotPanelFrame(page)) !== undefined, "プロットモードのパネルが開く", 30_000);
      await waitUntil(async () => {
        const groups = await editorGroupTabs(page);
        return groups.length === 2 && groups[0].includes("plot.md");
      }, "左の列に plot.md、右の列にパネルが並ぶ").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}）`);
      });
      // 入力の場所（焦点）は左の plot.md に残る（パネルは preserveFocus で開く）
      expect(await activeGroupIndex(page), "焦点が左の plot.md に残っていません").toBe(0);

      // 左で見出しを書いて保存すると、右の目次が追いつく
      if (!panel) throw new Error("プロットモードのパネルが見つかりません");
      const plotPanel = panel;
      const headingsText = () => plotPanel.evaluate(() => document.getElementById("headings")?.innerText ?? "");
      expect(await headingsText()).not.toContain("見張りの見出し");
      await focusTextEditor(page);
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.keyboard.insertText("## 見張りの見出し");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+KeyS");
      await waitUntil(
        async () => (await readFile(path.join(session.workFolder, "設定", "plot.md"), "utf8")).includes("## 見張りの見出し"),
        "打った見出しが plot.md に保存される"
      ).catch(async (error: unknown) => {
        const exists = await readFile(path.join(session.workFolder, "plot.md"), "utf8").catch(() => "（無し）");
        throw new Error(`${String(error)}（作品直下の plot.md：${exists.slice(0, 80)}）`);
      });
      await waitUntil(async () => (await headingsText()).includes("見張りの見出し"), "パネルの目次に足した見出しが出る");
    },
    {
      ...SIDEBAR_LAUNCH,
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        // plot.md は作者の既定の画面で開く（6.4.8）。土台の既定は .md を原稿エディターへ
        // 関連付けているので、ここでは .md を素のテキストエディターへ戻す
        "workbench.editorAssociations": {
          "*.txt": "novelai.manuscriptEditorHorizontal",
          "*.md": "default",
        },
      },
    }
  );
});
