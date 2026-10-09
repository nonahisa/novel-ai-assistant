/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、漫画の原作・エッセイ・歌詞（と台本）の雛形で
 * 新しい話を作ったときの原稿エディターの写真（雛形の見え方と、下段の種類ごとの目安。
 * 2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * **AI は呼ばない。** `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import type { Page } from "playwright-core";
import { describe, test } from "vitest";
import { composeText, footText, manuscriptFrames, openEpisode } from "../support/manuscriptFrame";
import { runCommand, waitForQuickInput } from "../support/quickInput";
import { withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, editorGroupTabs, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage } from "./lookSupport";

async function setWorkKind(page: Page, label: string): Promise<void> {
  await runCommand(page, "作品の種類（小説・台本など）");
  await waitForQuickInput(page, "の種類");
  await pickQuickPickRow(page, label);
  await page.waitForTimeout(800);
}

describe.skipIf(!lookEnabled)("見た目の写真：種類ごとの雛形", () => {
  test("漫画の原作・エッセイ・歌詞・台本の雛形で新しい話を作る", async () => {
    await withVsCode(
      "見た目の写真：種類ごとの雛形",
      [{ name: "001_はじまり.txt", text: "最初の話の一行目。\n" }],
      async (session) => {
        const { page } = session;
        await openEpisode(page, "001_はじまり.txt", "最初の話");
        await clearNotifications(page);
        const kinds: Array<[string, string, string]> = [
          ["漫画の原作", "■1ページ", "manga"],
          ["エッセイ・記事", "■見出し", "essay"],
          ["歌詞・詩", "【Aメロ】", "lyrics"],
          ["台本", "○場所（時）", "script"],
        ];
        for (const [label, marker, key] of kinds) {
          await setWorkKind(page, label);
          await clearNotifications(page);
          const before = (await editorGroupTabs(page)).flat().length;
          await runCommand(page, "新規話数ファイルを追加");
          // 話の数の入力・作品の選択などが出れば、先頭の選択肢か既定の入力で進める
          let frame = undefined as Awaited<ReturnType<typeof manuscriptFrames>>[number] | undefined;
          for (let step = 0; step < 12 && !frame; step++) {
            await page.waitForTimeout(1200);
            const dialog = await dialogText(page);
            if (dialog) {
              await lookNote(`[781-${key}] 確認：${dialog.replace(/\s+/g, " ").slice(0, 200)}`);
              await pressDialogButton(page, "OK").catch(() => pressDialogButton(page, "作る")).catch(() => undefined);
              continue;
            }
            if ((await quickPickTitle(page)) === undefined && (await page.locator(".quick-input-widget input").first().isVisible().catch(() => false))) {
              // 題の無い入力欄（ファイル名の入力）。既定の名前のまま決める
              await page.keyboard.press("Enter");
              continue;
            }
            if ((await quickPickTitle(page)) !== undefined) {
              const rows = await quickPickRows(page);
              const hasInput = await page.locator(".quick-input-widget input").first().isVisible().catch(() => false);
              await lookNote(`[781-${key}] 画面：${await quickPickTitle(page)}｜${rows.slice(0, 3).map((row) => row.label).join(" / ")}`);
              if (rows.length > 0) await pickQuickPickRow(page, rows[0].label).catch(() => undefined);
              else if (hasInput) await page.keyboard.press("Enter");
              continue;
            }
            for (const candidate of await manuscriptFrames(page)) {
              if ((await composeText(candidate).catch(() => "")).includes(marker.replace(/^[■□]/, ""))) frame = candidate;
            }
          }
          await page.waitForTimeout(1500);
          const tabs = (await editorGroupTabs(page)).flat();
          await lookNote(`[781-${key}] 新しい話のあとのタブ：${JSON.stringify(tabs)}（前：${before}枚）／雛形が出た面：${frame ? "あり" : "見つからず"}${frame ? `／下段：${await footText(frame, "counts")}／本文：${(await composeText(frame)).replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
          await waitUntil(async () => true, "待ち", 100);
          await shootPage(page, `781-${key}-新しい話の雛形`);
        }
      },
      { windowSize: { width: 1280, height: 800 } }
    );
  });
});
