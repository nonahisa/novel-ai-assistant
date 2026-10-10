/**
 * 話を1つ挿入して、「名前の変更だけを独立したコミットにしますか？」で「コミットする」を押すと、
 * 失敗の知らせが出ずにコミットが1つだけ増え、そのコミットが名前の変更だけになる
 * （画面の自動テスト、設計書6.67.1・6.113）。
 *
 * 実機確認リスト 0.89.1 の項目を機械へ移したもの。作者の本作（219話）の確認用コピーでは
 * なく、本物の git の置き場にした作り物の作品（4話）で押す。命令の長さの上限（219話・日本語名）は
 * 単体テスト（`episodeRenumberShared.test.ts`・`gitPathArgs.test.ts`）が見ているので、
 * ここで見るのは**押した道筋と、コミットの中身**：
 *
 * - 第2話を右クリック「この話の前に挿入」→ サブタイトル → 「付け替える」→「コミットする」
 * - 失敗の知らせ（「名前だけのコミットを…できませんでした」）が出ない
 * - コミットが1つだけ増える（最初の記録 → 1つ）
 * - そのコミットは第2話以降の名前の変更（R）だけで、新しく作った話（A）も別の変更（M）も入らない
 *   （作業木に残る新しい話は未記録のまま）
 *
 * GitHub は呼ばない（送り先の無い置き場）。**AI は呼ばない。**
 */
import { expect, test } from "vitest";
import { git, initRepoWithFirstCommit } from "./support/gitFixture";
import { answerInput, waitForQuickInput } from "./support/quickInput";
import { SIDEBAR_LAUNCH, treeContextMenu, treeRowLabels } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, pressDialogButton, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
  { name: "第3話_山場.txt", text: "三話の本文。\n" },
  { name: "第4話_おわり.txt", text: "四話の本文。\n" },
];

test("話を挿入して「コミットする」を押すと、失敗の知らせが出ずにコミットが1つ増え、名前の変更だけが記録される", async () => {
  await withVsCode(
    "挿入と名前だけのコミット",
    EPISODES,
    async (session) => {
      const { page } = session;
      // 作品の行は［記録待ち］が付くと名前が題で始まらないので、左の列だけ出して、行は話の名前で探す
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      const workRow = page.locator(`.monaco-list-row[aria-expanded][aria-label*="${E2E_WORK_TITLE}"]`).first();
      await waitUntil(async () => (await workRow.count()) > 0, "作品の行が出る");
      if ((await workRow.getAttribute("aria-expanded")) !== "true") await workRow.click();
      await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第4話")), "作品の下に話が並ぶ");

      const before = (await git(session.workFolder, ["rev-list", "--count", "HEAD"])).trim();
      expect(before).toBe("1");

      // 第2話の前に挿入する
      await treeContextMenu(page, "第2話", "この話の前に挿入");
      /*
        ノートPC（1.141.0、2026-10-10）でだけ、ここで15秒待って落ちた（こちらの機械では通常の窓でも
        1024x640 でも通る。1.138.0 のノートPCでは通った回もある）。製品が断りの知らせを出して
        止まったのか、品書きの押下が届かなかったのかを次の回で分けられるよう、落ちたときに
        出ている知らせと確認の窓を添える
      */
      await waitForQuickInput(page, "この話の前に挿入", 30_000).catch(async (error: unknown) => {
        const toasts = await page.locator(".notification-toast").allInnerTexts().catch(() => [] as string[]);
        throw new Error(`${String(error)}（出ている知らせ：${JSON.stringify(toasts)}／確認の窓：${(await dialogText(page)) ?? "なし"}）`);
      });
      await answerInput(page, "割り込み");

      // 付け替えの確認 → 付け替える
      await waitUntil(async () => ((await dialogText(page)) ?? "").includes("話数を付け替えます"), "付け替えの確認の窓が出る", 20_000);
      await pressDialogButton(page, "付け替える");

      // 名前だけのコミットの確認 → コミットする
      await waitUntil(
        async () => ((await dialogText(page)) ?? "").includes("名前の変更だけを独立したコミットにしますか？"),
        "名前だけのコミットの確認の窓が出る",
        20_000
      );
      await pressDialogButton(page, "コミットする");

      // コミットが1つだけ増える
      await waitUntil(async () => (await git(session.workFolder, ["rev-list", "--count", "HEAD"])).trim() === "2", "コミットが1つ増える", 20_000);
      await holdsFor(async () => (await git(session.workFolder, ["rev-list", "--count", "HEAD"])).trim() === "2", "コミットが2つ以上に増えない", 2_000);

      // そのコミットは名前の変更（R）だけ。新しい話（A）も別の変更（M）も入らない
      const changes = (await git(session.workFolder, ["-c", "core.quotepath=false", "show", "--name-status", "--format=", "-M", "HEAD"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      expect(changes.length, `コミットの中身：${changes.join(" / ")}`).toBe(3);
      expect(changes.every((line) => line.startsWith("R")), `名前の変更だけのはず：${changes.join(" / ")}`).toBe(true);
      expect(changes.join("\n")).toContain("第3話_つづき.txt");

      // 新しい話は作られていて、記録には入っていない（作業木に未記録で残る）
      const status = await git(session.workFolder, ["-c", "core.quotepath=false", "status", "--porcelain", "--", "本文"]);
      expect(status).toContain("割り込み");

      // 失敗の知らせが出ていない（右下の知らせに「できませんでした」が無い）
      const notices = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".notification-toast .notification-list-item-message")).map((item) => item.textContent ?? "")
      );
      expect(notices.join("\n")).not.toContain("できませんでした");
    },
    {
      ...SIDEBAR_LAUNCH,
      prepareWork: async ({ workFolder }) => {
        await initRepoWithFirstCommit(workFolder);
      },
    }
  );
}, 180_000);
