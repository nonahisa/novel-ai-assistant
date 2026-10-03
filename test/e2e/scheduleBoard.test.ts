/**
 * スケジュール画面（画面の自動テスト、設計書6.111・6.113）。
 *
 * 実機確認リスト 0.82.4〜0.83.13 の節の項目を機械へ移したもの（2026-10-04）：
 * - 「執筆データ › 作品目標設定」から「スケジュールを開く」で画面が開き、締切・発売日から
 *   段取りが**逆算されて、時間の順に並ぶ**（自費出版の例。表紙は推敲と同時に進める）
 * - 段を押すと**期日・日数・状態・メモを直せ、段の追加・並べ替え・削除ができる**
 *   （結果は `設定/スケジュール.json` を読んで見る）
 *
 * 逆算の中身（日付の計算）は単体テスト（`core/schedulePlan.test.ts`・`scheduleBoard.test.ts`）が見ている。
 * ここで見るのは**本物の画面で押したときの道筋と、描かれたものの並び**である。見た目の良し悪しは見ていない。
 * 日付は今日からの日数で組む（画面の「今日」は拡張機能の側の時計で決まり、動かせない）。**AI は呼ばない。**
 */
import { expect, test } from "vitest";
import {
  dayKey,
  drawnBars,
  readScheduleFile,
  schedule,
  scheduleFrame,
  selfPublishSteps,
  writeScheduleFile,
} from "./support/scheduleFixture";
import { clearNotifications, pickQuickPickRow } from "./support/workbenchDom";
import { runCommand, waitForQuickInput } from "./support/quickInput";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import type { Frame } from "playwright-core";

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };
const LAUNCH_DAYS = 150;

async function openSchedule(session: E2ESession): Promise<Frame> {
  const { page } = session;
  // 作品目標設定の選択肢から「スケジュールを開く」を押す（作者の道順）
  await runCommand(page, "作品目標設定");
  await waitForQuickInput(page, "目標");
  await pickQuickPickRow(page, "スケジュールを開く");
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await scheduleFrame(page)) !== undefined, "スケジュール画面が開く", 30_000);
  if (!frame) throw new Error("スケジュール画面の面が見つかりません");
  const found = frame;
  await waitUntil(async () => (await found.locator(".lane .bar").count()) > 0, "段の帯が描かれる", 15_000);
  return found;
}

test("作品目標設定からスケジュールを開くと、自費出版の段が時間の順に並び、表紙は推敲と同時に進み、発売日が示される", async () => {
  await withVsCode(
    "スケジュールの並び",
    [EPISODE],
    async (session) => {
      const frame = await openSchedule(session);
      const bars = await drawnBars(frame);
      expect(bars.map((bar) => bar.label)).toEqual([
        "執筆（初稿まで）",
        "推敲",
        "表紙の用意",
        "最終校正",
        "入稿（EPUB・PDF）",
        "配信の申請（ストアの審査）",
      ]);
      const by = (label: string) => {
        const found = bars.find((bar) => bar.label === label);
        if (!found) throw new Error(`段「${label}」が描かれていません`);
        return found;
      };
      // 時間は下へ進む：前の段が終わってから次の段が始まる
      expect(by("執筆（初稿まで）").top).toBeLessThan(by("推敲").top);
      // 表紙は推敲と同時に進める：**同じ日に終わり**（表紙は14日、推敲は10日なので表紙のほうが早く始まる）、
      // レーンを分け合って横に並ぶ（表紙が右）
      const end = (bar: { top: number; height: number }) => bar.top + bar.height;
      expect(Math.abs(end(by("表紙の用意")) - end(by("推敲"))), "表紙と推敲の終わりの高さ").toBeLessThan(2);
      expect(by("表紙の用意").top, "表紙は推敲より早く始まる（日数が長い）").toBeLessThan(by("推敲").top);
      expect(by("表紙の用意").width, "並行の段はレーンの半分ほどの幅").toBeLessThan(by("最終校正").width * 0.7);
      expect(by("表紙の用意").left, "表紙は推敲の右に並ぶ").toBeGreaterThan(by("推敲").left);
      // 表紙は人に頼む段なので、帯の左の縁が破線（`.others`）
      expect(by("表紙の用意").classes).toContain("others");
      expect(by("推敲").classes).not.toContain("others");
      // 同時に進める段のあとから、最終校正が始まる
      expect(by("最終校正").top, "最終校正は並行の段が終わってから始まる").toBeGreaterThanOrEqual(end(by("推敲")) - 2);
      expect(by("入稿（EPUB・PDF）").top).toBeGreaterThan(by("最終校正").top);
      expect(by("配信の申請（ストアの審査）").top).toBeGreaterThan(by("入稿（EPUB・PDF）").top);
      // 発売日（締切）の印
      const milestone = (await frame.locator(".milestone").first().innerText()).trim();
      const [, month, day] = dayKey(LAUNCH_DAYS).split("-").map(Number);
      expect(milestone).toBe(`◆ 発売日 ${month}/${day}`);
    },
    {
      prepareWork: async ({ workFolder }) => {
        await writeScheduleFile(workFolder, [
          schedule({
            id: "sch-1",
            kind: "selfPublish",
            name: "Kindle版",
            milestone: dayKey(LAUNCH_DAYS),
            targetChars: 80_000,
            steps: selfPublishSteps(),
          }),
        ]);
      },
    }
  );
});

test("段を押すと期日・日数・状態・メモを直して保存でき、段を足し、後ろへ動かし、消せる（ファイルで見る）", async () => {
  await withVsCode(
    "スケジュールの編集",
    [EPISODE],
    async (session) => {
      const { workFolder } = session;
      const frame = await openSchedule(session);
      const due = dayKey(40);

      // 推敲の段を押すと、右に詳細が開く
      const reviseBar = () => frame.locator(".lane .bar").filter({ has: frame.locator("xpath=.") }).nth(1);
      await reviseBar().click();
      await waitUntil(async () => (await frame.locator("#detail.open").count()) === 1, "詳細が開く", 10_000);
      const field = (label: string) => frame.locator("#detail .row", { hasText: label });
      await field("段の名前").first().locator("input").fill("推敲（直した）");
      await field("期日").locator("input").fill(due);
      await field("日数").first().locator("input").fill("12");
      await field("状態").locator("select").selectOption("doing");
      await field("メモ").locator("textarea").fill("見直しの観点を決める");
      await frame.locator("#detail .buttons button.primary", { hasText: "保存" }).click();

      const readSteps = async () => (await readScheduleFile(workFolder)).schedules[0]?.steps ?? [];
      await waitUntil(async () => (await readSteps()).some((step) => step.label === "推敲（直した）"), "保存がファイルに入る", 15_000);
      const saved = (await readSteps()).find((step) => step.id === "sp-revise");
      expect(saved?.label).toBe("推敲（直した）");
      expect(saved?.due, "手で入れた期日").toBe(due);
      expect(saved?.days).toBe(12);
      expect(saved?.status).toBe("doing");
      expect(saved?.note).toBe("見直しの観点を決める");
      // 期日を入れた段の帯は、描かれた字に（期日）が付く
      await waitUntil(
        async () => (await frame.locator(".lane .bar", { hasText: "（期日）" }).count()) >= 1,
        "期日つきの段に（期日）が付く",
        10_000
      );

      // 段を足す：この段の後ろに「追加の段」
      const addName = field("段の名前").nth(1).locator("input");
      await addName.fill("追加の段");
      await field("日数").nth(1).locator("input").fill("5");
      await frame.locator("#detail .buttons button", { hasText: "足す" }).click();
      await waitUntil(async () => (await readSteps()).some((step) => step.label === "追加の段"), "足した段がファイルに入る", 15_000);
      let order = (await readSteps()).map((step) => step.label);
      expect(order.indexOf("追加の段"), "選んだ段の直後に入る").toBe(order.indexOf("推敲（直した）") + 1);
      expect(order).toHaveLength(7);

      // 足した段が選ばれる。後ろへ動かすと、足した段が表紙の後ろへ移る
      await clearNotifications(session.page);
      await frame.locator("#detail h2", { hasText: "追加の段" }).waitFor({ timeout: 10_000 });
      await frame.locator("#detail .buttons button", { hasText: "後ろへ" }).first().click();
      await waitUntil(
        async () => {
          const labels = (await readSteps()).map((step) => step.label);
          return labels.indexOf("追加の段") > labels.indexOf("表紙の用意");
        },
        "後ろへ動かした順がファイルに入る",
        15_000
      );
      // 選ばれたままの段（追加の段）を消す
      await frame.locator("#detail .buttons button", { hasText: "段を消す" }).click();
      // 「この段を消しますか？ 状態とメモも一緒に消えます。」の確認（選ぶ画面）で「消す」を選ぶ
      await waitForQuickInput(session.page, "作品：");
      await pickQuickPickRow(session.page, "消す");
      await waitUntil(async () => !(await readSteps()).some((step) => step.label === "追加の段"), "段を消した結果がファイルに入る", 15_000);
      order = (await readSteps()).map((step) => step.label);
      expect(order).toHaveLength(6);
      expect(order, "直した推敲は残っている").toContain("推敲（直した）");
    },
    {
      prepareWork: async ({ workFolder }) => {
        await writeScheduleFile(workFolder, [
          schedule({
            id: "sch-1",
            kind: "selfPublish",
            name: "Kindle版",
            milestone: dayKey(LAUNCH_DAYS),
            targetChars: 80_000,
            steps: selfPublishSteps(),
          }),
        ]);
      },
    }
  );
});
