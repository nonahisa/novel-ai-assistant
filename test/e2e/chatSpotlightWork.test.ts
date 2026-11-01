/**
 * 相談の答えで光らせた項目は、相談の作品で走る（画面の自動テスト、設計書6.104・6.113。
 * 実機確認リスト 0.116.1 の 300 行を機械へ移した。作者の報告 2026-10-31「相談の作品は教科書チートだったのに、
 * 光らせた簡単ステップメニューの項目を押すと別の作品で走った」）。
 *
 * 見張ること：
 * - 作品が2つある環境で、簡単ステップメニューの最上段で作品A（設定資料あり）を選んでおき、相談の作品は
 *   作品B（設定資料なし）にして「矛盾を調べたいのですが、どこから？」と訊く。答えが「矛盾検知」を名指しすると、
 *   簡単ステップメニューの最上段が「選択作品：作品B」に替わり、会話に「簡単ステップメニューの作品を、
 *   相談の作品「作品B」に合わせました。」が出る。答えの下に［▶ 光らせる：矛盾検知］がある
 * - 光った「矛盾検知」の行を押すと**作品Bで走る**：作品Bには設定資料が無いので「「矛盾検知」には「設定資料」が
 *   要ります」の選ぶ画面で止まる（作品Aで走れば設定資料があるので、この画面は出ない。これで取り違えを見分ける）
 * - そのあと簡単ステップメニューの作品を作品Aへ替えても、相談の作品は作品Bのまま
 *
 * **本物の AI は呼ばない。** 偽の Ollama が「矛盾検知」を名指しした答えを返す。実機の AI が項目を名指しするかは
 * 作者の手に残す。項目の「確認の窓に作品名」は、作品Bに設定資料が無いと確認の窓まで進まないため、
 * 走った作品を前提の関所の出方で見分けている（同じことを別の形で見ている）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { emptyCharacter } from "../../src/models/character";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import { chatAnswer, SEARCH_TERMS_ANSWER } from "./support/chatAnswerButtons";
import { sendChatQuestion } from "./support/chatInput";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama, type FakeOllamaRequest } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { SIDEBAR_LAUNCH, showSidebar, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  notificationTexts,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickTitle,
  waitForQuickPick,
} from "./support/workbenchDom";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const OPEN_LARGE_KEY = "ctrl+alt+shift+h";
const OPEN_LARGE_PRESS = "Control+Alt+Shift+KeyH";

const QUESTION = "矛盾を調べたいのですが、どこから？";
const REPLY = "偽のAIの答えです：「矛盾検知」で、設定資料と本文の食い違いを調べられます。";
const ANSWER = chatAnswer({ reply: REPLY });
/**
 * 会話に出る1行（`features/actionSpotlight.ts` の `describeAlignedWork`）。features は vscode を読むので
 * テストからは呼べず、文をここへ写す（文を直したらここも直す）
 */
const ALIGNED_NOTE = `簡単ステップメニューの作品を、相談の作品「${OTHER_TITLE}」に合わせました。`;
const GATE_TITLE = "「矛盾検知」には「設定資料」が要ります";

function isSearchTermsRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes(SEARCH_TERMS_SYSTEM_PROMPT.split("\n")[0]) || request.user.startsWith("次の質問に合う場面を");
}

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    if (isSearchTermsRequest(request)) return SEARCH_TERMS_ANSWER;
    if (request.user.includes(QUESTION)) return ANSWER;
    return "{}";
  });
});
afterAll(async () => {
  await fake.close();
});

function launchOptions(): LaunchOptions {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  return fakeOllamaLaunch(fake, {
    settings: SIDEBAR_LAUNCH.settings,
    keybindings: [...SIDEBAR_LAUNCH.keybindings, registerOther, { key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" }],
    prepareWork: async ({ workFolder }) => {
      // 作品A（画面テストの作品）には設定資料（人物1人）を置く。作品Bには置かない
      await writeCharactersTo(defaultCharactersFolder(workFolder), [{ ...emptyCharacter("char_001", "港の娘"), appearedChapters: [1] }]);
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  });
}

/**
 * 簡単ステップメニューの最上段（作品を選ぶ行。木の0番目）の名前。
 * 光らせると木が下へ送られ、最上段が描かれなくなる（木は見えている行しか描かない）ので、
 * 描かれていなければ区画の上でホイールを上へ回して戻す
 */
async function stepTopLabel(page: Page): Promise<string> {
  const read = () =>
    page.evaluate(() => {
      const pane = Array.from(document.querySelectorAll(".pane")).find((node) =>
        (node.querySelector(".pane-header")?.textContent ?? "").includes("簡単ステップメニュー")
      );
      const top = Array.from(pane?.querySelectorAll(".monaco-list-row") ?? []).find((row) => (row as HTMLElement).dataset.index === "0");
      return top ? (top.querySelector(".label-name")?.textContent ?? top.getAttribute("aria-label") ?? "").trim() : undefined;
    });
  for (let attempt = 0; attempt < 10; attempt++) {
    const label = await read();
    if (label !== undefined) return label;
    const body = page.locator(".pane", { has: page.locator(".pane-header", { hasText: "簡単ステップメニュー" }) }).locator(".pane-body").first();
    const box = await body.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -600);
    }
    await page.waitForTimeout(150);
  }
  return "（最上段が描かれていません）";
}

/** 簡単ステップメニューの最上段を押して、作品を選ぶ */
async function chooseStepWork(page: Page, title: string): Promise<void> {
  const top = await stepTopLabel(page);
  await treeRow(page, top).click();
  await waitForQuickPick(page, "簡単ステップメニューで使う作品", 15_000);
  await pickQuickPickRow(page, title);
  await waitUntil(async () => (await stepTopLabel(page)) === `選択作品：${title}`, `簡単ステップメニューの最上段が「選択作品：${title}」になる`, 15_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの最上段：${JSON.stringify(await stepTopLabel(page))}）`);
    }
  );
}

/** 大きい相談画面の面 */
async function largeChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const large = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-sub") !== null)
      .catch(() => false);
    if (large) return frame;
  }
  return undefined;
}

async function logText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.textContent ?? "");
}

async function chatTarget(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("context-what")?.textContent ?? "");
}

test("相談の作品（作品B）で答えが「矛盾検知」を光らせると、簡単ステップメニューの作品が作品Bに合わさって会話に1行出て、光った行を押すと作品Bで走り、そのあとメニューの作品を替えても相談の作品は替わらない", async () => {
  await withVsCode(
    "相談で光らせた項目の作品",
    [{ name: "001_港.txt", text: "　港の娘は朝早く起きた。\n" }],
    async (session) => {
      const { page } = session;
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);
      await showSidebar(page, E2E_WORK_TITLE);

      // 簡単ステップメニューでは作品A、相談では作品B
      await chooseStepWork(page, E2E_WORK_TITLE);
      await runCommand(page, "相談作品選択");
      await waitForQuickPick(page, "どの作品について相談しますか");
      await pickQuickPickRow(page, OTHER_TITLE);

      const sentBefore = fake.requests.length;
      await pressWorkbenchKey(page, OPEN_LARGE_PRESS);
      let large: Frame | undefined;
      await waitUntil(
        async () => {
          large = await largeChatFrame(page);
          return large !== undefined && (await large.locator("#send").isVisible().catch(() => false)) && (await chatTarget(large)).includes(OTHER_TITLE);
        },
        "大きい相談画面が開き、相談の対象に作品Bが出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（相談の対象：${JSON.stringify(large ? await chatTarget(large) : undefined)}）`);
      });
      const chat = large as Frame;

      await sendChatQuestion(chat, QUESTION, "大きい相談画面");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await logText(chat)).includes(REPLY);
        },
        "答えが会話に出る",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（会話：${JSON.stringify((await logText(chat)).slice(-400))}／${describeFakeRequests(fake.requests, sentBefore)}）`);
      });

      /* ── 簡単ステップメニューの作品が作品Bに合わさり、会話に1行出る ── */
      await waitUntil(async () => (await stepTopLabel(page)) === `選択作品：${OTHER_TITLE}`, "簡単ステップメニューの最上段が「選択作品：作品B」に替わる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの最上段：${JSON.stringify(await stepTopLabel(page))}）`);
        }
      );
      await waitUntil(async () => (await logText(chat)).includes(ALIGNED_NOTE), `会話に「${ALIGNED_NOTE}」が出る`, 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（会話：${JSON.stringify((await logText(chat)).slice(-400))}）`);
      });
      const spotlightButton = chat.locator("button.option", { hasText: "光らせる：矛盾検知" });
      expect(await spotlightButton.count(), "答えの下に［▶ 光らせる：矛盾検知］がありません").toBeGreaterThan(0);
      // 札を押しても光らせ直すだけで、作品は作品Bのまま
      await spotlightButton.first().click();
      await page.waitForTimeout(1_500);
      expect(await stepTopLabel(page)).toBe(`選択作品：${OTHER_TITLE}`);

      /* ── 光った「矛盾検知」の行を押すと、作品Bで走る（設定資料が無いので前提の関所で止まる） ── */
      // 光った行は簡単ステップメニューの中で探す（詳細メニューの同じ名前の行と取り違えない）
      const stepPane = page.locator(".pane", { has: page.locator(".pane-header", { hasText: "簡単ステップメニュー" }) }).first();
      const row = stepPane.locator('.monaco-list-row[aria-label^="矛盾検知"]').first();
      for (let attempt = 0; attempt < 20 && (await row.count()) === 0; attempt++) {
        const box = await stepPane.locator(".pane-body").first().boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 120);
        }
        await page.waitForTimeout(150);
      }
      expect(await row.count(), "簡単ステップメニューに光った「矛盾検知」の行が見つかりません").toBe(1);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await quickPickTitle(page)) === GATE_TITLE;
        },
        "光った行を押すと、作品B（設定資料なし）で走って「設定資料が要ります」の選ぶ画面が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      await page.keyboard.press("Escape");

      /* ── メニューの作品を作品Aへ替えても、相談の作品は作品Bのまま ── */
      await chooseStepWork(page, E2E_WORK_TITLE);
      await page.waitForTimeout(1_000);
      expect(await chatTarget(chat), "メニューの作品を替えたら、相談の作品まで替わりました").toContain(OTHER_TITLE);

      /*
        ── 対照：作品Aで同じ行を押すと、設定資料があるので「設定資料が要ります」では止まらない ──
        これが無いと、上の「関所で止まった」がどちらの作品でも起きる形でも通ってしまう
      */
      for (let attempt = 0; attempt < 20 && (await row.count()) === 0; attempt++) {
        const box = await stepPane.locator(".pane-body").first().boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 120);
        }
        await page.waitForTimeout(150);
      }
      await row.scrollIntoViewIfNeeded();
      await row.click();
      let controlTitle = "";
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          controlTitle = (await quickPickTitle(page)) ?? "";
          return controlTitle !== "";
        },
        "（対照）作品Aで押すと、矛盾検知の次の選ぶ画面が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      expect(controlTitle, "（対照）設定資料のある作品Aでも「設定資料が要ります」で止まりました。走った作品を見分けられていません").not.toBe(GATE_TITLE);
      await page.keyboard.press("Escape");
    },
    launchOptions()
  );
}, 300_000);
