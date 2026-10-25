/**
 * はじめの案内の段の一覧で、行の右のチェックのボタン（「この段は済んでいる／飛ばす」）を押すと、
 * 操作は起きずに「飛ばした」の印が付いて一覧に戻り、全部の段に印が付くと説明文が変わり、
 * Esc で終わって、開き直すと印が消えている（画面の自動テスト、設計書6.90.7・6.113）。
 *
 * 実機確認リスト 0.99.20 の3件を 2026-10-11 に移した（作者の指示「機械でできる実機確認」）。
 * 印の流れそのもの（開いた段・飛ばした段が戻った一覧へ渡る、開き直すと消える）は単体テスト
 * `core/tutorialFlow.test.ts` が見ている。ここでは**本物の選ぶ画面の行のボタン**を押す。
 * 段を開いて「開いた」が付く流れは `tutorialResumeNoLoop.test.ts` が見ている。
 *
 * AI は呼ばない（作家タイプ診断もはじめの案内も、AI を使わない）。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickRows, quickPickTitle, waitForQuickPick } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const STEP_TITLE = "はじめの案内：続きを書く";
const SKIP_TOOLTIP = "この段は済んでいる／飛ばす";
const ALL_MARKED = "全部の段に印が付きました。終えるときは「案内を終える」を選んでください";

/** 作品を登録済みの人の答え（「続きを書く」が出る）。`tutorialResumeNoLoop.test.ts` と同じ */
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

const ROWS = ".quick-input-widget .quick-input-list .monaco-list-row";

/** 行の右のボタン（飛ばす）を持つ行＝段の行の名前 */
async function stepRowLabels(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ rows, tooltip }) =>
      Array.from(document.querySelectorAll(rows))
        .filter((row) => row.querySelector(`[title="${tooltip}"], [aria-label="${tooltip}"]`) !== null)
        .map((row) => (row.querySelector(".label-name")?.textContent ?? "").trim()),
    { rows: ROWS, tooltip: SKIP_TOOLTIP }
  );
}

/** 名前に `label` を含む段の行の、右のボタンを押す（ボタンは行に指を載せたときに出る） */
async function pressSkip(page: Page, label: string): Promise<void> {
  const row = page.locator(ROWS, { hasText: label }).first();
  await row.hover();
  await row.locator(`[title="${SKIP_TOOLTIP}"], [aria-label="${SKIP_TOOLTIP}"]`).first().click({ force: true });
}

async function descriptionOf(page: Page, label: string): Promise<string> {
  return (await quickPickRows(page)).find((row) => row.label.includes(label))?.description ?? "";
}

async function placeholder(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector(".quick-input-widget .quick-input-box input") as HTMLInputElement | null)?.placeholder ?? ""
  );
}

async function resumePapers(workFolder: string): Promise<string[]> {
  const names = await readdir(path.join(workFolder, ".aiwriter", "generated")).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith("執筆再開_"));
}

async function openStepList(page: Page): Promise<void> {
  await runCommand(page, "作家タイプ診断（はじめの案内）");
  await waitForQuickPick(page, "作家タイプ診断");
  await pickQuickPickRow(page, "はじめの案内をもう一度見る");
  await waitForQuickPick(page, "はじめの案内");
  await pickQuickPickRow(page, "続きを書く");
  await waitForQuickPick(page, STEP_TITLE, 20_000);
}

test("段の行の右のボタンで「飛ばした」が付いて一覧に戻り、全部に印が付くと説明文が変わり、Esc で終わって、開き直すと印は消えている", async () => {
  await withVsCode(
    "はじめの案内の飛ばす印",
    [{ name: EPISODE, text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const { page, workFolder } = session;
      await openStepList(page);

      const steps = await stepRowLabels(page);
      expect(steps.length, "段の行（右に飛ばすボタンのある行）がありません").toBeGreaterThan(0);
      expect(steps.some((label) => label.includes("再開用資料"))).toBe(true);
      expect(await placeholder(page)).not.toBe(ALL_MARKED);

      // 1. 「執筆を再開」を飛ばす：操作は起きず（紙ができない）、同じ一覧に「飛ばした」が付く
      await pressSkip(page, "再開用資料");
      await waitUntil(
        async () => (await quickPickTitle(page)) === STEP_TITLE && (await descriptionOf(page, "再開用資料")).includes("飛ばした"),
        "一覧に戻り、「執筆を再開」に「飛ばした」が付く",
        15_000
      );
      await holdsFor(async () => (await resumePapers(workFolder)).length === 0, "飛ばした段の操作が起きていない（執筆再開の紙が無い）", 3_000);

      // 2. 残りの段も全部飛ばすと、説明文が「全部の段に印が付きました…」に変わる
      for (const label of steps.filter((name) => !name.includes("再開用資料"))) {
        await pressSkip(page, label);
        await waitUntil(async () => (await descriptionOf(page, label)).includes("飛ばした"), `「${label}」に「飛ばした」が付く`, 15_000);
      }
      await waitUntil(async () => (await placeholder(page)) === ALL_MARKED, "説明文が「全部の段に印が付きました…」に変わる", 10_000);

      // 3. Esc で終わる（一覧が閉じ、出し直されない）
      await page.keyboard.press("Escape");
      await holdsFor(async () => (await quickPickTitle(page)) === undefined, "Esc のあと一覧が出ていない", 3_000);

      // 4. もう一度開くと、印は消えている
      await openStepList(page);
      for (const label of steps) {
        expect(await descriptionOf(page, label), `開き直しても「${label}」に印が残っています`).not.toMatch(/飛ばした|開いた/);
      }
      expect(await placeholder(page)).not.toBe(ALL_MARKED);
      await page.keyboard.press("Escape");
    },
    { globalState: { "novelai.writerProfile": WRITER_PROFILE } }
  );
});
