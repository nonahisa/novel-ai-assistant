/**
 * 組んで書く面（横書き・縦書き）で、**本物のマウスで押した所**に、**日本語入力の変換（composition）で確定した字**が入るか
 * （画面の自動テスト、設計書6.25・6.113。2026-11-14 夕 Mac の実機確認の報告から）。
 *
 * 報告：Mac で作者が2行目の「若」の前を押して「〜」を打つと、字は2行目の行頭に入った
 * （保存後の2行目は「～～～男は意外にも若かった。」）。前の回では、computer-use で「若」の前を押してから
 * 作者が打つと、最後の新しい行に入った。
 *
 * ここまでの画面テストは、カーソルを**字で置き**（`placeCaretAfter`。押すのは面の真ん中で、そのあと選択を
 * 書き換える）、字を**確定した形で入れて**いた（`keyboard.insertText`）。どちらも、押した点から決まる
 * カーソルと、変換の合図（compositionstart → compositionupdate → compositionend）を通っていない。
 * ここでは押す点を字の位置から測って本物のマウスで押し、字は Chromium の変換の口
 * （CDP の `Input.imeSetComposition` → `Input.insertText`）で入れる。
 *
 * 焦点の場所は2通り見る：面がすでに焦点を持っているとき／ほかの所（エクスプローラー）に焦点があるとき
 * （報告の作者は、別の所から戻って押した可能性がある）。
 *
 * **見ていないこと**：Mac の日本語入力そのもの（変換の合図の順番が違う可能性）。Windows で通るなら、
 * Mac では同じ台で合図の順番を記録して比べる。**AI は呼ばない。**
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import iconv = require("iconv-lite");
import type { CDPSession, Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, composeText, openEpisode } from "./support/manuscriptFrame";
import { turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "004_シフトJISの話.txt";
const BODY = "雨が上がった。\n男は意外にも若かった。\n三行目の終わり。\n";
const TYPED = "〜";
const TIMES = 3;

/**
 * 組んで書く面で、`needle` の最初の字の**前の端**を押す点（面の左上から）。
 * 横書きは字の左の端、縦書きは字の上の端（字は上から下へ流れる）
 */
async function pointBefore(frame: Frame, needle: string): Promise<{ x: number; y: number }> {
  const point = await frame.evaluate((text) => {
    const compose = document.getElementById("compose");
    if (!compose) return null;
    const box = compose.getBoundingClientRect();
    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      // 字の前の端から1画素だけ内側（字の前半を押すと、カーソルは字の前に置かれる）
      const vertical = getComputedStyle(compose).writingMode.startsWith("vertical");
      return vertical
        ? { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + 1 }
        : { x: rect.left - box.left + 1, y: rect.top - box.top + rect.height / 2 };
    }
    return null;
  }, needle);
  if (!point) throw new Error(`組んで書く面に「${needle}」が見つかりません`);
  return point;
}

/** 変換を1回：途中の字を見せてから確定する（日本語入力の合図の順番） */
async function composeOnce(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await cdp.send("Input.insertText", { text });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function fileText(session: E2ESession, encoding: "utf8" | "shift_jis"): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE)).catch(() => undefined);
  if (!raw) return "";
  return (encoding === "utf8" ? raw.toString("utf8") : iconv.decode(raw, "shift_jis")).replace(/\r\n/g, "\n");
}

function launchFor(sjis: boolean, vertical: boolean): LaunchOptions {
  return {
    ...(vertical ? VERTICAL_LAUNCH : {}),
    ...(sjis
      ? {
          settings: { "files.encoding": "shiftjis" },
          prepareWork: async ({ manuscriptFolder }: { manuscriptFolder: string }) => {
            await writeFile(path.join(manuscriptFolder, EPISODE), iconv.encode(BODY, "shift_jis"));
          },
        }
      : {}),
  };
}

async function focusExplorer(page: Page): Promise<void> {
  // エクスプローラーへ焦点を移す（面の外に焦点がある状態から、押して戻る）
  await page.keyboard.press("ControlOrMeta+Shift+KeyE");
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/*
  縦書きの2通りは 2026-11-14 夜に足した（MAC実機確認のセッションの見立て：61行の確認のとき、作者は
  原稿エディターを縦書きに切り替えていたらしい。横書きの3通りは Windows・Mac とも通った）
*/
const cases: Array<{ label: string; sjis: boolean; fromOutside: boolean; vertical: boolean }> = [
  { label: "UTF-8・面に焦点がある", sjis: false, fromOutside: false, vertical: false },
  { label: "UTF-8・エクスプローラーから押して戻る", sjis: false, fromOutside: true, vertical: false },
  { label: "Shift_JIS・エクスプローラーから押して戻る", sjis: true, fromOutside: true, vertical: false },
  { label: "Shift_JIS・面に焦点がある", sjis: true, fromOutside: false, vertical: true },
  { label: "Shift_JIS・エクスプローラーから押して戻る", sjis: true, fromOutside: true, vertical: true },
];

for (const { label, sjis, fromOutside, vertical } of cases) {
  const face = vertical ? "縦書き" : "横書き";
  test(`${face}（${label}）：「若」の前を押して変換で「〜」を${TIMES}回確定すると、字は「若」の前に入る`, async () => {
    const encoding = sjis ? "shift_jis" : "utf8";
    const expectedFile = BODY.replace("若", `${(sjis ? "～" : TYPED).repeat(TIMES)}若`);
    await withVsCode(
      `押した所への変換（${face}・${label}）`,
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        const { page } = session;
        let frame = await openEpisode(page, EPISODE, "若かった");
        if (vertical) frame = await turnVertical(session, "若かった");
        // 一度、最後の行を押して焦点とカーソルを面に置いておく（前の回の「最後の行」に当たる）
        await frame.locator("#compose").click({ position: await pointBefore(frame, "終わり") });
        if (fromOutside) await focusExplorer(page);
        // 変換の合図を記録する（組んで書く面で受けたもの）
        await frame.evaluate(() => {
          const holder = window as unknown as { __imeEvents?: string[] };
          const events: string[] = (holder.__imeEvents = []);
          const compose = document.getElementById("compose");
          for (const name of ["compositionstart", "compositionend"]) compose?.addEventListener(name, () => events.push(name), true);
        });
        await frame.locator("#compose").click({ position: await pointBefore(frame, "若") });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const caret = await caretPosition(frame);
        expect(caret, "押したあとのカーソルが読めません").toBeDefined();
        expect(
          { line: caret!.lineText, column: caret!.column },
          "押したあとのカーソルが「若」の前にありません"
        ).toEqual({ line: "男は意外にも若かった。", column: "男は意外にも".length });

        const cdp = await page.context().newCDPSession(page);
        for (let i = 0; i < TIMES; i += 1) await composeOnce(cdp, TYPED);
        await waitUntil(
          async () => (await composeText(frame)).includes(`${TYPED.repeat(TIMES)}若`) || (await composeText(frame)).includes(`${"～".repeat(TIMES)}若`),
          "確定した字が画面の「若」の前に出る",
          10_000
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（画面：${JSON.stringify(await composeText(frame))}）`
          );
        });

        // 変換の合図を本当に通ったか（確定した形で入っただけなら、このテストは何も見ていない）
        const trace = await frame.evaluate(() => (window as unknown as { __imeEvents?: string[] }).__imeEvents ?? []);
        expect(trace.filter((line) => line.startsWith("compositionstart")).length, `合図：${JSON.stringify(trace)}`).toBe(TIMES);
        expect(trace.filter((line) => line.startsWith("compositionend")).length, `合図：${JSON.stringify(trace)}`).toBe(TIMES);

        await page.keyboard.press("ControlOrMeta+KeyS");
        let last = "";
        await waitUntil(
          async () => (last = await fileText(session, encoding)) === expectedFile,
          "保存したファイルで、字が「若」の前にある",
          15_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（ファイル：${JSON.stringify(last)}）`);
        });
      },
      launchFor(sjis, vertical)
    );
  }, 120_000);
}
