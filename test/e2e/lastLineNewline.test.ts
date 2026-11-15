/**
 * 最後の行で「次の行へ進むキー」を押すと、改行が1つ足される（作者の依頼、2026-11-15。設計書6.25）。
 *
 * 作者の言葉：「最終行で下ボタンを押した場合、改行を自動で入れて欲しい。ただし空行2行でストップで」。
 * 次の行へ進むキーは、横書きでは ↓、縦書きでは ←（縦書きのキーは作者に未確認。決め打ちは
 * `views/lastLineNewlineScript.ts` の定数1か所）。
 *
 * 見張ること（横書き・縦書きの両方）：
 * - 最後の行で押すと改行が1つ増え、カーソルが新しい行へ進む。続けて押しても末尾の空行が2行で止まる
 * - 保存したファイルの末尾が、足した改行ぶんだけ増えている（CRLF の文書には CRLF で足す）
 * - 最後の行でないとき・折り返した最後の段落の途中の行のときは足さない（ふつうに動く）
 * - 変換中・選んだ範囲があるとき・Shift を押しているときは足さない
 *
 * 作ったのは先で、流すのは作者がこの機械を使っていないとき（スキル e2e）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, composeText, openEpisode, placeCaretAfter, selectText } from "./support/manuscriptFrame";
import { turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { saveAndSettle } from "./support/fileSettle";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.md";

/** どの窓でも最後の段落が折り返す長さ（composeLineEnd と同じ形） */
const LONG = "坂の上の町へ通った日のことを、いまでもときどき思い出す。".repeat(8) + "おわり。";

async function rawFile(session: E2ESession): Promise<string> {
  return readFile(path.join(session.manuscriptFolder, EPISODE), "utf8");
}

/** 組んで書く面の行の数（1行が compose の直下の子1つ） */
async function lineCount(frame: Frame): Promise<number> {
  return frame.evaluate(() => document.getElementById("compose")?.children.length ?? 0);
}

async function openFace(session: E2ESession, vertical: boolean, marker: string): Promise<Frame> {
  const frame = await openEpisode(session.page, EPISODE, marker);
  return vertical ? turnVertical(session, marker) : frame;
}

for (const vertical of [true, false]) {
  const face = vertical ? "縦書き" : "横書き";
  /*
    次の行へ進むキー。Mac の縦書きは ↓（Mac では矢印に編集の命令が添えて届き、縦書きの ← は1字前へ戻る。
    製品も Mac の縦書きは ↓ で足す。lastLineNewlineScript.ts。2026-11-15 Mac で縦書きの2本が毎回落ちた）
  */
  const NEXT = vertical ? (process.platform === "darwin" ? "ArrowDown" : "ArrowLeft") : "ArrowDown";

  test(`${face}：最後の行で押すと改行が1つ増え、カーソルが新しい行へ進む。続けて押すと空行2行で止まる`, async () => {
    await withVsCode(
      `最後の行で改行を足す（${face}）`,
      [{ name: EPISODE, text: "あいう\nえお" }],
      async (session) => {
        const frame = await openFace(session, vertical, "えお");
        await placeCaretAfter(frame, "えお");
        expect(await lineCount(frame), "テストの前提（2行）が崩れています").toBe(2);

        await session.page.keyboard.press(NEXT);
        await waitUntil(async () => (await lineCount(frame)) === 3, "1回目で行が1つ増える");
        const first = await caretPosition(frame);
        expect(first, "1回目のあとのカーソルが読めません").toBeDefined();
        expect(first!.lineText, "カーソルが新しい行へ進んでいません").toBe("");

        await session.page.keyboard.press(NEXT);
        await waitUntil(async () => (await lineCount(frame)) === 4, "2回目で行がもう1つ増える");

        // 3回目：末尾の空行が2行なので、これ以上は足さない
        await session.page.keyboard.press(NEXT);
        await holdsFor(async () => (await lineCount(frame)) === 4, "3回目で行が増えない", 2_000);

        await saveAndSettle(session.page, path.join(session.manuscriptFolder, EPISODE), "足した改行を保存した");
        expect((await rawFile(session)).replace(/\r\n/g, "\n")).toBe("あいう\nえお\n\n");
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：文書が CRLF のときは、足す改行も CRLF`, async () => {
    await withVsCode(
      `最後の行で足す改行の種類（${face}）`,
      [{ name: EPISODE, text: "あいう\r\nえお" }],
      async (session) => {
        const frame = await openFace(session, vertical, "えお");
        await placeCaretAfter(frame, "えお");
        await session.page.keyboard.press(NEXT);
        await waitUntil(async () => (await lineCount(frame)) === 3, "行が1つ増える");
        await saveAndSettle(session.page, path.join(session.manuscriptFolder, EPISODE), "足した改行を保存した");
        expect(await rawFile(session)).toBe("あいう\r\nえお\r\n");
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：最後の行でないときは足さない（ふつうに次の行へ動く）`, async () => {
    await withVsCode(
      `最後の行でなければ足さない（${face}）`,
      [{ name: EPISODE, text: "あいう\nえお\nかき" }],
      async (session) => {
        const frame = await openFace(session, vertical, "かき");
        await placeCaretAfter(frame, "あいう");
        await session.page.keyboard.press(NEXT);
        await holdsFor(async () => (await lineCount(frame)) === 3, "最後の行でないので行が増えない", 2_000);
        const moved = await caretPosition(frame);
        expect(moved?.lineText, "次の行へ動いていません").toBe("えお");
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：折り返した最後の段落の途中の行では足さず、ふつうに次の見えている行へ動く`, async () => {
    await withVsCode(
      `折り返した最後の段落の途中（${face}）`,
      [{ name: EPISODE, text: `あいう\n${LONG}` }],
      async (session) => {
        const frame = await openFace(session, vertical, "おわり");
        await placeCaretAfter(frame, "坂の上");
        const before = await caretPosition(frame);
        await session.page.keyboard.press(NEXT);
        await holdsFor(async () => (await lineCount(frame)) === 2, "途中の行なので行が増えない", 2_000);
        const after = await caretPosition(frame);
        expect(after?.lineText, "最後の段落から出ています").toBe(LONG);
        expect(after!.column, "次の見えている行へ動いていません").toBeGreaterThan(before!.column);
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：変換中は足さない`, async () => {
    await withVsCode(
      `変換中は足さない（${face}）`,
      [{ name: EPISODE, text: "あいう\nえお" }],
      async (session) => {
        const frame = await openFace(session, vertical, "えお");
        await placeCaretAfter(frame, "えお");
        // 本物の変換は届かない。変換の合図だけを送って、変換中の状態を作る
        await frame.evaluate(() => {
          document.getElementById("compose")?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        });
        await session.page.keyboard.press(NEXT);
        await holdsFor(async () => (await lineCount(frame)) === 2, "変換中は行が増えない", 2_000);
        await frame.evaluate(() => {
          document.getElementById("compose")?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        });
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：範囲を選んでいるとき・Shift を押しているときは足さない`, async () => {
    await withVsCode(
      `選択中と Shift では足さない（${face}）`,
      [{ name: EPISODE, text: "あいう\nえお" }],
      async (session) => {
        const frame = await openFace(session, vertical, "えお");
        await selectText(frame, "えお");
        await session.page.keyboard.press(NEXT);
        await holdsFor(async () => (await lineCount(frame)) === 2, "選んでいるので行が増えない", 2_000);

        await placeCaretAfter(frame, "えお");
        await session.page.keyboard.press(`Shift+${NEXT}`);
        await holdsFor(async () => (await lineCount(frame)) === 2, "Shift つきなので行が増えない", 2_000);
        expect(await composeText(frame)).not.toMatch(/えお\s*\n\s*\n/);
      },
      VERTICAL_LAUNCH
    );
  });
}
