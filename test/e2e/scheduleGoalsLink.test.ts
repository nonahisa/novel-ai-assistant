/**
 * スケジュールの画面から作品目標設定を開く（画面の自動テスト、設計書6.111.6・6.113。実機確認リスト 0.122.0 の
 * 374 行を機械へ移した。作者の判断 2026-11-02「案内だけでは開く道が無い」）。
 *
 * 作品目標設定に応募先（公募）がある作品では、スケジュールの画面にその応募先から出した公募のスケジュールが並ぶ。
 * その見出しを押すと、詳細に「直すときは作品目標設定で。」の案内と［作品目標設定を開く］が出て、押すと
 * **その作品の**作品目標設定が、作品を訊かずに開く（作品を2つ登録しておき、作品を選ぶ画面が出ないことを見る）。
 *
 * **AI は呼ばない。** 作品目標（`.aiwriter/goals.json`）は起こす前に製品の形で置く。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { emptyWorkGoals, type WorkGoals } from "../../src/models/workGoals";
import { dayKey, scheduleFrame } from "./support/scheduleFixture";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, quickInputWaitContext, quickPickTitle } from "./support/workbenchDom";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const CONTEST = "画面テスト新人賞";

test("作品目標設定の応募先から出したスケジュールの見出しを押すと、案内の下に［作品目標設定を開く］が出て、押すとその作品の作品目標設定が作品を訊かずに開く", async () => {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  await withVsCode(
    "スケジュールから作品目標設定",
    [{ name: "001_はじまり.txt", text: "一行目の文。\n" }],
    async (session) => {
      const { page } = session;
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);

      await runCommand(page, "スケジュール");
      let frame: Frame | undefined;
      await waitUntil(async () => (frame = await scheduleFrame(page)) !== undefined, "スケジュール画面が開く", 30_000);
      if (!frame) throw new Error("スケジュール画面の面が見つかりません");
      const board = frame;
      await waitUntil(async () => (await board.locator(".lane .bar").count()) > 0, "応募先から出した段の帯が描かれる", 15_000);
      /*
        **項目の文との違い**：段の帯を押すと開くのは「段の詳細」（期日・日数など）で、案内と［作品目標設定を開く］は
        スケジュールの見出し（帯の列の上の「画面テスト新人賞」。吹き出し「押すと詳細」）を押したときの詳細に出る
      */
      await board.locator(".lane-head", { hasText: CONTEST }).first().click();
      await waitUntil(async () => (await board.locator("#detail.open").count()) === 1, "スケジュールの詳細が開く", 10_000);
      const detail = (await board.locator("#detail").innerText()).replace(/\s+/g, " ");
      expect(detail, `詳細：${detail}`).toContain("直すときは作品目標設定で。");
      expect(detail, `詳細に応募先の名前がありません：${detail}`).toContain(CONTEST);
      const open = board.locator("#detail .buttons button", { hasText: "作品目標設定を開く" }).first();
      expect(await open.count(), `詳細に［作品目標設定を開く］がありません：${detail}`).toBe(1);
      await open.click();

      let title = "";
      await waitUntil(
        async () => {
          title = (await quickPickTitle(page)) ?? "";
          return title !== "";
        },
        "［作品目標設定を開く］で作品目標設定の画面が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });
      expect(title, "作品が2つあるのに、作品を訊かれました").not.toBe("作品を選択");
      // 押した見出しの作品（画面テストの作品）の作品目標設定（題は「「〈作品名〉」の目標」。features/setWorkGoals.ts）
      expect(title, `作品目標設定の画面の題：${title}`).toBe(`「${E2E_WORK_TITLE}」の目標`);
      await page.keyboard.press("Escape");
    },
    {
      keybindings: [registerOther],
      prepareWork: async ({ workFolder }) => {
        const goals: WorkGoals = {
          ...emptyWorkGoals(),
          contest: { name: CONTEST, url: null, deadline: dayKey(120), minChars: null, maxChars: 100_000, dailyGoal: null },
        };
        await mkdir(path.join(workFolder, ".aiwriter"), { recursive: true });
        await writeFile(path.join(workFolder, ".aiwriter", "goals.json"), `${JSON.stringify(goals, null, 2)}\n`, "utf8");
        const other = path.join(path.dirname(workFolder), OTHER_TITLE);
        await mkdir(path.join(other, "本文"), { recursive: true });
        await writeFile(path.join(other, "本文", "001_別の話.txt"), "　別の作品の本文。\n", "utf8");
        registerOther.args = { folderPath: other, title: OTHER_TITLE };
      },
    }
  );
}, 300_000);
