/**
 * 作者が編集者の提案を決め終えると、採否が編集者の置き場へ送り返される（画面の自動テスト、設計書5.6・6.113。
 * 実機確認リスト 0.119.0 の「編集者が置いた「意見だけ」の提案に作者が［読んだ］を押し、残りも決め終えると…」の
 * 作者の側を機械へ移した。作者の決定 2026-11-01「意見を読んだものは採用に数えない」）。
 *
 * 見張ること：
 * 1. 編集者が返した提案3件（直し2件・意見だけ1件）を提案パネルで、意見は［読んだ］、直しの1件は［適用］、
 *    もう1件は［見送る］で決める。**決め終える前は送り返さない**（送り先の記録が進まない）
 * 2. 最後の1件を決めると、下の帯に「採否を編集者へ送り返しました（採用 1・見送り 1・読まれた 1）。」が出る
 *    （読んだ意見は採用に数えない）
 * 3. 送り先（GitHub の代わりの裸の置き場）の提案の台帳に、3件の採否（accepted・rejected・read）が届いている
 *
 * **GitHub は呼ばない。** 編集用フォルダー（作者の側の写し）は一時フォルダーの中の本物の git の置き場で、
 * 送り先は同じ一時フォルダーの中の裸の置き場。送り返しの道（`shareWithEditor.ts` の `sendToEditor`）は、
 * 送り先が「この機能が作った送り先」（作品の `.aiwriter/editing.json` の `remoteUrl`）と同じでなければ
 * GitHub に非公開かを問い合わせに行く（`verifyKnownDestination`）。製品が「編集者へ渡す」で書くのと同じ記録を
 * 起こす前に置き、送り先の URL を `file:///…`（手元の裸の置き場）にして、記録と送り先の URL を一致させる。
 * **問い合わせの道は通らない**（一致すれば確かめを飛ばす。作成時に確かめてある、という作りのため）。
 * ただし一致の判定（`sameRepository`）は、両方を GitHub の「持ち主/リポジトリ名」として読めたときだけ真になる。
 * `file:///C:/Users/<名前>/…` は「Users」「<名前>」を拾って読める——**一時フォルダーの道の頭（ユーザー名）が
 * 英数字・`._-` の外の機械では読めず、GitHub の非公開の問い合わせへ落ちる**。そこで落ちたら、まずこの依存を疑う。
 *
 * **見ていないもの（作者の手）**：編集者の環境で同期してから「編集者提案確認」を押したときに同じ内訳が出る所
 * （2台目の環境が要る）。**AI は呼ばない。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { HAND_EDIT_CATEGORY, HAND_MEMO_CATEGORY, proposalId } from "../../src/models/proposal";
import { git, initRepoWithFirstCommit } from "./support/gitFixture";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { E2E_WORK_TITLE, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts, pressWorkbenchKey, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。";
const TEXT = `${LINE}\n`;
const FILE = `本文/${EPISODE}`;
const PROPOSER = "画面テスト編集者";

interface HandProposal {
  target: string;
  suggestion: string;
  reason: string;
  category: string;
  time: string;
}

/** 採る直し・見送る直し・読む意見（理由の文で行を見分ける） */
const TO_ACCEPT: HandProposal = { target: "雨の音", suggestion: "雨音", reason: "採る直しの理由", category: HAND_EDIT_CATEGORY, time: "2026-11-01T10:00:00.000Z" };
const TO_REJECT: HandProposal = { target: "終電", suggestion: "最終電車", reason: "見送る直しの理由", category: HAND_EDIT_CATEGORY, time: "2026-11-01T10:01:00.000Z" };
const TO_READ: HandProposal = { target: "駅のホーム", suggestion: "", reason: "読む意見の理由", category: HAND_MEMO_CATEGORY, time: "2026-11-01T10:02:00.000Z" };
const ALL = [TO_ACCEPT, TO_REJECT, TO_READ];

function idOf(entry: HandProposal): string {
  return proposalId(FILE, 1, entry.target, `${entry.suggestion}\u0000${entry.reason}`);
}

/** 前の版の編集者が手で置いた形（`buildHandProposal` と同じ番号の作り方） */
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

const LEDGER_RELATIVE = path.join(".aiwriter", "proposals", "proposals.jsonl");

/** 一時フォルダーの根の中の置き場（作品フォルダーは 根/書庫/作品）。送り先の名前は URL にするので英数字だけ */
function places(root: string): { editing: string; remote: string; remoteUrl: string } {
  const remote = path.join(root, "editing-remote.git");
  return {
    editing: path.join(root, "編集部", `${E2E_WORK_TITLE}-編集用`),
    remote,
    remoteUrl: `file:///${remote.replace(/\\/g, "/")}`,
  };
}

const LAUNCH: LaunchOptions = {
  ...OPEN_PROPOSALS_LAUNCH,
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    const { editing, remote, remoteUrl } = places(root);
    const ledger = `${ALL.map(proposalLine).join("\n")}\n`;

    // 作者の側の編集用フォルダー：編集者が返した3件の入った台帳を記録して、送り先へ送ってある
    await mkdir(path.join(editing, ".aiwriter", "proposals"), { recursive: true });
    await mkdir(path.join(editing, "本文"), { recursive: true });
    await writeFile(path.join(editing, "本文", EPISODE), TEXT, "utf8");
    await writeFile(path.join(editing, LEDGER_RELATIVE), ledger, "utf8");
    await initRepoWithFirstCommit(editing);
    await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
    await git(editing, ["remote", "add", "origin", remoteUrl]);
    await git(editing, ["push", "--quiet", "-u", "origin", "main"]);

    // 作品の台帳：同期で届いた3件（未決）
    await mkdir(path.join(workFolder, ".aiwriter", "proposals"), { recursive: true });
    await writeFile(path.join(workFolder, LEDGER_RELATIVE), ledger, "utf8");
    // どこに編集用フォルダーがあるか（`features/shareWithEditor.ts` の EditingPointer）
    await mkdir(path.join(workFolder, ".aiwriter", "cache"), { recursive: true });
    await writeFile(
      path.join(workFolder, ".aiwriter", "cache", "editing.json"),
      `${JSON.stringify({ folderPath: editing, sharedAt: "2026-11-01T09:00:00.000Z" }, null, 2)}\n`,
      "utf8"
    );
    // この機能が作った送り先の記録（`EditingSite`。作るときに非公開と確かめた送り先として覚えている形）
    await writeFile(path.join(workFolder, ".aiwriter", "editing.json"), `${JSON.stringify({ remoteUrl }, null, 2)}\n`, "utf8");
  },
};

/** 一覧の中で `reason` を含む行 */
function issueRow(frame: Frame, reason: string) {
  return frame.locator("#list .issue", { hasText: reason }).first();
}

/** 行のボタン（`action`）を押し、その行が決まった札に変わるまで待つ */
async function decide(frame: Frame, reason: string, action: "apply" | "dismiss", label: string): Promise<void> {
  const row = issueRow(frame, reason);
  await waitUntil(async () => (await row.count()) > 0, `${label}：行が並ぶ`, 15_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（一覧：${JSON.stringify((await frame.locator("#list").innerText().catch(() => "")).slice(0, 800))}）`);
  });
  const button = row.locator(`button[data-action="${action}"]`).first();
  await button.click();
  // 決めた行はボタンが消える（札だけになる）か、一覧から消える
  await waitUntil(
    async () => (await row.count()) === 0 || (await row.locator(`button[data-action="${action}"]`).count()) === 0,
    `${label}：押したあと、その行が決まった形になる`,
    15_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（行：${JSON.stringify(await row.innerText().catch(() => ""))}／知らせ：${JSON.stringify(await noticesOf(frame))}）`);
  });
}

/** 失敗の文に添える知らせ（行の待ちは面しか持っていないので、面の持ち主の頁から読む） */
async function noticesOf(frame: Frame): Promise<string[]> {
  return notificationTexts(frame.page());
}

async function remoteHead(remote: string, root: string): Promise<string> {
  return (await git(root, [`--git-dir=${remote}`, "rev-parse", "main"])).trim();
}

/** 送り先の提案の台帳にある採否（提案の番号 → 状態） */
async function remoteDecisions(remote: string, root: string): Promise<Map<string, string>> {
  const text = await git(root, [`--git-dir=${remote}`, "show", "main:.aiwriter/proposals/proposals.jsonl"]);
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.kind === "decision" && typeof row.proposalId === "string" && typeof row.status === "string") {
      result.set(row.proposalId, row.status);
    }
  }
  return result;
}

/** 下の帯と右下の知らせのうち、`text` を含むもの */
async function shownWith(page: Page, text: string): Promise<string | undefined> {
  return [...(await statusBarTexts(page)), ...(await notificationTexts(page))].find((one) => one.includes(text));
}

test("編集者の提案を、意見は［読んだ］・直しは［適用］と［見送る］で決め終えると、下の帯に「採否を編集者へ送り返しました（採用 1・見送り 1・読まれた 1）。」が出て、送り先の台帳に3件の採否が届く", async () => {
  await withVsCode(
    "採否を編集者へ送り返す",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, root } = session;
      const { remote } = places(root);
      await clearNotifications(page);
      const before = await remoteHead(remote, root);

      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      let frame: Frame | undefined;
      await waitUntil(
        async () => {
          frame = await proposalPanelFrame(page);
          if (!frame) return false;
          return (await frame.locator("#list .issue").count()) === 3;
        },
        "提案パネルに編集者の提案が3件並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（一覧：${JSON.stringify(frame ? (await frame.locator("#list").innerText().catch(() => "")).slice(0, 800) : "面が無い")}）`);
      });
      const panel = frame as Frame;
      // 意見だけの行は［適用］でなく［読んだ］
      const readButton = issueRow(panel, TO_READ.reason).locator('button[data-action="apply"]').first();
      expect((await readButton.innerText()).trim(), "意見だけの提案のボタンが［読んだ］ではありません").toBe("読んだ");

      /* ── 1. 決め終える前は送らない ── */
      await decide(panel, TO_READ.reason, "apply", "意見を［読んだ］");
      await decide(panel, TO_ACCEPT.reason, "apply", "直しを［適用］");
      await holdsFor(async () => (await remoteHead(remote, root)) === before && (await shownWith(page, "採否を編集者へ送り返しました")) === undefined, "未決が残っている間は送り返さない", 3_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        }
      );
      // 採った直しは本文に入った
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(`${LINE.replace("雨の音", "雨音")}\n`);

      /* ── 2. 最後の1件で送り返す ── */
      await decide(panel, TO_REJECT.reason, "dismiss", "直しを［見送る］");
      let shown: string | undefined;
      // 下の帯の完了の知らせは6秒だけ出るので、押した直後から見続ける
      await waitUntil(async () => (shown = await shownWith(page, "採否を編集者へ送り返しました")) !== undefined, "「採否を編集者へ送り返しました」が出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        }
      );
      expect(shown, `送り返しの知らせ：${shown}`).toContain("採否を編集者へ送り返しました（採用 1・見送り 1・読まれた 1）。");

      /* ── 3. 送り先に3件の採否が届いた ── */
      await waitUntil(async () => (await remoteHead(remote, root)) !== before, "送り先の記録が進む", 15_000);
      const decisions = await remoteDecisions(remote, root);
      expect(Object.fromEntries(decisions), "送り先の台帳の採否").toEqual({
        [idOf(TO_ACCEPT)]: "accepted",
        [idOf(TO_REJECT)]: "rejected",
        [idOf(TO_READ)]: "read",
      });
    },
    LAUNCH
  );
}, 240_000);
