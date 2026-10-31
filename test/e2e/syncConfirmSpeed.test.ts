/**
 * 「全作品同期」「保存・同期」の確認の窓が早く出る（0.115.2、commit 86fcc341。画面の自動テスト、設計書6.113。
 * リーダーの依頼 2026-10-31、作者の許可「今席にいるので、必要なら回してください」）。
 *
 * 何を見張るか：
 * - 0.115.2 で、同期の前の状態調べを「置き場（git のリポジトリ）ごとに1回」に改め、全作品同期の fetch を
 *   置き場ごとに同時に走らせた。測定の記録（docs/measurements/2026-10-29-非AIの速さ.md）では、写しで確認の窓まで
 *   1,316ms・git 73回 → 396ms・24回
 * - ここでは本物の VS Code で、作品ごとに別の置き場（それぞれ手元の裸の置き場を送り先にした git）を4つ登録し、
 *   各作品に記録待ちの変更を置いてから、キーで命令を押した瞬間から確認の窓（`syncAllWorks.ts` の `confirm`）が
 *   出るまでの時間を測る。**確認の窓では［同期する］を押さずに取りやめる**（Esc）
 * - 時間はテストの出力へ書き出す（`[同期の確認の窓]` の行。件数と ms。通ったときは既定の出力に出ないので、
 *   数字を読むときは `--reporter=verbose` を付けて走らせる）。合否の線は揺れに強いよう、
 *   3回の中央値が 3,000ms 以内（記録の 0.4秒に対して緩くとった）
 * - 「保存・同期」（`saveAndSyncAll` → 同じ `syncAllWorks`）も同じ窓なので、同じ形で測る。
 *   「GitHubと同期」（gitSync）は確認の窓でなく選ぶ画面を出すので、ここでは測らない
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts` の
 * `addLocalRemote`）で、fetch も手元のフォルダーどうしで済む。押すのは使い捨ての keybindings.json に
 * 足したキー（コマンドパレットを通すと、打鍵と行の出現待ちが時間に混ざる）。
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { describeNotices } from "./support/noticeRecord";
import { addLocalRemote, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, closeDialog, dialogText, pressWorkbenchKey, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "　一話の本文。";

/**
 * ほかの作品。**題は英字で始める**（登録簿は題の順に並ぶ。名前で探すときに取り違えないよう短い英字の頭にする。
 * librarySyncRecord と同じ）。キーは作品を登録するもの（`novelai.addWork` に道を渡す）
 */
const OTHERS = [
  { title: "B 二の作品", episode: "001_二.txt", line: "　二の作品の本文。", key: "ctrl+alt+shift+b", press: "Control+Alt+Shift+KeyB" },
  { title: "C 三の作品", episode: "001_三.txt", line: "　三の作品の本文。", key: "ctrl+alt+shift+c", press: "Control+Alt+Shift+KeyC" },
  { title: "D 四の作品", episode: "001_四.txt", line: "　四の作品の本文。", key: "ctrl+alt+shift+d", press: "Control+Alt+Shift+KeyD" },
] as const;

const SYNC_ALL_KEY = "ctrl+alt+shift+f";
const SYNC_ALL_PRESS = "Control+Alt+Shift+KeyF";
const SAVE_AND_SYNC_KEY = "ctrl+alt+shift+t";
const SAVE_AND_SYNC_PRESS = "Control+Alt+Shift+KeyT";

/** 置き場の数（作品ごとに1つ） */
const REPO_COUNT = 1 + OTHERS.length;
/** 1つの命令を測る回数 */
const ROUNDS = 3;
/** 合否の線（3回の中央値）。記録は 0.4秒 */
const LIMIT_MS = 3_000;

function libraryOf(workFolder: string): string {
  return path.dirname(workFolder);
}

function rootOf(workFolder: string): string {
  return path.dirname(libraryOf(workFolder));
}

function repoFolders(session: E2ESession): string[] {
  const library = libraryOf(session.workFolder);
  return [session.workFolder, ...OTHERS.map((other) => path.join(library, other.title))];
}

function remoteOf(root: string, index: number): string {
  return path.join(root, `送り先-${index + 1}.git`);
}

function launch(): LaunchOptions {
  const registers = OTHERS.map((other) => ({
    key: other.key,
    command: "novelai.addWork",
    args: { folderPath: "", title: other.title } as Record<string, unknown>,
  }));
  return {
    // 自動の送り直し・取りに行きは切る（測っている最中に git が混まないように）
    settings: { "novelai.git.autoResend": false, "novelai.git.autoFetch": false },
    keybindings: [
      ...registers,
      { key: SYNC_ALL_KEY, command: "novelai.syncAllWorks" },
      { key: SAVE_AND_SYNC_KEY, command: "novelai.saveAndSync" },
    ],
    prepareWork: async ({ workFolder }) => {
      const library = libraryOf(workFolder);
      const root = rootOf(workFolder);
      await initRepoWithFirstCommit(workFolder);
      await addLocalRemote(workFolder, remoteOf(root, 0));
      for (const [index, other] of OTHERS.entries()) {
        const folder = path.join(library, other.title);
        await mkdir(path.join(folder, "本文"), { recursive: true });
        await writeFile(path.join(folder, "本文", other.episode), `${other.line}\n`, "utf8");
        await initRepoWithFirstCommit(folder);
        await addLocalRemote(folder, remoteOf(root, index + 1));
        // keybindings.json はこの準備のあとに書かれるので、道はここで args へ入れる
        registers[index].args = { folderPath: folder, title: other.title };
      }
    },
  };
}

/** ほかの作品を登録する（作品の印ができるまで押し直す。同じ場所の二重の登録は製品が断る） */
async function registerOthers(session: E2ESession): Promise<void> {
  const { page } = session;
  const library = libraryOf(session.workFolder);
  for (const other of OTHERS) {
    const config = path.join(library, other.title, ".aiwriter", "config.json");
    const until = Date.now() + 60_000;
    for (;;) {
      await pressWorkbenchKey(page, other.press);
      const done = await waitUntil(() => existsSync(config), `${config} ができる`, 5_000)
        .then(() => true)
        .catch(() => false);
      if (done) break;
      if (Date.now() > until) throw new Error(`「${other.title}」を登録できません（${await describeNotices(session)}）`);
    }
  }
  // 登録のすぐあとは製品が印を書き足すことがある（librarySyncRecord の registerOther と同じ間）
  await page.waitForTimeout(2_500);
  await clearNotifications(page);
}

/** 登録で増えた作品の印を記録して送り、`git status` が空の状態にする（作者の操作ではない準備） */
async function settleBaseline(repo: string): Promise<void> {
  await gitWhileRunning(repo, ["add", "-A"]);
  if ((await gitWhileRunning(repo, ["status", "--porcelain"])).trim() !== "") {
    await gitWhileRunning(repo, ["commit", "--quiet", "-m", "作品の登録の印"]);
  }
  await gitWhileRunning(repo, ["push", "--quiet"]);
  const left = await porcelainLines(repo);
  if (left.length > 0) throw new Error(`準備の記録のあとも git status が空になりません（${repo}）：${JSON.stringify(left)}`);
}

/** ステータスバーの「未記録 N」の数（無ければ 0） */
async function unrecordedCount(page: Page): Promise<number> {
  for (const text of await statusBarTexts(page)) {
    const match = /未記録\s*(\d+)/.exec(text);
    if (match) return Number(match[1]);
  }
  return 0;
}

/** 押してから確認の窓が出るまでの ms を測り、窓の文を確かめて取りやめる */
async function measureConfirm(session: E2ESession, label: string, press: string): Promise<number> {
  const { page } = session;
  const startedAt = Date.now();
  await pressWorkbenchKey(page, press);
  let shown: string | undefined;
  await waitUntil(async () => ((shown = await dialogText(page)) ?? "").includes("か所を同期します"), `${label}の確認の窓が出る`, 30_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(shown)}／ステータスバー：${JSON.stringify(await statusBarTexts(page))}／${await describeNotices(session, startedAt - 1_000)}）`);
    }
  );
  const elapsed = Date.now() - startedAt;
  expect(shown, `${label}：作品ごとの置き場がすべて同期の相手に入る`).toContain(`${REPO_COUNT}か所を同期します。`);
  // ［同期する］は押さない
  await closeDialog(page);
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test(`作品ごとの置き場が${REPO_COUNT}つのとき、「全作品同期」と「保存・同期」の確認の窓が、押してから ${LIMIT_MS}ms 以内（3回の中央値）に出る`, async () => {
  await withVsCode(
    "同期の確認の窓の速さ",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const root = rootOf(session.workFolder);
      await registerOthers(session);
      const repos = repoFolders(session);
      for (const repo of repos) await settleBaseline(repo);

      // 各作品に記録待ちの変更を1つずつ置く（ディスクへ直に。保存の待ちを挟まない）
      const library = libraryOf(session.workFolder);
      await appendFile(path.join(session.manuscriptFolder, EPISODE), "　足した一行。\n", "utf8");
      for (const other of OTHERS) {
        await appendFile(path.join(library, other.title, "本文", other.episode), "　足した一行。\n", "utf8");
      }
      for (const repo of repos) {
        expect((await porcelainLines(repo)).length, `${repo} に記録待ちがある`).toBeGreaterThan(0);
      }
      /*
        **起動と登録のあとの読み直しが落ち着いてから測る。** 見張りが git を走らせている最中に押すと、
        同じ置き場の取り合いで時間が延びる。ステータスバーの「未記録」が全作品ぶん出るのを待ち、
        さらに少し置く（数え方が作品の合計でなかったときに止まらないよう、待ち切れなくても進む）
      */
      await waitUntil(async () => (await unrecordedCount(page)) >= REPO_COUNT, "ステータスバーに全作品ぶんの「未記録」が出る", 30_000).catch(
        () => undefined
      );
      await page.waitForTimeout(3_000);

      const results: Record<string, number[]> = { 全作品同期: [], 保存・同期: [] };
      for (const [label, press] of [
        ["全作品同期", SYNC_ALL_PRESS],
        ["保存・同期", SAVE_AND_SYNC_PRESS],
      ] as const) {
        for (let round = 1; round <= ROUNDS; round++) {
          const elapsed = await measureConfirm(session, `${label}（${round}回目）`, press);
          results[label].push(elapsed);
          console.log(`[同期の確認の窓] ${label} ${round}回目：置き場 ${REPO_COUNT}件・${elapsed}ms`);
          // 取りやめのあとの読み直しが落ち着くのを待ってから次を押す
          await page.waitForTimeout(1_500);
        }
      }
      for (const [label, values] of Object.entries(results)) {
        console.log(`[同期の確認の窓] ${label}：置き場 ${REPO_COUNT}件・${values.join("ms / ")}ms（中央値 ${median(values)}ms）`);
      }

      // 取りやめたので、何も記録・送信していない
      for (const [index, repo] of repos.entries()) {
        expect((await porcelainLines(repo)).length, `${repo} の記録待ちは残る`).toBeGreaterThan(0);
        const here = (await gitWhileRunning(repo, ["rev-parse", "HEAD"])).trim();
        const there = (await gitWhileRunning(remoteOf(root, index), ["rev-parse", "main"])).trim();
        expect(there, `${repo} の送り先は準備のときのまま`).toBe(here);
      }

      for (const [label, values] of Object.entries(results)) {
        expect(median(values), `${label}の確認の窓まで（${values.join("ms / ")}ms）`).toBeLessThanOrEqual(LIMIT_MS);
      }
    },
    launch()
  );
}, 300_000);

