/**
 * 小さいモデルで検知の機能を動かす前の知らせ（作者の裁定 2026-10-10「4B以下にはまとめて
 * メッセージを出す等の工夫が必要」。設計書6.28.9）。
 *
 * 見張ること：
 * - 申告の大きさが小さいモデル（偽の Ollama の "1B"）で検知の機能（ここでは単話プロットの
 *   「本文と照合」。割当は逸脱と同じ）を押すと、処理量の確認と一緒に右下へ知らせが出る。
 *   ［機能別AI割当を開く］［今後出さない］が並ぶ
 * - 知らせは確認の画面（選ぶ画面）にもモーダルにも重ねない——確認はふだんどおり出る
 * - 同じ作品・同じモデルなら、2回目には出ない（毎回しつこく出さない）
 * - 大きいモデル（"25.2B"）では出ない
 *
 * **本物の AI は呼ばない。** 確認で取りやめるので、偽の Ollama への生成の呼び出しも0回。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama } from "./support/fakeOllama";
import { expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeContextMenu } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, quickPickRows } from "./support/workbenchDom";

const EPISODE = "第1話_はじまり.txt";
const BODY = ["　朝、リナは港の市場へ出かけた。", "　リナは船着き場へ向かった。", ""].join("\n");
const PLOT = [
  "# 第1話の単話プロット",
  "",
  "## 展開（箇条書き）",
  "- リナが港の市場へ出かける",
  "- リナが船着き場へ向かう",
  "",
].join("\n");

/** 知らせの文の頭（`core/requirements.ts` の SMALL_MODEL_NOTICE） */
const NOTICE = "このAIは小さいため";

/** 右下の知らせのうち、小さいモデルの知らせの字。出ていなければ undefined */
async function smallModelToast(page: Page): Promise<string | undefined> {
  const toasts = page.locator(".notification-toast");
  const count = await toasts.count();
  for (let i = 0; i < count; i++) {
    const text = await toasts.nth(i).innerText().catch(() => "");
    if (text.includes(NOTICE)) return text;
  }
  return undefined;
}

/** プロットモードのパネル（目印は `#namesHeading`。`episodePlotContrast.test.ts` と同じ） */
async function plotPanelFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("namesHeading") !== null && document.getElementById("headings") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** プロットモードを開いて［本文と照合］を押し、処理量の確認が出るまで待つ */
async function pressContrastUntilConfirm(page: Page): Promise<void> {
  await treeContextMenu(page, E2E_WORK_TITLE, "プロットモード");
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await plotPanelFrame(page)) !== undefined, "プロットモードのパネルが開く", 30_000);
  if (!panel) throw new Error("プロットモードのパネルが見つかりません");
  const contrast = panel.locator('button.check-plot[data-check="contrast"]').first();
  await waitUntil(async () => (await contrast.count()) > 0, "第1話の行に［本文と照合］が出る", 30_000);
  await contrast.click();
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      return confirmShown(page);
    },
    "処理量の確認（選ぶ画面）が出る",
    30_000
  );
}

/**
 * 処理量の確認（選ぶ画面）が**見えているか**。`quickPickRows` は閉じたあとの画面にも
 * 前の行を読むので、窓が見えていることも確かめる
 */
async function confirmShown(page: Page): Promise<boolean> {
  const visible = await page.evaluate(() => {
    const widget = document.querySelector(".quick-input-widget") as HTMLElement | null;
    return widget !== null && widget.style.display !== "none" && widget.offsetParent !== null;
  });
  if (!visible) return false;
  const rows = await quickPickRows(page);
  return rows.some((row) => row.label.includes("照らし合わせます")) || rows[0]?.label === "実行";
}

/** 確認を取りやめる（AI を呼ばない） */
async function cancelConfirm(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await waitUntil(async () => !(await confirmShown(page)), "確認が閉じる", 10_000);
}

const PREPARE = {
  prepareWork: async ({ workFolder }: { workFolder: string }) => {
    const folder = path.join(workFolder, "設定", "episode-plots");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "第1話.md"), PLOT, "utf8");
  },
};

const SETTINGS = {
  ...SIDEBAR_LAUNCH.settings,
  "workbench.editorAssociations": {
    "*.txt": "novelai.manuscriptEditorHorizontal",
    "*.md": "default",
  },
};

test("小さいモデルで検知を押すと、確認と一緒に知らせが1回だけ出る（2回目は出ない）", async () => {
  const fake = await startFakeOllama(() => JSON.stringify({ findings: [] }));
  try {
    await withVsCode(
      "小さいモデルの知らせ",
      [{ name: EPISODE, text: BODY }],
      async ({ page }) => {
        await showSidebar(page, E2E_WORK_TITLE);
        await expandTreeRow(page, E2E_WORK_TITLE);
        await clearNotifications(page);

        /* ── 1回目：確認が出て、右下に知らせも出る ── */
        await pressContrastUntilConfirm(page);
        let toast: string | undefined;
        await waitUntil(async () => (toast = await smallModelToast(page)) !== undefined, "小さいモデルの知らせが出る", 15_000);
        expect(toast).toContain("大きいモデル（例：gemma4:26b）かクラウドのAIを勧めます");
        expect(toast, "どのモデルの話かが出ていません").toContain("1B");
        expect(toast).toContain("機能別AI割当を開く");
        expect(toast).toContain("今後出さない");
        // 確認の画面は知らせに隠れず、ふだんどおり出ている
        expect(await confirmShown(page), "確認の画面が出ていません").toBe(true);
        await cancelConfirm(page);
        await clearNotifications(page);

        /* ── 2回目：同じ作品・同じモデルなら出ない ── */
        await pressContrastUntilConfirm(page);
        await holdsFor(async () => (await smallModelToast(page)) === undefined, "2回目に知らせが出ないこと", 3_000);
        await cancelConfirm(page);
        expect(fake.requests.length, "確認で取りやめたので、偽のAIは呼ばれないはずです").toBe(0);
      },
      fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, settings: SETTINGS, ...PREPARE })
    );
  } finally {
    await fake.close();
  }
});

test("大きいモデル（申告 25.2B）では知らせを出さない", async () => {
  const fake = await startFakeOllama(() => JSON.stringify({ findings: [] }), { parameterSize: "25.2B" });
  try {
    await withVsCode(
      "大きいモデルには知らせない",
      [{ name: EPISODE, text: BODY }],
      async ({ page }) => {
        await showSidebar(page, E2E_WORK_TITLE);
        await expandTreeRow(page, E2E_WORK_TITLE);
        await clearNotifications(page);
        await pressContrastUntilConfirm(page);
        await holdsFor(async () => (await smallModelToast(page)) === undefined, "大きいモデルで知らせが出ないこと", 3_000);
        await cancelConfirm(page);
      },
      fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, settings: SETTINGS, ...PREPARE })
    );
  } finally {
    await fake.close();
  }
});
