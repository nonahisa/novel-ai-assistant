/**
 * 作者自身の読者タイプを相談から推し量る（画面の自動テスト、設計書6.101・6.113。
 * 実機確認リスト「0.111.8 作者自身の読者タイプを相談から推し量る」の1件目を 2026-10-25 に移した）。
 *
 * **画面の自動テストへ移した理由**：開発ホストは配布版と同じ保管庫（globalState）を使うので、
 * 9問の答えを消して試すと作者のふだんの答えまで消える（2026-10-25 夕）。ここは使い捨ての
 * 利用者データで VS Code を起こすので、作者の保管庫に触れずに「9問に答えていない状態」から始められる。
 *
 * 何を見張るか：
 * - 9問に答えていない作者の相談に、読み方を推し量る頼み（`【authorReaderSignals`）が添えられる
 * - 作品の読者の話（「この作品の読者は〜」）だけでは、相談パネルに推し量りの知らせが出ない
 * - 自分の読み方を同じ向きで話しても、層が雑食層から離れるまで（1〜3回目）は知らせが出ず、
 *   作家タイプ診断の入口の「読者としての好み」は「いま：まだ相談から推し量れていません」
 * - 4回目で相談パネルに「相談でのお話から、読者としてのあなたを「〇〇層」と推し量りました」と
 *   「あなたが決めたものではありません」が出て、入口が「いま：〇〇層（相談から推し量ったもの）」になる
 * - 逆の向きに話して真ん中へ戻すと、相談パネルには何も出ず（「出すのをやめました」も出ない）、
 *   入口が「いま：まだ相談から推し量れていません」に戻る（作者の判断 2026-10-25 昼「黙って隠す」）
 *
 * **本物の AI は呼ばない。** 偽の Ollama（`support/fakeOllama.ts`）が、問いの文で決めた
 * `authorReaderSignals` を返す。だから見えるのは「信号が返ったあとの配線と画面」だけで、
 * **AI が作品の読者の話を作者の読み方と取り違えないか（読み取りの出来）は見えない**——
 * 作品の読者の問いには偽物が null を返しているだけである。読み取りの出来は AI の測定の仕事。
 *
 * 省いたもの：ターゲット読者の「3つの輪」の断り（ターゲット読者の WebView を開く道が重いため）。
 * 輪に入れるかどうかの判定は `unit/core/targetSheetCircles.test.ts` が見ている。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AUTHOR_READER_PENDING_NOTE, authorReaderTypeLabel } from "../../src/core/authorReaderType";
import { READER_NEUTRAL_SCORE } from "../../src/core/readerTargetValidation";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import { sendChatQuestion } from "./support/chatInput";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama, type FakeOllamaRequest } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { pressWorkbenchKey, quickPickRows, quickPickTitle, waitForQuickPick } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";

/** 作品の読者の話（作者自身の読み方ではない）。偽の AI は信号を返さない */
const WORK_READER_QUESTION = "この作品の読者は、通勤の電車で読む人を考えています";
/** 自分の読み方の話（求めるもの＝苦くても揺さぶられたい、の向き）。1回ごとに別の文にする */
const SELF_QUESTIONS = [
  "苦い結末のほうが好きで、読み終わっても引きずっていたいです",
  "読者としては、すっきり終わる話より、胸に残る話を探して読みます",
  "自分が読むときは、救いのない終わり方でも揺さぶられるほうが好きです",
  "読み終わって何日も考えてしまうような話を、いつも選んで読んでいます",
] as const;
/** 逆の向き（すっきり気持ちよく終わってほしい） */
const REVERSE_QUESTION = "最近は疲れていて、読むならすっきり気持ちよく終わる話がいいです";

/** 答えの本文（会話に出たのを待つ目印）。問いごとに別の文にして、前の答えと取り違えない */
function replyFor(question: string): string {
  return `偽のAIの答えです：「${question.slice(0, 8)}」について承りました。`;
}

/**
 * 相談の答えの形（全項目を返す。`reply` が文字列でないと丸ごと捨てられる）。
 * `authorReaderSignals` は軸ごとの -1・0・1 だけ（層の名前は返さない。`core/authorReaderType.ts`）
 */
function chatAnswer(reply: string, authorReaderSignals: Record<string, number> | null): string {
  return JSON.stringify({
    reply,
    options: [],
    needFiles: null,
    edit: null,
    run: null,
    locate: null,
    reloadRecord: null,
    profileSignals: null,
    writerStyleSignals: null,
    authorReaderSignals,
  });
}

function respond(request: FakeOllamaRequest): string {
  // 相談の頼みには前の会話も載るので、**いちばん後ろに出てくる問い**を今回の問いとする
  // （先頭から探すと、2回目以降も1回目の問いに答えてしまう）
  const latest = [...SELF_QUESTIONS, REVERSE_QUESTION, WORK_READER_QUESTION]
    .map((question) => ({ question, at: request.user.lastIndexOf(question) }))
    .filter((hit) => hit.at >= 0)
    .sort((x, y) => y.at - x.at)[0]?.question;
  if (latest !== undefined && (SELF_QUESTIONS as readonly string[]).includes(latest)) return chatAnswer(replyFor(latest), { craving: 1 });
  if (latest === REVERSE_QUESTION) return chatAnswer(replyFor(REVERSE_QUESTION), { craving: -1 });
  // 作品の読者の話と、そのほか（場面探しなどが混ざったとき）には信号を返さない
  return chatAnswer(replyFor(latest ?? "そのほか"), null);
}

/**
 * 4回目に推し量られるはずの層の呼び名。**名前を決め打ちしない**（層の表が変わっても追える）。
 * 出発点（3軸とも中ほど）から、求めるものだけが +0.5 ずつ4回動いた点数で、製品と同じ関数に名乗らせる
 */
const EXPECTED_LABEL = authorReaderTypeLabel({
  scores: {
    familiarity: READER_NEUTRAL_SCORE,
    posture: READER_NEUTRAL_SCORE,
    craving: READER_NEUTRAL_SCORE + 0.5 * SELF_QUESTIONS.length,
  },
});

const ESTIMATED_PREFIX = "相談でのお話から、読者としてのあなたを";
const NOT_DECIDED = "あなたが決めたものではありません";
const STOPPED = "出すのをやめました";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(respond);
});
afterAll(async () => {
  await fake.close();
});

/** 横の相談パネルの面（`#context-what` と `#to-main` を持つ） */
async function sideChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const isSide = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null)
      .catch(() => false);
    if (isSide) return frame;
  }
  return undefined;
}

async function logText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "");
}

/** 会話欄に出ている推し量りの知らせの数（「推し量りました」の文の出た回数） */
function estimateNoticeCount(log: string): number {
  return log.split(ESTIMATED_PREFIX).length - 1;
}

async function openSideChat(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
  await waitUntil(async () => (await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
  const side = (await sideChatFrame(page)) as Frame;
  await waitUntil(
    async () => (await side.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE),
    "相談の対象に作品名が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの対象：${JSON.stringify(await side.evaluate(() => document.getElementById("context-what")?.textContent ?? ""))}）`);
  });
  return side;
}

/** 問いを送り、その答えが会話に出るまで待つ */
async function ask(page: Page, frame: Frame, question: string): Promise<void> {
  await sendChatQuestion(frame, question, "横の相談パネル");
  const answer = replyFor(question);
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      return (await logText(frame)).includes(answer);
    },
    `「${question}」の答えが会話に出る`,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（会話：${JSON.stringify((await logText(frame)).slice(-400))}／${describeFakeRequests(fake.requests)}）`);
  });
}

/**
 * 作家タイプ診断の入口を開き、「読者としての好み」の行の説明（「いま：…」）を読んで閉じる。
 * 説明が無ければ空文字（一度も推し量っていない・答えていない）
 */
async function readerEntranceDescription(page: Page): Promise<string> {
  await runCommand(page, "作家タイプ診断（はじめの案内）");
  await waitForQuickPick(page, "作家タイプ診断");
  const rows = await quickPickRows(page);
  const row = rows.find((item) => item.label.includes("読者としての好み"));
  if (!row) throw new Error(`作家タイプ診断の入口に「読者としての好み」の行がありません（${JSON.stringify(rows)}）`);
  await page.keyboard.press("Escape");
  await waitUntil(async () => (await quickPickTitle(page)) === undefined, "作家タイプ診断の入口が閉じる", 10_000);
  return row.description;
}

test("9問に答えずに相談で読み方を話すと、層が離れるまでは推し量れていないと出て、4回目で推し量りの知らせと入口の「いま：」が出て、逆の向きで真ん中へ戻ると黙って隠れる", async () => {
  await withVsCode(
    "相談から読者タイプを推し量る",
    [{ name: EPISODE, text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const { page } = session;
      const side = await openSideChat(page);

      /* ── 作品の読者の話だけでは、知らせが出ない ── */
      const requestsBefore = fake.requests.length;
      await ask(page, side, WORK_READER_QUESTION);
      // 9問に答えていない作者の相談にも、読み方を推し量る頼みが添えられている
      // 相談の前に、場面を探す検索語の頼み（SEARCH_TERMS_SYSTEM_PROMPT）にも同じ問いが載るので、それは除く
      const sent = fake.requests
        .slice(requestsBefore)
        .find((request) => request.user.includes(WORK_READER_QUESTION) && !request.system.includes(SEARCH_TERMS_SYSTEM_PROMPT));
      expect(sent, `作品の読者の問いが偽のAIに届いていません（${describeFakeRequests(fake.requests, requestsBefore)}）`).toBeDefined();
      expect(
        `${sent?.system ?? ""}\n${sent?.user ?? ""}`,
        "9問に答えていない作者の相談に、読み方を推し量る頼み（【authorReaderSignals）が添えられていません"
      ).toContain("【authorReaderSignals");
      await holdsFor(async () => estimateNoticeCount(await logText(side)) === 0, "作品の読者の話だけでは推し量りの知らせが出ない");
      // 一度も推し量っていない（何も記録していない）ので、入口には「いま：」が付かない
      expect(await readerEntranceDescription(page), "作品の読者の話だけで、入口に読者としての層が出ました").toBe("");

      /* ── 同じ向きで1〜3回：まだ推し量れていない ── */
      for (const [index, question] of SELF_QUESTIONS.slice(0, -1).entries()) {
        await ask(page, side, question);
        await holdsFor(
          async () => estimateNoticeCount(await logText(side)) === 0,
          `${index + 1}回目のあとは推し量りの知らせが出ない`
        );
        expect(await readerEntranceDescription(page), `${index + 1}回目のあとの入口の「読者としての好み」`).toBe(
          `いま：${AUTHOR_READER_PENDING_NOTE}`
        );
      }

      /* ── 4回目：推し量りの知らせと、入口の「いま：〇〇層（相談から推し量ったもの）」 ── */
      await ask(page, side, SELF_QUESTIONS[SELF_QUESTIONS.length - 1]);
      await waitUntil(
        async () => {
          const log = await logText(side);
          return estimateNoticeCount(log) === 1 && log.includes(NOT_DECIDED);
        },
        "4回目のあと、相談パネルに推し量りの知らせと「あなたが決めたものではありません」が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（会話：${JSON.stringify((await logText(side)).slice(-600))}）`);
      });
      const log = await logText(side);
      const named = /相談でのお話から、読者としてのあなたを「(.+?)」と推し量りました/.exec(log)?.[1];
      expect(named, `推し量りの知らせの層の名前（会話：${JSON.stringify(log.slice(-600))}）`).toBe(EXPECTED_LABEL);
      expect(await readerEntranceDescription(page), "4回目のあとの入口の「読者としての好み」").toBe(
        `いま：${EXPECTED_LABEL}（相談から推し量ったもの）`
      );

      /* ── 逆の向きで真ん中へ戻す：相談パネルには何も出ず、入口が戻る ── */
      await ask(page, side, REVERSE_QUESTION);
      await holdsFor(
        async () => {
          const text = await logText(side);
          return estimateNoticeCount(text) === 1 && !text.includes(STOPPED);
        },
        "真ん中へ戻ったとき、相談パネルに新しい知らせ（「出すのをやめました」など）が出ない"
      );
      const afterReverse = await logText(side);
      const tail = afterReverse.slice(afterReverse.indexOf(replyFor(REVERSE_QUESTION)));
      expect(tail, "逆の向きの答えのあとに、読者としての層の知らせが出ました").not.toContain("読者としてのあなた");
      expect(await readerEntranceDescription(page), "真ん中へ戻したあとの入口の「読者としての好み」").toBe(
        `いま：${AUTHOR_READER_PENDING_NOTE}`
      );
    },
    fakeOllamaLaunch(fake, {
      keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }],
    })
  );
});
