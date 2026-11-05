/**
 * 編集者メニューを上から順に押して、校閲を終えて返すまで進む（画面の自動テスト、設計書5.6.6・6.113。
 * 作者の指示 2026-11-05 夜「編集者用のメニューは専用のものを表示するようにして、上から順番に処理したら
 * 終わるようにしたほうがよさそうです」）。
 *
 * 見張ること：
 * 1. 編集者モードで起こすと、横の枠の一番上に「編集者メニュー」が出て、簡単ステップメニューは出ない。
 *    並びは 作品：〈作品名〉・この作品の編集を終える・作品を足す・状態の行（校閲中の話・置いた提案・
 *    作者の採否・受け取り）・手順1〜7・ヘルプ・作者モードへ戻る
 * 2. 受け取り待ちが無ければ「1」が済み、「2」が次はここ
 * 3. 「2. 校閲する話を選ぶ」を押して範囲を選ぶと、鍵の台帳が書かれ、「2」が済み・「3」が次はここ
 * 4. 「4」の「修正を提案する」で提案を置くと、「4」が済み・「5」が次はここ。状態の行に
 *    「この回 1件（まだ返していません）」
 * 5. 「6. 校閲を終えて作者へ返す」を押して［返す］と、送り先（手元の裸の置き場）へ台帳が届き、
 *    「2」〜「6」が済み、「7」は作者の返事待ち
 * 6. 「7. 作者の採否を見る」を押すと「まだ届いていません」と出る
 *
 * **GitHub は呼ばない。** 作品フォルダーを本物の git の置き場にし、送り先は同じ一時フォルダーの中の
 * 裸の置き場（`addLocalRemote`）。編集用の写しの印（`.aiwriter/editor-share-manifest.json`）を置いて、
 * 登録のときに `.gitignore` が書かれないようにする（写しの `.gitignore` は作者のもの。5.7.5.9）。
 * **AI は呼ばない。**
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { addLocalRemote, git, initRepoWithFirstCommit } from "./support/gitFixture";
import { answerInput, waitForQuickInput } from "./support/quickInput";
import { SIDEBAR_LAUNCH, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  focusTextEditor,
  notificationTexts,
  pressDialogButton,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickOpen,
  quickPickTitle,
  textEditorVisibleText,
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", ""].join("\n");
const PANE = "編集者メニュー";

const STEPS = [
  "1. 作者の最新の原稿を受け取る",
  "2. 校閲する話を選ぶ",
  "3. 機械に探させる",
  "4. 直しを提案する・メモ（意見）を書く",
  "5. 置いた提案を見直す",
  "6. 校閲を終えて作者へ返す",
  "7. 作者の採否を見る",
];

/** 作者の環境で整えられた `.gitignore` の行（`src/core/workRegistry.ts` の `IGNORED_PATHS` の写し。見本なので写してよい） */
const AUTHOR_GITIGNORE = [
  ".aiwriter/cache/",
  ".aiwriter/logs/",
  ".aiwriter/exports/",
  ".aiwriter/generated/",
  ".aiwriter/reports/",
  ".aiwriter/external-access.json",
  ".aiwriter/history/spotlight.jsonl",
  ".aiwriter/ai-instruction-usage.json",
  ".novelai-recovery/",
  "exports/",
];

const LAUNCH: LaunchOptions = {
  settings: {
    ...SIDEBAR_LAUNCH.settings,
    "novelai.mode": "editor",
    "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" },
  },
  keybindings: SIDEBAR_LAUNCH.keybindings,
  prepareWork: async ({ workFolder }) => {
    await mkdir(path.join(workFolder, ".aiwriter"), { recursive: true });
    await writeFile(path.join(workFolder, ".aiwriter", "editor-share-manifest.json"), "{}\n", "utf8");
    /*
      作者の作品から切り出した写しには、作者の環境で拡張機能が整えた `.gitignore` が入っている
      （ログ・キャッシュなどを記録しない。`workRegistry.ts` の `IGNORED_PATHS`）。写しの側では書かないので、
      ここで同じ形を置く。無いと、返したあとに書かれるログが「記録していない変更」に数えられる
    */
    await writeFile(path.join(workFolder, ".gitignore"), `${AUTHOR_GITIGNORE.join("\n")}\n`, "utf8");
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, path.join(path.dirname(path.dirname(workFolder)), "editing-remote.git"));
  },
};

/** 編集者メニューの行（名前と説明）を並びの順に */
async function menuRows(page: Page): Promise<Array<{ label: string; description: string }>> {
  return page.evaluate((title) => {
    const pane = Array.from(document.querySelectorAll(".pane")).find((node) =>
      (node.querySelector(".pane-header")?.textContent ?? "").includes(title)
    );
    if (!pane) return [];
    return Array.from(pane.querySelectorAll(".monaco-list-row"))
      .sort((a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index))
      .map((row) => ({
        label: (row.querySelector(".label-name")?.textContent ?? "").trim(),
        description: (row.querySelector(".label-description")?.textContent ?? "").trim(),
      }));
  }, PANE);
}

async function descriptionOf(page: Page, label: string): Promise<string> {
  return (await menuRows(page)).find((row) => row.label === label)?.description ?? "";
}

/** 手順の行の説明に `word` が出るまで待つ（台帳を書いたあと、読み直して描き直すまでの間がある） */
async function waitMark(page: Page, label: string, word: string, timeoutMs = 20_000): Promise<void> {
  await waitUntil(async () => (await descriptionOf(page, label)).includes(word), `「${label}」が「${word}」になる`, timeoutMs).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（編集者メニューの行：${JSON.stringify(await menuRows(page))}）`);
    }
  );
}

/**
 * 左の列の区画を、見出しの左端（畳みの矢印）を押して畳む。見出しの真ん中を押すと、
 * 指を載せて出たボタン（作品一覧の「保存・同期」など）に当たる（`editorModeMenus.test.ts` と同じ押し方）
 */
async function collapsePane(page: Page, title: string): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const expanded = async () => (await header.getAttribute("aria-expanded")) === "true";
  if (!(await expanded())) return;
  await header.click({ position: { x: 8, y: 10 } });
  await waitUntil(async () => !(await expanded()), `左の列の「${title}」が畳まれる`, 5_000);
}

async function clickRow(page: Page, label: string): Promise<void> {
  const row = page
    .locator(".pane", { has: page.locator(".pane-header", { hasText: PANE }) })
    .locator(".monaco-list-row", { has: page.locator(".label-name", { hasText: label }) })
    .first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
}

test("編集者メニューを上から順に押すと、範囲を選び・提案を置き・作者へ返すまで進み、各手順の印が「済み」「次はここ」に替わる", async () => {
  await withVsCode(
    "編集者メニューを上から順に",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, root, workFolder } = session;
      /*
        左の列を出す（`SIDEBAR_LAUNCH` のキー）。作品一覧の行は「［記録待ち1］…」と頭に印が付く
        （登録で書かれる設定が記録待ちになる）ので、`showSidebar` の「行が作品名で始まる」では待たず、
        編集者メニューの作品の行で待つ
      */
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      await waitUntil(async () => (await menuRows(page)).some((row) => row.label === `作品：${E2E_WORK_TITLE}`), "編集者メニューに作品の行が出る", 20_000);
      // 木は見えている行しか描かないので、ほかの区画を畳んで編集者メニューの背を高くする
      for (const other of ["AIに相談", "詳細メニュー", "作品一覧"]) await collapsePane(page, other);
      // 同期の見張りが最初に状態を読むまで（起動の混み具合で数十秒かかる）、受け取りの印は「まだ」
      await waitMark(page, STEPS[0], "済み", 90_000);

      /* ── 1. 並び ── */
      expect(await page.locator(".pane-header", { hasText: "簡単ステップメニュー" }).count(), "編集者モードで簡単ステップメニューが出ている").toBe(0);
      await waitUntil(async () => (await menuRows(page)).some((row) => row.label === STEPS[6]), "編集者メニューに手順が並ぶ", 20_000);
      const labels = (await menuRows(page)).map((row) => row.label);
      expect(labels[0]).toBe(`作品：${E2E_WORK_TITLE}`);
      expect(labels.slice(1, 3)).toEqual(["この作品の編集を終える", "作品を足す（参加のリンクを貼る）"]);
      expect(labels.slice(3, 7).map((label) => label.split("：")[0])).toEqual(["校閲中の話", "置いた提案", "作者の採否", "受け取り"]);
      expect(labels.slice(7, 14)).toEqual(STEPS);
      expect(labels.slice(14)).toEqual(["ヘルプ", "作者モードへ戻る"]);

      /* ── 2. 受け取り待ちが無ければ1が済み（上で待った）、2が次はここ ── */
      await waitMark(page, STEPS[1], "次はここ");

      /* ── 3. 校閲する話を選ぶ ── */
      await clearNotifications(page);
      await clickRow(page, STEPS[1]);
      // 行が出揃ってから決める（題だけ出て行がまだのときに Enter を押すと、何も選ばずに閉じる）
      await waitForQuickPick(page, "校閲する範囲：始めの話を選びます");
      await pickQuickPickRow(page, EPISODE);
      await waitForQuickPick(page, "校閲する範囲：終わりの話を選びます");
      await pickQuickPickRow(page, EPISODE);
      await waitForQuickPick(page, "何をしているかを、作者へ伝えます");
      await pickQuickPickRow(page, "校閲中");
      await waitUntil(
        async () => (await readFile(path.join(workFolder, ".aiwriter", "locks", "locks.jsonl"), "utf8").catch(() => "")).includes("acquire"),
        "校閲の鍵の台帳に、押さえた記録が入る",
        15_000
      );
      await waitMark(page, STEPS[1], "済み");
      await waitMark(page, STEPS[2], "次はここ");

      /* ── 4. 直しを提案する ── */
      await quickOpen(page, EPISODE);
      await waitUntil(async () => (await textEditorVisibleText(page)).includes("終電を逃した"), "素のテキストエディターに本文が出る", 20_000);
      await focusTextEditor(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("Shift+End");
      await clickRow(page, STEPS[3]);
      await waitUntil(async () => (await treeRow(page, "修正を提案する").count()) > 0, "「4」を開くと「修正を提案する」が並ぶ", 10_000);
      await focusTextEditor(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("Shift+End");
      await clickRow(page, "修正を提案する");
      await waitForQuickInput(page, "修正を提案する（1/2）：修正案", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      await answerInput(page, "　終電を逃した駅のホームに、雨音だけが残っていた。");
      await waitForQuickInput(page, "修正を提案する（2/2）：理由・意見");
      await answerInput(page, "言い方を短く");
      const ledger = path.join(workFolder, ".aiwriter", "proposals", "proposals.jsonl");
      await waitUntil(async () => (await readFile(ledger, "utf8").catch(() => "")).includes("言い方を短く"), "提案の台帳に置いた提案が入る", 15_000);
      // 本文は書き換わらない
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT);
      await waitMark(page, STEPS[3], "済み");
      await waitMark(page, STEPS[4], "次はここ");
      await waitUntil(
        async () => (await menuRows(page)).some((row) => row.label === "置いた提案：この回 1件（まだ返していません）"),
        "状態の行に「この回 1件（まだ返していません）」が出る",
        15_000
      );

      /* ── 5. 校閲を終えて作者へ返す ── */
      await clearNotifications(page);
      await clickRow(page, STEPS[5]);
      let dialog = "";
      await waitUntil(async () => (dialog = (await dialogText(page)) ?? "").includes("校閲を終えて、作者へ返します"), "返す前の確認の窓が出る", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(dialog)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
        }
      );
      await pressDialogButton(page, "返す");
      const remote = path.join(root, "editing-remote.git");
      await waitUntil(
        async () => (await git(remote, ["show", "main:.aiwriter/proposals/proposals.jsonl"]).catch(() => "")).includes("言い方を短く"),
        "送り先に置いた提案が届く",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      for (const step of STEPS.slice(1, 6)) await waitMark(page, step, "済み");
      await waitMark(page, STEPS[6], "返事待ち");

      /* ── 6. 作者の採否を見る ── */
      await clearNotifications(page);
      await clickRow(page, STEPS[6]);
      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("作者の採否は、まだ届いていません")),
        "採否がまだ届いていないと出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／選ぶ画面：${JSON.stringify(await quickPickTitle(page))}）`);
      });
    },
    LAUNCH
  );
}, 300_000);
