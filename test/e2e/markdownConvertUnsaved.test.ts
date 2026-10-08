/**
 * 開いたまま保存していない原稿があるとき、本文の .md 化は先に保存を訊き、
 * 中止すれば何も変わらず、保存して実行すれば打ちかけの字を失わずに変換される
 * （画面の自動テスト、設計書6.12.4・6.113）。
 *
 * 実機確認リスト A-9「MD化のときの取り込み」の「開いたまま保存していないファイルがあるとき、
 * 直せなかった旨が出るか」を機械へ移したもの。**いまの作りでは、作品一覧の右クリックからの
 * MD化は変換の前に「未保存の変更が N 件あります。保存してから実行しますか？」を訊く**
 * （`saveDirtyDocumentsBeforeExtraction`）ので、「直せなかった旨」の文言（保存前の本文を
 * 書き換えようとして断られた場合）には届かない。そこで、その手前の守りを見張る：
 *
 * - 本文を打って未保存のまま MD化すると、保存を訊く知らせが出る
 * - 「中止」を押すと、.txt のまま・中身も元のまま・.md はできない（ルビも直さない）
 * - もう一度 MD化して「保存して実行」を押すと、打った字が保存されたうえで .md になり、
 *   ルビが `{漢字|かんじ}` に直る（打った字も残る）。「直せなかった」の知らせは出ない
 *
 * **作者の原稿は使わない。AI は呼ばない。**
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { SIDEBAR_LAUNCH, treeContextMenu, treeRowLabels } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey, tabIsDirty } from "./support/workbenchDom";

const EPISODE = "第1話_ルビ.txt";
const CONVERTED = "第1話_ルビ.md";
const TEXT = "　｜漢字《かんじ》を読む朝だった。\n　二行目の文。\n";

async function manuscriptNames(session: E2ESession): Promise<string[]> {
  return readdir(session.manuscriptFolder);
}

async function readText(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 右下の知らせの本文（上から） */
async function noticeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast")).map((toast) => (toast as HTMLElement).innerText)
  );
}

/** 知らせの中のボタンを名前で押す */
async function pressNoticeButton(page: Page, label: string): Promise<void> {
  await page.locator(".notification-toast .monaco-button", { hasText: label }).first().click();
}

test("未保存のまま本文を .md 化すると保存を訊き、中止なら何も変わらず、保存して実行なら打った字を残して変換される", async () => {
  await withVsCode(
    "未保存でMD化",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "二行目の文");

      // 開いたら出る「.md にしませんか」の案内は、いまは使わないので閉じる
      await clearNotifications(page);

      // 打つ（未保存のまま）
      await placeCaretAfter(frame, "二行目の文。");
      await page.keyboard.insertText("【打ちかけ】");
      await waitUntil(async () => await tabIsDirty(page, EPISODE), "タブが未保存の印（●）になる");
      expect(await readText(session, EPISODE), "保存前のファイルは元のまま").toBe(TEXT);

      // 作品一覧を出して、話を右クリック →「本文 .md 化」
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      const workRow = page.locator(`.monaco-list-row[aria-expanded][aria-label*="${E2E_WORK_TITLE}"]`).first();
      await waitUntil(async () => (await workRow.count()) > 0, "作品の行が出る");
      if ((await workRow.getAttribute("aria-expanded")) !== "true") await workRow.click();
      await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第1話")), "作品の下に話が並ぶ");

      /* ── 中止：何も変わらない ── */
      await treeContextMenu(page, "第1話 ", "本文 .md 化");
      await waitUntil(
        async () => (await noticeTexts(page)).some((text) => text.includes("未保存の変更が 1 件あります")),
        "保存を訊く知らせが出る",
        20_000
      );
      await pressNoticeButton(page, "中止");
      await holdsFor(
        async () => {
          const names = await manuscriptNames(session);
          return names.includes(EPISODE) && !names.includes(CONVERTED) && (await readText(session, EPISODE)) === TEXT;
        },
        "中止したのに、.md ができた・.txt が変わった",
        2_500
      );
      expect(await tabIsDirty(page, EPISODE), "中止しても打ちかけは残っている").toBe(true);

      /* ── 保存して実行：打った字を残して変換される ── */
      await clearNotifications(page);
      await treeContextMenu(page, "第1話 ", "本文 .md 化");
      await waitUntil(
        async () => (await noticeTexts(page)).some((text) => text.includes("未保存の変更が 1 件あります")),
        "もう一度、保存を訊く知らせが出る",
        20_000
      );
      await pressNoticeButton(page, "保存して実行");
      await waitUntil(async () => (await manuscriptNames(session)).includes(CONVERTED), ".md ができる", 30_000);
      await waitUntil(
        async () => {
          const text = await readText(session, CONVERTED);
          return text.includes("{漢字|かんじ}") && text.includes("【打ちかけ】");
        },
        "ルビが直り、打った字も残っている",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（.md：${JSON.stringify(await readText(session, CONVERTED))}）`);
      });
      expect(await manuscriptNames(session), "元の .txt は無くなる（名前が変わった）").not.toContain(EPISODE);
      expect((await noticeTexts(page)).join("\n"), "直せなかった旨は出ない").not.toContain("直せませんでした");
    },
    SIDEBAR_LAUNCH
  );
}, 180_000);
