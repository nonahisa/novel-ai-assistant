/**
 * 作品一覧の話の右クリック「この話を削除」で、実際に消すところ（画面の自動テスト、設計書6.67・6.113。
 * 実機確認リスト 0.122.0 の 378 行の残り。作者の判断 2026-11-02「同じことをする入口は1つにして、押してから訊く」）。
 *
 * 右クリックに「この話を削除」が1つだけ出ること・問いの文と2つの選択肢は menuConsolidation が見ている。
 * ここでは、その先で**本当に消す**：
 *
 * 1. 「話数を詰める」：付け替えの確認（「…を削除し、第2話以降の2件の話数を詰めます。」）で［削除する］を押すと、
 *    第2話のファイルがごみ箱へ移り、あとの話の番号が1つずつ繰り上がる（第3話→第2話、第4話→第3話。名前の後ろはそのまま）
 * 2. 「詰めない（ファイルだけ消す）」：その話のファイルだけが消え、あとの話の番号はそのまま（番号は空いたまま）
 *
 * **消したファイルは作者の機械のごみ箱へ入る**（製品は `useTrash: true`）。見本の小さなファイル（一時フォルダーの
 * 作品の話）が1回走るごとに2つ、ごみ箱に残る。ごみ箱の中は見ない（作者のごみ箱を読み書きしない）。
 *
 * **AI は呼ばない。**
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { EPISODE_DELETE_CHOICES } from "../../src/core/episodeDeleteChoice";
import { SIDEBAR_LAUNCH, collapseSidebarPane, expandTreeRow, showSidebar, treeContextMenu, treeRow, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText, pressDialogButton, quickInputWaitContext } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
  { name: "第3話_山場.txt", text: "三話の本文。\n" },
  { name: "第4話_おわり.txt", text: "四話の本文。\n" },
];

/** 本文フォルダーの話のファイル（書き込み途中の一時ファイルは拾わない） */
async function episodeFiles(session: E2ESession): Promise<string[]> {
  return (await readdir(session.manuscriptFolder).catch(() => [] as string[])).filter((name) => name.endsWith(".txt") && !name.includes(".novelai-")).sort();
}

async function fileText(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 確認の窓（画面の中に描いたもの）の文が `needle` を含むまで待つ。落ちたらいまの窓を添える */
async function waitDialog(page: Page, needle: string, label: string): Promise<string> {
  let text = "";
  await waitUntil(async () => (text = (await dialogText(page)) ?? "").includes(needle), label, 15_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}）${await quickInputWaitContext(page)}`);
  });
  return text;
}

test("話の右クリック「この話を削除」で［話数を詰める］→［削除する］を押すとその話が消えてあとの話の番号が繰り上がり、［詰めない（ファイルだけ消す）］ではその話のファイルだけが消えて番号はそのまま", async () => {
  await withVsCode(
    "この話を削除で実際に消す",
    EPISODES,
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await collapseSidebarPane(page, "AIに相談");
      await expandTreeRow(page, E2E_WORK_TITLE);
      await waitTreeSettled(page);

      /* ── 1. 第2話を「話数を詰める」で消す ── */
      await treeContextMenu(page, "第2話", "この話を削除");
      await waitDialog(page, "あとの話の話数を詰めますか", "「話数を詰めますか」の問いが出る");
      await pressDialogButton(page, EPISODE_DELETE_CHOICES.renumber);
      const confirm = await waitDialog(page, "話数を詰めます", "「話数を詰める」で付け替えの確認が出る");
      expect(confirm, `付け替えの確認：${confirm}`).toContain("第2話_つづき.txt");
      expect(confirm, `付け替えの確認：${confirm}`).toContain("第2話以降の2件");
      await pressDialogButton(page, "削除する");

      const renumbered = ["第1話_はじまり.txt", "第2話_山場.txt", "第3話_おわり.txt"];
      await waitUntil(async () => JSON.stringify(await episodeFiles(session)) === JSON.stringify(renumbered), "第2話が消え、第3話・第4話が1つずつ繰り上がる", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの話：${JSON.stringify(await episodeFiles(session))}／窓：${JSON.stringify(await dialogText(page))}）`);
        }
      );
      // 繰り上がったのは名前だけで、中身は元の話のまま
      expect(await fileText(session, "第2話_山場.txt")).toBe("三話の本文。\n");
      expect(await fileText(session, "第3話_おわり.txt")).toBe("四話の本文。\n");
      // 付け替えのあとに出る知らせ・記録の問い（作品が Git でなければ出ない）を払う
      if ((await dialogText(page)) !== undefined) await page.keyboard.press("Escape");
      await clearNotifications(page);

      /* ── 2. いまの第2話（元の第3話）を「詰めない」で消す ── */
      await waitUntil(async () => (await treeRow(page, "第2話").getAttribute("aria-label"))?.includes("山場") ?? false, "作品一覧の第2話が「山場」に替わる", 20_000);
      await waitTreeSettled(page);
      await treeContextMenu(page, "第2話", "この話を削除");
      const ask = await waitDialog(page, "あとの話の話数を詰めますか", "2回目も「話数を詰めますか」の問いが出る");
      expect(ask, `問いの窓：${ask}`).toContain("第2話_山場.txt");
      await pressDialogButton(page, EPISODE_DELETE_CHOICES.fileOnly);

      await waitUntil(async () => !existsSync(path.join(session.manuscriptFolder, "第2話_山場.txt")), "「詰めない」で第2話のファイルが消える", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの話：${JSON.stringify(await episodeFiles(session))}／窓：${JSON.stringify(await dialogText(page))}）`);
        }
      );
      // あとの話（第3話）の番号はそのまま。遅れて付け替えが走らないことを数秒見る
      await holdsFor(
        async () => JSON.stringify(await episodeFiles(session)) === JSON.stringify(["第1話_はじまり.txt", "第3話_おわり.txt"]),
        "「詰めない」では第3話の番号がそのまま（第2話は空いたまま）",
        3_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの話：${JSON.stringify(await episodeFiles(session))}）`);
      });
      expect(await fileText(session, "第3話_おわり.txt")).toBe("四話の本文。\n");
      expect(await dialogText(page), "「詰めない」なのに付け替えの確認が出ています").toBeUndefined();
    },
    SIDEBAR_LAUNCH
  );
}, 300_000);
