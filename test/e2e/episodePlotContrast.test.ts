/**
 * プロットモードの「本文と照合」（P-28）の結果が、提案パネルの「単話プロットと本文」に出て、
 * 「本文を見る」で本文の該当行へ飛ぶ（画面の自動テスト、設計書6.36.3・6.113。実機確認リスト
 * 「わざと箇条書きに無い場面を本文に書いて「本文と照合」すると「単話プロットと本文」に出るか。
 * 「本文を見る」で該当行へ飛ぶか」を 2026-10-09 に移した）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama（`support/fakeOllama.ts`）が、決まった2件
 * （「箇条書きに無い」＝本文の引用つき、「出来事の欠落」＝箇条書きの行つき）を返す。
 * 見られるのは、答えが返ったあとの配線——コードの検証を通って（引用が本文に実在する・
 * 箇条書きの行が実在する）パネルの分類に並び、押すと行へ飛ぶこと。
 * **AI が本当に「箇条書きに無い場面」を見つけられるかは見えない**（`→〔AIの測定〕`。
 * 2026-09-25 の実接続の測定が記録にある）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { caretPosition, manuscriptFrames } from "./support/manuscriptFrame";
import { proposalPanelFrame } from "./support/sampleFinding";
import { expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeContextMenu } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickRows } from "./support/workbenchDom";

const EPISODE = "第1話_はじまり.txt";
const BODY = [
  "　朝、リナは港の市場へ出かけた。",
  "　市場の入口で、見知らぬ老人から古い地図を渡された。",
  "　リナは地図を懐にしまい、船着き場へ向かった。",
  "",
].join("\n");
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

const EXTRA_SCENE = "見知らぬ老人から古い地図を渡された";
const MISSING_ITEM = "日が暮れて宿へ戻る";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() =>
    JSON.stringify({
      findings: [
        {
          kind: "箇条書きに無い",
          plotItem: null,
          excerpt: EXTRA_SCENE,
          reason: "老人から地図を受け取る場面が本文にありますが、箇条書きに対応する行がありません",
        },
        {
          kind: "出来事の欠落",
          plotItem: MISSING_ITEM,
          excerpt: null,
          reason: "宿へ戻る場面が、本文のどこにも書かれていません",
        },
      ],
    })
  );
});
afterAll(async () => {
  await fake.close();
});

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

test("「本文と照合」で、箇条書きに無い場面と欠けた出来事が提案パネルの「単話プロットと本文」に並び、「本文を見る」でその行へ飛ぶ", async () => {
  await withVsCode(
    "単話プロットと本文の照合",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);

      /* ── プロットモードを開き、第1話の行の［本文と照合］を押す ── */
      await treeContextMenu(page, E2E_WORK_TITLE, "プロットモード");
      let panel: Frame | undefined;
      await waitUntil(async () => (panel = await plotPanelFrame(page)) !== undefined, "プロットモードのパネルが開く", 30_000);
      if (!panel) throw new Error("プロットモードのパネルが見つかりません");
      const plot = panel;
      const contrast = plot.locator('button.check-plot[data-check="contrast"]').first();
      await waitUntil(async () => (await contrast.count()) > 0, "第1話の行に［本文と照合］が出る（単話プロットがあり、本文もある話）", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（パネルの字：${JSON.stringify((await plot.evaluate(() => document.getElementById("episodes")?.innerText ?? "")).slice(0, 300))}）`);
        }
      );
      await contrast.click();

      /*
        ── 処理量の確認（上に出る選ぶ画面。「第1話の本文と、単話プロットを照らし合わせます。」
        「本文 68字と、展開の箇条書き 3件を送ります。」）→［実行］ ──
      */
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const rows = await quickPickRows(page);
          const detail = rows.map((row) => row.label).join(" ");
          if (!detail.includes("照らし合わせます")) return false;
          expect(detail, "確認に送る量（本文の字数・箇条書きの件数）が出ていません").toContain("箇条書き 3件を送ります");
          expect(rows[0]?.label).toBe("実行");
          await pickQuickPickRow(page, "実行");
          return true;
        },
        "処理量の確認が出て［実行］で進む",
        30_000
      );

      /* ── 提案パネルに「単話プロットと本文」として2件並ぶ ── */
      let proposals: Frame | undefined;
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          proposals = await proposalPanelFrame(page);
          return proposals !== undefined && (await proposals.locator(".location[data-action=\"jump\"]").count()) >= 2;
        },
        "提案パネルに指摘が2件並ぶ",
        60_000
      ).catch(async (error: unknown) => {
        const text = proposals ? await proposals.evaluate(() => document.body.innerText) : "（提案パネルが開いていません）";
        throw new Error(`${String(error)}（提案パネル：${JSON.stringify(text.slice(0, 400))}／偽のAIへの呼び出し：${fake.requests.length}回）`);
      });
      if (!proposals) throw new Error("提案パネルが見つかりません");
      const list = proposals;
      expect(fake.requests.length, "偽のAIが1回だけ呼ばれたはずです").toBe(1);
      expect(await list.evaluate(() => document.body.innerText), "分類名が「単話プロットと本文」ではありません").toContain("単話プロットと本文");
      const cards = list.locator(".issue");
      expect(await cards.count()).toBe(2);
      const first = (await cards.first().innerText()).replace(/\s+/g, " ");
      expect(first, "1件目に本文の引用が出ていません").toContain(EXTRA_SCENE);
      expect(first).toContain("箇条書きに無い");
      const second = (await cards.nth(1).innerText()).replace(/\s+/g, " ");
      expect(second, "2件目に箇条書きの行が出ていません").toContain(MISSING_ITEM);
      expect(second).toContain("出来事の欠落");
      // 適用の口は持たず、「本文を見る」と「単話プロットを開く」だけを出す
      expect(await list.locator('button[data-action="apply"]').count(), "［適用］が出ています").toBe(0);
      expect(await cards.first().locator('button[data-action="jump"]').innerText()).toBe("本文を見る");
      expect(await cards.first().locator('button[data-action="openSettings"]').innerText()).toBe("単話プロットを開く");

      /* ── 1件目の［本文を見る］で、引用のある2行目へ飛ぶ ── */
      await cards.first().locator('button[data-action="jump"]').click();
      await waitUntil(
        async () => {
          for (const frame of await manuscriptFrames(page)) {
            const caret = await caretPosition(frame).catch(() => undefined);
            if (caret?.lineText.includes(EXTRA_SCENE)) return true;
          }
          return false;
        },
        "［本文を見る］で、引用のある行（2行目）へ原稿のカーソルが来る",
        20_000
      );
      // 照合は本文を書き換えない
      const { readFile } = await import("node:fs/promises");
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(BODY);
    },
    fakeOllamaLaunch(fake, {
      ...SIDEBAR_LAUNCH,
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        // plot.md は作者の既定の画面で開く（6.4.8）。.md を素のテキストエディターへ戻す
        "workbench.editorAssociations": {
          "*.txt": "novelai.manuscriptEditorHorizontal",
          "*.md": "default",
        },
      },
      prepareWork: async ({ workFolder }) => {
        const folder = path.join(workFolder, "設定", "episode-plots");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "第1話.md"), PLOT, "utf8");
      },
    })
  );
});
