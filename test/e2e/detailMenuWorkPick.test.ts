/**
 * 詳細メニューから押した、作品が要る命令の作品の決め方（画面の自動テスト、設計書6.68.2・6.104・6.113。
 * 実機確認リスト 0.122.0 の 367 行と、0.117.0 の 316 行の後半を機械へ移した）。
 *
 * 1. 367（作者の判断 2026-11-02「詳細メニューから押した、作品が要る命令は、毎回作品を選ばせる」）：
 *    作品を2つ置き、作品一覧で作品A（画面テストの作品）を選び、原稿エディターで作品Bの話を開いたまま、
 *    詳細メニュー「執筆データ」→「執筆統計」を押す。作品を選ぶ画面が出て、いちばん上が作品Bで説明欄が
 *    「いま書いている原稿」で始まり、2番目が作品Aで「作品一覧で選んでいる作品」で始まる。原稿を閉じて
 *    押し直すと、いちばん上が作品A。**対照**：作品一覧の作品Aの右クリック「執筆統計」では選ぶ画面が出ず、
 *    作品Aの執筆統計が開く
 * 2. 316 の後半（作者の判断 2026-11-01）：作品一覧で作品Aを選んだまま、相談の作品を作品Bにして、答えが
 *    **簡単ステップメニューに無い**項目（「人物相関図」）を名指しすると、詳細メニューのその項目が光り、
 *    会話に「詳細メニューの項目は、相談の作品「作品B」で走ります。」が出る。光った行を押すと、作品を訊かずに
 *    作品Bの人物相関図が開く。**対照**：同じ行をもう一度押すと（光らせた1回は使い切った）、作品を選ぶ画面が出る
 * 3. 368（0.122.0）：簡単ステップメニューの最上段で作品Bを選び、相談の作品は作品Aのまま、簡単ステップメニューの
 *    「AIに相談」（薄字「大きく開く」）を押すと、大きい相談の画面が作品Bで開く
 *
 * **本物の AI は呼ばない。** 偽の Ollama が「人物相関図」を名指しした答えを返す。実機の AI が項目を
 * 名指しするかは作者の手に残す。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import { chatAnswer, SEARCH_TERMS_ANSWER } from "./support/chatAnswerButtons";
import { sendChatQuestion } from "./support/chatInput";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama, type FakeOllamaRequest } from "./support/fakeOllama";
import { openEpisode } from "./support/manuscriptFrame";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH, collapseSidebarPane, showSidebar, treeContextMenu, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  editorGroupTabs,
  notificationTexts,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickRows,
  quickPickTitle,
  tabNamesInclude,
  waitForQuickPick,
} from "./support/workbenchDom";

const OTHER_TITLE = "作品B";
const OTHER_EPISODE = "001_別の作品.txt";
const OTHER_TEXT = "　別の作品の本文。灯台の明かりが揺れた。\n";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const OPEN_LARGE_KEY = "ctrl+alt+shift+h";
const OPEN_LARGE_PRESS = "Control+Alt+Shift+KeyH";

/** 選ぶ画面の題（`resolveWork` の既定。執筆統計も人物相関図も題を渡さない） */
const PICK_TITLE = "作品を選択";

let fake: FakeOllama;

const QUESTION = "人物の関係を図で見たいのですが、どこから？";
const REPLY = "偽のAIの答えです：「人物相関図」で、人物どうしの関係を図で見られます。";

function isSearchTermsRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes(SEARCH_TERMS_SYSTEM_PROMPT.split("\n")[0]) || request.user.startsWith("次の質問に合う場面を");
}

beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    if (isSearchTermsRequest(request)) return SEARCH_TERMS_ANSWER;
    if (request.user.includes(QUESTION)) return chatAnswer({ reply: REPLY });
    return "{}";
  });
});
afterAll(async () => {
  await fake.close();
});

/** 作品B（画面テストの作品と同じ書庫の中）を起こしたあとで登録するキーと、相談を大きく開くキー */
function launchOptions(): LaunchOptions {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  return fakeOllamaLaunch(fake, {
    settings: SIDEBAR_LAUNCH.settings,
    keybindings: [...SIDEBAR_LAUNCH.keybindings, registerOther, { key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" }],
    prepareWork: async ({ workFolder }) => {
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", OTHER_EPISODE), OTHER_TEXT, "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  });
}

async function registerOtherWork(page: Page): Promise<void> {
  await page.keyboard.press(REGISTER_OTHER_PRESS);
  await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
  await clearNotifications(page);
  await showSidebar(page, E2E_WORK_TITLE);
  await waitUntil(async () => (await treeRow(page, OTHER_TITLE).count()) > 0, "作品一覧に作品Bの行が出る", 15_000);
}

/** 詳細メニューの区画 */
function detailPane(page: Page): Locator {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: "詳細メニュー" }) }).first();
}

/**
 * 詳細メニューの区画の中で、名前（aria-label）が `head` で始まる行を、描かれるまで区画を下へ送って探す。
 * **簡単ステップメニューにも同じ名前の行がある**（執筆統計）ので、区画の中だけで探す
 */
async function detailRow(page: Page, head: string): Promise<Locator> {
  const pane = detailPane(page);
  const row = pane.locator(`.monaco-list-row[aria-label^="${head}"]`).first();
  for (let attempt = 0; attempt < 30 && (await row.count()) === 0; attempt++) {
    const box = await pane.locator(".pane-body").first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
      await page.mouse.wheel(0, 120);
    }
    await page.waitForTimeout(150);
  }
  if ((await row.count()) === 0) {
    const labels = await pane.locator(".monaco-list-row").evaluateAll((rows) => rows.map((node) => node.getAttribute("aria-label") ?? ""));
    throw new Error(`詳細メニューに「${head}」の行が見つかりません（いまの行：${labels.join(" / ")}）`);
  }
  await row.scrollIntoViewIfNeeded();
  return row;
}

/** 詳細メニューの段を開く（開いていれば何もしない） */
async function expandDetailGroup(page: Page, head: string): Promise<void> {
  const row = await detailRow(page, head);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `詳細メニューの「${head}」が開く`, 10_000);
}

/** 詳細メニュー「執筆データ」→「執筆統計」を押し、作品を選ぶ画面の行を返す */
async function pressDetailWritingStats(page: Page): Promise<Array<{ label: string; description: string }>> {
  await expandDetailGroup(page, "執筆データ");
  const row = await detailRow(page, "執筆統計");
  await row.click();
  return waitForQuickPick(page, PICK_TITLE, 20_000);
}

/* ── 1. 367：詳細メニューから押すと毎回選ばせ、いま書いている原稿の作品が上に来る ── */

test("詳細メニューの「執筆統計」を押すと作品を選ぶ画面が出て、原稿エディターで開いている作品Bが「いま書いている原稿」として先頭、作品一覧で選んだ作品Aが2番目に来て、原稿を閉じると作品Aが先頭になる", async () => {
  await withVsCode(
    "詳細メニューの作品の選び方",
    [{ name: "001_港.txt", text: "　港の娘は朝早く起きた。\n" }],
    async (session) => {
      const { page } = session;
      await registerOtherWork(page);

      // 作品Bの話を原稿エディターで開く
      await openEpisode(page, OTHER_EPISODE, "灯台の明かり");
      await showSidebar(page, E2E_WORK_TITLE);
      // 木の区画を高くする（横の相談と簡単ステップメニューを畳む。作品一覧は選んだ行を見せたまま）
      await collapseSidebarPane(page, "AIに相談");
      await collapseSidebarPane(page, "簡単ステップメニュー");
      // 作品一覧で作品Aを選ぶ
      await treeRow(page, E2E_WORK_TITLE).click();
      await waitUntil(async () => (await treeRow(page, E2E_WORK_TITLE).getAttribute("aria-selected")) === "true", "作品一覧で作品Aが選ばれる", 10_000);
      expect(tabNamesInclude((await editorGroupTabs(page)).flat(), OTHER_EPISODE), `作品Bの原稿のタブがありません：${JSON.stringify(await editorGroupTabs(page))}`).toBe(true);

      const rows = await pressDetailWritingStats(page);
      expect(rows[0]?.label, `先頭の行：${JSON.stringify(rows)}`).toBe(OTHER_TITLE);
      expect(rows[0]?.description, `先頭の行の説明：${JSON.stringify(rows)}`).toMatch(/^いま書いている原稿/);
      expect(rows[1]?.label, `2番目の行：${JSON.stringify(rows)}`).toBe(E2E_WORK_TITLE);
      expect(rows[1]?.description, `2番目の行の説明：${JSON.stringify(rows)}`).toMatch(/^作品一覧で選んでいる作品/);
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 5_000);

      /* ── 原稿を閉じて押し直すと、先頭が作品A ── */
      await pressWorkbenchKey(page, "Control+KeyW");
      await waitUntil(async () => !tabNamesInclude((await editorGroupTabs(page)).flat(), OTHER_EPISODE), "作品Bの原稿のタブが閉じる", 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}）`);
      });
      const again = await pressDetailWritingStats(page);
      expect(again[0]?.label, `原稿を閉じたあとの先頭の行：${JSON.stringify(again)}`).toBe(E2E_WORK_TITLE);
      expect(again[0]?.description, `原稿を閉じたあとの先頭の行の説明：${JSON.stringify(again)}`).toMatch(/^作品一覧で選んでいる作品/);
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 5_000);

      /* ── 対照：作品一覧の右クリックから押すと訊かれず、その作品で開く ── */
      await treeContextMenu(page, E2E_WORK_TITLE, "執筆統計");
      const statsTab = `執筆統計: ${E2E_WORK_TITLE}`;
      await waitUntil(async () => tabNamesInclude((await editorGroupTabs(page)).flat(), statsTab), `右クリックで「${statsTab}」が開く`, 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}）${await quickInputWaitContext(page)}`);
      });
      expect(await quickPickTitle(page), "右クリックから押したのに作品を訊かれました").toBeUndefined();
    },
    launchOptions()
  );
}, 300_000);

/* ── 2. 316 の後半：相談で光らせた詳細メニューだけの項目は、相談の作品で走る ── */

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

/**
 * 会話に出る1行（`features/actionSpotlight.ts` の `describeAlignedWork`）。features は vscode を読むので
 * テストからは呼べず、文をここへ写す（文を直したらここも直す）
 */
const DETAIL_NOTE = `詳細メニューの項目は、相談の作品「${OTHER_TITLE}」で走ります。`;

test("作品一覧で作品Aを選んだまま、相談の作品（作品B）で答えが詳細メニューだけの「人物相関図」を光らせると、会話に「詳細メニューの項目は、相談の作品「作品B」で走ります。」が出て、光った行を押すと作品を訊かずに作品Bで開き、もう一度押すと作品を訊かれる", async () => {
  await withVsCode(
    "相談で光らせた詳細メニューの項目の作品",
    [{ name: "001_港.txt", text: "　港の娘は朝早く起きた。\n" }],
    async (session) => {
      const { page } = session;
      await registerOtherWork(page);
      await collapseSidebarPane(page, "簡単ステップメニュー");

      // 作品一覧（見えている）で作品Aを選び、相談の作品は作品B
      await treeRow(page, E2E_WORK_TITLE).click();
      await waitUntil(async () => (await treeRow(page, E2E_WORK_TITLE).getAttribute("aria-selected")) === "true", "作品一覧で作品Aが選ばれる", 10_000);
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
      await waitUntil(async () => (await logText(chat)).includes(DETAIL_NOTE), `会話に「${DETAIL_NOTE}」が出る`, 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（会話：${JSON.stringify((await logText(chat)).slice(-400))}）`);
      });
      expect(await chat.locator("button.option", { hasText: "光らせる：人物相関図" }).count(), "答えの下に［▶ 光らせる：人物相関図］がありません").toBeGreaterThan(0);

      /* ── 光った行を押すと、作品を訊かずに作品Bで開く ── */
      const graphTabB = `人物相関図: ${OTHER_TITLE}`;
      const row = await detailRow(page, "人物相関図");
      await row.click();
      await waitUntil(
        async () => tabNamesInclude((await editorGroupTabs(page)).flat(), graphTabB) || (await quickPickTitle(page)) !== undefined,
        "光った行を押すと、人物相関図が開くか、選ぶ画面が出る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      expect(await quickPickTitle(page), `光らせた行なのに作品を訊かれました（行：${JSON.stringify(await quickPickRows(page))}）`).toBeUndefined();
      expect(tabNamesInclude((await editorGroupTabs(page)).flat(), graphTabB), `作品Bの人物相関図が開いていません：${JSON.stringify(await editorGroupTabs(page))}`).toBe(true);
      expect(tabNamesInclude((await editorGroupTabs(page)).flat(), `人物相関図: ${E2E_WORK_TITLE}`), "作品一覧で選んでいた作品Aの人物相関図が開きました").toBe(false);

      /* ── 対照：同じ行をもう一度押すと（光らせた1回は使い切った）、作品を訊かれる ── */
      const rowAgain = await detailRow(page, "人物相関図");
      await rowAgain.click();
      await waitForQuickPick(page, PICK_TITLE, 20_000);
      await page.keyboard.press("Escape");
      await holdsFor(async () => !tabNamesInclude((await editorGroupTabs(page)).flat(), `人物相関図: ${E2E_WORK_TITLE}`), "取りやめたあとに作品Aの人物相関図が開かない", 2_000);
    },
    launchOptions()
  );
}, 300_000);

/* ── 3. 368：簡単ステップメニューの「AIに相談」（大きく開く）は、最上段の作品で開く ── */

/** 簡単ステップメニューの区画 */
function stepPane(page: Page): Locator {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: "簡単ステップメニュー" }) }).first();
}

/** 簡単ステップメニューの最上段（作品を選ぶ行。木の0番目）の名前（chatSpotlightWork と同じ読み方） */
async function stepTopLabel(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const label = await page.evaluate(() => {
      const pane = Array.from(document.querySelectorAll(".pane")).find((node) =>
        (node.querySelector(".pane-header")?.textContent ?? "").includes("簡単ステップメニュー")
      );
      const top = Array.from(pane?.querySelectorAll(".monaco-list-row") ?? []).find((row) => (row as HTMLElement).dataset.index === "0");
      return top ? (top.querySelector(".label-name")?.textContent ?? top.getAttribute("aria-label") ?? "").trim() : undefined;
    });
    if (label !== undefined) return label;
    const box = await stepPane(page).locator(".pane-body").first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -600);
    }
    await page.waitForTimeout(150);
  }
  return "（最上段が描かれていません）";
}

test("簡単ステップメニューの最上段で作品Bを選び、相談の作品は作品Aのまま、簡単ステップメニューの「AIに相談」（大きく開く）を押すと、大きい相談の画面が作品Bで開く", async () => {
  await withVsCode(
    "簡単ステップメニューの相談の作品",
    [{ name: "001_港.txt", text: "　港の娘は朝早く起きた。\n" }],
    async (session) => {
      const { page } = session;
      await registerOtherWork(page);
      await collapseSidebarPane(page, "AIに相談");

      // 相談の作品は作品A
      await runCommand(page, "相談作品選択");
      await waitForQuickPick(page, "どの作品について相談しますか");
      await pickQuickPickRow(page, E2E_WORK_TITLE);

      // 簡単ステップメニューの最上段で作品Bを選ぶ
      await treeRow(page, await stepTopLabel(page)).click();
      await waitForQuickPick(page, "簡単ステップメニューで使う作品", 15_000);
      await pickQuickPickRow(page, OTHER_TITLE);
      await waitUntil(async () => (await stepTopLabel(page)) === `選択作品：${OTHER_TITLE}`, "簡単ステップメニューの最上段が「選択作品：作品B」になる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの最上段：${JSON.stringify(await stepTopLabel(page))}）`);
        }
      );

      // 簡単ステップメニューの「AIに相談」（薄字「大きく開く」）を、段を開きながら探す
      const pane = stepPane(page);
      const chatRow = pane.locator('.monaco-list-row[aria-label^="AIに相談"]').first();
      const closed = pane.locator('.monaco-list-row[aria-expanded="false"]');
      for (let attempt = 0; attempt < 30 && (await chatRow.count()) === 0; attempt++) {
        if ((await closed.count()) > 0) {
          await closed.first().click();
          await page.waitForTimeout(300);
          continue;
        }
        const box = await pane.locator(".pane-body").first().boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
          await page.mouse.wheel(0, 120);
        }
        await page.waitForTimeout(150);
      }
      expect(await chatRow.count(), "簡単ステップメニューに「AIに相談」が見つかりません").toBe(1);
      expect((await chatRow.getAttribute("aria-label")) ?? "", "押す行が「大きく開く」の相談ではありません").toContain("大きく開く");
      await chatRow.scrollIntoViewIfNeeded();
      await chatRow.click();

      let large: Frame | undefined;
      await waitUntil(
        async () => {
          large = await largeChatFrame(page);
          return large !== undefined && (await chatTarget(large)).trim() !== "";
        },
        "大きい相談の画面が開く",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });
      const chat = large as Frame;
      await waitUntil(async () => (await chatTarget(chat)).includes(OTHER_TITLE), "大きい相談の画面の相談の対象が作品Bになる", 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（相談の対象：${JSON.stringify(await chatTarget(chat))}）`);
      });
      expect(await quickPickTitle(page), "大きく開くのに作品を訊かれました").toBeUndefined();
    },
    launchOptions()
  );
}, 300_000);
