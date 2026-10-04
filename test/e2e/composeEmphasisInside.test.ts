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
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { composeText, openEpisode, selectText } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";
const SOURCE = "前の字と《《強調文字》》と後ろの字。\n";

async function fileTextOf(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8")).replace(/\r\n/g, "\n");
}

async function fileText(session: E2ESession): Promise<string> {
  return fileTextOf(session, EPISODE);
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

/*
  作者の実機（2026-10-04、縦書き）：Ctrl+Alt+K で傍点を付けた直後の語の真ん中を押すと、カーソルが
  出ず、打った字が入らなかった。付けた直後は本体の選び直しで語ぜんたいが選ばれており、選ばれた所の
  中の編集できないかたまりを押すと、Chromium は選択を**行の頭**へ畳んでいた（0.98.6 の上で、縦書きでも
  横書きでも、打った字が行の頭に入った）。縦書きと横書きの両方で見張る
*/
for (const vertical of [true, false]) {
  test(`${vertical ? "縦書き" : "横書き"}：Ctrl+Alt+K で傍点を付けた直後に語の真ん中を押して打つと、字は語の中に入る（行の頭へ行かない）`, async () => {
    await withVsCode(
      `傍点を付けた直後に語の中で打つ（${vertical ? "縦" : "横"}）`,
      [{ name: "001_はじまり.md", text: "前の字と今日と後ろの字。\n" }],
      async (session) => {
        let frame = await openEpisode(session.page, "001_はじまり.md", "後ろの字");
        if (vertical) frame = await turnVertical(session, "後ろの字");
        await installTrace(frame);
        await selectText(frame, "今日");
        await session.page.keyboard.press("Control+Alt+KeyK");
        await waitUntil(async () => (await frame.locator("#compose .emphasis").count()) === 1, "傍点が付く");
        // 本体の選び直し（語ぜんたいを選ぶ）が届いてから押す
        await waitUntil(
          async () => frame.evaluate(() => !(window.getSelection()?.isCollapsed ?? true)),
          "傍点を付けた語が選び直される"
        );
        const emphasis = frame.locator("#compose .emphasis");
        const box = await emphasis.boundingBox();
        if (!box) throw new Error("傍点の語が見えません");
        await emphasis.click({ position: { x: box.width / 2, y: box.height / 2 } });
        await session.page.keyboard.insertText("あ");
        await waitUntil(async () => (await composeText(frame)).includes("今あ日"), "打った字が語の中に出る").catch(
          async (error: unknown) => {
            throw new Error(
              `${String(error)}（画面：${JSON.stringify(await composeText(frame))}／画面の出来事：${await traceOf(frame)}）`
            );
          }
        );
        await session.page.keyboard.press("Control+KeyS");
        await waitUntil(async () => (await fileTextOf(session, "001_はじまり.md")).includes("あ"), "打った字がファイルに入る", 15_000);
        expect(await fileTextOf(session, "001_はじまり.md")).toBe("前の字と{{今あ日}}と後ろの字。\n");
      },
      VERTICAL_LAUNCH
    );
  });
}

/**
 * 変換（日本語入力）で打つ。Playwright に変換の口は無いので、Chromium の開発者の口
 * （CDP の Input.imeSetComposition → Input.insertText）で、変換中の字と確定を送る。
 * 本物の日本語入力の変換キー・候補の窓は通らない（e2e スキルの「見張れないもの」）
 */
async function typeByIme(session: E2ESession, reading: string, result: string): Promise<void> {
  const cdp = await session.page.context().newCDPSession(session.page);
  try {
    await cdp.send("Input.imeSetComposition", { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
    await cdp.send("Input.imeSetComposition", { text: result, selectionStart: result.length, selectionEnd: result.length });
    await cdp.send("Input.insertText", { text: result });
  } finally {
    await cdp.detach();
  }
}

test("縦書き：傍点の語の真ん中を押して変換で打つと、確定した字は語の中に入る", async () => {
  await withVsCode(
    "傍点の語の中で変換して打つ",
    [{ name: "001_はじまり.md", text: "前の字と{{今日}}と後ろの字。\n" }],
    async (session) => {
      await openEpisode(session.page, "001_はじまり.md", "後ろの字");
      const frame = await turnVertical(session, "後ろの字");
      const emphasis = frame.locator("#compose .emphasis");
      const box = await emphasis.boundingBox();
      if (!box) throw new Error("傍点の語が見えません");
      await emphasis.click({ position: { x: box.width / 2, y: box.height / 2 } });
      // 作者の手と同じく、押してから打ち始めるまでに少し間がある（押してすぐの打鍵は上の2本が見る）
      await waitUntil(
        async () => frame.evaluate(() => document.querySelector("#compose .emphasis")?.getAttribute("data-open") === "1"),
        "押した傍点の語が開く"
      );
      await typeByIme(session, "あめ", "雨");
      await waitUntil(async () => (await composeText(frame)).includes("今雨日"), "確定した字が語の中に出る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（画面：${JSON.stringify(await composeText(frame))}）`);
        }
      );
      await session.page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await fileTextOf(session, "001_はじまり.md")).includes("雨"), "確定した字がファイルに入る", 15_000);
      expect(await fileTextOf(session, "001_はじまり.md")).toBe("前の字と{{今雨日}}と後ろの字。\n");
    },
    VERTICAL_LAUNCH
  );
});

/** 押す前後の画面の出来事を控える（落ちた回に、どこで選択が動いたかを読むため。製品には何も足さない） */
async function installTrace(frame: Frame): Promise<void> {
        await frame.evaluate(() => {
          const w = window as unknown as { __log: string[] };
          w.__log = [];
          const t0 = performance.now();
          const desc = () => {
            const s = window.getSelection();
            if (!s || s.rangeCount === 0) return "なし";
            return `${s.anchorNode?.nodeName}「${(s.anchorNode?.textContent ?? "").slice(0, 8)}」@${s.anchorOffset}→${s.focusNode?.nodeName}@${s.focusOffset}`;
          };
          document.addEventListener("selectionchange", () => w.__log.push(`${Math.round(performance.now() - t0)} sel ${desc()}`));
          for (const n of ["mousedown", "mouseup", "click"]) {
            document.addEventListener(
              n,
              (e) => {
                const m = e as MouseEvent;
                const r = document.caretRangeFromPoint(m.clientX, m.clientY);
                w.__log.push(
                  `${Math.round(performance.now() - t0)} ${n} ${desc()} 点=${r ? `${r.startContainer.nodeName}「${r.startContainer.textContent}」@${r.startOffset}` : "なし"} 的=${(e.target as Element).nodeName}`
                );
              },
              true
            );
          }
          for (const n of ["beforeinput", "input", "keydown"]) {
            document.addEventListener(
              n,
              (e) => {
                const ie = e as InputEvent;
                w.__log.push(
                  `${Math.round(performance.now() - t0)} ${n} ${ie.inputType ?? ""} ${desc()} 止め=${String(e.defaultPrevented)} 的=${(e.target as Element).nodeName}`
                );
              },
              true
            );
          }
          window.addEventListener("message", (e) => w.__log.push(`${Math.round(performance.now() - t0)} msg ${(e.data as { type?: string }).type}`));
        });
}

async function traceOf(frame: Frame): Promise<string> {
  return frame
    .evaluate(() => ((window as unknown as { __log?: string[] }).__log ?? []).join(" | "))
    .catch(() => "（記録が読めません）");
}

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
