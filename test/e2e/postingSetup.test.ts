/**
 * 投稿キットの初回の設定・投稿サイト設定・ランキング記録・執筆統計の「サイトの記録」
 * （画面の自動テスト、設計書6.113・6.68.3・6.68.5。実機確認リスト F-67・F-74 を
 * 2026-10-04 に移した）。
 *
 * 何を見張るか：
 * - 作品の右クリック「新話投稿」の初回は、**選んだサイトだけ**投稿ページのURLを訊く。
 *   別のサイトのURLは入力欄で断る。最後に「どの話まで投稿済みか」を一覧で訊く
 * - 基準線を引いたあと、作品一覧の「未投稿N」が実態に合う（出した話には出ず、
 *   あとから足した話にだけ出る）
 * - 「投稿サイト設定」で作品ID・作品ページ・ジャンルを入れると、執筆統計に
 *   「サイトの記録」の節が出て、作品ページへのリンクが入る
 * - 執筆統計を開いたまま「ランキング記録」で順位を入れると、その場で表に出る
 *
 * **投稿ページは開かない・クリップボードも使わない。** 基準線を最新話まで引いて
 * 「未投稿の話はありません」で終わらせる（その先の案内は、作者のブラウザで投稿
 * ページを開き、作者のクリップボードへ本文を積む）。作品ページのリンクも押さず、
 * 行き先だけを読む（押すと作者のブラウザが開く）。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { answerInput, fillInput, quickInputMessage, waitForQuickInput, waitQuickInputClosed } from "./support/quickInput";
import {
  expandTreeRow,
  showSidebar,
  SIDEBAR_LAUNCH,
  treeContextMenu,
  treeRowLabel,
  treeRowLabels,
} from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { acceptQuickPick, pickQuickPickRow, quickPickTitle, toggleQuickPickRow } from "./support/workbenchDom";

const WORK_ID = "1177354054880000000";
const NEW_EPISODE_URL = `https://kakuyomu.jp/my/works/${WORK_ID}/episodes/new`;
const WORK_URL = `https://kakuyomu.jp/works/${WORK_ID}`;

/** 執筆統計のパネルのうち「サイトの記録」の節（出ていなければ undefined） */
async function siteRecordsFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => Array.from(document.querySelectorAll("h3")).some((h) => h.textContent === "サイトの記録"))
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

test("新話投稿の初回は選んだサイトだけURLを訊いて別サイトのURLを断り、基準線のあと未投稿の印は足した話にだけ出て、投稿サイト設定の作品情報とランキング記録が執筆統計の「サイトの記録」にその場で出る", async () => {
  await withVsCode(
    "投稿キットとサイトの記録",
    [
      { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
      { name: "第2話_つづき.txt", text: "二話の本文。\n" },
      { name: "第3話_山場.txt", text: "三話の本文。\n" },
    ],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);

      /* ── 新話投稿の初回（F-67） ── */
      await treeContextMenu(page, E2E_WORK_TITLE, "新話投稿");
      await waitForQuickInput(page, "を出すサイト");
      await toggleQuickPickRow(page, "カクヨム");
      await acceptQuickPick(page);

      // 選んだカクヨムだけを訊く
      await waitForQuickInput(page, "の新規エピソード投稿ページ");
      expect(await quickPickTitle(page)).toBe("カクヨム の新規エピソード投稿ページ");
      // 別のサイトのURLは、入力欄で断る（Enter で進めない）
      await fillInput(page, "https://ncode.syosetu.com/n0000aa/");
      await waitUntil(async () => (await quickInputMessage(page)) !== "", "別のサイトのURLに断りが出る");
      await page.keyboard.press("Enter");
      expect(await quickPickTitle(page), "別のサイトのURLで先へ進みました").toBe("カクヨム の新規エピソード投稿ページ");
      await answerInput(page, NEW_EPISODE_URL);

      // ほかのサイトのURLは訊かれず、どの話まで投稿済みかを訊く
      await waitForQuickInput(page, "どの話まで投稿済みですか");
      await pickQuickPickRow(page, "第3話");
      await waitQuickInputClosed(page, "基準線を選ぶと画面が閉じる");

      const ledgerFile = path.join(session.workFolder, "設定", "投稿状態.json");
      await waitUntil(async () => (await readFile(ledgerFile, "utf8").catch(() => "")).includes("第3話"), "基準線が台帳に入る");

      // 出した話（第1〜3話）には未投稿の印が出ない。あとから足した話にだけ出る
      await writeFile(path.join(session.manuscriptFolder, "第4話_しんわ.txt"), "四話の本文。\n", "utf8");
      await waitUntil(async () => (await treeRowLabel(page, "第4話")).includes("未投稿1"), "足した第4話に「未投稿1」が出る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（行：${(await treeRowLabels(page)).join(" / ")}）`);
        }
      );
      for (const head of ["第1話", "第2話", "第3話"]) {
        expect(await treeRowLabel(page, head), `${head} に未投稿の印が出ています`).not.toContain("未投稿");
      }

      /* ── 投稿サイト設定で作品情報を入れる（F-74） ── */
      await treeContextMenu(page, E2E_WORK_TITLE, "投稿サイト設定");
      await waitForQuickInput(page, "を出すサイト");
      // 登録済みのカクヨムは選ばれた状態で出る。そのまま進める
      await acceptQuickPick(page);
      await waitForQuickInput(page, "カクヨム の新規エピソード投稿ページ");
      await answerInput(page, NEW_EPISODE_URL);
      await waitForQuickInput(page, "の投稿サイトの情報");
      await pickQuickPickRow(page, "作品ID・作品ページ・ジャンルも入れる");
      await waitForQuickInput(page, "カクヨム での作品ID");
      await answerInput(page, WORK_ID);
      await waitForQuickInput(page, "カクヨム の作品ページのURL");
      await answerInput(page, WORK_URL);
      await waitForQuickInput(page, "カクヨム でのジャンル");
      await answerInput(page, "ハイファンタジー");
      // 記録があるので、基準線を引き直すかを訊かれる。引き直さない
      await waitForQuickInput(page, "の投稿済みの基準線");
      await pickQuickPickRow(page, "引き直さずに終わる");
      await waitQuickInputClosed(page, "投稿サイト設定が閉じる");

      // 執筆統計に「サイトの記録」の節が出て、作品ページへのリンクが入る
      await treeContextMenu(page, E2E_WORK_TITLE, "執筆統計");
      let stats: Frame | undefined;
      await waitUntil(async () => (stats = await siteRecordsFrame(page)) !== undefined, "執筆統計に「サイトの記録」の節が出る", 30_000);
      if (!stats) throw new Error("執筆統計が見つかりません");
      const statsFrame = stats;
      const siteText = () =>
        statsFrame.evaluate(() => {
          const heading = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent === "サイトの記録");
          return heading?.parentElement?.innerText ?? "";
        });
      expect(await siteText()).toContain("カクヨム");
      expect(await siteText()).toContain(`作品ID ${WORK_ID}`);
      expect(await siteText()).toContain("ジャンル ハイファンタジー");
      // リンクは押さない（作者のブラウザが開く）。行き先だけ読む
      const links = await statsFrame.evaluate(() =>
        Array.from(document.querySelectorAll("[data-url]")).map((el) => ({
          text: (el.textContent ?? "").trim(),
          url: (el as HTMLElement).dataset.url ?? "",
        }))
      );
      expect(links).toContainEqual({ text: "作品ページを開く", url: WORK_URL });

      /* ── 開いたままランキングを記録すると、その場で表に出る（F-74） ── */
      expect(await siteText()).not.toContain("最新 日間");
      await treeContextMenu(page, E2E_WORK_TITLE, "ランキング記録");
      await waitForQuickInput(page, "のランキングを記録");
      await pickQuickPickRow(page, "カクヨム");
      await waitForQuickInput(page, "カクヨム のランキングの種別");
      await answerInput(page, "日間");
      await waitForQuickInput(page, "カクヨム の日間の順位");
      await answerInput(page, "１２");
      await waitForQuickInput(page, "メモ（任意）");
      await answerInput(page, "見張りの記録");
      await waitUntil(async () => (await siteText()).includes("最新 日間 12位"), "開いたままの執筆統計に順位が出る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（節：${await siteText()}）`);
        }
      );
      expect(await siteText()).toContain("見張りの記録");
    },
    SIDEBAR_LAUNCH
  );
});
