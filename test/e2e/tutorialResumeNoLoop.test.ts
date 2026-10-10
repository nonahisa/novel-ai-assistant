/**
 * はじめの案内で段を押したあとの流れ（画面の自動テスト、設計書6.90.7・6.113）。
 *
 * 作者の報告（2026-10-10）：はじめの案内で「続きを書く」→「執筆を再開」→作品を選ぶ→
 * また一覧→「執筆を再開」→作品を選ぶ……が終わらない（永久ループ）。執筆再開の紙は
 * 毎回できていたが、直後に段の一覧が前に出るので作者には見えなかった。
 *
 * 見張るのは次のこと（作品は1つ。作品を選ぶ窓は出ないはず）。
 *
 * 1. 「執筆を再開」を押すと、執筆再開の紙が作品の `.aiwriter/generated/` にできる
 * 2. **段の一覧をすぐ出し直さない**（数秒見続けて、一覧が出ないこと）。作品を選ぶ窓も出ない
 * 3. 右下に「…を開きました。」の知らせが出て、［はじめの案内に戻る］［終える］が並ぶ
 * 4. ［はじめの案内に戻る］を押したときだけ、段の一覧へ戻る
 *
 * AI は呼ばない（作家タイプ診断も執筆再開も、AI を使わない）。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickTitle, waitForQuickPick } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const STEP_TITLE = "はじめの案内：続きを書く";

/** 作品を登録済みの人の答え（「続きを書く」が出る）。値は `core/writerStyle.ts` の選択肢 */
const WRITER_PROFILE = {
  style: {
    situation: "have_files",
    plan: "designer",
    revise: "per_episode",
    material: "memo",
    outlet: "serial",
  },
  updatedAt: "2026-10-10T00:00:00.000Z",
};

async function noticeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast")).map((toast) => (toast as HTMLElement).innerText)
  );
}

async function noticeButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast .monaco-button")).map((button) => (button.textContent ?? "").trim())
  );
}

async function resumePapers(workFolder: string): Promise<string[]> {
  const names = await readdir(path.join(workFolder, ".aiwriter", "generated")).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith("執筆再開_"));
}

test("はじめの案内で「執筆を再開」を押すと、一覧を出し直さず知らせを出し、［はじめの案内に戻る］のときだけ一覧へ戻る", async () => {
  await withVsCode(
    "はじめの案内の永久ループ",
    [{ name: EPISODE, text: "　朝の駅は静かだった。改札を抜けて、白い息を吐いた。\n" }],
    async (session) => {
      const { page, workFolder } = session;

      await runCommand(page, "作家タイプ診断（はじめの案内）");
      await waitForQuickPick(page, "作家タイプ診断");
      await pickQuickPickRow(page, "はじめの案内をもう一度見る");

      await waitForQuickPick(page, "はじめの案内");
      await pickQuickPickRow(page, "続きを書く");

      await waitForQuickPick(page, STEP_TITLE, 20_000);
      await pickQuickPickRow(page, "執筆を再開");

      // 1. 紙ができる
      await waitUntil(async () => (await resumePapers(workFolder)).length === 1, "執筆再開の紙ができる", 30_000);

      // 3. 知らせが出て、ボタンが2つ並ぶ
      await waitUntil(
        async () => (await noticeTexts(page)).some((text) => text.includes("を開きました。")),
        "「…を開きました。」の知らせが出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeTexts(page))}）`);
      });
      expect(await noticeButtons(page)).toEqual(["はじめの案内に戻る", "終える"]);

      // 2. 段の一覧も、作品を選ぶ窓も出ない（数秒見続ける）
      await holdsFor(async () => (await quickPickTitle(page)) === undefined, "段のあとに選ぶ画面が出ていない状態", 3_000);

      // 4. ［はじめの案内に戻る］で一覧へ戻る。紙は増えない（段を勝手に動かさない）
      await page.locator(".notification-toast .monaco-button", { hasText: "はじめの案内に戻る" }).first().click();
      await waitForQuickPick(page, STEP_TITLE, 15_000);
      expect(await resumePapers(workFolder)).toHaveLength(1);
    },
    { globalState: { "novelai.writerProfile": WRITER_PROFILE } }
  );
});
