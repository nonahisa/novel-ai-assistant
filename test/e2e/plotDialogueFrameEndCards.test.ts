/**
 * 対話式プロット作成の「型に当てはめる」で枠を全部埋めると、AI を呼ばずに締めの一言と
 * 「続けて着想から掘る」などの札が出て、札の字が相談パネルの幅で切れない
 * （画面の自動テスト、設計書6.113・6.4.10。実機確認リスト 4692 行〔0.86.12〕の残り
 * 「札の文字が幅で切れないか（画面）」を、2026-10-15 の仕分け
 * 〔docs/measurements/2026-10-15-field-triage-hands.md〕で移した）。
 *
 * 「続けて着想から掘る」を押したあとに AI が何を尋ねるか（埋めた枠を尋ね直さない）は、
 * 2026-09-25 の実接続の台（`test/live/plotDialogue.test.ts` の `@dig`）で e4b・26b とも測ってあり、
 * ここでは見ない（偽の AI の答えはテストが決めるので、見ても意味が無い）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama が、枠ごとに違う問いと候補を返す
 * （コードが次の1点を決める型では、前と同じ問いの文を返すと繰り返しとして止められる。
 * `core/plotDialogueValidation.ts`）。枠の数が少ない「序破急」（3つ）を使う。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "./support/workbenchDom";

/** 枠を埋め終えたあとに並ぶ札（`core/plotDialogueStyles.ts`・`core/plotInterview.ts` の定数。一字一句写す） */
const END_CARDS = ["続けて着想から掘る", "ここまでをプロットに書く", "決まったことをまとめる", "問答を終える"];
/** 枠ごとに押す候補（偽の AI が n 回目に返す1つ目の候補） */
const PICKS = ["灯台の灯が消えた夜、凛が港で古い手紙を拾う", "手紙の差出人が、消えた灯台守その人だと分かる", "嵐の夜、凛が自分の手で灯台に灯をともす"];

let fake: FakeOllama;
let call = 0;
beforeAll(async () => {
  fake = await startFakeOllama(() => {
    // 枠ごとに違う問いと候補を返す（同じ文を返すと、繰り返しとして止められる）
    const n = Math.min(call, PICKS.length - 1);
    call++;
    return JSON.stringify({
      mode: "ask",
      confirm: "",
      topic: "",
      question: `${n + 1}つ目の枠では、どんな出来事が起きますか？`,
      why: "枠ごとの出来事が決まると、話の流れが見えます",
      candidates: [
        { text: PICKS[n], effect: "話がそこで動き出します" },
        // 1つ目の字を含めない（札は字の一部で探すので、含むと押し違える）
        { text: `${n + 1}つ目の枠は、凛の友人の側から動かす`, effect: "少し違う向きで動きます" },
        // 候補は3つ以上要る（`core/plotDialogueValidation.ts` の `candidatesMin`。2つでは問いごと落とされる）
        { text: `${n + 1}つ目の枠は、港の古老の昔話で語る`, effect: "過去から光を当てます" },
      ],
    });
  });
});
afterAll(async () => {
  await fake.close();
});

/** 相談パネルの面（入力欄と「本文へ」の口がある iframe） */
async function chatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null).catch(() => false);
    if (ok) return frame;
  }
  return undefined;
}

interface CardMeasure {
  text: string;
  overflow: number;
  textBeyondCard: number;
  cardBeyondView: number;
  ellipsis: boolean;
}

/** 最後に並んだ札の行（`.options.choices`）の、切れ具合 */
async function measureLastCards(frame: Frame): Promise<CardMeasure[]> {
  return frame.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll<HTMLElement>(".options.choices"));
    const last = boxes[boxes.length - 1];
    if (!last) return [];
    return Array.from(last.querySelectorAll<HTMLElement>(".option")).map((card) => {
      const box = card.getBoundingClientRect();
      let textRight = box.left;
      card.querySelectorAll("span").forEach((span) => {
        textRight = Math.max(textRight, span.getBoundingClientRect().right);
      });
      const styles = [card, ...Array.from(card.querySelectorAll<HTMLElement>("span"))].map((el) => getComputedStyle(el).textOverflow);
      return {
        text: card.innerText.replace(/\s+/g, " ").trim(),
        overflow: card.scrollWidth - card.clientWidth,
        textBeyondCard: textRight - box.right,
        cardBeyondView: box.right - document.documentElement.clientWidth,
        ellipsis: styles.includes("ellipsis"),
      };
    });
  });
}

test("「型に当てはめる」で序破急の3つの枠を埋めると、AI を呼ばずに「続けて着想から掘る」などの札が出て、札の字は相談パネルの幅で切れない", async () => {
  await withVsCode(
    "対話式プロットの型の締めの札",
    [{ name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const { page } = session;
      const from = fake.requests.length;
      call = 0;
      await clearNotifications(page);
      await runCommand(page, "対話式プロット作成");
      let chat: Frame | undefined;
      const seen: string[] = [];
      for (let step = 0; step < 20 && !chat; step++) {
        await page.waitForTimeout(1200);
        const title = await quickPickTitle(page);
        if (title !== undefined) {
          const rows = await quickPickRows(page);
          seen.push(`選ぶ画面：${title}`);
          if (rows.length > 0) await pickQuickPickRow(page, rows[0].label).catch(() => undefined);
        }
        const dialog = await dialogText(page);
        if (dialog) {
          seen.push(`確認の窓：${dialog}`);
          await pressDialogButton(page, "続ける").catch(() => pressDialogButton(page, "OK")).catch(() => undefined);
        }
        chat = await chatFrame(page);
      }
      if (!chat) throw new Error(`相談パネルが見つかりません（出たもの：${JSON.stringify(seen)}／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}）`);
      const frame = chat;
      const logText = async (): Promise<string> => (await frame.evaluate(() => document.getElementById("log")?.innerText ?? "")).replace(/\s+/g, " ");
      const option = (text: string) => frame.locator("button.option", { hasText: text }).last();
      const detail = async (): Promise<string> =>
        `（会話の末尾：${(await logText()).slice(-600)}／偽の AI への頼み：${describeFakeRequests(fake.requests, from).slice(0, 600)}）`;

      await waitUntil(async () => (await option("型に当てはめる").count()) > 0, "型を選ぶ札が出る", 30_000);
      await option("型に当てはめる").click();
      await waitUntil(async () => (await option("序破急").count()) > 0, "型の枠を選ぶ札が出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await detail()}`);
      });
      await option("序破急").click();
      await waitUntil(async () => (await logText()).includes("着想"), "着想を尋ねる一言が出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await detail()}`);
      });
      await frame.locator("#input").click();
      await page.keyboard.insertText("港町で暮らす少女の凛が、消えた灯台守を探す話");
      await frame.locator("#send").click();

      // 3つの枠を、偽の AI が出した1つ目の候補で埋める
      for (const pick of PICKS) {
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            return (await option(pick).count()) > 0;
          },
          `候補「${pick}」が出る`,
          90_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await detail()}`);
        });
        await page.waitForTimeout(500);
        await option(pick).click();
      }
      const afterLastPick = fake.requests.length;

      /* ── 埋め終えると、AI を呼ばずに締めの札が並ぶ ── */
      await waitUntil(
        async () => {
          for (const card of END_CARDS) if ((await option(card).count()) === 0) return false;
          return true;
        },
        `締めの札（${END_CARDS.join("・")}）が並ぶ`,
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await detail()}`);
      });
      await page.waitForTimeout(2000);
      expect(fake.requests.length - afterLastPick, `枠を埋め終えたあとに AI へ頼んでいます${await detail()}`).toBe(0);

      const cards = await measureLastCards(frame);
      for (const card of END_CARDS) {
        expect(cards.some((measured) => measured.text.endsWith(card)), `締めの札に「${card}」が無い：${JSON.stringify(cards.map((c) => c.text))}`).toBe(true);
      }
      for (const card of cards) {
        const text = JSON.stringify(card);
        expect(card.overflow, `札の中で横へはみ出しています：${text}`).toBeLessThanOrEqual(1);
        expect(card.textBeyondCard, `札の字が札の右端を越えています：${text}`).toBeLessThanOrEqual(1);
        expect(card.cardBeyondView, `札が相談パネルの右端を越えています：${text}`).toBeLessThanOrEqual(1);
        expect(card.ellipsis, `札の字が「…」で切られる作りです：${text}`).toBe(false);
      }
      const pageOverflow = await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(pageOverflow, "相談パネルが横へはみ出しています").toBeLessThanOrEqual(1);
    },
    fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 900 } })
  );
});
