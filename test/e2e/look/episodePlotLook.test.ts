/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、単話プロットの「設計を検査」の結果の写真
 * （「単話プロットの講評」の紙が別に開くか。指摘が0件のとき、完了の知らせに「直すべき所は見当たりません」。
 * 2026-10-09 の二段目。判断は作者がする）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama が決まった答えを返す。**判定の出来は見えない**。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { plotPanelFrame } from "./nameLookSupport";
import { expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeContextMenu } from "../support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { editorGroupTabs, pickQuickPickRow, quickPickRows } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage, shootPageKeepingToasts } from "./lookSupport";

const EPISODE = "第1話_はじまり.txt";
const BODY = "　朝、リナは港の市場へ出かけた。\n　リナは船着き場へ向かった。\n";
const PLOT = [
  "# 第1話の単話プロット",
  "",
  "## 視点",
  "リナの三人称",
  "",
  "## この話の目標",
  "リナが市場から船着き場へ向かう",
  "",
  "## 展開（箇条書き）",
  "- リナが港の市場へ出かける",
  "- リナが船着き場へ向かう",
  "- 日が暮れて宿へ戻る",
  "",
].join("\n");

let withFinding = true;
let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() =>
    JSON.stringify({
      strengths: [{ item: "リナが船着き場へ向かう", why: "目標へ向かう動きが、はっきり1つの行で書かれています" }],
      findings: withFinding ? [{ item: "日が暮れて宿へ戻る", kind: "目標に向かっていない", reason: "目標は船着き場へ向かうことですが、この行は宿へ戻る話で、目標から離れています" }] : [],
    })
  );
});
afterAll(async () => {
  await fake.close();
});

describe.skipIf(!lookEnabled)("見た目の写真：単話プロットの設計を検査", () => {
  for (const found of [true, false]) {
    test(found ? "指摘が1件あるとき" : "指摘が0件のとき", async () => {
      withFinding = found;
      await withVsCode(
        "見た目の写真：設計を検査",
        [{ name: EPISODE, text: BODY }],
        async (session) => {
          const { page } = session;
          await showSidebar(page, E2E_WORK_TITLE);
          await expandTreeRow(page, E2E_WORK_TITLE);
          await treeContextMenu(page, E2E_WORK_TITLE, "プロットモード");
          let panel: Frame | undefined;
          await waitUntil(async () => (panel = await plotPanelFrame(page)) !== undefined, "プロットモードのパネルが開く", 30_000);
          const plot = panel as Frame;
          const design = plot.locator('button.check-plot[data-check="design"]').first();
          await waitUntil(async () => (await design.count()) > 0, "第1話の行に［設計を検査］が出る", 30_000);
          await design.click();
          let toast = "";
          await waitUntil(
            async () => {
              await passLocalAiGate(page);
              const rows = await quickPickRows(page);
              if (rows.some((row) => row.label.includes("実行"))) await pickQuickPickRow(page, "実行").catch(() => undefined);
              const toasts = await page.locator(".notification-toast").allInnerTexts();
              const hit = toasts.find((text) => text.includes("見当たりません") || text.includes("単話プロット"));
              if (hit && toast === "") {
                toast = hit.replace(/\s+/g, " ");
                await shootPageKeepingToasts(page, `729-設計を検査-${found ? "指摘1件" : "指摘0件"}-完了の知らせ`);
              }
              return (await editorGroupTabs(page)).flat().some((name) => name.includes("講評"));
            },
            "単話プロットの講評の紙が開く",
            90_000
          ).catch(async (error: unknown) => {
            await lookNote(`[729] ${found ? "1件" : "0件"}：講評の紙が開かなかった：${String(error).slice(0, 100)}／タブ ${JSON.stringify(await editorGroupTabs(page))}`);
          });
          await page.waitForTimeout(1500);
          await lookNote(`[729] ${found ? "指摘1件" : "指摘0件"}：完了の知らせ：${toast || "（撮れませんでした）"}／タブ：${JSON.stringify(await editorGroupTabs(page))}`);
          await shootPage(page, `729-設計を検査-${found ? "指摘1件" : "指摘0件"}-講評の紙`);
        },
        fakeOllamaLaunch(fake, {
          ...SIDEBAR_LAUNCH,
          windowSize: { width: 1280, height: 900 },
          settings: { ...SIDEBAR_LAUNCH.settings, "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" } },
          prepareWork: async ({ workFolder }) => {
            const folder = path.join(workFolder, "設定", "episode-plots");
            await mkdir(folder, { recursive: true });
            await writeFile(path.join(folder, "第1話.md"), PLOT, "utf8");
          },
        })
      );
    });
  }
});
