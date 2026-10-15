/**
 * ヘルプの「場面別案内」で場面を選ぶと、押す場所に「▶」の印が付いて選ばれ、
 * 先の段の操作を押すと印がその次の段へ移る（画面の自動テスト、設計書6.104・6.113。
 * 実機確認リスト 840 行〔0.81.3〕の残り「押す場所が順に光る動き」を、2026-10-15 の仕分け
 * 〔docs/measurements/2026-10-15-field-triage-hands.md〕で移した）。
 *
 * 「光る」の中身は `features/actionSpotlight.ts` のとおり、**行を選んで見せる**ことと、
 * **「▶」の印**（`views/actionDecorations.ts` の `SPOTLIGHT_BADGE`。ファイルの飾りの札として
 * 行の後ろに描かれる）。目立つかどうかは見た目の判断なので見ない。見るのは、
 * - 場面を選ぶと、1段目の操作の行に「▶」が付き、その行が選ばれている
 * - 相談パネルに案内の札が出て、1段目の操作の名前が書かれている
 * - 先の段（2段目）の操作を押して終えると、印が3段目の行へ移り、1段目の行からは外れる
 *   （`core/guidedTour.ts` の「先の段の操作は、そこまで飛ばして進む」）
 * - 札も3段目の操作の名前になる
 *
 * 場面は「推敲して仕上げる」（校正一括実行 → 指摘対象外管理 → 冒頭診断）。1段目は AI を
 * 呼ぶので押さず、AI を呼ばない2段目（指摘対象外管理）を押して進める。**AI は呼ばない。**
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH, showSidebar, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts, pickQuickPickRow, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const SCENE = "推敲して仕上げる";
/** 段の操作の名前（package.json のコマンドの題。簡単ステップメニュー・詳細メニューの行もこの名前で始まる） */
const STEP1 = "校正一括実行";
const STEP2 = "指摘対象外管理";
const STEP3 = "冒頭診断";

/** 左の列の行のうち、「▶」の印が付いている行の名前と、選ばれているか */
async function spotlightedRows(page: Page): Promise<Array<{ label: string; selected: boolean }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".monaco-list-row"))
      .filter((row) =>
        Array.from(row.querySelectorAll<HTMLElement>("*")).some((el) => {
          // 飾りの札は擬似要素の content に入る（DOM の字にはならない）
          const after = getComputedStyle(el, "::after").content;
          return after.includes("▶") || (el.textContent ?? "").includes("▶");
        })
      )
      .map((row) => ({ label: row.getAttribute("aria-label") ?? "", selected: row.getAttribute("aria-selected") === "true" }))
  );
}

/** 相談パネルの面（入力欄と「本文へ」の口がある iframe） */
async function chatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null).catch(() => false);
    if (ok) return frame;
  }
  return undefined;
}

async function chatText(page: Page): Promise<string> {
  const frame = await chatFrame(page);
  if (!frame) return "";
  return (await frame.evaluate(() => document.body.innerText).catch(() => "")).replace(/\s+/g, " ");
}

/** 失敗の文へ添える様子 */
async function describeState(page: Page): Promise<string> {
  return (
    `（印の付いた行：${JSON.stringify(await spotlightedRows(page).catch(() => []))}` +
    `／選ぶ画面：${await quickPickTitle(page).catch(() => undefined)}` +
    `／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}` +
    `／相談パネルの末尾：${(await chatText(page).catch(() => "")).slice(-400)}）`
  );
}

test("場面別案内で「推敲して仕上げる」を選ぶと1段目の行に▶が付いて選ばれ、2段目の操作を押して終えると▶と札が3段目へ移る", async () => {
  await withVsCode(
    "場面別案内の光る順",
    [{ name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await clearNotifications(page);

      await runCommand(page, "場面別案内");
      await waitUntil(async () => (await quickPickTitle(page)) !== undefined, "場面を選ぶ画面が出る", 20_000);
      const scenes = await quickPickRows(page);
      expect(
        scenes.some((row) => row.label.includes(SCENE)),
        `場面の一覧：${JSON.stringify(scenes.map((row) => row.label))}`
      ).toBe(true);
      await pickQuickPickRow(page, scenes.find((row) => row.label.includes(SCENE))?.label ?? SCENE);

      /* ── 1段目の行に ▶ が付き、選ばれている。札にも1段目の名前 ── */
      await waitUntil(
        async () => (await spotlightedRows(page)).some((row) => row.label.startsWith(STEP1)),
        `「${STEP1}」の行に▶が付く`,
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page)}`);
      });
      const first = await spotlightedRows(page);
      expect(first.length, `▶の付いた行が1つでない${await describeState(page)}`).toBe(1);
      await waitUntil(async () => (await spotlightedRows(page))[0]?.selected === true, `「${STEP1}」の行が選ばれている`, 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}${await describeState(page)}`);
        }
      );
      await waitUntil(async () => (await chatText(page)).includes(STEP1), `相談パネルの札に「${STEP1}」が出る`, 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page)}`);
      });

      /* ── 2段目（先の段）の操作を押して終える。AI を呼ばない ── */
      await runCommand(page, STEP2);
      // 作品を訊かれたら見本の作品を選ぶ。そのほかの選ぶ画面（直さない語の一覧）は Esc で閉じる
      for (let round = 0; round < 6; round++) {
        await page.waitForTimeout(1000);
        if ((await spotlightedRows(page)).some((row) => row.label.startsWith(STEP3))) break;
        const title = await quickPickTitle(page);
        if (title === undefined) continue;
        const rows = await quickPickRows(page);
        const workRow = rows.find((row) => row.label.includes(E2E_WORK_TITLE));
        if (workRow) await pickQuickPickRow(page, workRow.label);
        else await page.keyboard.press("Escape");
      }

      /* ── ▶ は3段目の行へ移り、1段目の行から外れる。札も3段目 ── */
      await waitUntil(
        async () => {
          const rows = await spotlightedRows(page);
          return rows.length === 1 && rows[0].label.startsWith(STEP3);
        },
        `▶が「${STEP3}」の行だけに移る`,
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page)}`);
      });
      await waitUntil(async () => (await spotlightedRows(page))[0]?.selected === true, `「${STEP3}」の行が選ばれている`, 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}${await describeState(page)}`);
        }
      );
      expect(await treeRow(page, STEP3).count(), "3段目の行が左の列に描かれていない").toBeGreaterThan(0);
      await waitUntil(async () => (await chatText(page)).includes(STEP3), `相談パネルの札に「${STEP3}」が出る`, 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(page)}`);
      });
    },
    SIDEBAR_LAUNCH
  );
});
