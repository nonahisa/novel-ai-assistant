/**
 * 対話式プロット作成を始めると、型を選ぶ札が5つと、それぞれ1行の説明が出て、
 * 札の字が相談パネルの幅で切れず、型を選ぶまで AI を呼ばない（画面の自動テスト、設計書6.113・6.4.10。
 * 実機確認リスト 4686 行〔0.86.5〕を、2026-10-15 の仕分け
 * 〔docs/measurements/2026-10-15-field-triage-hands.md〕で移した）。
 *
 * 2026-09-25 の実接続の台で「札5つと説明・型を選ぶまで AI 0回」は測ってあり、残りは
 * 「札の文字が相談パネルの幅で切れて読めなくならないか（画面）」だった。
 * 「読みやすいか」は見た目の判断だが、**切れているか**は描かれた矩形で測れる——
 * 札の中の字の右端が札の右端を越えない・札が面の右端を越えない・横へ送る幅が無い。
 *
 * **本物の AI は呼ばない。** 偽の Ollama を立て、型を選ぶ前に1回も頼まれないことを数える
 * （偽の Ollama は札を押したあとのためでなく、「呼ばれたら分かる」ために置く）。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "./support/workbenchDom";

/** 型の名前と1行の説明（`core/plotDialogueStyles.ts` の `PLOT_DIALOGUE_STYLES`。一字一句写す） */
const STYLES: ReadonlyArray<{ label: string; summary: string }> = [
  { label: "着想から掘る", summary: "思いついていることから、話が一番広がる点を1つずつ尋ねます" },
  { label: "場面から広げる", summary: "書きたい場面が1つあるとき。その前後と、そこに至る理由を尋ねます" },
  { label: "結末から逆算する", summary: "終わり方だけ決まっているとき。そこへ至る出来事をさかのぼって尋ねます" },
  { label: "型に当てはめる", summary: "三幕構成・起承転結などの枠を選び、順に埋めます" },
  { label: "項目を順に埋める", summary: "ログライン・テーマ・世界観…と決まった順に尋ねます" },
];

let fake: FakeOllama;
beforeAll(async () => {
  // 呼ばれたら数えるだけ。中身は何でもよい（型を選ぶ前に呼ばれたら、それ自体が落ちる理由になる）
  fake = await startFakeOllama(() => JSON.stringify({ mode: "ask", confirm: "", topic: "", question: "", why: "", candidates: [] }));
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
  /** 札の中で横へ送る幅（scrollWidth − clientWidth） */
  overflow: number;
  /** 札の中の字の右端が札の右端を越えた量 */
  textBeyondCard: number;
  /** 札の右端が面の右端を越えた量 */
  cardBeyondView: number;
  ellipsis: boolean;
}

test("対話式プロット作成を始めると、型を選ぶ札が5つと各1行の説明が出て、札の字は相談パネルの幅で切れず、型を選ぶまで AI を呼ばない", async () => {
  await withVsCode(
    "対話式プロットの型の札",
    [{ name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const { page } = session;
      const requestsBefore = fake.requests.length;
      await clearNotifications(page);
      await runCommand(page, "対話式プロット作成");
      // 作品を訊く選ぶ画面・始める前の確かめの窓が出たら進める（見本の作品は1つだけ）
      let chat: Frame | undefined;
      const seen: string[] = [];
      for (let step = 0; step < 20 && !chat; step++) {
        await page.waitForTimeout(1200);
        const title = await quickPickTitle(page);
        if (title !== undefined) {
          const rows = await quickPickRows(page);
          seen.push(`選ぶ画面：${title}｜${rows.map((row) => row.label).join(" / ")}`);
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
      const logText = async (): Promise<string> => (await frame.evaluate(() => document.getElementById("log")?.innerText ?? "")).replace(/\r\n/g, "\n");

      await waitUntil(
        async () => (await frame.locator(".options.choices .option").count()) >= STYLES.length,
        "型を選ぶ札が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（会話の末尾：${(await logText()).replace(/\s+/g, " ").slice(-500)}）`);
      });
      // 描き終えるのを少し待つ（折り返しは描いたあとに決まる）
      await page.waitForTimeout(600);

      /* ── 札は5つ・名前は型の名前 ── */
      const cards: CardMeasure[] = await frame.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".options.choices .option")).map((card) => {
          const box = card.getBoundingClientRect();
          let textRight = box.left;
          card.querySelectorAll("span").forEach((span) => {
            textRight = Math.max(textRight, span.getBoundingClientRect().right);
          });
          const view = document.documentElement.clientWidth;
          const styles = [card, ...Array.from(card.querySelectorAll<HTMLElement>("span"))].map((el) => getComputedStyle(el).textOverflow);
          return {
            text: card.innerText.replace(/\s+/g, " ").trim(),
            overflow: card.scrollWidth - card.clientWidth,
            textBeyondCard: textRight - box.right,
            cardBeyondView: box.right - view,
            ellipsis: styles.includes("ellipsis"),
          };
        })
      );
      const labels = STYLES.map((style) => style.label);
      // 型の札5つのあとに「問答を終える」が付く（`plotStyleOptions`）。型の札だけを数える
      expect(cards.filter((card) => labels.some((label) => card.text.endsWith(label))).length, `型の札の数：${JSON.stringify(cards.map((card) => card.text))}`).toBe(STYLES.length);
      for (const label of labels) {
        expect(
          cards.some((card) => card.text.endsWith(label)),
          `「${label}」の札が無い：${JSON.stringify(cards.map((card) => card.text))}`
        ).toBe(true);
      }

      /* ── 札の字が幅で切れない ── */
      for (const card of cards) {
        const detail = JSON.stringify(card);
        expect(card.overflow, `札の中で横へはみ出しています：${detail}`).toBeLessThanOrEqual(1);
        expect(card.textBeyondCard, `札の字が札の右端を越えています：${detail}`).toBeLessThanOrEqual(1);
        expect(card.cardBeyondView, `札が相談パネルの右端を越えています：${detail}`).toBeLessThanOrEqual(1);
        expect(card.ellipsis, `札の字が「…」で切られる作りです：${detail}`).toBe(false);
      }
      // 相談パネル自体も横へ送らない
      const pageOverflow = await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(pageOverflow, "相談パネルが横へはみ出しています").toBeLessThanOrEqual(1);

      /* ── 各型の1行の説明が会話に出る ── */
      const log = (await logText()).replace(/\s+/g, "");
      for (const style of STYLES) {
        expect(log, `「${style.label}」の説明が会話に無い（会話の末尾：${log.slice(-600)}）`).toContain(`${style.label}：${style.summary}`.replace(/\s+/g, ""));
      }

      /* ── 型を選ぶまで AI を呼ばない ── */
      // 札が並んでからも数秒置き、遅れて頼むものを拾う
      await page.waitForTimeout(3000);
      expect(fake.requests.length - requestsBefore, "型を選ぶ前に AI へ頼んでいます").toBe(0);
    },
    fakeOllamaLaunch(fake, { ...SIDEBAR_LAUNCH, windowSize: { width: 1280, height: 900 } })
  );
});
