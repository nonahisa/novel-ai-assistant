/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、相談パネルの写真（案内の文言・言い切りの断り・最初の一言）
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama が決まった答えを返す。**答えの出来は見えない**。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { answerInput, runCommand } from "../support/quickInput";
import { SIDEBAR_LAUNCH } from "../support/sidebar";
import { withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, pickQuickPickRow, pressDialogButton, pressWorkbenchKey, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage } from "./lookSupport";

const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";

/** 質問の文に応じて決まった答えを返す偽の AI */
let answer = "偽のAIの答えです。";
let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => answer);
});
afterAll(async () => {
  await fake.close();
});

async function sideChat(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null).catch(() => false);
    if (ok) return frame;
  }
  return undefined;
}

async function logText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.innerText ?? "");
}

async function openChat(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
  let found: Frame | undefined;
  await waitUntil(async () => (found = await sideChat(page)) !== undefined, "横の相談パネルが開く", 30_000);
  const frame = found as Frame;
  await waitUntil(async () => ((await frame.evaluate(() => document.getElementById("context-what")?.textContent ?? "")) ?? "").length > 3, "相談の対象が決まる", 30_000);
  return frame;
}

async function ask(page: Page, frame: Frame, question: string, waitFor?: string): Promise<void> {
  const before = (await logText(frame)).length;
  await frame.locator("#input").click();
  await page.keyboard.insertText(question);
  await frame.locator("#send").click();
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const text = await logText(frame);
      return text.length > before + question.length && !(await frame.evaluate(() => document.body.innerText.includes("考えています")));
    },
    "答えが出る",
    90_000
  ).catch(() => undefined);
  if (waitFor) await waitUntil(async () => (await logText(frame)).includes(waitFor), `「${waitFor}」が会話に出る`, 30_000).catch(() => undefined);
  await page.waitForTimeout(1200);
}

describe.skipIf(!lookEnabled)("見た目の写真：相談パネル", () => {
  test("読者が決まっていない作品への案内の操作名と、「〜を実行します」と言い切ったときの断り", async () => {
    await withVsCode(
      "見た目の写真：相談パネルの案内",
      [{ name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
      async (session) => {
        const { page } = session;
        const chat = await openChat(page);
        await clearNotifications(page);

        // 807：読者がまだ決まっていない作品に話しかける
        answer = "読者の層を決めると、書き方の方針が決まります。";
        await ask(page, chat, "この作品の読者層を決めたいです。どこから始めればいいですか");
        await lookNote(`[807] 相談パネルの会話：${(await logText(chat)).replace(/\s+/g, " ").slice(0, 900)}`);
        await shootPage(page, "807-相談パネル-読者が決まっていない作品への案内");

        // 510：旧名で頼み、答えが言い切りでボタンが出ない
        answer = "ターゲット読者診断を実行します。しばらくお待ちください。";
        await ask(page, chat, "ターゲット読者診断を実行して", "何も始まっていません");
        await lookNote(`[510] 相談パネルの会話：${(await logText(chat)).replace(/\s+/g, " ").slice(-900)}`);
        await shootPage(page, "510-相談パネル-実行しますと言い切ったとき");
      },
      fakeOllamaLaunch(fake, {
        ...SIDEBAR_LAUNCH,
        windowSize: { width: 1280, height: 900 },
        keybindings: [...SIDEBAR_LAUNCH.keybindings, { key: OPEN_SIDE_KEY, command: "novelai.openChat" }],
      })
    );
  });

  test("新規作品を「プロットから始める」で作った直後の最初の一言", async () => {
    await withVsCode(
      "見た目の写真：プロットから始めた直後",
      [{ name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
      async (session) => {
        const { page } = session;
        await clearNotifications(page);
        await runCommand(page, "プロット起点");
        // 作品名の入力・種類・タイプなど、順に出る画面を、先頭の選択肢で進める
        let sawChat: Frame | undefined;
        for (let step = 0; step < 30 && !sawChat; step++) {
          await page.waitForTimeout(1200);
          await passLocalAiGate(page);
          const dialog = await dialogText(page);
          if (dialog) {
            await lookNote(`[917] 出た確認：${dialog.replace(/\s+/g, " ").slice(0, 200)}`);
            await pressDialogButton(page, "続ける").catch(() => pressDialogButton(page, "OK")).catch(() => pressDialogButton(page, "作る")).catch(() => undefined);
            continue;
          }
          const title = await quickPickTitle(page);
          if (title !== undefined) {
            const rows = await quickPickRows(page);
            const hasInput = await page.locator(".quick-input-widget input").first().isVisible().catch(() => false);
            await lookNote(`[917-手順${step}] ${title}｜${rows.slice(0, 4).map((row) => row.label).join(" / ")}${hasInput ? "｜（入力欄あり）" : ""}`);
            if (rows.length === 0 && hasInput) await answerInput(page, "海辺の見本の物語");
            else if (rows.length > 0) await pickQuickPickRow(page, rows[0].label);
            continue;
          }
          for (const frame of page.frames()) {
            const text = await frame.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "");
            if (text.includes("プロットを一緒に考えましょうか")) sawChat = frame;
          }
        }
        await page.waitForTimeout(1500);
        await lookNote(`[917] 最初の一言が出たか：${sawChat ? "出た" : "出なかった"}${sawChat ? `／会話：${(await logText(sawChat)).replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
        await shootPage(page, "917-プロットから始めた直後の相談パネル");
      },
      fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 900 } })
    );
  });
});
