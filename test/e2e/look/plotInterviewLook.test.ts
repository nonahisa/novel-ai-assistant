/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、対話式プロット作成で人称（誰の目で語るか）を答えて
 * 「ここまでをプロットに書く」を押したときの、会話の文言と plot.md の写真
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama が、決まった問い（人称）と候補を返す。**問いの出来は見えない**。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { runCommand } from "../support/quickInput";
import { SIDEBAR_LAUNCH } from "../support/sidebar";
import { withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, setPane, shootPage } from "./lookSupport";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() =>
    JSON.stringify({
      mode: "ask",
      confirm: "",
      topic: "語り手",
      question: "この物語は、誰の目で語りますか？",
      why: "語り手が決まると、文体と描ける範囲が決まります",
      candidates: [
        { text: "凛の一人称", effect: "凛の心の中を直に書けます" },
        { text: "凛の三人称一元", effect: "凛の視点に沿って、少し距離を置いて書けます" },
        { text: "語り手を置かない三人称", effect: "出来事を外から淡々と書けます" },
      ],
      section: "narrativePerson",
    })
  );
});
afterAll(async () => {
  await fake.close();
});

async function chatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null).catch(() => false);
    if (ok) return frame;
  }
  return undefined;
}

describe.skipIf(!lookEnabled)("見た目の写真：対話式プロット作成の人称", () => {
  test("人称で「凛の一人称」を選んで、ここまでをプロットに書く", async () => {
    await withVsCode(
      "見た目の写真：対話式プロット作成",
      [{ name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
      async (session) => {
        const { page } = session;
        await clearNotifications(page);
        await runCommand(page, "対話式プロット作成");
        let chat: Frame | undefined;
        for (let step = 0; step < 20 && !chat; step++) {
          await page.waitForTimeout(1200);
          if ((await quickPickTitle(page)) !== undefined) {
            const rows = await quickPickRows(page);
            await lookNote(`[511] 選ぶ画面：${await quickPickTitle(page)}｜${rows.slice(0, 3).map((row) => row.label).join(" / ")}`);
            if (rows.length > 0) await pickQuickPickRow(page, rows[0].label).catch(() => undefined);
          }
          const dialog = await dialogText(page);
          if (dialog) await pressDialogButton(page, "続ける").catch(() => pressDialogButton(page, "OK")).catch(() => undefined);
          chat = await chatFrame(page);
        }
        if (!chat) throw new Error("相談パネルが見つかりません");
        const frame = chat;
        // 相談の欄に場所を空ける（ほかの部を畳む）
        for (const title of ["作品一覧", "簡単ステップメニュー", "詳細メニュー"]) await setPane(page, title, false);
        const logText = () => frame.evaluate(() => document.getElementById("log")?.innerText ?? "");
        const option = (text: string) => frame.locator("button.option", { hasText: text }).last();

        await waitUntil(async () => (await option("着想から掘る").count()) > 0, "型を選ぶ札が出る", 30_000);
        await option("着想から掘る").click();
        await waitUntil(async () => (await logText()).includes("着想"), "着想を尋ねる一言が出る", 30_000);
        await frame.locator("#input").click();
        await page.keyboard.insertText("港町で暮らす少女の凛が、消えた灯台守を探す話");
        await frame.locator("#send").click();
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            return (await option("凛の一人称").count()) > 0;
          },
          "人称を尋ねる問いと候補が出る",
          90_000
        );
        await page.waitForTimeout(800);
        await shootPage(page, "511-対話式プロット-人称を尋ねられたところ");
        await option("凛の一人称").click();
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            return (await option("ここまでをプロットに書く").count()) > 0;
          },
          "次の問いと［ここまでをプロットに書く］が出る",
          90_000
        ).catch(async (error: unknown) => {
          await lookNote(`[511] 次の問いが出なかった：会話の末尾 ${(await logText()).replace(/\s+/g, " ").slice(-500)}`);
          throw error;
        });
        await page.waitForTimeout(800);
        await option("ここまでをプロットに書く").click();
        await waitUntil(async () => (await logText()).includes("誰の目で語るかは別の項目へ回しました"), "回した旨の一言が会話に出る", 60_000).catch(async (error: unknown) => {
          await lookNote(`[511] 回した旨の一言は出なかった：${String(error).slice(0, 80)}／会話の末尾：${(await logText()).replace(/\s+/g, " ").slice(-500)}`);
        });
        await page.waitForTimeout(1500);
        await lookNote(`[511] 会話の末尾：${(await logText()).replace(/\s+/g, " ").slice(-700)}`);
        await shootPage(page, "511-対話式プロット-書いたあとの会話");
        const plot = (await readFile(path.join(session.workFolder, "設定", "plot.md"), "utf8").catch(() => "（plot.md が読めません）")).replace(/\r\n/g, "\n");
        await lookNote(`[511] plot.md：${plot.replace(/\n+/g, " ／ ").slice(0, 700)}`);
      },
      fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 900 } })
    );
  });
});
