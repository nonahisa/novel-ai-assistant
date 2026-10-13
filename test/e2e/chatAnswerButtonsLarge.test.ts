/**
 * 大きい相談画面の答えのボタン（画面の自動テスト、設計書6.21・6.31.3・6.4.7・6.113。
 * 実機確認リスト 6504・6546 行を、仕分け 2026-10-12 の束 E18 として移した。2026-10-13）。
 *
 * 1. 6504：大きい画面で質問すると答えが返り、答えに付いたものが1つずつ押せるか
 *    - 書き込み：頼まれた書き込みは押さずに入る（2026-09-21 の作者の裁定）。`設定/plot.md` の「テーマ」に
 *      入り、［取り消す］を押すと書く前（未記入）へ戻る
 *    - 機能起動：「ほかにできること」を開いて［表記ゆれを検知する（AIを使いません）］を押すと、詳細メニューと
 *      同じ表記ゆれの検知が走り（組を選ぶ画面が出る）、校正・メモパネルに指摘が並び、AI は呼ばれない
 *    - そこを見せて：［◎ 星の場面を見せて］で原稿エディターが開き、その行へカーソルが来て光る
 *    - 選択肢：［1 星の数を…］を押すと、その字が次の質問として前のやり取りを添えて送られ、答えが返る
 * 2. 6546：「アジャーノに殿下の情報が混ざっている」と伝えて返った［「アジャーノ」をAIで再読込］を押すと、
 *    設定資料パネルがアジャーノで開き、留意点の欄に相談の留意点がそのまま入り、再読込の頼みが留意点つきで
 *    AI へ届いて、項目の提案が並ぶ（相談には「設定資料の画面で開きました」が出る）
 *
 * **本物の AI は呼ばない。** 偽の Ollama が相談の答えの形（WORK_CHAT_SCHEMA）でボタンを載せた答えを返す
 * （`support/chatAnswerButtons.ts`。製品の検算へ通して、ボタンとして残る形であることを確かめてある）。
 * 答えの出来（実機の AI がボタンを付けるか）は見えない——AI の測定の仕事。見えるのは押したあとの配線だけ。
 *
 * **押す順に意味がある。** 選択肢を押すと、画面は「古い選択肢が残ると、どの返事への選択か分からない」ため
 * `.options` の箱を全部消す——［取り消す］・実行・そこを見せての行も同じ名前の箱に入っているので、
 * 選択肢は最後に押す。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import {
  AJANO,
  BUTTON_OPTIONS,
  BUTTONS_ANSWER,
  BUTTONS_BODY,
  BUTTONS_EPISODE,
  BUTTONS_QUESTION,
  BUTTONS_REPLY,
  DENKA,
  EDIT_THEME,
  ENRICH_ANSWER,
  ENRICH_ROLE,
  ENRICH_SUMMARY,
  isEnrichRequest,
  LOCATE_LABEL,
  LOCATE_QUOTE,
  OPTION_ANSWER,
  OPTION_REPLY,
  RELOAD_BODY,
  RELOAD_BUTTON_TEXT,
  RELOAD_CHAT_ANSWER,
  RELOAD_EPISODE,
  RELOAD_NOTES,
  RELOAD_QUESTION,
  RELOAD_REPLY,
  RUN_BUTTON_TEXT,
  SEARCH_TERMS_ANSWER,
} from "./support/chatAnswerButtons";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama, type FakeOllamaRequest } from "./support/fakeOllama";
import { caretPosition, manuscriptFrames, memoPanelFrame, revealFlashLit } from "./support/manuscriptFrame";
import { defaultCharactersFolder, settingsFolder, settingsPanelFrame, writeCharactersTo } from "./support/settingsFixture";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  dialogText,
  editorGroupTabs,
  notificationTexts,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
  toggleQuickPickRow,
  waitForQuickPick,
} from "./support/workbenchDom";

const OPEN_LARGE_KEY = "ctrl+alt+shift+h";
const OPEN_LARGE_PRESS = "Control+Alt+Shift+KeyH";

/** 場面探しの検索語づくり（P-22）の頼みか。system の1行目か、頼みの書き出しで見分ける */
function isSearchTermsRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes(SEARCH_TERMS_SYSTEM_PROMPT.split("\n")[0]) || request.user.startsWith("次の質問に合う場面を");
}

/**
 * 相談の本体への答え。**件の頭で差し替える**（偽の Ollama はファイルの中の件で共有する）。
 * 検索語づくりと再読込の頼みは、ここへ来る前に振り分ける
 */
let chatResponder: (request: FakeOllamaRequest) => string = () => "{}";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    if (isSearchTermsRequest(request)) return SEARCH_TERMS_ANSWER;
    if (isEnrichRequest(request)) return ENRICH_ANSWER;
    return chatResponder(request);
  });
});
afterAll(async () => {
  await fake.close();
});

/** 相談の本体の頼みのうち、`from` より後で、user に `needle` を含むもの（検索語づくり・再読込は除く） */
function chatRequestsSince(from: number, needle: string): FakeOllamaRequest[] {
  return fake.requests.slice(from).filter((request) => request.user.includes(needle) && !isSearchTermsRequest(request) && !isEnrichRequest(request));
}

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

/** 落ちたときに添える：会話の終わり・出ている知らせと確認の窓・タブ・偽の AI への頼み */
async function describeState(page: Page, frame: Frame | undefined, from: number): Promise<string> {
  const log = frame ? (await logText(frame).catch(() => "")).slice(-500) : "（大きい画面が見つからない）";
  return (
    `（会話の終わり：${JSON.stringify(log)}／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}` +
    `／確認の窓：${JSON.stringify(await dialogText(page).catch(() => undefined))}／選ぶ画面：${JSON.stringify(await quickPickTitle(page).catch(() => undefined))}` +
    `／列とタブ：${JSON.stringify(await editorGroupTabs(page).catch(() => []))}／${describeFakeRequests(fake.requests, from)}）`
  );
}

/** 大きい相談画面を開く（開いていれば前に出す）。前に出て［送る］が見えるまで待ち、面を返す */
async function showLargeChat(page: Page, from: number): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_LARGE_PRESS);
  let large: Frame | undefined;
  await waitUntil(
    async () => {
      large = await largeChatFrame(page);
      return large !== undefined && (await large.locator("#send").isVisible().catch(() => false));
    },
    "大きい相談画面が前に出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await describeState(page, large, from)}`);
  });
  return large as Frame;
}

/** 大きい相談画面を開いて、相談の対象に作品名が出るまで待つ */
async function openLargeChat(page: Page, from: number): Promise<Frame> {
  const large = await showLargeChat(page, from);
  await waitUntil(
    async () => (await large.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE),
    "大きい画面の「相談の対象」に作品名が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの対象：${JSON.stringify(await large.evaluate(() => document.getElementById("context-what")?.textContent ?? ""))}）`);
  });
  return large;
}

/** 入力欄に打って送り、答えが会話に出るまで待つ（手元のAIの関所が出たら通す） */
async function ask(page: Page, large: Frame, question: string, reply: string, from: number): Promise<void> {
  await large.locator("#input").click();
  await page.keyboard.insertText(question);
  await large.locator("#send").click();
  await waitForReply(page, large, reply, from);
}

async function waitForReply(page: Page, large: Frame, reply: string, from: number): Promise<void> {
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      return (await logText(large)).includes(reply);
    },
    `大きい画面に答え「${reply.slice(0, 20)}…」が出る`,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await describeState(page, large, from)}`);
  });
}

/** 答えの下の「ほかにできること（N件）を見る」を開く（実行・再読込はここに畳まれている） */
async function openMore(large: Frame, count: number): Promise<void> {
  const toggle = large.locator(".more-toggle", { hasText: `ほかにできること（${count}件）を見る` }).last();
  await waitUntil(async () => (await toggle.count()) > 0, `答えの下に「ほかにできること（${count}件）を見る」が出る`, 15_000).catch(async (error: unknown) => {
    const toggles = await large.evaluate(() => Array.from(document.querySelectorAll(".more-toggle")).map((node) => node.textContent ?? ""));
    throw new Error(`${String(error)}（畳みの札：${JSON.stringify(toggles)}／会話：${JSON.stringify((await logText(large)).slice(-400))}）`);
  });
  await toggle.click();
}

/**
 * 答えに付いた箱（`data-edit-id` が `edit-`・`run-`・`locate-`・`reload-` で始まる）の、**最後の**結果の行
 * （.done / .failed）を「class:字」で返す。
 *
 * 箱は id の頭で探す——押したあとの箱はボタンの行が消える（`markEdit`）ので、ボタンの字では見つからない。
 * 最後の行を取るのは、書き込みの箱には「書き換えました」が最初からあり、取り消しの結果がその下に足されるため
 */
async function resultLineOf(large: Frame, idPrefix: string): Promise<string> {
  return large.evaluate((prefix) => {
    const boxes = Array.from(document.querySelectorAll("[data-edit-id]")).filter((box) => (box as HTMLElement).dataset.editId?.startsWith(prefix));
    const box = boxes[boxes.length - 1];
    if (!box) return "";
    const lines = box.querySelectorAll(".done, .failed");
    const line = lines[lines.length - 1];
    return line ? `${line.className}:${line.textContent ?? ""}` : "";
  }, idPrefix);
}

/** 設定資料フォルダーの plot.md（無ければ空） */
async function plotText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(await settingsFolder(session), "plot.md"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/* ── 1. 6504：選択肢・書き込み・機能起動・そこを見せて ── */

test("大きい画面で質問すると答えが返り、書き込みは入って［取り消す］で戻り、［表記ゆれを検知する］は検知を走らせ、［そこを見せて］は原稿のその行へ行き、選択肢は次の質問として送られる", async () => {
  chatResponder = (request) => {
    // 選択肢の頼みは、前のやり取り（1問目）も添えて送られるので、先に見分ける
    if (request.user.includes(BUTTON_OPTIONS[0])) return OPTION_ANSWER;
    if (request.user.includes(BUTTONS_QUESTION)) return BUTTONS_ANSWER;
    return "{}";
  };
  await withVsCode(
    "相談の答えのボタン（大きい画面）",
    [{ name: BUTTONS_EPISODE, text: BUTTONS_BODY }],
    async (session) => {
      const { page } = session;
      // 偽の AI はファイルの中の件で共有なので、この件で増えた分だけを見る
      const sentBefore = fake.requests.length;
      let large = await openLargeChat(page, sentBefore);

      /* ── 質問 → 答えが返る ── */
      await ask(page, large, BUTTONS_QUESTION, BUTTONS_REPLY, sentBefore);
      expect(chatRequestsSince(sentBefore, BUTTONS_QUESTION).length, `質問が相談として偽のAIへ届いていません（${describeFakeRequests(fake.requests, sentBefore)}）`).toBeGreaterThan(0);

      /* ── 書き込み：押さずに入る → ［取り消す］で書く前（未記入）へ戻る ── */
      await waitUntil(async () => (await plotText(session)).includes(EDIT_THEME), "設定/plot.md の「テーマ」に頼まれた中身が書き込まれる", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（plot.md：${JSON.stringify((await plotText(session)).slice(0, 400))}）${await describeState(page, large, sentBefore)}`);
        }
      );
      await waitUntil(async () => (await resultLineOf(large, "edit-")).includes("を書き換えました"), "会話に「書き換えました」と入った中身が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（結果の行：${JSON.stringify(await resultLineOf(large, "edit-"))}）${await describeState(page, large, sentBefore)}`);
        }
      );
      await large.locator("[data-edit-id] button.option", { hasText: "取り消す" }).first().click();
      await waitUntil(async () => !(await plotText(session)).includes(EDIT_THEME), "［取り消す］で plot.md から書いた中身が消える", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（plot.md：${JSON.stringify((await plotText(session)).slice(0, 400))}／結果の行：${JSON.stringify(await resultLineOf(large, "edit-"))}）`);
        }
      );
      await waitUntil(async () => (await resultLineOf(large, "edit-")).includes("書く前（未記入）へ戻しました"), "会話に「書く前（未記入）へ戻しました」が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（結果の行：${JSON.stringify(await resultLineOf(large, "edit-"))}）`);
        }
      );

      /* ── 機能起動：［表記ゆれを検知する（AIを使いません）］ → 表記ゆれの検知が走る ── */
      await openMore(large, 1);
      const run = large.locator(".more-body button.option", { hasText: RUN_BUTTON_TEXT });
      expect(await run.count(), `「${RUN_BUTTON_TEXT}」の札がありません`).toBe(1);
      const sentBeforeRun = fake.requests.length;
      await run.click();
      // 詳細メニューと同じコマンド（novelai.checkNotation）が走ると、組を選ぶ画面が出る
      await waitUntil(
        async () => (await quickPickTitle(page))?.startsWith("表記ゆれが 1 組見つかりました") === true,
        "押すと表記ゆれの組を選ぶ画面が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（結果の行：${JSON.stringify(await resultLineOf(large, "run-"))}）${await describeState(page, large, sentBefore)}`);
      });
      await waitUntil(async () => (await quickPickRows(page)).length === 1, "組の行が1つ出る", 10_000);
      const [row] = await quickPickRows(page);
      expect(row.label).toContain("沢山");
      await toggleQuickPickRow(page, row.label);
      await acceptQuickPick(page);
      await waitForQuickPick(page, `${row.label} — どちらに揃えますか`);
      await pickQuickPickRow(page, "「たくさん」に揃える");
      // 検知が終わると、指摘は校正・メモパネルに並ぶ（設計書6.96.5）
      await waitUntil(
        async () => {
          const memo = await memoPanelFrame(page);
          return memo !== undefined && (await memo.evaluate(() => document.querySelectorAll('button[data-act="fix"]').length === 1 && document.body.innerText.includes("沢山")));
        },
        "校正・メモパネルに表記ゆれの指摘（沢山→たくさん）が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page, large, sentBefore)}`);
      });
      large = (await largeChatFrame(page)) ?? large;
      await waitUntil(async () => (await resultLineOf(large, "run-")).startsWith("done:"), "相談の会話に「実行しました」が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（結果の行：${JSON.stringify(await resultLineOf(large, "run-"))}）`);
        }
      );
      // 札は「AIを使いません」と言っている——押しても AI は呼ばれない
      // 遅れて飛ぶ頼みも拾うよう、しばらく見続ける
      await holdsFor(async () => fake.requests.length === sentBeforeRun, "表記ゆれの検知のあとも AI が呼ばれないこと", 2_000).catch((error: unknown) => {
        throw new Error(`${String(error)}（${describeFakeRequests(fake.requests, sentBeforeRun)}）`);
      });

      /* ── そこを見せて：原稿エディターでその行が光り、カーソルが来る ── */
      large = await showLargeChat(page, sentBefore);
      const locate = large.locator("[data-edit-id] button.option", { hasText: LOCATE_LABEL });
      expect(await locate.count(), `「${LOCATE_LABEL}」の札がありません`).toBe(1);
      await locate.click();
      let manuscript: Frame | undefined;
      await waitUntil(
        async () => {
          [manuscript] = await manuscriptFrames(page);
          if (!manuscript) return false;
          return ((await caretPosition(manuscript).catch(() => undefined))?.lineText ?? "").includes(LOCATE_QUOTE);
        },
        "原稿エディターが開き、カーソルが指された行へ来る",
        30_000
      ).catch(async (error: unknown) => {
        const caret = manuscript ? await caretPosition(manuscript).catch(() => undefined) : undefined;
        throw new Error(`${String(error)}（カーソル：${JSON.stringify(caret)}／結果の行：${JSON.stringify(await resultLineOf(large, "locate-"))}）${await describeState(page, large, sentBefore)}`);
      });
      await waitUntil(async () => revealFlashLit(manuscript as Frame), "指された行が光る", 5_000);
      await waitUntil(async () => (await resultLineOf(large, "locate-")).includes(`${BUTTONS_EPISODE} の 2行目を開きました`), "相談の会話に「2行目を開きました」が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（結果の行：${JSON.stringify(await resultLineOf(large, "locate-"))}）`);
        }
      );

      /* ── 選択肢：押すと、その字が次の質問として前のやり取りを添えて送られる（最後に押す） ── */
      large = await showLargeChat(page, sentBefore);
      expect(await large.evaluate(() => document.getElementById("hint")?.textContent ?? ""), "選択肢の番号の案内が出ていません").toContain("番号（1〜2）");
      const option = large.locator(".options button.option", { hasText: BUTTON_OPTIONS[0] });
      expect(await option.count(), `選択肢「${BUTTON_OPTIONS[0]}」の札がありません`).toBe(1);
      const sentBeforeOption = fake.requests.length;
      await option.click();
      await waitForReply(page, large, OPTION_REPLY, sentBefore);
      const sent = describeFakeRequests(fake.requests, sentBeforeOption);
      const second = chatRequestsSince(sentBeforeOption, BUTTON_OPTIONS[0])[0];
      expect(second, `選択肢の字が相談として偽のAIへ届いていません（${sent}）`).toBeDefined();
      expect(second?.user, `選択肢の頼みに前のやり取りが添えられていません（${sent}）`).toContain("【これまでのやり取り】");
      expect(second?.user, `選択肢の頼みの前のやり取りに1問目がありません（${sent}）`).toContain(BUTTONS_QUESTION);
      const after = await logText(large);
      expect(after.lastIndexOf(BUTTON_OPTIONS[0]), `選んだ字が質問として会話に積まれていません：${after.slice(-400)}`).toBeGreaterThan(after.indexOf(BUTTONS_REPLY));
    },
    fakeOllamaLaunch(fake, { keybindings: [{ key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" }] })
  );
});

/* ── 2. 6546：「AIで再読込」 → 設定資料パネル・留意点・再読込 ── */

test("大きい画面で「アジャーノに殿下の情報が混ざっている」と伝えて出た［「アジャーノ」をAIで再読込］を押すと、設定資料パネルがアジャーノで開き、留意点がそのまま入り、留意点つきの再読込が AI へ届いて提案が並ぶ", async () => {
  chatResponder = (request) => (request.user.includes(RELOAD_QUESTION) ? RELOAD_CHAT_ANSWER : "{}");
  await withVsCode(
    "相談からAIで再読込（大きい画面）",
    [{ name: RELOAD_EPISODE, text: RELOAD_BODY }],
    async (session) => {
      const { page } = session;
      const sentBefore = fake.requests.length;
      const large = await openLargeChat(page, sentBefore);

      await ask(page, large, RELOAD_QUESTION, RELOAD_REPLY, sentBefore);

      /* ── 押す前：札と留意点が見える ── */
      await openMore(large, 1);
      const reload = large.locator(".more-body button.option", { hasText: RELOAD_BUTTON_TEXT });
      expect(await reload.count(), `「${RELOAD_BUTTON_TEXT}」の札がありません（会話：${JSON.stringify((await logText(large)).slice(-400))}）`).toBe(1);
      const preview = await large.evaluate(() => Array.from(document.querySelectorAll(".more-body .preview")).map((node) => node.textContent ?? ""));
      expect(preview, "押す前に留意点が見えていません").toContain(`留意点: ${RELOAD_NOTES}`);

      const sentBeforeReload = fake.requests.length;
      await reload.click();

      /* ── 設定資料パネルがアジャーノで開き、留意点の欄に相談の留意点がそのまま入る ── */
      let panel: Frame | undefined;
      const notesValue = async (): Promise<string> =>
        panel
          ? panel.evaluate(() => (document.querySelector('textarea[placeholder^="例：他の登場人物"]') as HTMLTextAreaElement | null)?.value ?? "").catch(() => "")
          : "";
      await waitUntil(
        async () => {
          panel = await settingsPanelFrame(session);
          return panel !== undefined && (await notesValue()) === RELOAD_NOTES;
        },
        "設定資料パネルが開き、留意点の欄に相談の留意点が入る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（パネル：${panel ? "開いた" : "無い"}／留意点の欄：${JSON.stringify(await notesValue())}）${await describeState(page, large, sentBefore)}`);
      });
      const detail = await (panel as Frame).evaluate(() => document.getElementById("detail")?.textContent ?? "");
      expect(detail, "設定資料パネルにアジャーノが出ていません").toContain(AJANO.name);

      /* ── 留意点つきの再読込が AI へ届く ── */
      let enrich: FakeOllamaRequest | undefined;
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          enrich = fake.requests.slice(sentBeforeReload).find(isEnrichRequest);
          return enrich !== undefined;
        },
        "再読込の頼みが偽のAIへ届く",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page, large, sentBeforeReload)}`);
      });
      const enrichSent = describeFakeRequests(fake.requests, sentBeforeReload);
      expect(enrich?.user, `再読込の相手がアジャーノではありません（${enrichSent}）`).toContain(`「${AJANO.name}」について`);
      expect(enrich?.user, `再読込の頼みに留意点の見出しがありません（${enrichSent}）`).toContain("【作者からの留意点】");
      expect(enrich?.user, `再読込の頼みに相談の留意点がそのまま入っていません（${enrichSent}）`).toContain(RELOAD_NOTES);
      expect(enrich?.user, `殿下の記録を読み直しています（${enrichSent}）`).not.toContain(`「${DENKA.name}」について`);
      expect(enrich?.structured, "再読込の頼みが構造化出力（JSON スキーマ）になっていません").toBe(true);

      /* ── 項目の提案が並ぶ（保存はされない） ── */
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const text = await (panel as Frame).evaluate(() => document.querySelector(".note.proposal")?.textContent ?? "").catch(() => "");
          return text.includes(ENRICH_ROLE) && text.includes(ENRICH_SUMMARY);
        },
        "設定資料パネルに再読込の提案（紹介・役割）が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        const status = await (panel as Frame).evaluate(() => document.getElementById("status")?.textContent ?? "").catch(() => "");
        throw new Error(`${String(error)}（パネルの知らせ：${JSON.stringify(status)}）${await describeState(page, large, sentBeforeReload)}`);
      });

      /* ── 相談の会話に「設定資料の画面で開きました」が出る ── */
      const latest = (await largeChatFrame(page)) ?? large;
      await waitUntil(
        async () => (await resultLineOf(latest, "reload-")).includes(`「${AJANO.name}」を設定資料の画面で開きました`),
        "相談の会話に「設定資料の画面で開きました」が出る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（結果の行：${JSON.stringify(await resultLineOf(latest, "reload-"))}）`);
      });
    },
    fakeOllamaLaunch(fake, {
      keybindings: [{ key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" }],
      prepareWork: async ({ workFolder }) => {
        await writeCharactersTo(defaultCharactersFolder(workFolder), [AJANO, DENKA]);
      },
    })
  );
});
