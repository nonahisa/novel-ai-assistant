/**
 * 編集部モード（1台の中で）：作者／編集者の切り替えと、校閲のロック（画面の自動テスト、設計書5.6・6.113。
 * 実機確認リスト 4714・4719・4720・4721 行を、仕分け 2026-10-12 の束 E12 として移した。作者の裁定
 * 「仕分けて機械の分から減らす」）。
 *
 * 項目は「2環境」（作者の機械と編集部の機械）を前提に書かれているが、**ロックの台帳
 * （`.aiwriter/locks/locks.jsonl`）は同期で運ばれるファイルそのもの**なので、1台の中で
 * 「編集部の側で押さえた台帳」を見本として置けば、作者の側の振る舞いを見られる。
 * 同期（GitHub）で台帳が相手へ届くことは見ない（作者の手に残す）。
 *
 * 1. 編集者の側（4714・4719）：簡単ステップメニュー「6. 編集部校正・校閲」→「作者／編集者切替」で
 *    確認の窓が出て、［編集者にする］で設定 `novelai.mode` が `editor` になる（設定ファイルで見る）。
 *    続けて「校閲開始／終了」で、開いているファイルを押さえると、台帳に「編集者が押さえた」1行が増える
 * 2. 作者の側（4720・4721）：編集部が2時間前から押さえている台帳を置き、作者が提案パネルの［適用］で
 *    直そうとすると「〜は校閲中です」の窓に**誰が・何を・いつから**が出る。直さずに閉じれば本文は
 *    変わらない。作者が「校閲開始／終了」で［外す］を押すと台帳に外した1行が増え、そのあとの［適用］は
 *    窓を出さずに通る
 *
 * **このテストでは .txt を素のテキストエディターで開く**（`workbench.editorAssociations`）。
 * 「校閲開始／終了」は `vscode.window.activeTextEditor` で開いているファイルを決めるので、
 * 原稿エディター（カスタムエディター）で開いていると「校閲するファイルを開いてから実行してください」で
 * 止まる（`features/reviewProposals.ts` の `toggleReviewLock`）。原稿エディターでの振る舞いは
 * ここでは見ない（報告に別に書いた）。
 *
 * **AI は呼ばない。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { findAction } from "../../src/core/actionTree";
import type { LockEvent } from "../../src/models/fileLock";
import { runCommand, waitForQuickInput } from "./support/quickInput";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  readJsonLines,
  writeSampleFinding,
} from "./support/sampleFinding";
import { collapseSidebarPane, SIDEBAR_LAUNCH, scrollTreeUntilRow, showSidebar } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  activateTab,
  clearNotifications,
  closeDialog,
  dialogText,
  focusTextEditor,
  notificationTexts,
  pickQuickPickRow,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickOpen,
  statusBarTexts,
  textEditorVisibleText,
} from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", ""].join("\n");
const FIXED = TEXT.replace("以外にも", "意外にも");
const STEP = "6. 編集部校正・校閲";

function labelOf(command: string): string {
  const label = findAction(command)?.label;
  if (!label) throw new Error(`actionTree に ${command} がありません`);
  return label;
}

/** 素のテキストエディターで開く（上の断り書き）。左の列とキーは残す */
function plainEditorLaunch(extra: LaunchOptions = {}): LaunchOptions {
  return {
    ...extra,
    settings: {
      ...SIDEBAR_LAUNCH.settings,
      "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" },
      ...extra.settings,
    },
    keybindings: [...SIDEBAR_LAUNCH.keybindings, ...OPEN_PROPOSALS_LAUNCH.keybindings, ...(extra.keybindings ?? [])],
  };
}

function locksFile(workFolder: string): string {
  return path.join(workFolder, ".aiwriter", "locks", "locks.jsonl");
}

async function lockEvents(workFolder: string): Promise<LockEvent[]> {
  return (await readJsonLines(locksFile(workFolder))) as unknown as LockEvent[];
}

/** 素のテキストエディターで話を開き、本文が見えるまで待つ */
async function openPlain(session: E2ESession): Promise<void> {
  await quickOpen(session.page, EPISODE);
  await waitUntil(async () => (await textEditorVisibleText(session.page)).includes("終電を逃した"), "素のテキストエディターに本文が出る", 20_000);
}

/** 確認の窓（モーダル）が出るまで待ち、その文を返す */
async function waitDialog(session: E2ESession, includes: string, label: string): Promise<string> {
  let text = "";
  await waitUntil(async () => (text = (await dialogText(session.page)) ?? "").includes(includes), label, 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／右下の知らせ：${JSON.stringify(await notificationTexts(session.page))}）${await quickInputWaitContext(session.page)}`);
  });
  return text;
}

/* ── 1. 編集者の側：切り替えと、押さえる ── */

test("簡単ステップメニュー「6. 編集部校正・校閲」の「作者／編集者切替」で編集者モードになり、「校閲開始／終了」で開いているファイルが編集者の名で押さえられる", async () => {
  await withVsCode(
    "編集者モードと校閲のロック",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, root, workFolder } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      // 横の「AIに相談」が左の列の下半分を取り、簡単ステップメニューが数行まで低くなるので畳む（collapseSidebarPane）
      await collapseSidebarPane(page, "AIに相談");

      /* ── ステップメニューの「6. 編集部校正・校閲」を開き、「作者／編集者切替」を押す ── */
      // 窓が低いと、畳んでも「6.」が区画の外で描かれないことがある（ノートPCの狭い窓）。描かれるまで区画を送る
      const step = await scrollTreeUntilRow(page, "1. 作品登録", STEP);
      await step.scrollIntoViewIfNeeded();
      if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
      await waitUntil(async () => (await step.getAttribute("aria-expanded")) === "true", `「${STEP}」が開く`);
      const row = await scrollTreeUntilRow(page, STEP, labelOf("novelai.switchMode"));
      await row.click();

      const ask = await waitDialog(session, "この環境を「編集者」として使いますか。", "「編集者」として使うかの確認の窓が出る");
      // 押す前に、できなくなることが具体的に書かれている（設計書5.6.1）
      expect(ask, `確認の窓に「できなくなること」がありません：${ask}`).toContain("【できなくなること】");
      await pressDialogButton(page, "編集者にする");

      // 設定（環境ごと＝ユーザーの settings.json）が editor になる
      const settingsFile = path.join(root, "user-data", "User", "settings.json");
      await waitUntil(async () => /"novelai\.mode"\s*:\s*"editor"/.test(await readFile(settingsFile, "utf8").catch(() => "")), "設定 novelai.mode が editor になる", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（settings.json：${JSON.stringify((await readFile(settingsFile, "utf8").catch(() => "読めない")).slice(0, 600))}）`);
        }
      );
      await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("編集者モードにしました")), "「編集者モードにしました」の知らせが出る", 15_000);
      await clearNotifications(page);

      /* ── 開いているファイルを「校閲開始／終了」で押さえる ── */
      await openPlain(session);
      await focusTextEditor(page);
      await runCommand(page, labelOf("novelai.toggleReviewLock"));
      await waitForQuickInput(page, "何をしているかを、作者へ伝えます", 20_000);
      await pickQuickPickRow(page, "校閲中");

      await waitUntil(async () => (await lockEvents(workFolder)).length === 1, "ロックの台帳に1行増える", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（台帳：${await readFile(locksFile(workFolder), "utf8").catch(() => "（まだ無い）")}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      const [event] = await lockEvents(workFolder);
      expect(event.kind).toBe("acquire");
      expect(event.holderKind, "編集者モードで押さえたのに、作者の名で押さえています").toBe("editor");
      expect(event.note).toBe("校閲中");
      expect(event.file.replace(/\\/g, "/").toLowerCase()).toBe(`本文/${EPISODE}`.toLowerCase());
      await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("を押さえました")), "「…を押さえました」の知らせが出る", 15_000);
      // 押さえても本文は変わらない
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT);
    },
    plainEditorLaunch()
  );
});

/* ── 2. 作者の側：押さえられたファイルを直そうとする・外す ── */

/** 編集部が2時間前から押さえている台帳（作者の側に同期で届いた形） */
const HOLDER = "山田（編集部）";

test("編集部が押さえているファイルを作者が［適用］で直そうとすると誰が・何を・いつからが出て、閉じれば本文は変わらず、作者が［外す］で外せば［適用］が通る", async () => {
  await withVsCode(
    "作者の側のロック",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, workFolder } = session;
      const file = path.join(session.manuscriptFolder, EPISODE);
      const read = async () => (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
      await openPlain(session);

      /* ── 提案パネルの［適用］で直そうとする ── */
      await clearNotifications(page);
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      let proposals: Frame | undefined;
      await waitUntil(
        async () => (proposals = await proposalPanelFrame(page)) !== undefined && (await proposals.locator('button[data-action="apply"]').count()) > 0,
        "提案パネルに［適用］が並ぶ",
        20_000
      );
      if (!proposals) throw new Error("提案パネルが見つかりません");
      const panel = proposals;
      await panel.locator('button[data-action="apply"]').first().click();

      const warning = await waitDialog(session, "は校閲中です。", "［適用］で「〜は校閲中です」の窓が出る");
      const oneLine = warning.replace(/\s+/g, " ");
      expect(oneLine, `窓にファイルの名前がありません：${oneLine}`).toContain(EPISODE);
      expect(oneLine, `窓に誰が見ているかがありません：${oneLine}`).toContain(`${HOLDER} が校閲中です`);
      expect(oneLine, `窓に何をしているかがありません：${oneLine}`).toContain("（校閲中）");
      expect(oneLine, `窓にいつからかがありません：${oneLine}`).toContain("2時間ほど前から");
      // 直さずに閉じる → 本文は変わらない
      await closeDialog(page);
      await holdsFor(async () => (await read()) === TEXT, "窓を閉じたあと本文が変わらない", 2_000);

      /* ── 作者が「校閲開始／終了」で外す ── */
      await activateTab(page, EPISODE);
      await focusTextEditor(page);
      await runCommand(page, labelOf("novelai.toggleReviewLock"));
      const release = await waitDialog(session, "は押さえられています。", "「〜は押さえられています」の窓が出る");
      expect(release.replace(/\s+/g, " "), "外す前の窓に、誰が押さえているかがありません").toContain(HOLDER);
      await pressDialogButton(page, "外す");
      await waitUntil(async () => (await lockEvents(workFolder)).length === 2, "ロックの台帳に外した1行が増える", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（台帳：${await readFile(locksFile(workFolder), "utf8").catch(() => "読めない")}）`);
      });
      const events = await lockEvents(workFolder);
      expect(events[1].kind).toBe("release");
      expect(events[1].holderKind, "作者が外したのに、作者の名で記録されていません").toBe("author");
      /*
        **外した知らせは下の帯（ステータスバー）に出る**（`features/reviewProposals.ts` の `toggleReviewLock` は
        `notifyDone`＝その場限りの完了。押さえたときの「…を押さえました」は件の説明を伴うので右下の知らせ）。
        2026-10-12 ノートPC では右下だけを15秒待って落ちた。帯の字は6秒で消えるので、台帳を待ったあとすぐ見る。
        念のため右下の知らせも見る（行き先が変わっても、この件の見たいこと＝外したと伝わることは同じ）
      */
      await waitUntil(
        async () => [...(await statusBarTexts(page)), ...(await notificationTexts(page))].some((text) => text.includes("のロックを外しました")),
        "「…のロックを外しました」が下の帯（または右下の知らせ）に出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}／いまの窓：${JSON.stringify(await dialogText(page))}／台帳：${JSON.stringify(await lockEvents(workFolder))}）`
        );
      });

      /* ── 外したあとの［適用］は、窓を出さずに通る ── */
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      // 開き直しで面が作り直されることがあるので、探し直す
      let again: Frame | undefined;
      await waitUntil(
        async () => (again = await proposalPanelFrame(page)) !== undefined && (await again.locator('button[data-action="apply"]').count()) > 0,
        "提案パネルに［適用］がまだある",
        20_000
      ).catch(async (error: unknown) => {
        const text = again ? await again.evaluate(() => document.body.innerText).catch(() => "") : "（提案パネルが見つかりません）";
        throw new Error(`${String(error)}（提案パネル：${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 400))}）`);
      });
      if (!again) throw new Error("提案パネルが見つかりません");
      await again.locator('button[data-action="apply"]').first().click();
      await waitUntil(async () => (await read()) === FIXED, "外したあとの［適用］で本文が直る", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（本文：${JSON.stringify(await read())}／いまの窓：${JSON.stringify(await dialogText(page))}）`);
      });
      expect(await dialogText(page), "外したのに、まだ校閲中の窓が出ています").toBeUndefined();
    },
    plainEditorLaunch({
      prepareWork: async ({ workFolder }) => {
        await writeSampleFinding(workFolder, {
          episode: EPISODE,
          text: TEXT,
          original: "男は以外にも若かった。",
          target: "以外",
          suggestion: "意外",
          message: "「思いのほか」の意味なら「意外」です",
        });
        const event: LockEvent = {
          kind: "acquire",
          file: `本文/${EPISODE}`,
          holder: HOLDER,
          holderKind: "editor",
          time: new Date(Date.now() - 2 * 3_600_000 - 5 * 60_000).toISOString(),
          note: "校閲中",
        };
        await mkdir(path.dirname(locksFile(workFolder)), { recursive: true });
        await writeFile(locksFile(workFolder), `${JSON.stringify(event)}\n`, "utf8");
      },
    })
  );
});
