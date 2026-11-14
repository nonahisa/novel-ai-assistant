/**
 * メモの印を作品ごとに選べる（画面の自動テスト、設計書6.40.8。作者の決定 2026-11-14 夜）。
 *
 * - 作品の設定（`.aiwriter/config.json` の `memoMarkers`）で `%%` をオンにした作品では、
 *   原稿エディターで `%%` の行が付箋の色で出て、校正・メモパネルにも付箋として並ぶ
 * - 囲み（`<!-- ～ -->`）をオンにした作品で、閉じていない `<!--` のある話を保存すると知らせが出る。
 *   同じ場所のままもう一度保存しても、2回目は出さない
 *
 * 印は作品の設定ファイルから毎回読む（`core/memoMarkerStore.ts`）。選ぶ窓（詳細メニューの
 * 「メモの印」）は通さず、設定ファイルへ直に書く——ここで見たいのは「設定のとおりに読むか」で、
 * 窓の確かめは単体テスト（`test/unit/features/setMemoMarkers.test.ts`）が見ている。
 * **AI は呼ばない。**
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts } from "./support/workbenchDom";
import { OPEN_SCENE_MEMOS_PRESS } from "./support/keys";

/**
 * 作品の設定ファイルへ印を書く。**登録で設定ファイルができたあと、話を開く前に**呼ぶ
 * （原稿エディターは開くときに印を読む）。
 */
async function setWorkMemoMarkers(session: E2ESession, ids: readonly string[]): Promise<void> {
  const file = path.join(session.workFolder, ".aiwriter", "config.json");
  const config = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as Record<string, unknown>;
  config.memoMarkers = [...ids];
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** 組んで書く面で、その字を含む行に付いている class（行が無ければ undefined） */
async function composeLineClass(frame: Frame, needle: string): Promise<string | undefined> {
  return frame.evaluate((text) => {
    const lines = Array.from(document.querySelectorAll("#compose p, #compose div"));
    const found = lines.find((line) => (line.textContent ?? "").includes(text));
    return found ? found.getAttribute("class") ?? "" : undefined;
  }, needle);
}

const PERCENT_EPISODE = "001_はじまり.txt";
const PERCENT_TEXT = "一行目の文。\n%% 百分の印のメモ\n三行目の文。\n// 斜線のメモ\n五行目の文。\n";

test("設定のファイルで %% をオンにした作品を開くと、%% の行が付箋の色で出て、校正・メモパネルに付箋として並ぶ", async () => {
  await withVsCode("作品ごとのメモの印", [{ name: PERCENT_EPISODE, text: PERCENT_TEXT }], async (session) => {
    const { page } = session;
    await setWorkMemoMarkers(session, ["slash", "percent"]);
    const frame = await openEpisode(page, PERCENT_EPISODE, "五行目の文");

    // %% の行は付箋（memo）、ほかの行は付箋ではない。// の行もオンのまま付箋
    await waitUntil(
      async () => ((await composeLineClass(frame, "百分の印のメモ")) ?? "").split(/\s+/).includes("memo"),
      "原稿エディターで %% の行が付箋の色になる"
    );
    expect(((await composeLineClass(frame, "斜線のメモ")) ?? "").split(/\s+/)).toContain("memo");
    expect(((await composeLineClass(frame, "三行目の文")) ?? "").split(/\s+/)).not.toContain("memo");

    // 校正・メモパネルにも、%% の行が付箋として並ぶ
    await placeCaretAfter(frame, "一行目");
    await page.keyboard.press(OPEN_SCENE_MEMOS_PRESS);
    let panel: Frame | undefined;
    await waitUntil(
      async () => {
        panel = await memoPanelFrame(page);
        return panel !== undefined && (await panel.locator("button.go", { hasText: "百分の印のメモ" }).count()) > 0;
      },
      "校正・メモパネルに %% の行が付箋として並ぶ",
      30_000
    );
    if (!panel) throw new Error("校正・メモパネルが見つかりません");
    expect(await panel.locator("button.go", { hasText: "斜線のメモ" }).count()).toBeGreaterThan(0);
    // 本文の行は付箋にならない
    expect(await panel.locator("button.go", { hasText: "三行目の文" }).count()).toBe(0);
  });
});

const COMMENT_EPISODE = "001_はじまり.txt";
const COMMENT_TEXT = "一行目の文。\n<!-- 閉じ忘れの囲み\n三行目の文。\n";
const UNCLOSED_NOTICE = "が閉じていません";

test("囲みをオンにした作品で、閉じていない <!-- のある話を保存すると知らせが出る（同じ場所なら2回目は出ない）", async () => {
  await withVsCode("閉じていないメモの囲み", [{ name: COMMENT_EPISODE, text: COMMENT_TEXT }], async (session) => {
    const { page } = session;
    await setWorkMemoMarkers(session, ["slash", "comment"]);
    const frame = await openEpisode(page, COMMENT_EPISODE, "三行目の文");
    await clearNotifications(page);
    const file = path.join(session.manuscriptFolder, COMMENT_EPISODE);

    // 本文を1字変えて保存する（変えないと保存が走らない）
    await placeCaretAfter(frame, "三行目");
    await page.keyboard.insertText("あ");
    await page.keyboard.press("ControlOrMeta+KeyS");
    await waitUntil(async () => (await readFile(file, "utf8")).includes("三行目あ"), "打った字がファイルに入る");
    await waitUntil(
      async () => (await notificationTexts(page)).some((text) => text.includes(UNCLOSED_NOTICE)),
      "保存すると、閉じていない <!-- の知らせが出る"
    );
    const notice = (await notificationTexts(page)).find((text) => text.includes(UNCLOSED_NOTICE)) ?? "";
    expect(notice).toContain("2行目");

    // 同じ場所のまま、もう一度保存しても知らせは出ない（書いている最中に毎回出すと手が止まる）
    await clearNotifications(page);
    await placeCaretAfter(frame, "三行目あ");
    await page.keyboard.insertText("い");
    await page.keyboard.press("ControlOrMeta+KeyS");
    await waitUntil(async () => (await readFile(file, "utf8")).includes("三行目あい"), "2回目に打った字がファイルに入る");
    await holdsFor(
      async () => !(await notificationTexts(page)).some((text) => text.includes(UNCLOSED_NOTICE)),
      "同じ場所の閉じ忘れは、2回目の保存では知らせない"
    );
  });
});
