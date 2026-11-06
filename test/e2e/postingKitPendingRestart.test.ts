/**
 * 投稿キットの案内の途中でヘルパーから届いた話の番号は、VS Code を閉じても消えない（画面の自動テスト、
 * 設計書6.68.8・6.113。実機確認リスト 379行〔0.125.1〕「投稿キットの案内を開いたまま、ヘルパーから話の番号が
 * 届いたあと、「投稿しました」を選ぶ前に VS Code を閉じて開き直す。次に「投稿しました」を選ぶか開き直したときに、
 * 番号が台帳に入る（預かりが消えない）」を機械へ移した。作者の答え 2026-11-03 昼「残す」）。
 *
 * 見張ること：
 * 1. 「新話投稿」の案内（「第1話 … を カクヨム へ」）で［ヘルパーへ渡す形でコピー］を選び、案内を開いたまま、
 *    ヘルパーが送り返す形の番号（`novelai-posted`。封筒の札つき）を受け口（`vscode://…/import-posted`）へ届けると、
 *    「番号を受け取りました。…」と出て、台帳には書かない（案内の保存を止めないため。`postingKitSession.ts`）。
 *    案内は開いたまま
 * 2. 「投稿しました」を選ばずに VS Code を閉じて開き直す。投稿の記録がまだ無いので、開いたときには台帳へ
 *    入らない（預かったまま）
 * 3. もう一度「新話投稿」で同じ話の案内を開き、「投稿しました」を選ぶと、投稿の記録にその番号
 *    （`posts[].siteEpisodeId`）が入る＝預かりが開き直しをまたいで残っていた
 *
 * **ヘルパーは本物を使わない。** 番号はクリップボードへ置き（ヘルパーと同じ渡し方。`core/postedEnvelope.ts`）、
 * 合図の URI は**テスト用の VS Code の主プロセスへ `open-url` として渡す**（Electron の `app.emit("open-url")`。
 * VS Code の `ElectronURLListener` が受けて、拡張機能の受け口へ回す）。「Developer: Open URL」の入力欄は使わない
 * ——入力欄が出ると開いている案内（選ぶ画面）が閉じ、「案内を開いたまま」の場面にならない。**OS には開かせない**
 * （作者の VS Code へ届いてしまう）。VS Code 自身の「この URI を開かせますか」は設定で止める
 * （`support/helperRankingFixture.ts` の `HELPER_LINK_LAUNCH` と同じ）。
 *
 * **外のブラウザは開かせない**（`postingKitSteps.test.ts` と同じく本体側の `shell.openExternal` を替える）。
 * 本物のサイトへは何も送らない。AI は呼ばない。クリップボードは本物の OS のものを通るので、走らせたあと前の中身へ戻す。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { POSTED_IMPORT_URI_PATH } from "../../src/core/readerStatsHelperLink";
import { EXTENSION_URI_AUTHORITY } from "../../src/core/setupRequest";
import { HELPER_LINK_LAUNCH } from "./support/helperRankingFixture";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { runCommand } from "./support/quickInput";
import { restartVsCode, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, pickQuickPickRow, pressDialogButton, quickPickPlaceholder, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n" },
  { name: "第2話_つづき.txt", text: "　二話の本文。\n" },
];
const WORK_ID = "1177354054934574437";
const POST_URL = `https://kakuyomu.jp/my/works/${WORK_ID}/episodes/new`;
/** ヘルパーが投稿のあとの画面で読む、話の番号（作り話の数字。カクヨムの番号の桁に合わせた） */
const EPISODE_ID = "16818093000000000001";
const POSTED_URI = `vscode://${EXTENSION_URI_AUTHORITY}${POSTED_IMPORT_URI_PATH}`;

/** カクヨムだけ登録済み・作品ID あり・投稿の記録はまだ無い */
const LEDGER = {
  schemaVersion: "1",
  sites: [{ site: "kakuyomu", newEpisodeUrl: POST_URL }],
  siteProfiles: [{ site: "kakuyomu", workId: WORK_ID }],
  posts: [],
};

const LAUNCH: LaunchOptions = {
  settings: HELPER_LINK_LAUNCH.settings,
  keybindings: HELPER_LINK_LAUNCH.keybindings,
  globalState: { "novelai.siteLink.browserGuideShown": true },
  prepareWork: async ({ workFolder }) => {
    await mkdir(path.join(workFolder, "設定"), { recursive: true });
    await writeFile(path.join(workFolder, "設定", "投稿状態.json"), `${JSON.stringify(LEDGER, null, 2)}\n`, "utf8");
  },
};

/** 外のブラウザを開かせない（本体側の `shell.openExternal` を替える。起こし直すたびに入れ直す） */
async function blockBrowser(session: E2ESession): Promise<void> {
  await session.app.evaluate(({ shell }) => {
    const target = globalThis as unknown as { __e2eOpened?: string[] };
    target.__e2eOpened = [];
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
      target.__e2eOpened?.push(url);
    };
  });
}

interface LedgerPost {
  episodePath?: string;
  site?: string;
  siteEpisodeId?: string;
}

async function ledgerPosts(session: E2ESession): Promise<LedgerPost[]> {
  // 製品は台帳を「退避 → 新規作成」で書くので、一瞬ファイルが無いことがある。読めるまで待つ
  let text = "";
  await waitUntil(
    async () => {
      try {
        text = await readFile(path.join(session.workFolder, "設定", "投稿状態.json"), "utf8");
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    },
    "台帳（設定\\投稿状態.json）が読める",
    10_000
  );
  return ((JSON.parse(text) as { posts?: LedgerPost[] }).posts ?? []);
}

/** 案内の選ぶ画面の題（`… を カクヨム へ`）が出るまで待つ。VS Code 自身の「外のサイトを開きますか」は［Open］で進める */
async function waitGuide(page: Page, what: string): Promise<string> {
  let title: string | undefined;
  await waitUntil(
    async () => {
      const dialog = await dialogText(page);
      if (dialog?.includes("open the external website")) {
        await pressDialogButton(page, "Open").catch(() => undefined);
        return false;
      }
      title = await quickPickTitle(page);
      return title !== undefined && title.includes("を カクヨム へ");
    },
    what,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの題：${JSON.stringify(title)}／行：${JSON.stringify((await quickPickRows(page).catch(() => [])).map((row) => row.label))}）`);
  });
  return title ?? "";
}

/** ヘルパーの合図を、テスト用の VS Code の主プロセスへ渡す（OS には開かせない） */
async function sendHelperSignal(session: E2ESession): Promise<void> {
  await session.app.evaluate(({ app }, url) => {
    // VS Code の受け手は `open-url` の event.preventDefault() を呼ぶ
    app.emit("open-url", { preventDefault: () => undefined }, url);
  }, POSTED_URI);
}

test("投稿キットの案内の途中で届いた話の番号は、「投稿しました」を選ぶ前に VS Code を開き直しても消えず、次に「投稿しました」を選ぶと投稿の記録に入る", async () => {
  await withVsCode(
    "投稿キットの預かりを開き直しで残す",
    EPISODES,
    async (session) => {
      const before = await session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
      try {
        await blockBrowser(session);

        /* ── 1. 案内を開き、封筒をコピーして、案内を開いたまま番号が届く ── */
        await runCommand(session.page, "新話投稿");
        const title = await waitGuide(session.page, "第1話の案内「… を カクヨム へ」が出る");
        expect(title, `案内の題：${title}`).toContain("第1話");
        await pickQuickPickRow(session.page, "ヘルパーへ渡す形でコピー");
        let envelope: { postRef?: string; title?: string; workId?: string } = {};
        await waitUntil(
          async () => {
            const text = await session.app.evaluate(({ clipboard }) => clipboard.readText());
            try {
              envelope = JSON.parse(text) as typeof envelope;
              return typeof envelope.postRef === "string";
            } catch {
              return false;
            }
          },
          "封筒（札つき）がクリップボードに入る",
          10_000
        );
        expect(envelope.workId, "封筒に作品IDが入っていない").toBe(WORK_ID);
        await waitUntil(async () => (await quickPickTitle(session.page)) === title, "封筒をコピーしたあとも案内が開いている", 10_000);

        // ヘルパーが投稿のあとの画面で読んで送り返す形（ヘルパー 0.20.0 との取り決め）
        await session.app.evaluate(
          ({ clipboard }, value) => clipboard.writeText(value),
          JSON.stringify({
            "novelai-posted": 1,
            site: "kakuyomu",
            workId: WORK_ID,
            episodeId: EPISODE_ID,
            title: envelope.title,
            postRef: envelope.postRef,
            readAt: new Date().toISOString(),
          })
        );
        const sent = Date.now();
        await sendHelperSignal(session);
        await waitForNotice(session, (message) => message.includes("番号を受け取りました"), "案内の途中で届いた番号を「預かった」と知らせる", {
          since: sent,
          timeoutMs: 30_000,
        });
        // 案内は開いたまま・台帳には書かない
        expect(await quickPickTitle(session.page), "番号が届いたあと、案内が閉じました").toBe(title);
        expect(await ledgerPosts(session), "案内の途中なのに、台帳へ書きました").toEqual([]);

        /* ── 2. 「投稿しました」を選ばずに閉じて開き直す ── */
        const reopened = Date.now();
        await restartVsCode(session);
        await blockBrowser(session);
        // 投稿の記録がまだ無いので、開いたときには入らない（預かったまま。14日までは消さない）
        await holdsFor(async () => (await ledgerPosts(session)).length === 0, "開き直しただけでは、投稿の記録は増えない", 5_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledgerPosts(session))}／${await describeNotices(session, reopened)}）`);
        });

        /* ── 3. もう一度案内を開いて「投稿しました」→ 預かった番号が入る ── */
        await runCommand(session.page, "新話投稿");
        await waitGuide(session.page, "開き直したあと、第1話の案内がもう一度出る");
        await pickQuickPickRow(session.page, "投稿しました");
        await waitUntil(async () => (await ledgerPosts(session)).length === 1, "投稿の記録が1件入る", 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledgerPosts(session))}／${await describeNotices(session, reopened)}）`);
        });
        const posts = await ledgerPosts(session);
        expect(posts[0], `台帳：${JSON.stringify(posts)}`).toMatchObject({ episodePath: "本文/第1話_はじまり.txt", site: "kakuyomu", siteEpisodeId: EPISODE_ID });

        // 告知の質問（投稿おつかれさまでした）が出たら、作らずに終える
        await waitUntil(async () => (await quickPickTitle(session.page)) !== undefined, "投稿のあとの問いが出る", 10_000).catch(() => undefined);
        if ((await quickPickTitle(session.page)) === "投稿おつかれさまでした") {
          await pickQuickPickRow(session.page, "告知は作らずに終わる");
        }
        // 案内を終えたあとも番号は残る（終えるときの片づけで消さない）
        await holdsFor(async () => (await ledgerPosts(session))[0]?.siteEpisodeId === EPISODE_ID, "案内を終えたあとも番号が残る", 3_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledgerPosts(session))}／選ぶ画面：${await quickPickPlaceholder(session.page)}）`);
        });
      } finally {
        await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
      }
    },
    LAUNCH
  );
}, 300_000);
