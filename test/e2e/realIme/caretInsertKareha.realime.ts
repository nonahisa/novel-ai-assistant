/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で、**押した場所に確定した字が入る**か（2026-11-15 作者の依頼。①）。
 *
 * 横書きと縦書きの原稿エディターそれぞれで、本文の途中（ある語のあと）にカーソルを置き、
 * romaji:kareha → SPACE → ENTER と OS のキーで打つ。画面の本文と保存したファイルで、
 * その場所に「彼は」が入り、前後の字が変わっていないことを見る。カーソルが「彼は」の直後にあることも見る。
 *
 * ふだんの画面の自動テスト（composeImeClickPlace など）は Chromium の変換の口で字を入れ、本物の IME を通らない。
 * ここは本物の IME の変換の流れ（未確定の字 → 変換 → 確定）を通す。
 *
 * **流すのは作者がこの PC を使っていないときだけ**（打鍵は前に出ている窓へ届く）。門は `NOVELAI_REAL_IME=1`。
 * 候補の1番目が「彼は」であることは、IME の核の答え（作者の機械の学習）に頼る。AI は呼ばない。
 */
import path from "node:path";
import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { caretPosition, composeText, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { saveAndSettle } from "../support/fileSettle";
import { turnVertical, VERTICAL_LAUNCH } from "../support/verticalFace";
import { waitUntil } from "../support/wait";
import type { Frame } from "playwright-core";
import { REAL_IME_ENABLED, runRealImeTest, type RealIme } from "./support/imeBridge";
import type { E2ESession } from "../support/vscodeApp";

const EPISODE = "001_彼は.txt";
const BODY = "雨が上がった。\nそのとき言った。\n";
const NEEDLE = "そのとき";
const EXPECTED_LINE = "そのとき彼は言った。";
const EXPECTED_BODY = "雨が上がった。\nそのとき彼は言った。\n";

/** カーソルを置いて打ち、画面とファイルを確かめる（横書き・縦書きで同じ） */
async function typeAndCheck(session: E2ESession, ime: RealIme, frame: Frame): Promise<void> {
  await placeCaretAfter(frame, NEEDLE);
  // SPACE のあとは候補が非同期で届くので少し待ってから確定する
  await ime.type(frame, ["romaji:kareha", "key:SPACE", "wait:600", "key:ENTER"]);
  await waitUntil(async () => (await composeText(frame)).includes(EXPECTED_LINE), `「${EXPECTED_LINE}」が画面に出る`, 15_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}）`);
    }
  );
  const shown = await composeText(frame);
  expect(shown, "前の行が変わっていない").toContain("雨が上がった。");
  expect(shown, "読みのかなが残っていない").not.toContain("かれは");
  // カーソルは確定した「彼は」の直後（同じ行の7字目）
  expect(await caretPosition(frame)).toEqual({ lineText: EXPECTED_LINE, column: (NEEDLE + "彼は").length });

  const file = path.join(session.manuscriptFolder, EPISODE);
  await saveAndSettle(session.page, file, "打った話");
  const saved = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
  expect(saved, "保存したファイル").toBe(EXPECTED_BODY);
}

test.skipIf(!REAL_IME_ENABLED)("本物の IME：横書きの原稿エディターで、語のあとに置いたカーソルの所へ「彼は」が確定して入る", async (ctx) => {
  await runRealImeTest(ctx, "横書き 彼は", [{ name: EPISODE, text: BODY }], async (session, ime) => {
    const frame = await openEpisode(session.page, EPISODE, "そのとき");
    await typeAndCheck(session, ime, frame);
  });
});

test.skipIf(!REAL_IME_ENABLED)("本物の IME：縦書きの原稿エディターで、語のあとに置いたカーソルの所へ「彼は」が確定して入る", async (ctx) => {
  await runRealImeTest(
    ctx,
    "縦書き 彼は",
    [{ name: EPISODE, text: BODY }],
    async (session, ime) => {
      await openEpisode(session.page, EPISODE, "そのとき");
      const frame = await turnVertical(session, "そのとき");
      await typeAndCheck(session, ime, frame);
    },
    VERTICAL_LAUNCH
  );
});
