/**
 * 傍点の語の「中」で打った字が入る（作者の裁定、2026-10-04。設計書6.25.9）。
 *
 * 傍点のかたまりは編集できない（`contenteditable="false"`）。矢印ではかたまりを
 * 1単位で飛び越えるので中へ入らないが、**マウスで語の真ん中を押すと、カーソルが
 * かたまりの中の字に置かれ**、そこで打った字は `beforeinput` だけが起きて
 * 画面にも原稿にも入らなかった（0.98.6 の上で、このテストの2本とも落ちることを
 * 確かめてから直した。語の一部をマウスで引いて選んで打っても同じだった）。
 *
 * 見張ること：打った字は傍点の語の中に入り、原稿では《《 》》の中に増える。
 * 語の一部を選んで打てば、選んだ字だけが置き換わり、傍点は残りの字に付いたまま。
 * 日本語入力の本物の変換は見られない（字は確定した形で入る）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { composeText, openEpisode } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";
const SOURCE = "前の字と《《強調文字》》と後ろの字。\n";

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

async function saveAndWaitFor(session: E2ESession, expected: (text: string) => boolean, label: string) {
  await session.page.keyboard.press("Control+KeyS");
  await waitUntil(async () => expected(await fileText(session)), label, 15_000);
}

test("マウスで傍点の語の真ん中を押して打つと、字が語の中に入り、原稿でも《《 》》の中に増える", async () => {
  await withVsCode("傍点の語の中で打つ", [{ name: EPISODE, text: SOURCE }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "後ろの字");
    const emphasis = frame.locator("#compose .emphasis");
    const box = await emphasis.boundingBox();
    if (!box) throw new Error("傍点の語が見えません");
    // 4字の語の真ん中（2字目と3字目の間）を押す
    await emphasis.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await session.page.keyboard.insertText("あ");
    await waitUntil(async () => (await composeText(frame)).includes("強調あ文字"), "打った字が語の中に出る").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（画面：${JSON.stringify(await composeText(frame))}）`);
      }
    );
    // 続けて打った字も、同じ語の中の続きに入る
    await session.page.keyboard.insertText("い");
    await waitUntil(async () => (await composeText(frame)).includes("強調あい文字"), "続けて打った字も語の中に出る");
    // 傍点は外れていない（語は1つのかたまりのまま）
    expect(await frame.locator("#compose .emphasis").count()).toBe(1);
    await saveAndWaitFor(session, (text) => text.includes("あい"), "打った字がファイルに入る");
    expect(await fileText(session)).toBe("前の字と《《強調あい文字》》と後ろの字。\n");
  });
});

test("傍点の語の真ん中から語の外へマウスで引いて選んで打つと、選んだ字だけが置き換わり、傍点は残りの字に付いたまま", async () => {
  await withVsCode("傍点の語の一部を選んで打つ", [{ name: EPISODE, text: SOURCE }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "後ろの字");
    const emphasis = frame.locator("#compose .emphasis");
    const box = await emphasis.boundingBox();
    if (!box) throw new Error("傍点の語が見えません");
    // 語の真ん中から、語の右の外へ引く（ブラウザは選択の端を語の尻で止める）
    await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await session.page.mouse.down();
    await session.page.mouse.move(box.x + box.width + 30, box.y + box.height / 2, { steps: 5 });
    await session.page.mouse.up();
    await session.page.keyboard.insertText("え");
    await waitUntil(async () => (await composeText(frame)).includes("強調え"), "打った字が画面に出る").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（画面：${JSON.stringify(await composeText(frame))}）`);
      }
    );
    await saveAndWaitFor(session, (text) => text.includes("え"), "打った字がファイルに入る");
    expect(await fileText(session)).toBe("前の字と《《強調え》》と後ろの字。\n");
  });
});
