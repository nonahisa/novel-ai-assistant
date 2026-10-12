/**
 * バックアップを選ぶ窓（ファイル選択）：章立て取込の一覧と、前に選んだ場所を覚えること
 * （画面の自動テスト、設計書6.66.6・6.113。実機確認リスト 722・974 行を、仕分け 2026-10-12 の束 E13 として
 * 移した。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * **ファイル選択は VS Code の簡易の窓（`files.simpleDialog.enable`）で開く。** 既定の Windows では OS の
 * ダイアログになり、Playwright から読めないうえ、作者の画面の前面に出る。簡易の窓は上に出る選ぶ画面の形で、
 * 入力欄に今いるフォルダーの道が入っている（＝既定の場所が字で読める）。**OS のダイアログの見た目そのもの
 * は見ていない**（作者の手に残すなら、それだけ）。
 *
 * 1. 分け済みの作品（話ごとのファイル）を右クリック「章立て取込（バックアップから）」→「バックアップのファイルから」
 *    → 窓でなろうの合本（展開した .txt）を選ぶと、確認に章の一覧（章の題・何話から）が並び、［章を立てる］で
 *    `設定/章立て.json` に章が2つ入る。原稿は1文字も変わらない（実機確認リスト 722 行）
 * 2. もう一度開くと、窓は**前に選んだファイルのフォルダー**から開く（実機確認リスト 974 行）。間に別の
 *    フォルダーのファイル（話）を開いておく——2026-09-23 の実機では、VS Code 任せだと「開いていたファイルの
 *    フォルダー」から開き、前に選んだ場所を覚えていなかった。直し（`features/backupPickFolder.ts`）は
 *    バックアップを選ぶ3つの入口（新しい作品として取り込む・相談パネルの［バックアップを渡す］・章立て取込）で
 *    共通なので、項目の元の入口（相談パネル）の代わりに、章立て取込の入口で見る
 *
 * **AI は呼ばない。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { fillInput, waitForQuickInput } from "./support/quickInput";
import { expandTreeRow, SIDEBAR_LAUNCH, showSidebar, treeContextMenu, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  pickQuickPickRow,
  quickInputWaitContext,
  quickOpen,
  quickPickRows,
  quickPickTitle,
} from "./support/workbenchDom";

const SEP = (n: number) => `------------------------- エピソード${n}開始 -------------------------`;
const TITLES = ["潮の匂い", "古い地図", "嵐の夜", "迷い船"];
const PARTS: Array<[number, string] | undefined> = [[1, "第一章『岬』"], undefined, [2, "第二章『灯』"], undefined];

/** なろうの合本を話ごとに分けた1話ぶん（区切り行が残る。章の最初の話にだけ見出しが付く）。単体テストと同じ形 */
function localEpisode(n: number): string {
  const part = PARTS[n - 1];
  return [SEP(n), ...(part ? [`【第${part[0]}章】`, part[1], ""] : []), "【エピソードタイトル】", `${n}話　${TITLES[n - 1]}`, "", "【本文】", `${TITLES[n - 1]}の本文。`, ""].join(
    "\r\n"
  );
}

const wide = (n: number) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));

/** なろうのバックアップ（ZIP を展開した合本の .txt）。`core/chapterOutline.test.ts` と同じ形 */
function narouCollected(): string {
  const lines = ["【Nコード】", "N0000ZZ", "", "【作品タイトル】", "架空の灯台守", ""];
  TITLES.forEach((title, index) => {
    const n = index + 1;
    const part = PARTS[index];
    lines.push(SEP(n), ...(part ? [`【第${part[0]}章】`, part[1], ""] : []), "【エピソードタイトル】", `${wide(n)}話　${title}`, "", "【本文】", `${title}の本文。`, "");
  });
  return lines.join("\n");
}

const EPISODES = TITLES.map((_, index) => ({ name: `episode_000${index + 1}.txt`, text: localEpisode(index + 1) }));
const BACKUP_FOLDER_NAME = "バックアップ置き場";
const BACKUP_NAME = "N0000ZZ.txt";
const DIALOG_TITLE = "章立てを読むバックアップを選ぶ（ZIP／テキスト）";

/** 道を比べられる形に揃える（区切り・大文字小文字・末尾の区切り） */
function samePath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** 簡易の窓の入力欄の値（いま開いているフォルダーの道）。窓が出ていなければ空 */
async function dialogPath(page: Page): Promise<string> {
  return page.locator(".quick-input-widget input").first().inputValue().catch(() => "");
}

/** 作品を右クリック「章立て取込（バックアップから）」→「バックアップのファイルから」で、簡易の窓まで進む */
async function openBackupDialog(page: Page): Promise<void> {
  await waitTreeSettled(page);
  await treeContextMenu(page, E2E_WORK_TITLE, "章立て取込（バックアップから）");
  await waitForQuickInput(page, "に章立てを取り込む", 20_000);
  await pickQuickPickRow(page, "バックアップのファイルから");
  await waitForQuickInput(page, DIALOG_TITLE, 20_000);
  // 入力欄に道が入るまで待つ（窓は開いてから中身を読む）
  await waitUntil(async () => (await dialogPath(page)).length > 0, "ファイル選択の窓の入力欄に道が入る", 10_000);
}

async function chaptersLedger(session: E2ESession): Promise<{ chapters: Array<{ name: string; startEpisodePath: string }> } | undefined> {
  const raw = await readFile(path.join(session.workFolder, "設定", "章立て.json"), "utf8").catch(() => "");
  return raw ? (JSON.parse(raw) as { chapters: Array<{ name: string; startEpisodePath: string }> }) : undefined;
}

test("分け済みの作品の右クリック「章立て取込（バックアップから）」で、選ぶ窓からなろうの合本を選ぶと章の一覧が並んで章が立ち、もう一度開くと前に選んだフォルダーから開く", async () => {
  await withVsCode(
    "バックアップを選ぶ窓",
    EPISODES,
    async (session) => {
      const { page, root } = session;
      const backupFolder = path.join(root, BACKUP_FOLDER_NAME);
      const backupFile = path.join(backupFolder, BACKUP_NAME);
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);
      await clearNotifications(page);

      /* ── 1回目：窓でバックアップを選ぶ ── */
      await openBackupDialog(page);
      const firstDefault = await dialogPath(page);
      await fillInput(page, backupFile);
      /*
        簡易の窓は、打った道を候補の行と突き合わせてから受ける。1回の Enter で決まらず、
        行を選んだだけで止まることがあるので、窓の題が消えるまで（3回まで）押す
      */
      for (let attempt = 0; attempt < 3 && (await quickPickTitle(page)) === DIALOG_TITLE; attempt++) {
        await page.keyboard.press("Enter");
        await waitUntil(async () => (await quickPickTitle(page)) !== DIALOG_TITLE, "ファイル選択の窓が閉じる", 3_000).catch(() => undefined);
      }

      /* ── 確認に章の一覧（題・何話から）が並ぶ ── */
      let rowsText = "";
      await waitUntil(
        async () => {
          const title = (await quickPickTitle(page)) ?? "";
          rowsText = [title, ...(await quickPickRows(page)).map((row) => row.label)].join(" ／ ");
          return rowsText.includes("章を2個立てます") && rowsText.includes("第二章『灯』");
        },
        "章を立てる確認に、章の一覧が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（いまの画面：${JSON.stringify(rowsText.slice(0, 500))}／窓の入力欄：${JSON.stringify(await dialogPath(page))}／` +
            `選んだ道：${JSON.stringify(backupFile)}／1回目の既定の場所：${JSON.stringify(firstDefault)}）${await quickInputWaitContext(page)}`
        );
      });
      // 章ごとに「・章の題　← 何話から」の1行（話の呼び方は作品の形式で変わるので、話数の数字と「から」で見る）
      expect(rowsText, `第一章の行がありません：${rowsText}`).toMatch(/・第一章『岬』　← [^／]*1[^／]*から/);
      expect(rowsText, `第二章の行がありません：${rowsText}`).toMatch(/・第二章『灯』　← [^／]*3[^／]*から/);
      expect(rowsText, "原稿を書き換えないことが書かれていません").toContain("原稿は書き換えません");
      await pickQuickPickRow(page, "章を立てる");

      await waitUntil(async () => ((await chaptersLedger(session))?.chapters.length ?? 0) === 2, "設定/章立て.json に章が2つ入る", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（章立て：${JSON.stringify(await chaptersLedger(session))}）`);
      });
      const ledger = await chaptersLedger(session);
      expect(ledger?.chapters.map((chapter) => chapter.name)).toEqual(["第一章『岬』", "第二章『灯』"]);
      expect(ledger?.chapters.map((chapter) => path.basename(chapter.startEpisodePath))).toEqual(["episode_0001.txt", "episode_0003.txt"]);
      // 原稿は1文字も変わらない
      for (const episode of EPISODES) {
        expect(await readFile(path.join(session.manuscriptFolder, episode.name), "utf8"), `${episode.name} が書き換わりました`).toBe(episode.text);
      }

      /* ── 2回目：間に別のフォルダーの話を開いてから、もう一度開く ── */
      await clearNotifications(page);
      await quickOpen(page, EPISODES[1].name);
      await openBackupDialog(page);
      const secondDefault = await dialogPath(page);
      expect(
        samePath(secondDefault),
        `2回目の窓が、前に選んだフォルダー（${backupFolder}）から開いていません（2回目：${secondDefault}／1回目：${firstDefault}）`
      ).toBe(samePath(backupFolder));
      // 選ばずに閉じる（何も書かない）
      await page.keyboard.press("Escape");
      await holdsFor(async () => (await chaptersLedger(session))?.chapters.length === 2, "選ばずに閉じても章立てが変わらない", 2_000);
    },
    {
      ...SIDEBAR_LAUNCH,
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        // ファイル選択を、OS のダイアログでなく VS Code の中の簡易の窓で出す（上の断り書き）
        "files.simpleDialog.enable": true,
      },
      prepareWork: async ({ workFolder }) => {
        // バックアップは書庫の外（作者がダウンロードしたフォルダーに当たる）
        const folder = path.join(path.dirname(path.dirname(workFolder)), BACKUP_FOLDER_NAME);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, BACKUP_NAME), narouCollected(), "utf8");
      },
    }
  );
});
