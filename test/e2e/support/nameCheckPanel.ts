/**
 * 名前点検のパネル（設計書6.37）を開き、人物ごとの「候補を出す（AI）」を押す部品（設計書6.113）。
 *
 * 写真撮りの台本（`look/nameCheckLook.test.ts`）に同じ形の手順があるが、あちらは決まった待ち時間と
 * 写真の置き場への書き留めを使う。検査ではそれを持ち込まず、待つものを名乗って待つ形でここに置いた。
 *
 * **本物の AI は呼ばない。** 候補は偽の Ollama（`fakeOllama.ts`）が返す。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { passLocalAiGate } from "./fakeOllama";
import { runCommand } from "./quickInput";
import type { E2ESession } from "./vscodeApp";
import { waitUntil } from "./wait";
import { clearNotifications, dialogText, pickQuickPickRow, quickInputWaitContext, quickPickRows, quickPickTitle } from "./workbenchDom";

/** 名前点検のパネル（目印は人物の一覧 `#people` と、人物ごとの［候補を出す（AI）］） */
export async function nameCheckFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame.evaluate(() => document.getElementById("people") !== null && document.querySelector("[data-suggest]") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/**
 * コマンドパレットの「名前点検」で開き、人物が `peopleCount` 人並ぶまで待つ。
 * 作品を訊く選ぶ画面が出たら先頭（登録した見本の作品は1つだけ）を選ぶ
 */
export async function openNameCheck(session: E2ESession, peopleCount: number): Promise<Frame> {
  const { page } = session;
  await clearNotifications(page);
  await runCommand(page, "名前点検");
  let panel: Frame | undefined;
  let picked = false;
  await waitUntil(
    async () => {
      if (!picked && (await quickPickTitle(page)) !== undefined) {
        const rows = await quickPickRows(page);
        if (rows.length > 0) {
          await pickQuickPickRow(page, rows[0].label);
          picked = true;
        }
      }
      return (panel = await nameCheckFrame(page)) !== undefined;
    },
    "名前点検のパネルが開く",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
  });
  const frame = panel as Frame;
  await waitUntil(async () => (await frame.locator("[data-suggest]").count()) >= peopleCount, `名前点検に人物が ${peopleCount} 人並ぶ`, 15_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（人物の欄：${JSON.stringify((await frame.locator("#people").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300))}）`);
    }
  );
  return frame;
}

/**
 * 人物 `characterId` の［候補を出す（AI）］を押し、系統を選ぶ画面で `originRow` を選んで、
 * その人物の候補の欄（系統の一文 `.origin-note`）が出て、ボタンが押せる形に戻るまで待つ。
 * `requested` は「この件で偽の AI へ頼みが届いたか」（ファイルで共有する偽の AI の、前の件の分を数えない）。
 * 通った選ぶ画面の題を返す
 */
export async function suggestNamesFor(
  session: E2ESession,
  frame: Frame,
  characterId: string,
  originRow: string,
  requested: () => boolean
): Promise<{ titles: string[] }> {
  const { page } = session;
  const titles: string[] = [];
  const box = frame.locator(`#candidates-${characterId}`);
  await frame.locator(`[data-suggest="${characterId}"]`).click();
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      if (title !== "" && titles[titles.length - 1] !== title) titles.push(title);
      if (title.includes("名前の系統")) {
        await pickQuickPickRow(page, originRow);
      } else if (title === "") {
        // 料金などの確認が窓で出たら名乗って落とす（手元のAIでは出ないはず）
        const dialog = await dialogText(page);
        if (dialog !== undefined && !dialog.includes("手元のAIへ送る前に確かめてください")) {
          throw new Error(`候補を出す途中で、思わぬ確認の窓が出ました：${dialog.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
      return (
        requested() &&
        (await box.locator(".origin-note").count()) > 0 &&
        (await frame.locator(`[data-suggest="${characterId}"]`).isEnabled())
      );
    },
    `系統「${originRow}」を選んで、「${characterId}」の候補の欄が並ぶ`,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（通った選ぶ画面：${JSON.stringify(titles)}／候補の欄：${JSON.stringify((await box.innerText().catch(() => "（無い）")).replace(/\s+/g, " ").slice(0, 400))}）` +
        `${await quickInputWaitContext(page)}`
    );
  });
  return { titles };
}

/** 作品の操作ログ（`.aiwriter/logs/actions.log`）の行 */
export async function actionLogLines(session: E2ESession): Promise<string[]> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
  return text.replace(/\r\n/g, "\n").split("\n");
}
