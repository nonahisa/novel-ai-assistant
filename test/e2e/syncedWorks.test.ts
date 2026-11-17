/**
 * 作品一覧の「ほかの機械の作品」（画面の自動テスト、設計書5.5.11.1・6.113。1.0.26 で足した機能）。
 *
 * 設定の同期で届いた作品の一覧（globalState の鍵 `novelai.syncedWorks`）のうち、この機械に無い作品を
 * 作品一覧の最後に並べ、［取り寄せる］で clone、［一覧から外す］で一覧から消す。見張るのは次の3つ：
 *
 * 1. この機械に無い作品（https の GitHub の URL）を置いて起こすと、見出し「ほかの機械の作品」と作品名の行が出る。
 *    **起動のあと20秒待ってから** この機械の作品の origin を読み、読み終えるまでは並べない作り
 *    （`STARTUP_REFRESH_DELAY_MS`）なので、固定の待ちは足さず「行が出るまで」待つ
 * 2. 行の［取り寄せる］で、**URL を訊く入力欄を出さずに**置き場所を選ぶ段へ進む（URL は同期で届いた値を使う）。
 *    置き場所の窓が出たのを見て取りやめる——**clone はしない・ネットに出ない**
 * 3. ［一覧から外す］で行が消え、見出しも消える（確認の窓は無い作り）
 *
 * **値は起こす前に保管庫へ置く**（`LaunchOptions.globalState`。製品にテスト専用の口は足していない）。
 * 見本の作品は git のリポジトリでない（origin が無い）ので、置いた作品は「この機械に無い作品」として並ぶ。
 * ［取り寄せる］は Git があるか確かめてから進むので、Git の入っていない機械では2で落ちる（その旨を失敗の文に添える）。
 *
 * **置き場所の窓は VS Code の簡易の窓（`files.simpleDialog.enable`）で開く。** OS のダイアログは Playwright から
 * 読めず、作者の画面の前面に出る（`backupFileDialog.test.ts` と同じ）。
 *
 * 行を押すのは右クリックの品書きから（インラインのボタンと同じ命令 `novelai.cloneSyncedWork`・
 * `novelai.forgetSyncedWork`。品書きを押す部品は他の件で確かめた道 `treeContextMenu` を使う）。
 *
 * **AI・GitHub は呼ばない。**
 */
import { expect, test } from "vitest";
import { SIDEBAR_LAUNCH, showSidebar, treeContextMenu, treeRow, treeRowLabels, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, quickInputWaitContext, quickPickTitle } from "./support/workbenchDom";

/** 製品の `features/syncedWorkList.ts` の `SYNCED_WORKS_KEY` と同じ鍵 */
const SYNCED_WORKS_KEY = "novelai.syncedWorks";
const HEADER = "ほかの機械の作品";
const OTHER_TITLE = "霧の港の記録";
/** 存在しなくてよい（clone の前で取りやめる）。資格情報の無い、一覧に載せる形のまま置く */
const OTHER_URL = "https://github.com/example-owner/kiri-no-minato.git";

/** 製品の `addWorkFromGithub.ts` の入力欄・窓の題 */
const URL_INPUT_TITLE = "GitHubから作品を取り寄せる";
const PLACE_DIALOG_TITLE = "作品フォルダを置く場所を選択";
const FOLDER_NAME_TITLE = "フォルダー名";

/** 起動のあと20秒待ってから読み直す作り。起動の遅い機械でも足りるよう、その上に余裕を持たせる */
const ROW_APPEARS_MS = 90_000;

test("同期で届いたこの機械に無い作品が「ほかの機械の作品」に並び、［取り寄せる］は URL を訊かずに置き場所の窓へ進み、［一覧から外す］で消える", async () => {
  await withVsCode(
    "ほかの機械の作品",
    [{ name: "第1話.txt", text: "港の朝。\n" }],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await clearNotifications(page);

      /* ── 1. 見出しと作品名の行が出る ── */
      await waitUntil(
        async () => (await treeRow(page, HEADER).count()) > 0 && (await treeRow(page, OTHER_TITLE).count()) > 0,
        `作品一覧に「${HEADER}」の見出しと「${OTHER_TITLE}」の行が出る`,
        ROW_APPEARS_MS
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
      });
      // 見出しは作品の行より下（一覧の最後）に置く作り
      const labels = await treeRowLabels(page);
      const headerAt = labels.findIndex((label) => label.startsWith(HEADER));
      const workAt = labels.findIndex((label) => label.startsWith(E2E_WORK_TITLE));
      expect(headerAt, `見出しが作品の行より上にあります（並び：${labels.join(" / ")}）`).toBeGreaterThan(workAt);

      /* ── 2. ［取り寄せる］：URL を訊かずに置き場所の窓へ ── */
      await waitTreeSettled(page);
      // 途中で出た画面の題を全部控える（URL の入力欄が一瞬でも出たら落とす）
      const seenTitles = new Set<string>();
      const noteTitle = async (): Promise<string> => {
        const title = (await quickPickTitle(page)) ?? "";
        if (title !== "") seenTitles.add(title);
        return title;
      };
      await treeContextMenu(page, OTHER_TITLE, "取り寄せる");
      await waitUntil(async () => (await noteTitle()).includes(PLACE_DIALOG_TITLE), `置き場所を選ぶ窓（「${PLACE_DIALOG_TITLE}」）が出る`, 30_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（出た画面：${[...seenTitles].join(" / ") || "なし"}。Git が入っていない機械では、Git の案内が出てここで止まる）${await quickInputWaitContext(page)}`
          );
        }
      );
      expect(
        [...seenTitles].some((title) => title.includes(URL_INPUT_TITLE)),
        `URL を訊く入力欄が出ました（出た画面：${[...seenTitles].join(" / ")}）`
      ).toBe(false);

      // 置き場所を選ばずに閉じる。clone の前のフォルダー名の欄へも進まない
      await page.keyboard.press("Escape");
      await waitUntil(async () => !(await noteTitle()).includes(PLACE_DIALOG_TITLE), "置き場所の窓が閉じる", 10_000);
      await holdsFor(
        async () => {
          const title = await noteTitle();
          return !title.includes(FOLDER_NAME_TITLE) && !title.includes(URL_INPUT_TITLE) && !title.includes(PLACE_DIALOG_TITLE);
        },
        "取りやめたあと、フォルダー名の欄・URL の入力欄・置き場所の窓のどれも出ない",
        3_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（出た画面：${[...seenTitles].join(" / ")}）`);
      });
      // 取りやめても一覧からは消えない
      expect(await treeRow(page, OTHER_TITLE).count(), "取りやめただけで行が消えました").toBeGreaterThan(0);

      /* ── 3. ［一覧から外す］で行と見出しが消える ── */
      await waitTreeSettled(page);
      await treeContextMenu(page, OTHER_TITLE, "一覧から外す");
      await waitUntil(
        async () => (await treeRow(page, OTHER_TITLE).count()) === 0 && (await treeRow(page, HEADER).count()) === 0,
        `「${OTHER_TITLE}」の行と「${HEADER}」の見出しが消える`,
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
      });
      // 遅れて走る読み直し（登録の変化のあと2秒）で戻ってこない
      await holdsFor(async () => (await treeRow(page, OTHER_TITLE).count()) === 0, `外した「${OTHER_TITLE}」が戻ってこない`, 4_000);
      // この機械の作品の行は残る
      expect(await treeRow(page, E2E_WORK_TITLE).count(), "この機械の作品の行まで消えました").toBeGreaterThan(0);
    },
    {
      ...SIDEBAR_LAUNCH,
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        // 置き場所の窓を、OS のダイアログでなく VS Code の中の簡易の窓で出す（冒頭の断り書き）
        "files.simpleDialog.enable": true,
      },
      globalState: {
        [SYNCED_WORKS_KEY]: {
          version: 1,
          works: [{ title: OTHER_TITLE, remoteUrl: OTHER_URL, addedAt: "2026-11-01T00:00:00.000Z" }],
        },
      },
    }
  );
});
