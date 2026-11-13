/**
 * Shift_JIS の話を**自動保存**（`files.autoSave: afterDelay`）で書くときの残りの見張り（画面の自動テスト、
 * 設計書5.4.2・6.113。0.148.1／0.148.3。実機確認リスト 0.148.1 の〔Win〕の項目の残り）。
 * 先に済んでいる分（「〜」→「～」・続けて打った字・「♡」→「〓」の窓と置き場と控え）は
 * `shiftJisSaveBytes.test.ts`。
 *
 * 見張ること：
 * 1. **長く続けて打っても、字が消えず、順番も入れ替わらない**：自動保存の間隔（0.5秒）を何度もまたいで
 *    3秒あまり1字ずつ打ち（途中に「〜」）、打った順のまま画面とファイルに残る（「〜」は「～」になる）
 * 2. **続けてほかの字を打っても、窓は2回目は出ない**：「♡」を打つと窓が1回出る。［校正・メモパネルを開く］で
 *    答えたあと、続けて「♡」をもう1度・ほかの字を打っても、窓は出ない
 * 3. **［校正・メモパネルを開く］で「Shift_JIS に無い字」の行が出て、［本文へ］で〓の行へ飛び、〓を別の字に
 *    直して保存すると行が消える**
 * 4. **［控えを開く］で、♡ の入った控え（UTF-8・BOM 付き）が化けずに開く**
 *
 * 文書を Shift_JIS で開くのは `files.encoding: shiftjis`（使い捨ての settings.json）。落ちたときは
 * 読んだバイト列・窓・パネルの行を失敗の文へ添える。
 *
 * **見ていないこと**：日本語入力の本物の変換（打った字は確定した形で入る）。**AI は呼ばない。**
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import iconv = require("iconv-lite");
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { dialogButtons } from "./support/importFlow";
import { caretPosition, composeText, memoPanelFrame, openEpisode, placeCaretAfter, selectText } from "./support/manuscriptFrame";
import { withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, pressDialogButton } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const BODY = "終電を逃した駅のホーム。\n雨の音だけが残っていた。\n";
const GETA_MARK = [0x81, 0xac];
const ROW_LABEL = "Shift_JIS に無い字";

function sjisAutoSave(): LaunchOptions {
  return {
    settings: { "files.encoding": "shiftjis", "files.autoSave": "afterDelay", "files.autoSaveDelay": 500 },
    prepareWork: async ({ manuscriptFolder }) => {
      await writeFile(path.join(manuscriptFolder, EPISODE), iconv.encode(BODY, "shift_jis"));
    },
  };
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");

function includesSequence(bytes: Uint8Array, sequence: readonly number[]): boolean {
  outer: for (let at = 0; at + sequence.length <= bytes.length; at += 1) {
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[at + index] !== sequence[index]) continue outer;
    }
    return true;
  }
  return false;
}

/** 話のファイルを Shift_JIS として読んだ字（書き込み途中で無いときは前の値のまま） */
async function readSjis(file: string, last: { text: string }): Promise<string> {
  const raw = await readFile(file).catch(() => undefined);
  if (raw) last.text = iconv.decode(raw, "shift_jis").replace(/\r\n/g, "\n");
  return last.text;
}

async function waitDialogWithMark(page: Page, label: string): Promise<string> {
  let shown: string | undefined;
  await waitUntil(
    async () => {
      shown = await dialogText(page);
      return shown !== undefined && shown.includes("♡");
    },
    label,
    20_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(shown)}）`);
  });
  return shown ?? "";
}

/** 打った字が画面と本文のファイルに出るまでに、保存を何度もまたぐ */
test("自動保存の原稿エディターで、3秒あまり1字ずつ打ち続けても、字が消えず順番も入れ替わらない（途中の「〜」は「～」になる）", async () => {
  const typed = ["あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ", "〜", "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と", "な", "に", "ぬ", "ね", "の"];
  const shownText = typed.join("").replace("〜", "～");
  await withVsCode("Shift_JIS 自動保存で長く打つ", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder } = session;
    const frame = await openEpisode(page, EPISODE, "雨の音");
    await placeCaretAfter(frame, "雨の音");
    for (const char of typed) {
      await page.keyboard.insertText(char);
      await new Promise((resolve) => setTimeout(resolve, 130));
    }
    const expected = BODY.replace("雨の音だけ", `雨の音${shownText}だけ`);
    const file = path.join(manuscriptFolder, EPISODE);
    const last = { text: "" };
    await waitUntil(async () => (await readSjis(file, last)) === expected, "打った字が順番どおり、全部ファイルに入る", 20_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(last.text)}／バイト：${hex(await readFile(file).catch(() => new Uint8Array()))}）`);
      }
    );
    await waitUntil(async () => (await composeText(frame)).includes(`雨の音${shownText}だけ`), "画面にも順番どおり全部残る", 10_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}）`);
      }
    );
    // 数秒たっても崩れない（遅れて字が消えたり入れ替わったりしない）
    await holdsFor(async () => (await readSjis(file, last)) === expected, "保存したファイルの本文", 3_000);
  }, sjisAutoSave());
}, 120_000);

test("「♡」を打つと窓が1回出る。［校正・メモパネルを開く］で答えたあと続けて打っても窓は出ず、パネルに「Shift_JIS に無い字」の行が出て、［本文へ］で〓の行へ飛び、〓を別の字に直して保存すると行が消える", async () => {
  await withVsCode("Shift_JIS 自動保存で〓の行", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder } = session;
    const file = path.join(manuscriptFolder, EPISODE);
    const frame = await openEpisode(page, EPISODE, "雨の音");
    await placeCaretAfter(frame, "雨の音");
    await page.keyboard.insertText("♡");

    const shown = await waitDialogWithMark(page, "「♡」を「〓」にしたことを知らせる窓が出る");
    expect(shown).toContain("〓");
    const buttons = await dialogButtons(page);
    for (const label of ["校正・メモパネルを開く", "控えを開く"]) {
      expect(
        buttons.some((text) => text.includes(label)),
        `窓に［${label}］が並んでいません（ボタン：${JSON.stringify(buttons)}）`
      ).toBe(true);
    }
    const bytes = await readFile(file);
    expect(includesSequence(bytes, GETA_MARK), `ファイル：${hex(bytes)}`).toBe(true);

    /* ── ［校正・メモパネルを開く］ ── */
    await pressDialogButton(page, "校正・メモパネルを開く");
    let memo: Frame | undefined;
    await waitUntil(
      async () => {
        memo = await memoPanelFrame(page);
        return memo !== undefined && (await memo.evaluate((label) => document.body.innerText.includes(label), ROW_LABEL));
      },
      `校正・メモパネルが開き、「${ROW_LABEL}」の行が出る`,
      20_000
    ).catch(async (error: unknown) => {
      const text = memo ? await memo.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "") : "（パネルが無い）";
      throw new Error(`${String(error)}（パネルの字：${JSON.stringify(text)}）`);
    });

    /* ── 続けて打っても、窓は2回目は出ない（同じ字「♡」をもう1度、ほかの字も） ── */
    // 面は開き直さない（開き直すとパネルが後ろへ回り、押せなくなる）。原稿の面へ焦点だけ戻す
    const again = frame;
    await placeCaretAfter(again, "だけが残っていた");
    await page.keyboard.insertText("♡");
    await page.keyboard.insertText("が");
    await holdsFor(async () => (await dialogText(page)) === undefined, "続けて打っても2回目の窓は出ない（窓が無いこと）", 4_000);

    /* ── ［本文へ］で〓の行へ飛ぶ ── */
    const row = (memo as Frame).locator(".row, li, tr, .item", { hasText: ROW_LABEL }).filter({ has: (memo as Frame).locator('button[data-act="reveal"]') }).first();
    const reveal = (await row.count()) > 0 ? row.locator('button[data-act="reveal"]').first() : (memo as Frame).locator('button[data-act="reveal"]').first();
    await reveal.click();
    await waitUntil(
      async () => ((await caretPosition(again))?.lineText ?? "").includes("〓"),
      "［本文へ］でカーソルが〓のある行へ飛ぶ",
      15_000
    ).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（カーソル：${JSON.stringify(await caretPosition(again))}／画面：${JSON.stringify(await composeText(again))}）`);
    });

    /* ── 〓を別の字に直して保存すると、行が消える（残りの〓も直す） ── */
    for (let guard = 0; guard < 4 && (await composeText(again)).includes("〓"); guard++) {
      await selectText(again, "〓");
      await page.keyboard.insertText("愛");
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    expect(await composeText(again), "〓を全部直した").not.toContain("〓");
    const last = { text: "" };
    await waitUntil(async () => !(await readSjis(file, last)).includes("〓") && last.text.includes("愛"), "直した字（愛）が保存される", 15_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(last.text)}）`);
      }
    );
    await waitUntil(
      async () => !(await (memo as Frame).evaluate((label) => document.body.innerText.includes(label), ROW_LABEL).catch(() => false)),
      `直して保存すると、パネルの「${ROW_LABEL}」の行が消える`,
      20_000
    ).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（パネルの字：${JSON.stringify(await (memo as Frame).evaluate(() => document.body.innerText.slice(0, 600)).catch(() => ""))}）`);
    });
  }, sjisAutoSave());
}, 180_000);

test("窓の［控えを開く］で、♡ の入った控えが文字化けせずに開く", async () => {
  await withVsCode("Shift_JIS 自動保存で控えを開く", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder } = session;
    const frame = await openEpisode(page, EPISODE, "雨の音");
    await placeCaretAfter(frame, "雨の音");
    await page.keyboard.insertText("♡");
    await waitDialogWithMark(page, "「♡」を「〓」にしたことを知らせる窓が出る");
    await pressDialogButton(page, "控えを開く");
    let shown = "";
    await waitUntil(
      async () => {
        shown = (await page.locator(".editor-instance .monaco-editor .view-lines").first().innerText().catch(() => "")).replace(/ /g, " ");
        return shown.includes("♡");
      },
      "控えが開き、♡ が化けずに読める",
      15_000
    ).catch(async (error: unknown) => {
      const folder = path.join(manuscriptFolder, ".novelai-recovery");
      throw new Error(`${String(error)}（前のエディターの字：${JSON.stringify(shown)}／控え：${JSON.stringify(await readdir(folder, { recursive: true }).catch(() => []))}）`);
    });
    expect(shown, "控えには元の本文の続きも読める").toContain("雨の音♡");
    expect(shown, "文字化けの印（�）が無い").not.toContain("�");
  }, sjisAutoSave());
}, 120_000);
