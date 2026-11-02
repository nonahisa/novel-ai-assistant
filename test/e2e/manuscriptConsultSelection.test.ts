/**
 * 原稿エディターの本文の右クリック「AIに相談（選んだ所）」を押したときの働き（画面の自動テスト、設計書6.25.10・6.21・6.113。
 * 実機確認リスト 0.122.0 の 371 行の残り。作者の判断 2026-11-02 で名前を命令の名前「AIに相談」にそろえた）。
 *
 * 品書きの名前は manuscriptEditor の「本文の右クリックの品書きに…」が、「ここにメモを足す」を押したときの働きは
 * sceneMemoJumps が見ている。ここでは「AIに相談（選んだ所）」を押したときを見る：
 *
 * 1. 字を選んで右クリック →「AIに相談（選んだ所）」で、横の相談パネルが開き、相談の対象がその話の本文になる
 * 2. 素のテキストエディターのタブは開かない（以前は3列目に素のエディターが開いていた。作者の報告 2026-10-04）
 * 3. そのまま問いを送ると、AI へ渡す材料に「作者が選んだ範囲です」の断りと、選んだ字が入る
 *
 * **本物の AI は呼ばない。** 偽の Ollama が相談の答えの形で決まった答えを返す。見ているのは、選んだ所が
 * 相談へ渡る配線だけ（答えの出来は見えない）。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sendChatQuestion } from "./support/chatInput";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { manuscriptFrames, openEpisode, selectText } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { countTabsNamed, editorGroupTabs } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const BODY = ["　朝の駅は静かだった。", "　改札の横で、リナは古い切符を握りしめていた。", "　発車のベルが鳴った。", ""].join("\n");
const SELECTED = "リナは古い切符を握りしめていた";
const QUESTION = "この一文の気持ちは伝わりますか";
const ANSWER = "偽のAIの答えです：伝わります。";
/** 選んだ範囲を渡したときに、材料の頭に付く断り（`prompts/workChat.ts`） */
const SELECTION_NOTE = "作者が選んだ範囲です";

function chatAnswer(reply: string): string {
  return JSON.stringify({ reply, options: [], needFiles: null, edit: null, run: null, locate: null, reloadRecord: null, profileSignals: null, writerStyleSignals: null });
}

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => chatAnswer(ANSWER));
});
afterAll(async () => {
  await fake.close();
});

/** 横の相談パネルの面（`#context-what` と［メインに表示］`#to-main` を持つ） */
async function sideChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null).catch(() => false);
    if (found) return frame;
  }
  return undefined;
}

/** 組んで書く面の選択の真ん中（`#compose` の左上からの位置）。右クリックで選択を外さないため */
async function selectionPoint(frame: Frame): Promise<{ x: number; y: number }> {
  const point = await frame.evaluate(() => {
    const compose = document.getElementById("compose");
    const selection = window.getSelection();
    if (!compose || !selection || selection.rangeCount === 0) return undefined;
    const rects = Array.from(selection.getRangeAt(0).getClientRects());
    const rect = rects.find((entry) => entry.height > 0) ?? selection.getRangeAt(0).getBoundingClientRect();
    const base = compose.getBoundingClientRect();
    return { x: rect.left - base.left + Math.max(rect.width / 2, 1), y: rect.top - base.top + rect.height / 2 };
  });
  if (!point) throw new Error("組んで書く面の選択が取れません（右クリックの場所が決まりません）");
  return point;
}

test("本文の字を選んで右クリック「AIに相談（選んだ所）」を押すと、素のタブを開かずに横の相談パネルがその話の本文を対象に開き、問いを送るとAIへ選んだ字が「作者が選んだ範囲」として渡る", async () => {
  await withVsCode(
    "AIに相談（選んだ所）",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      const from = fake.requests.length;
      const frame = await openEpisode(page, EPISODE, "発車のベル");
      await selectText(frame, SELECTED);

      /* ── 右クリック →「AIに相談（選んだ所）」 ── */
      await frame.locator("#compose").click({ button: "right", position: await selectionPoint(frame) });
      const item = frame.locator("#menu .item", { hasText: "AIに相談（選んだ所）" }).first();
      await waitUntil(async () => (await frame.locator("#menu").evaluate((menu) => menu.classList.contains("open"))) && (await item.count()) > 0, "右クリックの品書きに「AIに相談（選んだ所）」が出る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（品書き：${JSON.stringify(await frame.locator("#menu").innerText().catch(() => ""))}）`);
        }
      );
      expect(await item.getAttribute("class"), "字を選んでいるのに「AIに相談（選んだ所）」が押せない形です").not.toContain("disabled");
      await item.click();

      /* ── 横の相談パネルが開き、対象がその話の本文になる ── */
      let side: Frame | undefined;
      let what = "";
      await waitUntil(
        async () => {
          side = await sideChatFrame(page);
          what = side ? await side.evaluate(() => document.getElementById("context-what")?.textContent ?? "").catch(() => "") : "";
          // 話の題が読めれば「第1話 の本文」、読めなければ「001_はじまり.txt（本文）」（`core/chatContext.ts`）
          return what === "第1話 の本文" || what.includes(EPISODE);
        },
        "横の相談パネルが開き、相談の対象にその話が出る",
        30_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（いまの対象：${JSON.stringify(what)}）`);
      });

      /* ── 素のテキストエディターのタブは開かない ── */
      await holdsFor(async () => countTabsNamed((await editorGroupTabs(page)).flat(), EPISODE) === 1 && (await manuscriptFrames(page)).length === 1, "同じ話のタブが1枚のまま（素のエディターが開かない）").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}）`);
        }
      );

      /* ── 問いを送ると、選んだ字が「作者が選んだ範囲」として AI へ渡る ── */
      await sendChatQuestion(side as Frame, QUESTION, "横の相談パネル");
      // 相談は先に場面探しの検索語づくり（P-22）を頼んでから、本番の問いを送る。答えが会話に出るまで待つ
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return ((await side?.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "")) ?? "").includes(ANSWER);
        },
        "相談の答えが会話に出る",
        60_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}\n${describeFakeRequests(fake.requests, from)}`);
      });
      const asked = fake.requests.slice(from).filter((request) => request.user.includes(QUESTION) && !request.user.startsWith("次の質問に合う場面を"));
      const material = asked[asked.length - 1]?.user ?? "";
      expect(material, `AIへ渡した材料に選んだ範囲の断りがありません：${material.slice(0, 600)}`).toContain(SELECTION_NOTE);
      const note = material.indexOf(SELECTION_NOTE);
      expect(material.slice(note), "断りのあとに選んだ字がありません").toContain(SELECTED);
    },
    fakeOllamaLaunch(fake)
  );
}, 240_000);
