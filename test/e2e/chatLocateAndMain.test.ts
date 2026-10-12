/**
 * 相談パネルの「そこを見せて」と「メインに表示」（画面の自動テスト、設計書6.21・6.25.11・6.113。
 * 実機確認リスト 112・5525 行を、仕分け 2026-10-12 の束 E5 として移した。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 1. 112：原稿エディターで開いている話を、相談の答えの「そこを見せて」（◎の札）が指したとき、
 *    **素のテキストエディターのタブが増えず**、原稿エディターのその行へカーソルが来て光り、
 *    **焦点が相談パネルから本文へ移る**（以前は相談パネルに残っていた）
 * 2. 5525：横の相談パネルで1往復したあと［メインに表示］を押すと、本文の領域（エディターの列）に
 *    大きい相談画面が「AIに相談」のタブとして開き、横のパネルも残り、**さっきの会話の続きが見え**、
 *    そのまま次を聞くと前のやり取りを添えて送られる
 *
 * **本物の AI は呼ばない。** 偽の Ollama が相談の答えの形（`prompts/workChat.ts` の WORK_CHAT_SCHEMA）で
 * 決まった答えを返す。答えの出来は見えない（AI の測定の仕事）。見えるのは答えが返ったあとの配線と画面だけ。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { caretPosition, manuscriptFrames, openEpisode, placeCaretAfter, revealFlashLit } from "./support/manuscriptFrame";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { countTabsNamed, editorGroupTabs, pressWorkbenchKey, tabNamesInclude } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const BODY = ["　朝の駅は静かだった。", "　改札の横で、リナは古い切符を握りしめていた。", "　発車のベルが鳴った。", ""].join("\n");
const LOCATE_QUOTE = "リナは古い切符を握りしめていた";

const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";

const QUESTION_1 = "切符の場面はどこでしたか";
const QUESTION_2 = "その場面をもう少し膨らませたいです";
const ANSWER_1 = "偽のAIの答えです：切符の場面は2行目です。";
const ANSWER_2 = "偽のAIの答えです：改札の音を足すと膨らみます。";

/** 相談の答えの形（全項目を返す）。`locate` を渡すと「そこを見せて」の札が出る */
function chatAnswer(reply: string, locate: { path: string; text: string; label: string } | null = null): string {
  return JSON.stringify({
    reply,
    options: [],
    needFiles: null,
    edit: null,
    run: null,
    locate,
    reloadRecord: null,
    profileSignals: null,
    writerStyleSignals: null,
  });
}

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    if (request.user.includes(QUESTION_2)) return chatAnswer(ANSWER_2);
    // 1問目には、原稿の2行目を指す「そこを見せて」を添える（道は作品フォルダーからの相対）
    return chatAnswer(ANSWER_1, { path: `本文/${EPISODE}`, text: LOCATE_QUOTE, label: "切符の場面を見せて" });
  });
});
afterAll(async () => {
  await fake.close();
});

/** 相談パネルの面（`#context-what` を持つ）。大きい画面は `#to-sub`、横は `#to-main` を持つ */
async function chatFrames(page: Page): Promise<{ side?: Frame; large?: Frame }> {
  const found: { side?: Frame; large?: Frame } = {};
  for (const frame of page.frames()) {
    const kind = await frame
      .evaluate(() => {
        if (document.getElementById("context-what") === null) return "";
        if (document.getElementById("to-sub") !== null) return "large";
        if (document.getElementById("to-main") !== null) return "side";
        return "";
      })
      .catch(() => "");
    if (kind === "large") found.large = frame;
    if (kind === "side") found.side = frame;
  }
  return found;
}

async function logText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.innerText ?? "");
}

/** 横の相談パネルを開き、相談の対象に作品名が出るまで待つ */
async function openSideChat(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
  await waitUntil(async () => (await chatFrames(page)).side !== undefined, "横の相談パネルが開く", 30_000);
  const side = (await chatFrames(page)).side as Frame;
  await waitUntil(
    async () => (await side.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE),
    "相談の対象に作品名が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの対象：${JSON.stringify(await side.evaluate(() => document.getElementById("context-what")?.textContent ?? ""))}）`);
  });
  return side;
}

/** 面の入力欄に打って送り、答えが会話に出るまで待つ */
async function ask(page: Page, frame: Frame, question: string, answer: string, where: string): Promise<void> {
  await frame.locator("#input").click();
  await page.keyboard.insertText(question);
  await frame.locator("#send").click();
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      return (await logText(frame)).includes(answer);
    },
    `${where}に答えが出る`,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${where}の会話：${JSON.stringify((await logText(frame)).slice(-400))}／偽のAIへの呼び出し：${fake.requests.length}回）`);
  });
}

/**
 * 原稿の面が、本体（ワークベンチ）の側で焦点を持っているか。
 * WebView は2重の iframe なので、内側の面の親（外側の枠）の `<iframe>` が、本体の文書の
 * `document.activeElement` になっているかで見る。あわせて内側で焦点のある要素の id も返す
 */
async function focusOf(frame: Frame): Promise<{ outerActive: boolean; innerActive: string }> {
  const outer = frame.parentFrame();
  const element = outer ? await outer.frameElement().catch(() => undefined) : undefined;
  const outerActive = element ? await element.evaluate((node) => node === document.activeElement).catch(() => false) : false;
  const innerActive = await frame.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName ?? "").catch(() => "");
  return { outerActive, innerActive };
}

test("原稿エディターで開いている話を相談の「そこを見せて」が指すと、素のタブが増えず、原稿のその行が光ってカーソルが来て、焦点が本文へ移る", async () => {
  await withVsCode(
    "相談のそこを見せて",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      const manuscript = await openEpisode(page, EPISODE, "発車のベルが鳴った");
      await placeCaretAfter(manuscript, "朝の駅");

      const side = await openSideChat(page);
      await ask(page, side, QUESTION_1, ANSWER_1, "横の相談パネル");
      const locate = side.locator(".edit button.option", { hasText: "切符の場面を見せて" }).first();
      await waitUntil(async () => (await locate.count()) > 0, "答えの下に「そこを見せて」の札（◎）が出る", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（会話：${JSON.stringify((await logText(side)).slice(-400))}）`);
      });
      const tabsBefore = await editorGroupTabs(page);
      expect(countTabsNamed(tabsBefore.flat(), EPISODE), `押す前から同じ話のタブが重なっています：${JSON.stringify(tabsBefore)}`).toBe(1);

      await locate.click();

      /* ── 原稿エディターのその行へカーソルが来て、光る ── */
      await waitUntil(async () => ((await caretPosition(manuscript).catch(() => undefined))?.lineText ?? "").includes(LOCATE_QUOTE), "原稿エディターのカーソルが指された行へ来る", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（カーソル：${JSON.stringify(await caretPosition(manuscript).catch(() => undefined))}／列とタブ：${JSON.stringify(await editorGroupTabs(page))}）`);
        }
      );
      await waitUntil(async () => revealFlashLit(manuscript), "指された行が光る", 5_000);

      /* ── 焦点が相談パネルから本文へ移る ── */
      await waitUntil(async () => (await focusOf(manuscript)).outerActive, "焦点が原稿エディターへ移る", 10_000).catch(async (error: unknown) => {
        const active = await page.evaluate(() => {
          const node = document.activeElement;
          return node ? `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 80)}` : "なし";
        });
        throw new Error(`${String(error)}（本体の焦点：${active}／原稿の面の中の焦点：${(await focusOf(manuscript)).innerActive}）`);
      });
      expect((await focusOf(manuscript)).innerActive, "原稿の面の中で、組んで書く面に焦点がありません").toBe("compose");

      /* ── 素のテキストエディターのタブが増えない（遅れて開く2枚目も見逃さない） ── */
      await holdsFor(async () => countTabsNamed((await editorGroupTabs(page)).flat(), EPISODE) === 1 && (await manuscriptFrames(page)).length === 1, "同じ話のタブが1枚のまま").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}／原稿の面：${(await manuscriptFrames(page)).length}枚）`);
        }
      );
      expect(await page.locator(".editor-group-container .monaco-editor .view-lines", { hasText: "発車のベル" }).count(), "素のテキストエディターで本文が開いています").toBe(0);
    },
    fakeOllamaLaunch(fake, { keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }] })
  );
});

test("横の相談パネルで1往復したあと［メインに表示］を押すと、本文の領域に大きく開き、横のパネルも残り、会話の続きが見えて、続けて聞くと前のやり取りを添えて送る", async () => {
  await withVsCode(
    "相談をメインに表示",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      const side = await openSideChat(page);
      await ask(page, side, QUESTION_1, ANSWER_1, "横の相談パネル");

      await side.locator("#to-main").click();
      await waitUntil(async () => (await chatFrames(page)).large !== undefined, "［メインに表示］で大きい相談画面が開く", 30_000);
      const large = (await chatFrames(page)).large as Frame;

      // 本文の領域（エディターの列）に「AIに相談」のタブとして開く
      await waitUntil(async () => tabNamesInclude((await editorGroupTabs(page)).flat(), "AIに相談"), "エディターの列に「AIに相談」のタブが出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}）`);
        }
      );
      // 会話の続きが見える（さっきの問いと答え）
      await waitUntil(async () => {
        const text = await logText(large);
        return text.includes(QUESTION_1) && text.includes(ANSWER_1);
      }, "大きい画面に、さっきの問いと答えが出る", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（大きい画面の会話：${JSON.stringify((await logText(large)).slice(-400))}）`);
      });
      // 横のパネルも残っている
      const { side: sideAfter } = await chatFrames(page);
      expect(sideAfter, "［メインに表示］のあと、横の相談パネルが消えました").toBeDefined();
      expect(await logText(sideAfter as Frame), "横の相談パネルの会話が消えました").toContain(ANSWER_1);

      /* ── 大きい画面で続けて聞く → 前のやり取りを添えて送られる ── */
      const sentBefore = fake.requests.length;
      await ask(page, large, QUESTION_2, ANSWER_2, "大きい相談画面");
      const second = fake.requests.slice(sentBefore).find((request) => request.user.includes(QUESTION_2));
      expect(second, "2問目が偽のAIへ届いていません").toBeDefined();
      expect(second?.user, "2問目に前のやり取りが添えられていません（会話が続いていない）").toContain("【これまでのやり取り】");
      expect(second?.user).toContain(QUESTION_1);
      const after = await logText(large);
      expect(after.indexOf(QUESTION_1), `大きい画面で、前の問いが新しい答えより上にありません：${after.slice(-400)}`).toBeLessThan(after.indexOf(ANSWER_2));
    },
    fakeOllamaLaunch(fake, { keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }] })
  );
});
