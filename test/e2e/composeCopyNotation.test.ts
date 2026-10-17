/**
 * 組んで書く面でコピーしたとき、本物のクリップボードに入る形（画面の自動テスト、設計書6.12.8・6.113。
 * 実機確認リスト「コピーして素のエディタ（メモ帳・素のVS Codeエディタ）へ貼ると、ルビが投稿サイトの記法
 * （｜漢字《かんじ》）ごと貼れるか」の、クリップボードの中身の部分。2026-10-18）。
 *
 * 何を見張るか（`features` の面が `copy` で載せる3つの形。単体テスト `cross/composeFace.test.ts`「写すときの3つの形」が
 * 形そのものを見張り、ここは**実際に OS のクリップボードを通った中身**を読む）：
 * - `text/plain`：投稿サイトの記法（`｜灯《あかり》は《《確かに》》見た。`）。メモ帳・素のエディタへ貼る形で、
 *   読み仮名が地の文として混ざらない（`{灯|あかり}` のままにも、字だけにもならない）
 * - `text/html`：`<ruby>灯<rt>あかり</rt></ruby>`（Word など、ルビを受け取る貼り先でルビとして入る）
 * - この面へ貼り戻すと、記法が二重にならず元どおり（面は自前の形を先に読む）
 * - `.md` の原稿も、`{灯|あかり}` ではなく `｜灯《あかり》` で入る（2026-09-25 朝の裁定）
 *
 * コピーは**本物の OS のクリップボード**を通る。走らせたあと前の中身へ戻す。貼り先のアプリ（メモ帳・Word）で
 * 実際にどう見えるかは見ない（作者の手に残す）。AI は呼ばない。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, openEpisode } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const TXT = "001_はじまり.txt";
const MD = "002_つづき.md";
/** 原稿の中のルビ・傍点の書き方（`.txt`＝投稿サイトの記法。`.md`＝`{漢字|読み}`） */
const TXT_BODY = "　｜灯《あかり》は《《確かに》》見た。\n";
/** `.txt` と同じ字だが、末尾を変える（面を開き分ける目印。同じ字だと前の話の面を取り違える） */
const MD_BODY = "　{灯|あかり}は{{確かに}}見えた。\n";
/** コピーしたときの `text/plain`（どちらの原稿も同じ形） */
const PLAIN = "　｜灯《あかり》は《《確かに》》見た。";
const PLAIN_MD = "　｜灯《あかり》は《《確かに》》見えた。";

async function readClipboard(session: E2ESession): Promise<{ text: string; html: string }> {
  return session.app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
}

/** 面の中身を全部選んでコピーする（`copy` は製品の面が受ける） */
async function copyAll(session: E2ESession, frame: Frame): Promise<{ text: string; html: string }> {
  await frame.locator("#compose").click();
  // 前のコピーと取り違えない：先にクリップボードを空にする
  await session.app.evaluate(({ clipboard }) => clipboard.clear());
  await session.page.keyboard.press("Control+KeyA");
  await session.page.keyboard.press("Control+KeyC");
  let copied = { text: "", html: "" };
  await waitUntil(
    async () => {
      copied = await readClipboard(session);
      return copied.text !== "";
    },
    "コピーしたあと、OS のクリップボードに字が入る",
    10_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（クリップボード：${JSON.stringify(copied)}／面の字：${JSON.stringify(await composeText(frame))}）`);
  });
  return copied;
}

async function fileText(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8")).replace(/\r\n/g, "\n");
}

test("コピーすると、素のテキストは｜灯《あかり》の記法・HTML は <ruby>・どちらの原稿でも同じ形で、貼り戻しても二重にならない", async () => {
  await withVsCode(
    "コピーの形",
    [
      { name: TXT, text: TXT_BODY },
      { name: MD, text: MD_BODY },
    ],
    async (session) => {
      const { page, app } = session;
      // コピーは OS のクリップボードを使う。走らせたあと前の中身へ戻す
      const before = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() })).catch(() => ({ text: "", html: "" }));
      try {
        /* ── .txt の原稿 ── */
        const frame = await openEpisode(page, TXT, "見た");
        const copied = await copyAll(session, frame);
        expect(copied.text.replace(/\r\n/g, "\n").trim(), "素のテキストが、投稿サイトの記法になっていない").toBe(PLAIN.trim());
        expect(copied.text, "読み仮名が記法の外（地の文）に混ざっている").not.toMatch(/あかり[^》]/);
        expect(copied.text, "ルビの内部の記法 {灯|あかり} のまま入っている").not.toContain("{灯|あかり}");
        expect(copied.html, "HTML にルビの印（<ruby>）が無い").toContain("<ruby>灯<rt>あかり</rt></ruby>");

        /* ── この面へ貼り戻すと、記法が二重にならず元どおり（行の終わりへ貼る） ── */
        await frame.locator("#compose").click();
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Control+KeyV");
        await waitUntil(async () => (await composeText(frame)).split("見た。").length - 1 >= 2, "貼り戻した字が面に出る（見た。が2回）", 10_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（面の字：${JSON.stringify(await composeText(frame))}）`);
          }
        );
        await page.keyboard.press("Control+KeyS");
        await waitUntil(
          async () => (await fileText(session, TXT)).split("｜灯《あかり》").length - 1 >= 2,
          "貼り戻して保存すると、ファイルに記法が2か所入る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session, TXT))}）`);
        });
        const saved = await fileText(session, TXT);
        expect(saved, "記法が二重になっている（｜｜灯 や 《《あかり》》 など）").not.toMatch(/｜｜|《あかり》》|｜《/);
        expect(saved.split("｜灯《あかり》").length - 1, "ルビの記法が2か所").toBe(2);

        /* ── .md の原稿：{灯|あかり} ではなく ｜灯《あかり》 で入る ── */
        const mdFrame = await openEpisode(page, MD, "見えた");
        const mdCopied = await copyAll(session, mdFrame);
        expect(mdCopied.text.replace(/\r\n/g, "\n").trim(), ".md の原稿の素のテキストが、投稿サイトの記法になっていない").toBe(PLAIN_MD.trim());
        expect(mdCopied.text, ".md のコピーに {灯|あかり} が残っている").not.toContain("{灯|あかり}");
        expect(mdCopied.html, ".md のコピーの HTML に <ruby> が無い").toContain("<ruby>灯<rt>あかり</rt></ruby>");
      } finally {
        await app
          .evaluate(({ clipboard }, saved) => {
            if (saved.html) clipboard.write({ text: saved.text, html: saved.html });
            else clipboard.writeText(saved.text);
          }, before)
          .catch(() => undefined);
      }
    }
  );
}, 240_000);
