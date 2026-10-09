/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、左の列（作品一覧・詳細メニュー）と右クリックの品書きの写真
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。AI は呼ばない。
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { describe, test } from "vitest";
import { initRepoWithFirstCommit } from "../support/gitFixture";
import { openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { contextMenuLabels, expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeRow, treeRowLabels } from "../support/sidebar";
import { turnVertical, VERTICAL_LAUNCH } from "../support/verticalFace";
import { E2E_WORK_TITLE, withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { focusTextEditor, pressWorkbenchKey, quickOpen, quickPickRows, quickPickTitle, textEditorVisibleText } from "../support/workbenchDom";
import { lookEnabled, lookNote, setPane, setRow, setSidebarWidth, shootPage, shootWithZoom } from "./lookSupport";

const EPISODE = "001_はじまり.txt";
const LAUNCH = { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 800 } };

describe.skipIf(!lookEnabled)("見た目の写真：左の列", () => {
  test("詳細メニュー（既定の幅と狭い幅）", async () => {
    await withVsCode(
      "見た目の写真：詳細メニュー",
      [{ name: EPISODE, text: "一行目の文。\n" }],
      async (session) => {
        const { page } = session;
        await openEpisode(page, EPISODE, "一行目の文");
        await showSidebar(page, E2E_WORK_TITLE);
        await setPane(page, "作品一覧", false);
        await setPane(page, "簡単ステップメニュー", false);
        const clip = { x: 0, y: 30, width: 350, height: 750 };
        await lookNote(`[181] 既定の左の列の幅：${(await page.locator(".part.sidebar").first().boundingBox())?.width}`);

        // ── 既定の幅 ──
        await setRow(page, "環境設定", true);
        await setRow(page, "初回設定", true);
        await lookNote(`[181] 環境設定を開いた行：${JSON.stringify(await treeRowLabels(page))}`);
        await shootWithZoom(page, "181-詳細メニュー-環境設定-AIチューニング-既定の幅", clip);
        await setRow(page, "環境設定", false);

        await setRow(page, "作品執筆", true);
        await setRow(page, "原稿整備", true);
        await shootWithZoom(page, "181-詳細メニュー-原稿整備-章立て取込-既定の幅", clip);
        await setRow(page, "作品執筆", false);

        await setRow(page, "資料管理", true);
        await setRow(page, "資料閲覧", true);
        await shootWithZoom(page, "181-詳細メニュー-紹介文あらすじ-既定の幅", clip);
        await setRow(page, "資料管理", false);

        // ── 狭い幅（約240px） ──
        const narrow = await setSidebarWidth(page, 240);
        await lookNote(`[608] 狭くした左の列の幅：${narrow}`);
        await setRow(page, "環境設定", true);
        await setRow(page, "初回設定", true);
        await shootWithZoom(page, "608-詳細メニュー-環境設定-狭い幅", clip);
        await setRow(page, "環境設定", false);
        await setRow(page, "作品執筆", true);
        await setRow(page, "相談・助言", true);
        await shootWithZoom(page, "608-詳細メニュー-相談助言-狭い幅", clip);
        await setRow(page, "原稿整備", true);
        await shootWithZoom(page, "608-詳細メニュー-原稿整備-狭い幅", clip);
        await setRow(page, "作品執筆", false);
        await setRow(page, "新作構想", true);
        await shootWithZoom(page, "608-詳細メニュー-新作構想-狭い幅", clip);
      },
      LAUNCH
    );
  });

  test("長い題の作品の［記録待ち］の印（作品一覧の既定の幅）", async () => {
    const title = "ハイエルフ未亡人のお気楽資産運用～食っちゃ寝ライフを送りたい";
    await withVsCode(
      "見た目の写真：長い題の記録待ち",
      [{ name: EPISODE, text: "一行目の文。\n" }],
      async (session) => {
        const { page } = session;
        await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
        const row = page.locator(`.monaco-list-row[aria-expanded][aria-label*="ハイエルフ"]`).first();
        await waitUntil(async () => (await row.count()) > 0, "作品の行が出る");
        await appendFile(path.join(session.manuscriptFolder, EPISODE), "足した一行。\n", "utf8");
        await waitUntil(async () => ((await row.getAttribute("aria-label")) ?? "").includes("記録待ち"), "記録待ちの印が付く", 30_000);
        await lookNote(`[312] 作品の行の名前：${await row.getAttribute("aria-label")}`);
        await lookNote(`[312] 左の列の幅：${(await page.locator(".part.sidebar").first().boundingBox())?.width}`);
        await shootWithZoom(page, "312-長い題の記録待ち-既定の幅", { x: 0, y: 30, width: 350, height: 200 });
      },
      { ...LAUNCH, workTitle: title, prepareWork: ({ workFolder }) => initRepoWithFirstCommit(workFolder) }
    );
  });

  test("ヘルプの場面別案内", async () => {
    await withVsCode(
      "見た目の写真：場面別案内",
      [{ name: EPISODE, text: "一行目の文。\n" }],
      async (session) => {
        const { page } = session;
        await openEpisode(page, EPISODE, "一行目の文");
        await showSidebar(page, E2E_WORK_TITLE);
        await setPane(page, "作品一覧", false);
        await setPane(page, "簡単ステップメニュー", false);
        await setRow(page, "ヘルプ", true);
        await shootWithZoom(page, "825-ヘルプの並び", { x: 0, y: 30, width: 350, height: 750 });
        await treeRow(page, "場面別案内").click();
        await waitUntil(async () => (await quickPickTitle(page)) !== undefined, "場面を選ぶ画面が出る", 20_000);
        await page.waitForTimeout(800);
        const rows = await quickPickRows(page);
        await lookNote(`[825] 場面の一覧（${await quickPickTitle(page)}）：${rows.map((row) => `${row.label}〔${row.description}〕`).join(" / ")}`);
        await shootPage(page, "825-場面を選ぶ画面");
        await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").first().click();
        await page.waitForTimeout(4000);
        await lookNote(`[825] 選んだあとの題：${await quickPickTitle(page)}`);
        await shootPage(page, "825-場面を選んだあと");
      },
      LAUNCH
    );
  });
});

describe.skipIf(!lookEnabled)("見た目の写真：右クリックの品書きとコマンドの名前", () => {
  test("原稿エディターの右クリック（横書き・縦書き）と、ルビ・傍点の名前", async () => {
    await withVsCode(
      "見た目の写真：原稿の右クリック",
      [{ name: EPISODE, text: "　右クリックを試す行。\n　二行目の文。\n" }],
      async (session) => {
        const { page } = session;
        const frame = await openEpisode(page, EPISODE, "右クリックを試す行");
        await placeCaretAfter(frame, "右クリック");
        await frame.locator("#compose").click({ button: "right" });
        await waitUntil(async () => ((await frame.locator("#menu").innerText().catch(() => "")) ?? "").length > 0, "右クリックの品書きが出る");
        await lookNote(`[129・166] 横書きの右クリックの品書き：${(await frame.locator("#menu").innerText()).split("\n").join(" / ")}`);
        await shootPage(page, "129-右クリック-横書き");
        await shootPage(page, "166-原稿エディターの右クリック-横書き");
        await page.keyboard.press("Escape");

        const vertical = await turnVertical(session, "右クリックを試す行");
        await placeCaretAfter(vertical, "右クリック");
        await vertical.locator("#compose").click({ button: "right" });
        await waitUntil(async () => ((await vertical.locator("#menu").innerText().catch(() => "")) ?? "").length > 0, "縦書きの右クリックの品書きが出る");
        await shootPage(page, "129-右クリック-縦書き");
      },
      { ...VERTICAL_LAUNCH, windowSize: { width: 1280, height: 800 } }
    );
  });

  test("コマンドパレット・作品一覧の右クリックの名前", async () => {
    await withVsCode(
      "見た目の写真：名前の4か所",
      [
        { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
        { name: "第2話_つづき.md", text: "二話の本文。\n" },
      ],
      async (session) => {
        const { page } = session;
        await showSidebar(page, E2E_WORK_TITLE);
        await expandTreeRow(page, E2E_WORK_TITLE);
        await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第1話")), "作品の下に話が並ぶ");

        // 作品の右クリック（181「章立て取込（バックアップから）」）
        await treeRow(page, E2E_WORK_TITLE).click({ button: "right" });
        await waitUntil(async () => (await contextMenuLabels(page)).length > 0, "作品の右クリックの品書きが出る");
        await lookNote(`[181] 作品の右クリックの品書き：${(await contextMenuLabels(page)).join(" / ")}`);
        await shootPage(page, "181-作品の右クリック");
        await page.keyboard.press("Escape");

        // 話の右クリック（166 作品一覧の話）
        await treeRow(page, "第1話").click({ button: "right" });
        await waitUntil(async () => (await contextMenuLabels(page)).length > 0, "話の右クリックの品書きが出る");
        await lookNote(`[166] 話の右クリックの品書き：${(await contextMenuLabels(page)).join(" / ")}`);
        await shootPage(page, "166-作品一覧の話の右クリック");
        await page.keyboard.press("Escape");

        // コマンドパレット（166「コピー（投稿サイト用）」、181「章立て取込（バックアップから）」）
        const copy = await commandPaletteShot(page, "コピー（投稿サイト用）", "166-コマンドパレット-コピー投稿サイト用");
        await lookNote(`[166] パレットの並び：${copy.join(" / ")}`);
        const chapters = await commandPaletteShot(page, "章立て取込", "181-コマンドパレット-章立て取込");
        await lookNote(`[181] パレットの並び：${chapters.join(" / ")}`);
      },
      LAUNCH
    );
  });

  test(".md を素のテキストエディターで開いた右クリック", async () => {
    await withVsCode(
      "見た目の写真：md の右クリック",
      [{ name: "第2話_つづき.md", text: "# 二話\n\n二話の本文。\n" }],
      async (session) => {
        const { page } = session;
        await quickOpen(page, "第2話_つづき.md");
        await waitUntil(async () => (await textEditorVisibleText(page)).includes("二話の本文"), "素のエディターに本文が出る", 20_000);
        await focusTextEditor(page);
        await page.locator(".editor-group-container.active .monaco-editor .view-lines").first().click({ button: "right" });
        // 素のエディターの右クリックは、品書きが影の DOM（shadow root）の中に描かれる
        const monacoMenuLabels = () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll(".shadow-root-host")).flatMap((host) =>
              Array.from(host.shadowRoot?.querySelectorAll(".action-label") ?? []).map((item) => (item.textContent ?? "").trim())
            )
          );
        await waitUntil(async () => (await monacoMenuLabels()).length > 0, ".md の右クリックの品書きが出る");
        await lookNote(`[166] .md の右クリックの品書き：${(await monacoMenuLabels()).join(" / ")}`);
        await shootPage(page, "166-md-素のエディターの右クリック");
      },
      {
        ...LAUNCH,
        settings: { ...SIDEBAR_LAUNCH.settings, "workbench.editorAssociations": { "*.md": "default", "*.txt": "default" } },
      }
    );
  });
});

/** コマンドパレットに `query` を打って、並びを写真に撮り、行の名前を返して閉じる */
async function commandPaletteShot(page: Page, query: string, name: string): Promise<string[]> {
  await page.keyboard.press("Control+Shift+KeyP");
  await page.locator(".quick-input-widget input").first().waitFor({ state: "visible" });
  await page.keyboard.insertText(query);
  let labels: string[] = [];
  await waitUntil(
    async () => {
      labels = (await quickPickRows(page)).map((row) => row.label);
      return labels.length > 0;
    },
    `パレットに「${query}」の候補が出る`,
    10_000
  );
  await page.waitForTimeout(800);
  await shootPage(page, name);
  await page.keyboard.press("Escape");
  return labels;
}
