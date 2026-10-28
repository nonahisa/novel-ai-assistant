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
 *    続けて「校閲開始／終了」で、校閲する話の範囲（始めの話・終わりの話の2つの選択）を選ぶと、
 *    範囲の話ぶんだけ台帳に「編集者が押さえた」行が増える（範囲の外の話は押さえない。作者の裁定 2026-10-28）
 * 2. 作者の側（4720・4721）：編集部が2時間前から押さえている台帳を置き、作者が提案パネルの［適用］で
 *    直そうとすると「〜は編集部が校閲中のため、適用できません」の窓に**誰が・何を・いつから**が出て
 *    断られる。閉じれば本文は変わらない。窓の中で外す道は無く（2026-10-28）、窓の［連携を解除…］から
 *    連携の解除を通すと台帳に作者の名の外した行が増え、そのあとの［適用］は窓を出さずに通る
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
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", ""].join("\n");
const FIXED = TEXT.replace("以外にも", "意外にも");
// 範囲校閲の見本：001〜003 を選び、004 は範囲の外に残す
const EPISODE_2 = "002_街.txt";
const EPISODE_3 = "003_宿.txt";
const EPISODE_4 = "004_朝.txt";
const OTHER_TEXT = ["　街は静かだった。", ""].join("\n");
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

test("簡単ステップメニュー「6. 編集部校正・校閲」の「作者／編集者切替」で編集者モードになり、「校閲開始／終了」で選んだ範囲の話が編集者の名で押さえられる", async () => {
  await withVsCode(
    "編集者モードと校閲のロック",
    [
      { name: EPISODE, text: TEXT },
      { name: EPISODE_2, text: OTHER_TEXT },
      { name: EPISODE_3, text: OTHER_TEXT },
      { name: EPISODE_4, text: OTHER_TEXT },
    ],
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

      /* ── 「校閲開始／終了」で、校閲する話の範囲（始め・終わり）を選んで押さえる ──
         作者の裁定（2026-10-28）：作品丸ごとでなく、校閲中の話数の範囲を決める */
      await openPlain(session);
      await focusTextEditor(page);
      await runCommand(page, labelOf("novelai.toggleReviewLock"));
      // 始めの話：先頭の近道「開いている話」を選ぶ（開いているのは 001）
      const startRows = await waitForQuickPick(page, "校閲する範囲：始めの話を選びます", 20_000);
      expect(startRows[0]?.description, `先頭の行が「開いている話」の近道ではありません：${JSON.stringify(startRows)}`).toContain("開いている話");
      await pickQuickPickRow(page, "開いている話");
      // 終わりの話：003 まで（002 は間の話。004 は範囲の外）
      await waitForQuickPick(page, "校閲する範囲：終わりの話を選びます", 20_000);
      await pickQuickPickRow(page, EPISODE_3);
      await waitForQuickInput(page, "何をしているかを、作者へ伝えます", 20_000);
      await pickQuickPickRow(page, "校閲中");

      const wanted = [EPISODE, EPISODE_2, EPISODE_3].map((name) => `本文/${name}`.toLowerCase());
      await waitUntil(async () => (await lockEvents(workFolder)).length >= 3, "ロックの台帳に範囲の話数ぶん増える", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（台帳：${await readFile(locksFile(workFolder), "utf8").catch(() => "（まだ無い）")}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      const events = await lockEvents(workFolder);
      const acquired = events.filter((event) => event.kind === "acquire");
      for (const event of acquired) {
        expect(event.holderKind, "編集者モードで押さえたのに、作者の名で押さえています").toBe("editor");
        expect(event.note).toBe("校閲中");
      }
      expect(
        acquired.map((event) => event.file.replace(/\\/g, "/").toLowerCase()).sort(),
        `押さえた話が範囲（001〜003）と違います。004 は外に残るはずです：${JSON.stringify(events)}`
      ).toEqual(wanted);
      await waitUntil(
        async () => [...(await statusBarTexts(page)), ...(await notificationTexts(page))].some((text) => text.includes("を校閲中にしました")),
        "「…を校閲中にしました」が下の帯（または右下の知らせ）に出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      // 押さえても本文は変わらない
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT);
    },
    plainEditorLaunch()
  );
});

/* ── 2. 作者の側：押さえられたファイルを直そうとする・外す ── */

/** 編集部が2時間前から押さえている台帳（作者の側に同期で届いた形） */
const HOLDER = "山田（編集部）";

test("編集部が押さえているファイルを作者が［適用］で直そうとすると誰が・何を・いつからが出て断られ、閉じれば本文は変わらず、連携を解除すれば［適用］が通る", async () => {
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

      // 編集部が押さえた話は、作者の［適用］が断られる（作者の裁定 2026-10-28。以前の「それでも直す」は無い）
      const warning = await waitDialog(session, "は編集部が校閲中のため、適用できません。", "［適用］で「〜は編集部が校閲中のため、適用できません」の窓が出る");
      const oneLine = warning.replace(/\s+/g, " ");
      expect(oneLine, `窓にファイルの名前がありません：${oneLine}`).toContain(EPISODE);
      expect(oneLine, `窓に誰が見ているかがありません：${oneLine}`).toContain(`${HOLDER} が校閲中です`);
      expect(oneLine, `窓に何をしているかがありません：${oneLine}`).toContain("（校閲中）");
      expect(oneLine, `窓にいつからかがありません：${oneLine}`).toContain("2時間ほど前から");
      // 窓の中で外す道は無く、解くのは［連携を解除…］だけ
      expect(oneLine, `窓に［連携を解除…］がありません：${oneLine}`).toContain("連携を解除…");
      expect(oneLine, `窓に作者が窓の中で［外す］道が残っています：${oneLine}`).not.toContain("外す");
      // 閉じる → 本文は変わらない
      await closeDialog(page);
      await holdsFor(async () => (await read()) === TEXT, "窓を閉じたあと本文が変わらない", 2_000);

      /* ── 作者が編集部との連携を解除する（決裂したときの手段）──
         もう一度［適用］→窓の［連携を解除…］→確認の［解除する］。テストの作品は GitHub に繋がっていない
         （送り先が無い）ので権利は外せず、手で外す案内が出て、鍵だけが外れる */
      await clearNotifications(page);
      await panel.locator('button[data-action="apply"]').first().click();
      await waitDialog(session, "は編集部が校閲中のため、適用できません。", "もう一度、断りの窓が出る");
      // 次の確認の窓がすぐ出るので、窓が消えるのを待たずに押す（pressDialogButton は消えるのを待つ）
      await page.locator(".monaco-dialog-box .monaco-button", { hasText: "連携を解除…" }).first().click();
      const revoke = await waitDialog(session, "編集部との連携を解除しますか。", "連携の解除の確認の窓が出る");
      expect(revoke.replace(/\s+/g, " "), "解除の確認に、外す校閲中の印の範囲がありません").toContain("校閲中の印を外します");
      await pressDialogButton(page, "解除する");
      await waitUntil(async () => (await lockEvents(workFolder)).length === 2, "ロックの台帳に外した1行が増える", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（台帳：${await readFile(locksFile(workFolder), "utf8").catch(() => "読めない")}）`);
      });
      const events = await lockEvents(workFolder);
      expect(events[1].kind).toBe("release");
      expect(events[1].holderKind, "作者が外したのに、作者の名で記録されていません").toBe("author");
      expect(events[1].file.replace(/\\/g, "/").toLowerCase()).toBe(`本文/${EPISODE}`.toLowerCase());
      /*
        **GitHub に繋がっていない作品では権利を外せない**ので、右下に「権利は GitHub から外せませんでした…
        手で外してください」の案内が出る（`features/revokeEditorAccess.ts` の `reportRevokeFailure`。
        成功の「連携を解除しました」は下の帯に出るが、この見本では出ない）。鍵は外れている。
      */
      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("手で外してください")),
        "権利を外せなかった案内（手で外してください）が右下の知らせに出る",
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
        // 「渡したことがある作品」の印。これが無いと連携の解除は「まだ渡していません」で何もしない。
        // 送り先（remoteUrl）は置かない＝GitHub へは何も届かず、鍵だけが外れる
        await writeFile(path.join(workFolder, ".aiwriter", "editing.json"), `${JSON.stringify({ editorLogin: "yamada-editor" })}\n`, "utf8");
      },
    })
  );
});
