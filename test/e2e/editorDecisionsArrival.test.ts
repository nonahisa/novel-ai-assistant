/**
 * 編集者の環境に、作者が送り返した採否が届く（画面の自動テスト、設計書5.6・5.7.5.9・6.113）。
 * 実機確認リストの次の2つの、編集者の側を機械へ移した：
 *
 * - 337行〔0.120.2〕「編集者の環境（kmizu さん）で、作者が採否を送り返したあとに VS Code を開き直すと、下の帯の
 *   「未取得 1 / 未記録 1」が消えて採否が入り、「作者が提案を決めました（採用 N・見送り N・読まれた N）。」が
 *   1回だけ出る（もう一度開き直しても同じ知らせは出ない）。0.120.0 で足された `.gitignore` の行は戻っている」
 * - 335行〔0.119.0〕の残り「編集者の環境で同期してから詳細メニュー「編集者提案確認」を押すと、同じ内訳が出る」
 *   （作者の側は `editorDecisionsReturn` が見ている）
 *
 * 1. 開き直し（337）：編集者の写しの `.gitignore` に、0.120.0 までの版が足した行（`.aiwriter/cache/`）が
 *    記録されないまま残り（未記録 1）、作者は採否3件（採用・見送り・読まれた）を送ってある（未取得 1）。
 *    下の帯に「未取得 1 / 未記録 1」が出ている状態で VS Code を閉じて開き直すと、開いたときの点検が
 *    `.gitignore` を記録済みの形へ戻し（`features/editorGitignoreRescue.ts`）、採否を受け取り、
 *    「作者が提案を決めました（採用 1・見送り 1・読まれた 1）。」が1回だけ出て、下の帯から2つの数が消える。
 *    もう一度開き直しても、同じ知らせは出ない（`features/decisionMemory.ts` の覚え）
 * 2. 同期してから「編集者提案確認」（335）：起きている間に作者が採否を送り、「保存・同期」の確認の窓
 *    ［受け取る］で受け取ると、「作者が提案を決めました（…）。」が出て、続けて「編集者提案確認」を押すと
 *    「未決の提案はありません（これまでに 3 件の提案がありました）。これまでの採否：採用 1・見送り 1・読まれた 1。」
 *
 * 知らせは右下の知らせと、**知らせの記録ファイル**（`support/noticeRecord.ts`）の両方で見る。開き直しの部品
 * （`restartVsCode`）は最後に右下の知らせを閉じるので、開いた直後の点検の知らせは記録のほうで数える。
 *
 * **GitHub は呼ばない。** 作品フォルダー（編集用リポジトリの写し）を本物の git の置き場にし、送り先は同じ
 * 一時フォルダーの中の裸の置き場、「作者の側」はそれを clone したフォルダー。写しの印
 * （`.aiwriter/editor-share-manifest.json`）を置き、`.aiwriter/editing.json` は置かない（`isEditorCopyFolder`）。
 * 登録で書かれる印（config.json）は、起こしたあとに記録して送っておく（作者から届いた写しには記録済みで入っている形）。
 * 自動の送り直し・自動の取りに行きは切る。**AI は呼ばない。**
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { HAND_EDIT_CATEGORY, HAND_MEMO_CATEGORY, proposalId } from "../../src/models/proposal";
import { describeNotices, recordedNotices, waitForNotice } from "./support/noticeRecord";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { runCommand } from "./support/quickInput";
import { restartVsCode, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, pressDialogButton, quickInputWaitContext, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。";
const FILE = `本文/${EPISODE}`;
const PROPOSER = "画面テスト編集者";
const LEDGER_RELATIVE = path.join(".aiwriter", "proposals", "proposals.jsonl");

/** 作者の環境で整えられた `.gitignore` の行（`editorMenuFlow.test.ts` と同じ見本。`workRegistry.ts` の `IGNORED_PATHS` の写し） */
const AUTHOR_GITIGNORE = [
  ".aiwriter/cache/",
  ".aiwriter/logs/",
  ".aiwriter/exports/",
  ".aiwriter/generated/",
  ".aiwriter/reports/",
  ".aiwriter/external-access.json",
  ".aiwriter/history/spotlight.jsonl",
  ".aiwriter/ai-instruction-usage.json",
  ".novelai-recovery/",
  "exports/",
];
/**
 * 0.120.0 までの版が、写しの `.gitignore` の末尾へ足していた行（`editorGitignoreRescue.ts` の冒頭）。
 * 作者の側は `!.aiwriter/cache/`（`novelai.git.syncCache: true`）を送っていたが、見本では作者の `.gitignore` に
 * もう `.aiwriter/cache/` があるので、足された行は同じ行の2つ目になる（戻す判定は「拡張機能の行だけが末尾に
 * 足されたか」なので同じに働く。`!.aiwriter/cache/` を入れると、戻したあと製品が書くキャッシュが未記録に数えられ、取り込みが止まる）
 */
const ADDED_BY_OLD_VERSION = ".aiwriter/cache/";

interface HandProposal {
  target: string;
  suggestion: string;
  reason: string;
  category: string;
  time: string;
  status: "accepted" | "rejected" | "read";
}

/** 編集者が返した3件と、作者が決めた採否（直しを採る・直しを見送る・意見を読む） */
const RETURNED: HandProposal[] = [
  { target: "雨の音", suggestion: "雨音", reason: "採られる直しの理由", category: HAND_EDIT_CATEGORY, time: "2026-11-01T10:00:00.000Z", status: "accepted" },
  { target: "終電", suggestion: "最終電車", reason: "見送られる直しの理由", category: HAND_EDIT_CATEGORY, time: "2026-11-01T10:01:00.000Z", status: "rejected" },
  { target: "駅のホーム", suggestion: "", reason: "読まれる意見の理由", category: HAND_MEMO_CATEGORY, time: "2026-11-01T10:02:00.000Z", status: "read" },
];

function idOf(entry: HandProposal): string {
  return proposalId(FILE, 1, entry.target, `${entry.suggestion}\u0000${entry.reason}`);
}

function proposalLine(entry: HandProposal): string {
  return JSON.stringify({
    kind: "proposal",
    id: idOf(entry),
    time: entry.time,
    proposer: PROPOSER,
    file: FILE,
    line: 1,
    original: LINE,
    target: entry.target,
    suggestion: entry.suggestion,
    reason: entry.reason,
    category: entry.category,
  });
}

/** 作者が決めた採否の行（`models/proposal.ts` の `ProposalDecision`） */
function decisionLine(entry: HandProposal, index: number): string {
  return JSON.stringify({
    kind: "decision",
    proposalId: idOf(entry),
    time: `2026-11-03T12:0${index}:00.000Z`,
    decidedBy: "作者",
    status: entry.status,
    note: "",
  });
}

const DECIDED = "作者が提案を決めました（採用 1・見送り 1・読まれた 1）。";

function places(root: string): { remote: string; author: string } {
  return { remote: path.join(root, "送り先.git"), author: path.join(root, "作者の機械") };
}

const LAUNCH: LaunchOptions = {
  settings: {
    "novelai.mode": "editor",
    "novelai.git.autoResend": false,
    "novelai.git.autoFetch": false,
    "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" },
  },
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    const { remote, author } = places(root);
    await mkdir(path.join(workFolder, ".aiwriter", "proposals"), { recursive: true });
    await writeFile(path.join(workFolder, ".aiwriter", "editor-share-manifest.json"), "{}\n", "utf8");
    await writeFile(path.join(workFolder, ".gitignore"), `${AUTHOR_GITIGNORE.join("\n")}\n`, "utf8");
    // 編集者が「校閲を終えて返す」で返した3件（記録して送り先へ送ってある）
    await writeFile(path.join(workFolder, LEDGER_RELATIVE), `${RETURNED.map(proposalLine).join("\n")}\n`, "utf8");
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, remote);
    await git(root, ["clone", "--quiet", remote, author]);
    await git(author, ["config", "user.name", "作者"]);
    await git(author, ["config", "user.email", "e2e-author@example.invalid"]);
    await git(author, ["config", "core.autocrlf", "false"]);
  },
};

/**
 * 登録のあとの手元を、記録して送ってある形にする（作者から届いた写しは、登録の印まで記録済みで入っている）。
 * 起動の直後に製品が書き足すものが落ち着くのを待ってから記録する
 */
async function settleEditorSide(session: E2ESession): Promise<void> {
  const { page, workFolder } = session;
  await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "作品の登録の印（config.json）ができる", 30_000);
  await page.waitForTimeout(2_500);
  if ((await porcelainLines(workFolder)).length > 0) {
    await gitWhileRunning(workFolder, ["add", "-A"]);
    await gitWhileRunning(workFolder, ["commit", "--quiet", "-m", "登録の印"]);
  }
  await gitWhileRunning(workFolder, ["push", "--quiet"]);
}

/** 作者の側：最新を受け取り、採否3件を台帳へ足して送る */
async function authorSendsDecisions(session: E2ESession): Promise<string> {
  const { author } = places(session.root);
  await git(author, ["pull", "--quiet", "--ff-only"]);
  await appendFile(path.join(author, LEDGER_RELATIVE), `${RETURNED.map(decisionLine).join("\n")}\n`, "utf8");
  await git(author, ["commit", "--quiet", "-am", "採否を編集者へ送り返す"]);
  await git(author, ["push", "--quiet"]);
  return (await git(author, ["rev-parse", "HEAD"])).trim();
}

/** 記録ファイルにある `text` を含む知らせの数（`since` より後） */
async function countRecorded(session: E2ESession, text: string, since: number): Promise<number> {
  return (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(text)).length;
}

async function statusBarSyncText(page: Page): Promise<string> {
  return (await statusBarTexts(page)).filter((text) => /未取得|未記録|未送信|競合/.test(text)).join(" ／ ");
}

test("作者が採否を送り返したあとに開き直すと、写しの .gitignore が戻り、下の帯の「未取得 1 / 未記録 1」が消えて採否が入り、「作者が提案を決めました」が1回だけ出て、もう一度開き直しても出ない", async () => {
  await withVsCode(
    "開き直して作者の採否を受け取る",
    [{ name: EPISODE, text: `${LINE}\n` }],
    async (session) => {
      const { workFolder } = session;
      await settleEditorSide(session);
      const gitignore = path.join(workFolder, ".gitignore");
      const committedGitignore = await gitWhileRunning(workFolder, ["show", "HEAD:.gitignore"]);

      /* ── 開き直す前の形：作者が採否を送り、0.120.0 の行が記録されずに残っている ── */
      const authorHead = await authorSendsDecisions(session);
      await gitWhileRunning(workFolder, ["fetch", "--quiet"]);
      // fetch のあとに作業木を変える（作品フォルダーの見張りが、変わったのを拾って状態を読み直す）
      await appendFile(gitignore, `${ADDED_BY_OLD_VERSION}\n`, "utf8");
      const dirty = await porcelainLines(workFolder);
      expect(dirty, "準備の段で、.gitignore のほかにも記録していない変更があります").toEqual([" M .gitignore"]);
      await waitUntil(
        async () => {
          const text = await statusBarSyncText(session.page);
          return text.includes("未取得 1") && text.includes("未記録 1");
        },
        "開き直す前に、下の帯に「未取得 1 / 未記録 1」が出る",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(session.page))}／状態：${JSON.stringify(dirty)}）`);
      });
      expect(await countRecorded(session, "作者が提案を決めました", 0), "開き直す前に、採否の知らせが出ています").toBe(0);

      /* ── 開き直す：.gitignore が戻り、採否を受け取り、知らせが1回 ── */
      const firstReopen = Date.now();
      await restartVsCode(session);
      await waitForNotice(session, (message) => message.includes("作者が提案を決めました"), "開き直したあと「作者が提案を決めました」が出る", {
        since: firstReopen,
        timeoutMs: 90_000,
      }).then((message) => expect(message).toContain(DECIDED));
      await waitUntil(async () => (await gitWhileRunning(workFolder, ["rev-parse", "HEAD"])).trim() === authorHead, "作者の採否の記録まで受け取る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（状態：${await gitWhileRunning(workFolder, ["status", "--short", "--branch"])}／${await describeNotices(session, firstReopen)}）`);
        }
      );
      expect((await readFile(path.join(workFolder, LEDGER_RELATIVE), "utf8")).match(/"kind":"decision"/g)?.length ?? 0, "台帳に採否3件が入っていません").toBe(3);
      expect((await readFile(gitignore, "utf8")).replace(/\r\n/g, "\n"), "0.120.0 の版が足した .gitignore の行が戻っていません").toBe(committedGitignore.replace(/\r\n/g, "\n"));
      expect(await porcelainLines(workFolder), "受け取ったあとも記録していない変更が残っています").toEqual([]);
      await waitUntil(async () => !/未取得|未記録/.test(await statusBarSyncText(session.page)), "下の帯から「未取得」「未記録」が消える", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(session.page))}）`);
        }
      );
      // 知らせは1回だけ（同じ点検の中で二度数えない）
      await session.page.waitForTimeout(3_000);
      expect(await countRecorded(session, "作者が提案を決めました", firstReopen), `知らせが2回以上出ました（${await describeNotices(session, firstReopen)}）`).toBe(1);

      /* ── もう一度開き直す：同じ知らせは出ない ── */
      const secondReopen = Date.now();
      await restartVsCode(session);
      await holdsFor(
        async () =>
          (await countRecorded(session, "作者が提案を決めました", secondReopen)) === 0 &&
          !(await notificationTexts(session.page)).some((text) => text.includes("作者が提案を決めました")),
        "もう一度開き直しても「作者が提案を決めました」は出ない",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeNotices(session, secondReopen)}）`);
      });
    },
    LAUNCH
  );
}, 360_000);

test("起きている間に作者が採否を送り、「保存・同期」の［受け取る］で受け取ると「作者が提案を決めました」が出て、「編集者提案確認」に同じ内訳（採用 1・見送り 1・読まれた 1）が出る", async () => {
  await withVsCode(
    "同期して作者の採否を見る",
    [{ name: EPISODE, text: `${LINE}\n` }],
    async (session) => {
      const { page, workFolder } = session;
      await settleEditorSide(session);
      const authorHead = await authorSendsDecisions(session);
      await clearNotifications(page);
      const since = Date.now();

      /* ── 保存・同期 → 確認の窓［受け取る］ ── */
      await runCommand(page, "保存・同期");
      let dialog = "";
      await waitUntil(async () => (dialog = (await dialogText(page)) ?? "").includes("作者の最新の原稿を受け取ります"), "受け取りの確認の窓が出る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(dialog)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
        }
      );
      await pressDialogButton(page, "受け取る");
      await waitUntil(async () => (await gitWhileRunning(workFolder, ["rev-parse", "HEAD"])).trim() === authorHead, "作者の採否の記録まで受け取る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（状態：${await gitWhileRunning(workFolder, ["status", "--short", "--branch"])}／${await describeNotices(session, since)}）`);
        }
      );
      const arrived = await waitForNotice(session, (message) => message.includes("作者が提案を決めました"), "受け取ったあと「作者が提案を決めました」が出る", {
        since,
        timeoutMs: 30_000,
      });
      expect(arrived).toContain(DECIDED);

      /* ── 編集者提案確認 → 同じ内訳 ── */
      await clearNotifications(page);
      const asked = Date.now();
      await runCommand(page, "編集者提案確認");
      const summary = await waitForNotice(session, (message) => message.includes("これまでの採否"), "「編集者提案確認」で採否の内訳が出る", {
        since: asked,
        timeoutMs: 20_000,
      });
      expect(summary).toContain(`未決の提案はありません（これまでに ${RETURNED.length} 件の提案がありました）。`);
      expect(summary, "作者の側の送り返しの知らせと内訳が違います（意見を読んだものを採用に数えていないか）").toContain("これまでの採否：採用 1・見送り 1・読まれた 1。");
    },
    LAUNCH
  );
}, 300_000);
