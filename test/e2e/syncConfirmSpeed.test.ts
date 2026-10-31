/**
 * 「全作品同期」「保存・同期」の確認の窓と、開いたときの点検が早く終わる（0.115.2、commit 86fcc341。
 * 画面の自動テスト、設計書6.113。リーダーの依頼 2026-10-31、作者の許可「今席にいるので、必要なら回してください」）。
 *
 * 何を見張るか：
 * - 0.115.2 で、同期の前の状態調べを「置き場（git のリポジトリ）ごとに1回」に改め、全作品同期の fetch を
 *   置き場ごとに同時に走らせた。測定の記録（docs/measurements/2026-10-29-非AIの速さ.md）では、写しで確認の窓まで
 *   1,316ms・git 73回 → 396ms・24回。開いたときの点検（点検 終了）は 4.2秒 → 1.9秒
 * - 本物の VS Code で、各作品に記録待ちの変更を置いてから、キーで命令を押した瞬間から確認の窓
 *   （`syncAllWorks.ts` の `confirm`）が出るまでの時間を測る。**確認の窓では［同期する］を押さずに取りやめる**（Esc）。
 *   置き場の形は2通り：
 *   - 作品ごとに別の置き場（4つ）
 *   - **作者の書庫と同じ形**：置き場（git）は書庫1つで、その中に作品7つ
 * - 書庫の形では、開いたときの点検の時間も測る。製品が保管庫のログ（`.aiwriter/logs/actions.log`）へ
 *   毎回書く「起動の所要時間」の1行（設計書6.107）の「点検 開始」「点検 終了」を読む（**製品に口は足さない**）。
 *   VS Code を3回開き直して3回分を読む
 * - 時間はテストの出力へ書き出す（`[同期の確認の窓]`・`[開いたときの点検]` の行。通ったときは既定の出力に
 *   出ないので、数字を読むときは `--reporter=verbose --silent=false` を付けて走らせる）。合否の線は揺れに強いよう、
 *   確認の窓は3回の中央値が 3,000ms 以内（記録の 0.4秒に対して緩くとった）。点検は10秒で見切られて
 *   「点検 未了」にならないことだけを見る
 * - 「保存・同期」（`saveAndSyncAll` → 同じ `syncAllWorks`）も同じ窓なので、同じ形で測る。
 *   「GitHubと同期」（gitSync）は確認の窓でなく選ぶ画面を出すので、ここでは測らない
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts` の
 * `addLocalRemote`）で、fetch も手元のフォルダーどうしで済む。押すのは使い捨ての keybindings.json に
 * 足したキー（コマンドパレットを通すと、打鍵と行の出現待ちが時間に混ざる）。
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { describeNotices } from "./support/noticeRecord";
import { addLocalRemote, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { SHOW_SIDEBAR_KEY } from "./support/sidebar";
import { restartVsCode, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, closeDialog, dialogText, pressWorkbenchKey, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "　一話の本文。";

interface OtherWork {
  title: string;
  episode: string;
  line: string;
  /** 登録するキー（`novelai.addWork` に道を渡す） */
  key: string;
  press: string;
}

/**
 * ほかの作品。**題は英字で始める**（登録簿は題の順に並ぶ。名前で探すときに取り違えないよう短い英字の頭にする。
 * librarySyncRecord と同じ）
 */
const ALL_OTHERS: readonly OtherWork[] = [
  { title: "B 二の作品", episode: "001_二.txt", line: "　二の作品の本文。", key: "ctrl+alt+shift+b", press: "Control+Alt+Shift+KeyB" },
  { title: "C 三の作品", episode: "001_三.txt", line: "　三の作品の本文。", key: "ctrl+alt+shift+c", press: "Control+Alt+Shift+KeyC" },
  { title: "D 四の作品", episode: "001_四.txt", line: "　四の作品の本文。", key: "ctrl+alt+shift+d", press: "Control+Alt+Shift+KeyD" },
  { title: "E 五の作品", episode: "001_五.txt", line: "　五の作品の本文。", key: "ctrl+alt+shift+e", press: "Control+Alt+Shift+KeyE" },
  { title: "G 六の作品", episode: "001_六.txt", line: "　六の作品の本文。", key: "ctrl+alt+shift+g", press: "Control+Alt+Shift+KeyG" },
  { title: "H 七の作品", episode: "001_七.txt", line: "　七の作品の本文。", key: "ctrl+alt+shift+h", press: "Control+Alt+Shift+KeyH" },
];

const SYNC_ALL_KEY = "ctrl+alt+shift+f";
const SYNC_ALL_PRESS = "Control+Alt+Shift+KeyF";
const SAVE_AND_SYNC_KEY = "ctrl+alt+shift+t";
const SAVE_AND_SYNC_PRESS = "Control+Alt+Shift+KeyT";
/** 左の列（作品一覧）を出すキー（`support/sidebar.ts` の `SHOW_SIDEBAR_KEY`） */
const SHOW_SIDEBAR_PRESS = "Control+Alt+Shift+KeyJ";

/** 1つの命令を測る回数・開き直す回数 */
const ROUNDS = 3;
/** 合否の線（3回の中央値）。記録は 0.4秒 */
const LIMIT_MS = 3_000;

/**
 * 置き場の形。
 * - `perWork`：作品ごとに別の置き場（作品の数だけ git と送り先がある）
 * - `library`：書庫1つが置き場（作者の書庫と同じ形）。送り先も1つ
 */
type Layout = "perWork" | "library";

interface Scenario {
  layout: Layout;
  others: readonly OtherWork[];
}

const PER_WORK: Scenario = { layout: "perWork", others: ALL_OTHERS.slice(0, 3) };
const LIBRARY: Scenario = { layout: "library", others: ALL_OTHERS };

function libraryOf(workFolder: string): string {
  return path.dirname(workFolder);
}

function rootOf(workFolder: string): string {
  return path.dirname(libraryOf(workFolder));
}

/** 置き場（git の根）の一覧 */
function repoFolders(session: E2ESession, scenario: Scenario): string[] {
  const library = libraryOf(session.workFolder);
  if (scenario.layout === "library") return [library];
  return [session.workFolder, ...scenario.others.map((other) => path.join(library, other.title))];
}

function remoteOf(root: string, index: number): string {
  return path.join(root, `送り先-${index + 1}.git`);
}

function launchFor(scenario: Scenario, settings: Record<string, unknown>): LaunchOptions {
  const registers = scenario.others.map((other) => ({
    key: other.key,
    command: "novelai.addWork",
    args: { folderPath: "", title: other.title } as Record<string, unknown>,
  }));
  return {
    settings,
    keybindings: [
      ...registers,
      { key: SYNC_ALL_KEY, command: "novelai.syncAllWorks" },
      { key: SAVE_AND_SYNC_KEY, command: "novelai.saveAndSync" },
      { key: SHOW_SIDEBAR_KEY, command: "workbench.view.extension.novelai" },
    ],
    prepareWork: async ({ workFolder }) => {
      const library = libraryOf(workFolder);
      const root = rootOf(workFolder);
      for (const [index, other] of scenario.others.entries()) {
        const folder = path.join(library, other.title);
        await mkdir(path.join(folder, "本文"), { recursive: true });
        await writeFile(path.join(folder, "本文", other.episode), `${other.line}\n`, "utf8");
        // keybindings.json はこの準備のあとに書かれるので、道はここで args へ入れる
        registers[index].args = { folderPath: folder, title: other.title };
      }
      if (scenario.layout === "library") {
        await initRepoWithFirstCommit(library);
        await addLocalRemote(library, remoteOf(root, 0));
        return;
      }
      await initRepoWithFirstCommit(workFolder);
      await addLocalRemote(workFolder, remoteOf(root, 0));
      for (const [index, other] of scenario.others.entries()) {
        const folder = path.join(library, other.title);
        await initRepoWithFirstCommit(folder);
        await addLocalRemote(folder, remoteOf(root, index + 1));
      }
    },
  };
}

/** ほかの作品を登録する（作品の印ができるまで押し直す。同じ場所の二重の登録は製品が断る） */
async function registerOthers(session: E2ESession, scenario: Scenario): Promise<void> {
  const { page } = session;
  const library = libraryOf(session.workFolder);
  for (const other of scenario.others) {
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

/** 作品を登録し、印を記録・送信してから、各作品の話に1行足して記録待ちにする */
async function prepareChanges(session: E2ESession, scenario: Scenario): Promise<string[]> {
  await registerOthers(session, scenario);
  const repos = repoFolders(session, scenario);
  for (const repo of repos) await settleBaseline(repo);
  // 各作品に記録待ちの変更を1つずつ置く（ディスクへ直に。保存の待ちを挟まない）
  const library = libraryOf(session.workFolder);
  await appendFile(path.join(session.manuscriptFolder, EPISODE), "　足した一行。\n", "utf8");
  for (const other of scenario.others) {
    await appendFile(path.join(library, other.title, "本文", other.episode), "　足した一行。\n", "utf8");
  }
  for (const repo of repos) {
    expect((await porcelainLines(repo)).length, `${repo} に記録待ちがある`).toBeGreaterThan(0);
  }
  return repos;
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
async function measureConfirm(session: E2ESession, label: string, press: string, repoCount: number): Promise<number> {
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
  expect(shown, `${label}：置き場がすべて同期の相手に入る`).toContain(`${repoCount}か所を同期します。`);
  // ［同期する］は押さない
  await closeDialog(page);
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 全作品同期と保存・同期の確認の窓を3回ずつ測り、出力へ書いて、何も送っていないことと合否を見る */
async function measureBoth(session: E2ESession, scenario: Scenario, repos: readonly string[]): Promise<void> {
  const { page } = session;
  const root = rootOf(session.workFolder);
  const workCount = 1 + scenario.others.length;
  const where = `置き場 ${repos.length}件・作品 ${workCount}件`;
  /*
    **起動と登録のあとの読み直しが落ち着いてから測る。** 見張りが git を走らせている最中に押すと、
    同じ置き場の取り合いで時間が延びる。ステータスバーの「未記録」が作品ぶん出るのを待ち、
    さらに少し置く（数え方が作品の合計でなかったときに止まらないよう、待ち切れなくても進む）
  */
  await waitUntil(async () => (await unrecordedCount(page)) >= workCount, "ステータスバーに全作品ぶんの「未記録」が出る", 30_000).catch(
    () => undefined
  );
  await page.waitForTimeout(3_000);

  const results: Record<string, number[]> = { 全作品同期: [], 保存・同期: [] };
  for (const [label, press] of [
    ["全作品同期", SYNC_ALL_PRESS],
    ["保存・同期", SAVE_AND_SYNC_PRESS],
  ] as const) {
    for (let round = 1; round <= ROUNDS; round++) {
      const elapsed = await measureConfirm(session, `${label}（${round}回目）`, press, repos.length);
      results[label].push(elapsed);
      console.log(`[同期の確認の窓] ${label} ${round}回目：${where}・${elapsed}ms`);
      // 取りやめのあとの読み直しが落ち着くのを待ってから次を押す
      await page.waitForTimeout(1_500);
    }
  }
  for (const [label, values] of Object.entries(results)) {
    console.log(`[同期の確認の窓] ${label}：${where}・${values.join("ms / ")}ms（中央値 ${median(values)}ms）`);
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
}

/** 自動の送り直し・取りに行きは切る（測っている最中に git が混まないように） */
const QUIET_SYNC = { "novelai.git.autoResend": false, "novelai.git.autoFetch": false };

test(`作品ごとの置き場が${1 + PER_WORK.others.length}つのとき、「全作品同期」と「保存・同期」の確認の窓が、押してから ${LIMIT_MS}ms 以内（3回の中央値）に出る`, async () => {
  await withVsCode(
    "同期の確認の窓の速さ（作品ごとの置き場）",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const repos = await prepareChanges(session, PER_WORK);
      await measureBoth(session, PER_WORK, repos);
    },
    launchFor(PER_WORK, QUIET_SYNC)
  );
}, 300_000);

test(`書庫1つ（置き場1つ）に作品${1 + LIBRARY.others.length}つのとき、「全作品同期」と「保存・同期」の確認の窓が、押してから ${LIMIT_MS}ms 以内（3回の中央値）に出る`, async () => {
  await withVsCode(
    "同期の確認の窓の速さ（書庫の形）",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const repos = await prepareChanges(session, LIBRARY);
      await measureBoth(session, LIBRARY, repos);
    },
    launchFor(LIBRARY, QUIET_SYNC)
  );
}, 300_000);

/** 保管庫のログ（`user-data/User/globalStorage/<拡張機能>/.aiwriter/logs/actions.log`）を探す */
async function vaultLogFiles(session: E2ESession): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.startsWith("actions") && entry.name.endsWith(".log") && path.basename(folder) === "logs") found.push(full);
    }
  };
  await walk(path.join(session.root, "user-data", "User", "globalStorage"), 0);
  return found;
}

/** 保管庫のログにある「起動の所要時間」の行（古い順） */
async function startupLines(session: E2ESession): Promise<string[]> {
  const lines: string[] = [];
  for (const file of await vaultLogFiles(session)) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) if (line.includes("起動の所要時間：")) lines.push(line);
  }
  return lines;
}

function millisOf(line: string, label: string): number | undefined {
  const match = new RegExp(`${label} ([\\d,]+)ms`).exec(line);
  return match ? Number(match[1].replace(/,/g, "")) : undefined;
}

test(`書庫1つに作品${1 + LIBRARY.others.length}つのとき、開いたときの点検が10秒で見切られずに終わる（起動の所要時間の行の「点検 終了」を3回読む）`, async () => {
  await withVsCode(
    "開いたときの点検の速さ（書庫の形）",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      await prepareChanges(session, LIBRARY);
      const workCount = 1 + LIBRARY.others.length;
      /*
        **作品一覧の列を開いたまま開き直す。** 「起動の所要時間」の行は作品一覧の初回描画を待って書かれる
        （一覧が描かれないと書かれない）。作者の普段の起動と同じく、列が開いた状態で起こす（測定の記録と同じ手順）
      */
      await pressWorkbenchKey(session.page, SHOW_SIDEBAR_PRESS);
      await waitUntil(
        async () => (await session.page.locator(`.monaco-list-row[aria-expanded][aria-label*="${LIBRARY.others[0].title}"]`).count()) > 0,
        "作品一覧に作品の行が出る（題の順で先頭に来る英字の作品で見る）",
        30_000
      );
      await session.page.waitForTimeout(2_000);
      const ends: number[] = [];
      const spans: number[] = [];
      for (let round = 1; round <= ROUNDS; round++) {
        const before = (await startupLines(session)).length;
        await restartVsCode(session);
        let line = "";
        await waitUntil(
          async () => {
            const lines = await startupLines(session);
            if (lines.length <= before) return false;
            line = lines[lines.length - 1];
            return true;
          },
          `${round}回目の開き直しの「起動の所要時間」の行`,
          60_000
        ).catch(async (error: unknown) => {
          const files = await vaultLogFiles(session);
          throw new Error(`${String(error)}（保管庫のログ：${JSON.stringify(files)}／起動の行の数：${(await startupLines(session)).length}）`);
        });
        console.log(`[開いたときの点検] ${round}回目：${line.replace(/^.*起動の所要時間：/, "")}`);
        expect(line, `${round}回目：作品 ${workCount} 件で開いた`).toContain(`（作品 ${workCount}`);
        expect(line, `${round}回目：点検が10秒で見切られずに終わった`).not.toContain("点検 未了");
        const start = millisOf(line, "点検 開始");
        const end = millisOf(line, "点検 終了");
        expect(start, `${round}回目：「点検 開始」がある`).toBeDefined();
        expect(end, `${round}回目：「点検 終了」がある`).toBeDefined();
        ends.push(end as number);
        spans.push((end as number) - (start as number));
        // 点検のあとの読み直しが落ち着いてから閉じる
        await session.page.waitForTimeout(2_000);
      }
      console.log(
        `[開いたときの点検] 作品 ${workCount}件・置き場1つ：点検 終了 ${ends.join("ms / ")}ms（中央値 ${median(ends)}ms）` +
          `／点検 開始から終了まで ${spans.join("ms / ")}ms（中央値 ${median(spans)}ms）`
      );
    },
    // 点検は既定のまま（取りに行きも走らせる。送り先は手元）。送り直しだけ切る（未送信は無いが、念のため）
    launchFor(LIBRARY, { "novelai.git.autoResend": false })
  );
}, 400_000);
