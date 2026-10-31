/**
 * 相談ではっきり頼まれたら、押すのを待たずに動かす（画面の自動テスト。設計書6.6.3・6.113。
 * 作者の判断 2026-10-31「明確な意思表示があるなら、AIが機能を実行しても良いのでは？」、
 * e2e を足すのは作者の判断 2026-11-01「足す」）。
 *
 * 見張ること：
 * 1. 「表記ゆれを検知して」と頼み、AI が表記ゆれの検知を名指しして今すぐ動かす印（`runNow`）を
 *    立てると、**ボタンを押さずに**表記ゆれの組を選ぶ画面が出る。会話には
 *    「頼まれたので「表記ゆれを検知する」を動かします」の1行が出て、答えの下のボタンは残る
 *    （もう一度押せる。`pendingRuns` を消さない）
 * 2. 同じ答えでも、作者の発言が「表記ゆれってどうやるの？」（使い方を訊いただけ）なら動かない。
 *    数秒見続けても組を選ぶ画面は出ず、ボタンだけが出る
 *
 * **本物の AI は呼ばない。** 偽の Ollama が相談の答えの形（WORK_CHAT_SCHEMA）で答える。
 * 見えるのは「印がそろったら動く・そろわなければ動かない」の配線だけで、実機の AI が
 * 印を立てるかは AI の測定の仕事。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chatRunNowMessage } from "../../src/core/chatEdit";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import { chatAnswer, RUN_BUTTON_TEXT, RUN_KIND, SEARCH_TERMS_ANSWER } from "./support/chatAnswerButtons";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama, type FakeOllamaRequest } from "./support/fakeOllama";
import { sendChatQuestion } from "./support/chatInput";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, editorGroupTabs, notificationTexts, pressWorkbenchKey, quickPickTitle } from "./support/workbenchDom";

const OPEN_LARGE_KEY = "ctrl+alt+shift+h";
const OPEN_LARGE_PRESS = "Control+Alt+Shift+KeyH";

const EPISODE = "001_星.txt";
/** 「沢山」1回・「たくさん」2回。表記ゆれの組はこの1組だけ（chatAnswerButtonsLarge.test.ts と同じ形） */
const BODY = ["　空には沢山の星があった。", "　たくさんの星が見えた。", "　たくさん、と彼女は言った。", ""].join("\n");

/** 頼み（「〜て」で言い切る）。「表記」を含むので、AI が名指しした表記ゆれの検知は話題が合う */
const REQUEST_QUESTION = "表記ゆれを検知して";
/** 使い方を訊いただけ（`isExplicitRunRequest` が外す）。こちらも「表記」を含み、ボタンは残る */
const HOWTO_QUESTION = "表記ゆれってどうやるの？";

const REPLY = "偽のAIの答えです：表記ゆれの検知で、揺れている書き方の組を確かめられます。";
/** 表記ゆれの検知を名指しし、今すぐ動かす印を立てた答え。**どちらの件でも同じ答えを返す** */
const RUN_NOW_ANSWER = chatAnswer({ reply: REPLY, run: RUN_KIND, runNow: true });

/** 会話に出る1行（製品の文言をそのまま使う。手で写すと、文言を直したときに食い違う） */
const RUN_NOW_NOTE = chatRunNowMessage("checkNotation", false, "表記ゆれを検知する");
const RUN_NOW_HEAD = "頼まれたので「表記ゆれを検知する」を動かします";
/** 組を選ぶ画面の題の書き出し（詳細メニューと同じ novelai.checkNotation が走ると出る） */
const NOTATION_PICK_TITLE = "表記ゆれが 1 組見つかりました";

function isSearchTermsRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes(SEARCH_TERMS_SYSTEM_PROMPT.split("\n")[0]) || request.user.startsWith("次の質問に合う場面を");
}

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    if (isSearchTermsRequest(request)) return SEARCH_TERMS_ANSWER;
    if (request.user.includes(REQUEST_QUESTION) || request.user.includes(HOWTO_QUESTION)) return RUN_NOW_ANSWER;
    return "{}";
  });
});
afterAll(async () => {
  await fake.close();
});

/** 大きい相談画面の面（`#context-what` と `#to-sub` を持つ） */
async function largeChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const large = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-sub") !== null)
      .catch(() => false);
    if (large) return frame;
  }
  return undefined;
}

/** 会話の欄（`#log`）の字。**隠れた面でも読めるよう textContent で取る** */
async function logText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.textContent ?? "");
}

/** 答えの下に残っている実行のボタン（畳みの中にあって隠れていても数える）の数 */
async function runButtonCount(frame: Frame): Promise<number> {
  return frame.evaluate(
    (text) => Array.from(document.querySelectorAll(".more-body button.option")).filter((node) => (node.textContent ?? "").includes(text)).length,
    RUN_BUTTON_TEXT
  );
}

/** 落ちたときに添える：会話の終わり・出ている知らせと確認の窓・選ぶ画面・タブ・偽の AI への頼み */
async function describeState(page: Page, frame: Frame | undefined, from: number): Promise<string> {
  const log = frame ? (await logText(frame).catch(() => "")).slice(-500) : "（大きい画面が見つからない）";
  return (
    `（会話の終わり：${JSON.stringify(log)}／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}` +
    `／確認の窓：${JSON.stringify(await dialogText(page).catch(() => undefined))}／選ぶ画面：${JSON.stringify(await quickPickTitle(page).catch(() => undefined))}` +
    `／列とタブ：${JSON.stringify(await editorGroupTabs(page).catch(() => []))}／${describeFakeRequests(fake.requests, from)}）`
  );
}

/** 大きい相談画面を開き、［送る］が見えて相談の対象に作品名が出るまで待つ */
async function openLargeChat(page: Page, from: number): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_LARGE_PRESS);
  let large: Frame | undefined;
  await waitUntil(
    async () => {
      large = await largeChatFrame(page);
      if (!large || !(await large.locator("#send").isVisible().catch(() => false))) return false;
      return (await large.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE);
    },
    "大きい相談画面が前に出て、相談の対象に作品名が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await describeState(page, large, from)}`);
  });
  return large as Frame;
}

/** 送って、答えが会話に出るまで待つ（手元のAIの関所が出たら通す） */
async function ask(page: Page, large: Frame, question: string, from: number): Promise<void> {
  await sendChatQuestion(large, question, "大きい相談画面");
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      return (await logText(large)).includes(REPLY);
    },
    `大きい画面に「${question}」への答えが出る`,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await describeState(page, large, from)}`);
  });
}

test("「表記ゆれを検知して」と頼み、AI が今すぐ動かす印を立てると、ボタンを押さずに表記ゆれの組を選ぶ画面が出て、会話に「頼まれたので…動かします」が出て、答えの下のボタンも残る", async () => {
  await withVsCode(
    "相談で頼まれたら押さずに動かす",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      // 偽の AI はファイルの中の件で共有なので、この件で増えた分だけを見る
      const sentBefore = fake.requests.length;
      const large = await openLargeChat(page, sentBefore);

      await ask(page, large, REQUEST_QUESTION, sentBefore);

      /* ── ボタンを押さずに、詳細メニューと同じ表記ゆれの検知が走る（組を選ぶ画面が出る） ── */
      await waitUntil(
        async () => (await quickPickTitle(page))?.startsWith(NOTATION_PICK_TITLE) === true,
        "押さずに表記ゆれの組を選ぶ画面が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page, large, sentBefore)}`);
      });

      /* ── 会話に動かすことの1行が出る ── */
      const log = await logText(large);
      expect(log, `会話に「${RUN_NOW_HEAD}」の1行がありません：${log.slice(-500)}`).toContain(RUN_NOW_NOTE);
      expect(log.indexOf(RUN_NOW_NOTE), "動かすことの1行が答えより前に出ています").toBeGreaterThan(log.indexOf(REPLY));

      /* ── 答えの下のボタンは残る（もう一度押せる） ── */
      expect(await runButtonCount(large), `答えの下の「${RUN_BUTTON_TEXT}」が消えました${await describeState(page, large, sentBefore)}`).toBe(1);
    },
    fakeOllamaLaunch(fake, { keybindings: [{ key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" }] })
  );
});

test("同じ答えでも、作者が「表記ゆれってどうやるの？」と使い方を訊いただけなら動かさず、ボタンだけを出す", async () => {
  await withVsCode(
    "相談で使い方を訊いただけなら動かさない",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      const sentBefore = fake.requests.length;
      const large = await openLargeChat(page, sentBefore);

      await ask(page, large, HOWTO_QUESTION, sentBefore);

      /* ── 数秒見続けても、組を選ぶ画面は出ず、動かすことの1行も出ない ── */
      await holdsFor(
        async () => (await quickPickTitle(page))?.startsWith(NOTATION_PICK_TITLE) !== true && !(await logText(large)).includes(RUN_NOW_HEAD),
        "使い方を訊いただけで表記ゆれの検知が動かないこと",
        5_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page, large, sentBefore)}`);
      });

      /* ── ボタンは出ている（押せば動かせる） ── */
      expect(await runButtonCount(large), `答えの下に「${RUN_BUTTON_TEXT}」がありません${await describeState(page, large, sentBefore)}`).toBe(1);
    },
    fakeOllamaLaunch(fake, { keybindings: [{ key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" }] })
  );
});
