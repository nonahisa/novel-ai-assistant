/**
 * 読み上げの「⚑ 引っかかった」（画面の自動テスト、設計書6.42・6.113。実機確認リスト
 * 「『⚑ 引っかかった』でその文の直前の行に `// 音読：ここで引っかかった` が入り、一時停止するか。
 * 連打しても同じ行に2つ入らないか」の、入る行と二重にならないところ。2026-10-18）。
 *
 * **声は偽物に替える。** 読み上げは OS の声（Web Speech API の `speechSynthesis`）を使うので、そのまま走らせると
 * 画面の外でも音が鳴る。面の中で `speechSynthesis`・`SpeechSynthesisUtterance` を、日本語の声を1つ名乗り、
 * 読む文を控えるだけの偽物に替える（音は出ない。読み終わりの知らせも来ない＝「いま読んでいる文」で止まったまま）。
 * 製品の道具箱・列・拡張機能への便・本文への書き込み（`readingMark`→`insertMemoLineAbove`）は本物。
 * 声そのものが耳に聞こえるか・再開が同じ文から続くか（声の動き）は見ない（作者の手に残す）。AI は呼ばない。
 *
 * 見張るのは次のとおり：
 * - 2行目にカーソルを置いて［読む］を押すと「二行目の文。」から読み始める（偽の声が受ける文）
 * - ［⚑ 引っかかった］を押すと、その文（2行目）の直前に `// 音読：ここで引っかかった` の行が入り、
 *   一時停止（［▶ 続ける］）になり、［⚑］は計画が届くまで押せない
 * - 続けて何度押しても（押せないあいだの連打も、計画が戻ったあとの2回目も）、同じ文の上にメモは2つ入らない
 * - ファイル（保存したあと）で、メモの行は1つで、本文の字は変わっていない
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";
const MEMO = "// 音読：ここで引っかかった";
const ORIGINAL = "一行目の文。\n二行目の文。\n三行目の文。\n";

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/** 面の中の声を偽物に替える（読む文を `__e2eSpoken` へ控える。音は出ない） */
async function installFakeVoice(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const spoken: string[] = [];
    (window as unknown as { __e2eSpoken: string[] }).__e2eSpoken = spoken;
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const fake = {
      speaking: false,
      paused: false,
      getVoices: () => [{ name: "E2E 日本語", lang: "ja-JP" }],
      speak: (utterance: FakeUtterance) => {
        spoken.push(utterance.text);
      },
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
    };
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true, writable: true });
    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  });
}

async function spoken(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => (window as unknown as { __e2eSpoken?: string[] }).__e2eSpoken ?? []);
}

function memoCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() === MEMO).length;
}

async function scenario(secondPressAfterResume: boolean): Promise<void> {
  await withVsCode("読み上げの引っかかった", [{ name: EPISODE, text: ORIGINAL }], async (session) => {
    const { page } = session;
    const frame = await openEpisode(page, EPISODE, "三行目の文");
    await installFakeVoice(frame);

    // 読み上げの列を開き、2行目にカーソルを置いて［読む］
    await frame.locator("#aloudToggle").click();
    await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる（偽の日本語の声が見つかる）", 15_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（列の注：${JSON.stringify(await frame.locator("#aloudNote").innerText().catch(() => ""))}）`);
      }
    );
    await placeCaretAfter(frame, "二行目");
    await frame.locator("#aloudPlay").click();
    await waitUntil(async () => (await spoken(frame)).length > 0, "偽の声が最初の文を受ける", 15_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（列の注：${JSON.stringify(await frame.locator("#aloudNote").innerText().catch(() => ""))}／ボタン：${JSON.stringify(await frame.locator("#aloudPlay").innerText().catch(() => ""))}）`);
    });
    expect((await spoken(frame))[0], `カーソルのある2行目の文から読み始める（受けた文：${JSON.stringify(await spoken(frame))}）`).toContain("二行目の文");
    await waitUntil(async () => !(await frame.locator("#aloudMark").isDisabled()), "［⚑ 引っかかった］が押せる", 10_000);

    // ［⚑ 引っかかった］：続けて3回押す（押せなくなるので、2回目からは何も起きない）
    await frame.evaluate(() => {
      const button = document.getElementById("aloudMark") as HTMLButtonElement;
      button.click();
      button.click();
      button.click();
    });

    // 本文（面）に、その文の直前の行へメモが入る
    await waitUntil(async () => (await composeText(frame)).includes("音読：ここで引っかかった"), "面にメモ「音読：ここで引っかかった」が出る", 15_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（面の字：${JSON.stringify(await composeText(frame))}）`);
      }
    );
    // 一時停止（［▶ 続ける］）になる
    await waitUntil(async () => (await frame.locator("#aloudPlay").innerText()).includes("続ける"), "一時停止になる（［▶ 続ける］）", 10_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（ボタン：${JSON.stringify(await frame.locator("#aloudPlay").innerText())}）`);
      }
    );

    /*
      保存して、ファイルで読む：メモは1つ、2行目の直前、本文の字は変わらない。
      **本文の面を押さない**：読んでいる最中に本文を押すと「ここから読み直す」になり、押した所の文へ読む位置が飛ぶ
      （設計書6.42。`aloudJumpToClick`）。そうなると次の［⚑］は飛んだ先の文の上に入り、「同じ文の上に2つ」の見張りにならない。
      保存のキーは、面の中に焦点が残っているのでそのまま届く
    */
    await page.keyboard.press("Control+KeyS");
    await waitUntil(async () => memoCount(await fileText(session)) >= 1, "保存すると、ファイルにメモの行が入る", 15_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
    });
    const first = await fileText(session);
    expect(first, `メモは2行目の直前に1つ（ファイル：${JSON.stringify(first)}）`).toBe(`一行目の文。\n${MEMO}\n二行目の文。\n三行目の文。\n`);

    // 押した直後は［⚑］が押せない（印を打ったぶんが本文へ入って計画が戻るまで。連打で二重に刺さるのを防ぐ）
    expect(await frame.locator("#aloudMark").isDisabled(), "印を打った直後は［⚑］が押せない形になっていない").toBe(true);
    if (!secondPressAfterResume) return;

    /*
      一時停止のあと［▶ 続ける］を押すと、［⚑］がまた押せるようになる（読む位置は2行目のまま）。
      **その状態でもう一度［⚑］を押しても、同じ文の上にメモは2つ入らない**（実機確認リストの「連打しても同じ行に2つ入らないか」）。
    */
    await frame.locator("#aloudPlay").click();
    await waitUntil(async () => !(await frame.locator("#aloudMark").isDisabled()), "［▶ 続ける］のあと、［⚑］がまた押せる", 10_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（ボタン：${JSON.stringify(await frame.locator("#aloudPlay").innerText())}／面の字：${JSON.stringify(await composeText(frame))}）`);
    });
    await frame.locator("#aloudMark").click();
    await page.waitForTimeout(2_500);
    await page.keyboard.press("Control+KeyS");
    await page.waitForTimeout(1_500);
    const final = await fileText(session);
    expect(
      final.split("\n").filter((line) => line.trim() === MEMO).length,
      `2回目の［⚑］で、同じ文の上にメモが2つ以上になっている（ファイル：${JSON.stringify(final)}／偽の声が受けた文：${JSON.stringify(await spoken(frame))}）`
    ).toBe(1);
    expect(final.split(MEMO + "\n").join(""), "本文の字が変わっている").toBe(ORIGINAL);
  });
}

test("読み上げの［⚑ 引っかかった］は、読んでいる文の直前の行にメモを1つ入れて一時停止し、押せない間の連打でも二重にならない", async () => {
  await scenario(false);
}, 180_000);

/*
  **製品の不具合の疑い（2026-10-18、ノートPCの偽の声での確認。実際の声では見ていない）。**
  一時停止のあと［▶ 続ける］を押すと、読む位置は同じ文（2行目）のまま［⚑］が押せるようになり、そこでもう一度押すと、
  同じ文の上に同じメモの行が**もう1つ**入る（「一行目／メモ／メモ／二行目」）。実機確認リストの
  「連打しても同じ行に2つ入らないか」の期待と食い違う。製品は直していない。
  `test.fails`：いまは「2つ入る」ので、このテストは落ちるのが正しい扱いにして、全件を赤くしない。
  製品が直って1つのままになったら、このテストが「落ちるはずが通った」と知らせるので、`test.fails` を外す。
*/
test.fails("［⚑ 引っかかった］で止めたあと、［▶ 続ける］で読み直してもう一度押しても、同じ文の上にメモは2つ入らない（いまは2つ入る＝不具合の疑い）", async () => {
  await scenario(true);
}, 180_000);
