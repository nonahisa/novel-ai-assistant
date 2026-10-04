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
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter, selectText } from "./support/manuscriptFrame";
import { turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.md";
/*
  **折り返さない長さにする**（2026-10-04、ノートPCで落ちて改めた）。Home／End は**見えている
  行**（縦書きでは1列）の端へ動く（ふつうのエディターと同じ）。作者の行（38字）をそのまま
  使うと、ノートPCの狭い窓では縦の1列に収まらず2列に折り返し、End は1列目の終わり、Home は
  2列目の頭へ動いて、「行末・行の頭」を見たことにならなかった。ここで見たいのは
  「ルビがあっても End が止まらない」ことなので、1列に収まる長さにし、収まっているかを先に確かめる
*/
const LINE = "「ああ、{何度|なんど}も来た。今日はいるよ」";

/** 1行目が折り返さずに1行（縦書きでは1列）に収まっているか。収まっていなければ理由を返す */
async function lineFitsOneRow(frame: Frame): Promise<string | null> {
  return frame.evaluate(() => {
    const line = document.querySelector("#compose")?.firstElementChild;
    if (!line) return "1行目がありません";
    const vertical = document.body.classList.contains("vertical");
    // 本文の字（読み仮名 rt の中は除く）の中ほどが、最初の字と半字以上ずれていないか
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let first: number | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest("rt")) continue;
      const value = node.nodeValue ?? "";
      for (let i = 0; i < value.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        const center = vertical ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
        const size = vertical ? rect.width : rect.height;
        if (first === null) first = center;
        else if (Math.abs(center - first) > size / 2) return `1行目が「${value[i]}」で折り返しています`;
      }
    }
    return null;
  });
}

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
        let frame = await openEpisode(session.page, EPISODE, "いるよ");
        if (vertical) frame = await turnVertical(session, "いるよ");
        expect(await lineFitsOneRow(frame), "テストの前提（1行目が折り返さない）が崩れています").toBeNull();
        await selectText(frame, "今日");
        await session.page.keyboard.press("Control+Alt+KeyK");
        // 傍点が付いたのを見てから End（End が先に着くと、付ける語の選択が動いてしまう）
        await waitUntil(async () => (await frame.locator("#compose .emphasis").count()) === 1, "傍点が付く");
        await session.page.keyboard.press("End");
        await session.page.keyboard.insertText("い");
        await waitUntil(async () => (await composeText(frame)).includes("」い"), "打った字が行末に出る").catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（画面：${JSON.stringify(await composeText(frame))}）`);
          }
        );
        await saveAndWaitFor(session, "」い");
        expect(await fileText(session)).toBe("「ああ、{何度|なんど}も来た。{{今日}}はいるよ」い\n二行目。\n");
      },
      VERTICAL_LAUNCH
    );
  });

  test(`${face}：ルビのある行の途中から End で行末、Home で行の頭へ動いて打てる`, async () => {
    await withVsCode(
      `ルビのある行の Home と End（${face}）`,
      [{ name: EPISODE, text: `${LINE}\n二行目。\n` }],
      async (session) => {
        let frame = await openEpisode(session.page, EPISODE, "いるよ");
        if (vertical) frame = await turnVertical(session, "いるよ");
        expect(await lineFitsOneRow(frame), "テストの前提（1行目が折り返さない）が崩れています").toBeNull();
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
