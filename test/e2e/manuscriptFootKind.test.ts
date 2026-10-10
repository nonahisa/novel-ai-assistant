/**
 * 原稿エディターの下段（画面の自動テスト、設計書6.25・6.109・6.113）。
 *
 * 実機確認リスト 0.76.5〜0.82.3 の節の項目を機械へ移したもの（2026-10-04）：
 * - 作品の種類を変えると、**開き直さなくても**下段の目安が変わる（エッセイ「読了 約N分」・
 *   台本「約N分」・漫画の原作「Nページ・Nコマ」・歌詞「N連・N行」。小説は出ない）
 * - 下段が「この話で今日 +N字」になり、**第1話で1日の目標に届くと、先に開いてあった第2話の
 *   タブへ切り替えたときにも「今日の目標に届きました」が出る**
 *
 * 数え方そのものは単体テスト（`core/kindMeasure.test.ts`・`core/celebrations.test.ts`）が見ている。
 * ここで見るのは**本物の画面の下段に出る字**である。見た目の良し悪しは見ていない。**AI は呼ばない。**
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand, waitForQuickInput } from "./support/quickInput";
import { composeText, footText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activateTab, pickQuickPickRow } from "./support/workbenchDom";

/** 「作品の種類」で種類を替える（コマンドパレット→選ぶ画面。作者の道順） */
async function setWorkKind(page: Page, label: string): Promise<void> {
  await runCommand(page, "作品の種類（小説・台本など）");
  await waitForQuickInput(page, "の種類");
  await pickQuickPickRow(page, label);
}

/** 漫画の原作（■1・□2）と歌詞（札つきの塊3・行8）の両方に読める本文 */
const MIXED_TEXT = [
  "■ページ1",
  "□コマ1",
  "絵の説明。台詞。",
  "□コマ2",
  "絵の説明その2。",
  "",
  "【Aメロ】",
  "一行目の歌詞。",
  "二行目の歌詞。",
  "",
  "三行目の歌詞。",
  "",
].join("\n");

test("作品の種類を変えると、開いたままの原稿の下段に、種類ごとの目安が出て、小説へ戻すと消える", async () => {
  await withVsCode("下段の目安", [{ name: "001_はじまり.txt", text: MIXED_TEXT }], async (session) => {
    const frame = await openEpisode(session.page, "001_はじまり.txt", "一行目の歌詞");
    const counts = () => footText(frame, "counts");
    const expectCounts = async (pattern: RegExp, label: string) => {
      await waitUntil(async () => pattern.test(await counts()), label, 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの下段：「${await counts()}」）`);
      });
    };

    // 小説：目安は出ない（「このファイル N字」のあとに括弧が付かない）
    await waitUntil(async () => (await counts()).includes("このファイル"), "下段に字数が出る", 15_000);
    expect(await counts()).not.toMatch(/このファイル [\d,]+字（/);

    // 開き直さずに、種類ごとの目安が出る
    await setWorkKind(session.page, "エッセイ・記事");
    await expectCounts(/このファイル [\d,]+字（読了 約\d+分）/, "エッセイ：読了の目安が出る");
    await setWorkKind(session.page, "台本");
    await expectCounts(/このファイル [\d,]+字（約\d+分）/, "台本：分数の目安が出る");
    await setWorkKind(session.page, "漫画の原作");
    await expectCounts(/このファイル [\d,]+字（1ページ・2コマ）/, "漫画の原作：ページ数とコマ数が出る");
    await setWorkKind(session.page, "歌詞・詩");
    await expectCounts(/このファイル [\d,]+字（3連・8行）/, "歌詞：連の数と行の数が出る");

    // 小説へ戻すと、目安は消える
    await setWorkKind(session.page, "小説");
    await waitUntil(async () => !/このファイル [\d,]+字（/.test(await counts()), "小説へ戻すと目安が消える", 30_000);
  });
});

test("下段は「この話で今日 +N字」になり、第1話で1日の目標に届くと、開いてあった第2話のタブにも「今日の目標に届きました」が出る", async () => {
  const first = { name: "001_はじまり.txt", text: "一行目の文。\n" };
  const second = { name: "002_つづき.txt", text: "二話目の本文。\n" };
  await withVsCode(
    "下段の今日の目標",
    [first, second],
    async (session) => {
      const { page } = session;
      // 第1話、第2話の順に開く（2枚のタブ）
      const firstFrame = await openEpisode(page, first.name, "一行目の文");
      const secondFrame = await openEpisode(page, second.name, "二話目の本文");
      /*
        **「この話で今日」は、本文が描かれたあとに別の便で届く**（`sendFootCounts`。作品の合計を
        出すのに全話を走査するので、「このファイル N字」の便より遅れる）。描かれた直後に1回だけ
        読むと「このファイル 7字 ／ 表示倍率 100%」の形（作品も今日もまだ無い）で落ちた
        （ノートPC・1.141.0、2026-10-11）。届くまで待つ
      */
      await waitUntil(
        async () => (await footText(secondFrame, "counts")).includes("この話で今日 0字"),
        "第2話の下段に「この話で今日 0字」が届く",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの下段：「${await footText(secondFrame, "counts")}」）`);
      });

      // 第1話へ戻って、1日の目標（20字）を超えて打ち、保存する
      await activateTab(page, "001_はじまり.txt");
      await waitUntil(async () => (await composeText(firstFrame)).includes("一行目の文"), "第1話の面が前に出る", 15_000);
      await placeCaretAfter(firstFrame, "一行目の文。");
      // **最初の保存は、その日の起点（基準線）を置くだけで、書いた量には数えない**（統計の作り）。
      // 先に1字打って保存し、起点を置いてから、目標を超えて打つ
      await page.keyboard.insertText("。");
      await page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await footText(firstFrame, "note")).includes("保存しました"), "起点を置く保存が通る", 15_000);
      await page.keyboard.insertText("あ".repeat(30));
      await page.keyboard.press("Control+KeyS");

      // 第1話の下段：この話で今日 +30字、目標に届いた一言
      await waitUntil(
        async () => /この話で今日 \+30字/.test(await footText(firstFrame, "counts")),
        "第1話の下段が「この話で今日 +30字」になる",
        20_000
      );
      await waitUntil(
        async () => (await cheerText(firstFrame)).includes("今日の目標に届きました"),
        "第1話に「今日の目標に届きました」が出る",
        20_000
      );

      // 先に開いてあった第2話のタブへ切り替えても、同じ一言が出ている
      await activateTab(page, "002_つづき.txt");
      const front = await frontManuscript(page, "二話目の本文");
      await waitUntil(
        async () => (await cheerText(front)).includes("今日の目標に届きました"),
        "第2話の下段にも「今日の目標に届きました」が出る",
        20_000
      );
      // 第2話そのものは書いていないので、この話の今日は0字のまま
      // （タブを戻したときにも下段は測り直しの便で届き直すので、待って読む）
      await waitUntil(
        async () => (await footText(front, "counts")).includes("この話で今日 0字"),
        "第2話の下段は「この話で今日 0字」のまま",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの下段：「${await footText(front, "counts")}」）`);
      });
    },
    { settings: { "novelai.stats.dailyGoal": 20 } }
  );
});

/** 下の欄の、目標に届いたときの一言（字数の右。`#cheer`） */
async function cheerText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("cheer")?.textContent ?? "");
}

/** 本文に `expected` を含む原稿エディターの面 */
async function frontManuscript(page: Page, expected: string): Promise<Frame> {
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame)).includes(expected)) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    `本文に「${expected}」を含む原稿の面がある`,
    15_000
  );
  if (!found) throw new Error("原稿の面が見つかりません");
  return found;
}
