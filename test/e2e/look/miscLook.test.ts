/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、ほかの小さな画面の写真（プロットモードの知らせの帯・
 * 機能別AI割当の案内・Ollama導入の案内・AIチューニングの確認画面ほか。2026-10-09 の二段目）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama（または空のモデル一覧を返す偽のサーバー）を使う。**判断は作者がする**。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { runCommand } from "../support/quickInput";
import { SIDEBAR_LAUNCH } from "../support/sidebar";
import { withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage, shootPageKeepingToasts } from "./lookSupport";
import { openPlotMode } from "./nameLookSupport";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => "{}", { extraModels: ["e2e-fake:2b"] });
});
afterAll(async () => {
  await fake.close();
});

/** 選ぶ画面の題・行を残して返す（探索用） */
async function describePick(page: Page, label: string): Promise<string> {
  const title = (await quickPickTitle(page)) ?? "";
  const rows = await quickPickRows(page);
  const text = `${title}｜${rows.map((row) => `${row.label}〔${row.description}〕`).join(" / ")}`;
  await lookNote(`[${label}] ${text.slice(0, 700)}`);
  return text;
}

describe.skipIf(!lookEnabled)("見た目の写真：そのほかの画面", () => {
  test("プロットモードの上の知らせの帯（形の違う名前のファイルがある作品）", async () => {
    await withVsCode(
      "見た目の写真：プロットモードの帯",
      [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
      async (session) => {
        const { page } = session;
        const plot = await openPlotMode(session);
        await waitUntil(async () => ((await plot.locator("#notice").innerText().catch(() => "")) ?? "").includes("episode_0005.md"), "知らせの帯に名前の断りが出る", 30_000);
        await lookNote(`[369] 帯の文：${await plot.locator("#notice").innerText()}`);
        await page.waitForTimeout(800);
        await shootPage(page, "369-プロットモード-上の帯");
      },
      {
        ...SIDEBAR_LAUNCH,
        windowSize: { width: 1280, height: 800 },
        settings: { ...SIDEBAR_LAUNCH.settings, "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" } },
        prepareWork: async ({ workFolder }) => {
          await mkdir(path.join(workFolder, "設定", "episode-plots"), { recursive: true });
          await writeFile(path.join(workFolder, "設定", "plot.md"), "# 見本の物語\n\n## 主要登場人物\n- 主人公：高校生。\n", "utf8");
          await writeFile(path.join(workFolder, "設定", "episode-plots", "第1話.md"), "第1話の予定\n", "utf8");
          await writeFile(path.join(workFolder, "設定", "episode-plots", "episode_0005.md"), "第5話の案\n", "utf8");
        },
      }
    );
  });

  test("機能別AI割当の選ぶ画面と、割り当てたあとのAIチューニングの知らせ・確認画面", async () => {
    await withVsCode(
      "見た目の写真：機能別AI割当",
      [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
      async (session) => {
        const { page } = session;
        await clearNotifications(page);
        await runCommand(page, "機能別AI割当");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どの機能のAI"), "機能の一覧が出る", 20_000);
        await page.waitForTimeout(800);
        await describePick(page, "389");
        await shootPage(page, "389-機能別AI割当-機能の一覧");

        // 誤字脱字を選び、使うAIを選び直す（偽の Ollama のモデル）
        await pickQuickPickRow(page, "誤字脱字");
        for (let step = 0; step < 12; step++) {
          await page.waitForTimeout(1200);
          await passLocalAiGate(page);
          const dialog = await dialogText(page);
          if (dialog) {
            await lookNote(`[419] 出た確認：${dialog.replace(/\s+/g, " ").slice(0, 200)}`);
            await pressDialogButton(page, "続ける").catch(() => pressDialogButton(page, "OK")).catch(() => undefined);
            continue;
          }
          const title = (await quickPickTitle(page)) ?? "";
          if (title === "") {
            const toasts = await page.locator(".notification-toast").allInnerTexts();
            if (toasts.some((text) => text.includes("実行するようにしました"))) break;
            continue;
          }
          const text = await describePick(page, `419-手順${step}`);
          if (title.includes("で使うAI")) await pickQuickPickRow(page, "使うAIを選ぶ");
          else if (/プロバイダ|AI.*選/.test(title) && text.includes("Ollama")) await pickQuickPickRow(page, "Ollama");
          else if (text.includes("e2e-fake")) await pickQuickPickRow(page, "e2e-fake:2b");
          else break;
        }
        await page.waitForTimeout(1500);
        const toasts = await page.locator(".notification-toast").allInnerTexts();
        await lookNote(`[419] 割り当てたあとの知らせ：${toasts.map((text) => text.replace(/\s+/g, " ")).join(" ／ ")}`);
        await shootPageKeepingToasts(page, "419-割り当てたあとの知らせ");
        const button = page.locator(".notification-toast", { hasText: "測っていません" }).locator("a.monaco-button, .monaco-button", { hasText: "AIチューニングで測る" }).first();
        if ((await button.count()) > 0) {
          await button.click();
          await waitUntil(async () => (await quickPickTitle(page)) !== undefined || (await dialogText(page)) !== undefined, "確認画面が出る", 20_000);
          await page.waitForTimeout(800);
          const dialog = await dialogText(page);
          if (dialog) await lookNote(`[419] 確認の窓：${dialog.replace(/\s+/g, " ").slice(0, 400)}`);
          else await describePick(page, "419-測る画面");
          await shootPageKeepingToasts(page, "419-AIチューニングで測るを押したあと");
          // 「読める長さだけ測る」を選んで、測る先が出る次の画面を見る（見たら取りやめる）
          await pickQuickPickRow(page, "読める長さだけ測る");
          await page.waitForTimeout(2500);
          for (let step = 0; step < 8; step++) {
            await passLocalAiGate(page);
            await page.waitForTimeout(1200);
            const next = await dialogText(page);
            if (next) {
              await lookNote(`[419] 次の確認の窓：${next.replace(/\s+/g, " ").slice(0, 600)}`);
              await shootPage(page, `419-測る先の確認の窓`);
              await page.keyboard.press("Escape");
              break;
            }
            if ((await quickPickTitle(page)) !== undefined) {
              await describePick(page, "419-次の画面");
              await shootPage(page, `419-測る先の確認画面`);
              await page.keyboard.press("Escape");
              break;
            }
            if (step === 7) {
              const after = await page.locator(".notification-toast, .notifications-toasts").allInnerTexts();
              await lookNote(`[419] 選んだあと8回見ても確認の窓・選ぶ画面は出ませんでした。知らせ：${after.map((text) => text.replace(/\s+/g, " ")).join(" ／ ")}`);
              await shootPageKeepingToasts(page, "419-読める長さだけを選んだあと");
            }
          }
        } else {
          await lookNote("[419] 「AIチューニングで測る」の知らせは出ませんでした");
        }
      },
      fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 800 } })
    );
  });

  test("Ollama導入の案内（モデルが1つも無いとき）", async () => {
    // 空のモデル一覧を返す偽のサーバー（モデルが1つも無い Ollama）
    const empty = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url?.startsWith("/api/tags") ? JSON.stringify({ models: [] }) : "Ollama is running");
    });
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(empty.address() as AddressInfo).port}`;
    try {
      await withVsCode(
        "見た目の写真：Ollama導入の案内",
        [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
        async (session) => {
          const { page } = session;
          await clearNotifications(page);
          await runCommand(page, "Ollama導入");
          await waitUntil(
            async () => (await page.locator(".notification-toast", { hasText: "モデルが1つもありません" }).count()) > 0,
            "モデルが無いという案内が出る",
            30_000
          );
          await page.waitForTimeout(800);
          const text = await page.locator(".notification-toast", { hasText: "モデルが1つもありません" }).first().innerText();
          await lookNote(`[389] Ollama導入の案内：${text.replace(/\s+/g, " ")}`);
          await shootPageKeepingToasts(page, "389-Ollama導入の案内");
        },
        { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 800 }, settings: { ...SIDEBAR_LAUNCH.settings, "novelai.ollama.endpoint": endpoint } }
      );
    } finally {
      await new Promise<void>((resolve) => {
        empty.closeAllConnections();
        empty.close(() => resolve());
      });
    }
  });
});
