/**
 * 組んで書く面の End／Home は、見えている行の端へ動く（作者の実機報告、2026-10-04。設計書6.25.9）。
 *
 * 作者は縦書きで「今日」を選んで Ctrl+Alt+K で傍点を付け、すぐ End を押して「い」を打った。
 * 「い」は行末でなく、同じ行の前のほうのルビ「{何度|なんど}」の直後に入った。
 * 調べると、**行にルビ（編集できないかたまり）があると、Chromium の End はそのルビの直後で
 * 止まる**（縦書きでも横書きでも。傍点を付けたかどうかに関わらず、行の頭から End でも同じ）。
 * 0.98.6 の上で、このテストは縦横とも落ちることを確かめてから直した。
 *
 * 見張ること：End のあとに打った字は行末に入る。Home のあとに打った字は行の頭に入る。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter, selectText } from "./support/manuscriptFrame";
import { turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.md";
const LINE = "「ああ、{何度|なんど}も来てもらってるのにすいませんねぇ。今日はいますよ」";

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

async function saveAndWaitFor(session: E2ESession, needle: string): Promise<void> {
  await session.page.keyboard.press("Control+KeyS");
  await waitUntil(async () => (await fileText(session)).includes(needle), `「${needle}」がファイルに入る`, 15_000);
}

for (const vertical of [true, false]) {
  const face = vertical ? "縦書き" : "横書き";

  test(`${face}：ルビのある行で「今日」に傍点を付け、付いてから End を押して打つと、字は行末に入る`, async () => {
    await withVsCode(
      `ルビのある行の End（${face}）`,
      [{ name: EPISODE, text: `${LINE}\n二行目。\n` }],
      async (session) => {
        let frame = await openEpisode(session.page, EPISODE, "いますよ");
        if (vertical) frame = await turnVertical(session, "いますよ");
        await selectText(frame, "今日");
        await session.page.keyboard.press("Control+Alt+KeyK");
        // 傍点が付いたのを見てから End（End が先に着くと、付ける語の選択が動いてしまう）
        await waitUntil(async () => (await frame.locator("#compose .emphasis").count()) === 1, "傍点が付く");
        await session.page.keyboard.press("End");
        await session.page.keyboard.insertText("い");
        await waitUntil(async () => (await composeText(frame)).includes("い"), "打った字が画面に出る");
        await saveAndWaitFor(session, "」い");
        expect(await fileText(session)).toBe(
          "「ああ、{何度|なんど}も来てもらってるのにすいませんねぇ。{{今日}}はいますよ」い\n二行目。\n"
        );
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：ルビのある行の途中から End で行末、Home で行の頭へ動いて打てる`, async () => {
    await withVsCode(
      `ルビのある行の Home と End（${face}）`,
      [{ name: EPISODE, text: `${LINE}\n二行目。\n` }],
      async (session) => {
        let frame = await openEpisode(session.page, EPISODE, "いますよ");
        if (vertical) frame = await turnVertical(session, "いますよ");
        await placeCaretAfter(frame, "「ああ");
        await session.page.keyboard.press("End");
        await session.page.keyboard.insertText("尾");
        await session.page.keyboard.press("Home");
        await session.page.keyboard.insertText("頭");
        await saveAndWaitFor(session, "頭");
        await waitUntil(async () => (await fileText(session)).includes("尾"), "End のあとに打った字がファイルに入る");
        expect(await fileText(session)).toBe(`頭${LINE}尾\n二行目。\n`);
      },
      VERTICAL_LAUNCH
    );
  });
}
