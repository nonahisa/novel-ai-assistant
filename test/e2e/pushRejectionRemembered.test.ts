/**
 * 送る前に止めた記録（100MB 超のファイル入り）の覚えが、VS Code を起動し直しても残る
 * （画面の自動テスト。設計書5.5.21「自動の送り直しは、同じ記録で断られたら…」の行、作者の答え 2026-11-16「残す」。1.0.16）。
 *
 * - 台：作品フォルダーを git にし、同じ一時フォルダーの裸の置き場を送り先にする（`gitFixture.ts`。
 *   **GitHub には繋がない**。送り先は手元のフォルダーなので、外へは何も出ない）。送っていない記録に
 *   101MB のファイル（`truncate` で作る中身の無いファイル）を入れる。送る前の検査（`findLargeFilesToSend`）が止める
 * - 1回目の起動：作品は起動のあとに登録するので、開いたときの点検はこの作品を見ない。自動の送り直しの鼓動
 *   （1分ごと。画面の外の窓では焦点の戻りを当てにできないので、これをきっかけにする）が送る前に止め、
 *   知らせ（［ログを表示］だけ）を1回出し、ログに「送らなかった」を残す
 * - 閉じたところで保管庫（`state.vscdb` の `novelai.pushRejections`）に HEAD の記録が入っていることを**ファイルで**見る
 * - 2回目の起動：作品は登録済みなので、先に開いたときの点検が走り、**覚えを見て**止める（このときは点検の知らせが出る。
 *   これは点検の報告で、送り直しの知らせではない）。覚えが読めていれば、点検は大きさを調べ直さず、
 *   ログに「開いたとき：送る記録に…送らなかった」が増えない。**ここが覚えの写しの有無を分ける**——
 *   写しが壊れていても、点検が大きさで止めて画面の中の覚えに入れるので、送り直しは黙ってしまう
 * - 1回目に知らせが出るまでの時間＋余裕のあいだ、送り直しの知らせが出ない・送り直しの「送らなかった」が増えない
 * - 送り先の裸の置き場の記録の数が、最初から変わらない（どちらの起動でも送っていない）
 *
 * **AI は呼ばない。**
 */
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { NoticeEntry } from "../../src/core/noticeLog";
import { addLocalRemote, git, initRepoWithFirstCommit } from "./support/gitFixture";
import { recordedNotices } from "./support/noticeRecord";
import { editGlobalState, restartVsCode, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { notificationTexts } from "./support/workbenchDom";

/** 大きなファイルの道（作品フォルダーから。本文の外に置き、原稿の読み取りに拾わせない） */
const BIG_FILE = "資料/e2ememo_大きな素材.bin";
/** GitHub の上限（100MB）を超える大きさ */
const BIG_SIZE = 101 * 1024 * 1024;
/** 保管庫の鍵（`src/features/pushRejectionMemory.ts` の `STORAGE_KEY`） */
const STORAGE_KEY = "novelai.pushRejections";
/** 自動の送り直しが送る前に止めたときのログの見出し（`autoResend.ts`） */
const RESEND_STOPPED_LOG = "自動の送り直し：送る記録に GitHub に送れない大きさのファイルがあるので送らなかった";
/** 開いたときの点検が大きさを調べて止めたときのログの見出し（`handoffSync.ts`。覚えで止めたときは書かない） */
const HANDOFF_STOPPED_LOG = "開いたとき：送る記録に GitHub に送れない大きさのファイルがあるので送らなかった";

/**
 * 自動の送り直しの知らせか（`autoResend.ts` の `noticeRejected`：「置き場：断りの文」、ボタンは［ログを表示］だけ）。
 * 開いたときの点検の報告（「「…」は最後まで通りませんでした（…）」、［同期する］［ログを表示］）とはボタンで分ける
 */
function isResendNotice(entry: NoticeEntry): boolean {
  return (
    entry.message.includes("GitHub に送れない大きさ") &&
    !entry.message.includes("最後まで通りませんでした") &&
    entry.items.length === 1 &&
    entry.items[0] === "ログを表示"
  );
}

async function resendNoticesSince(session: E2ESession, since: number): Promise<NoticeEntry[]> {
  // 時刻は秒の端数で前後しうるので、1秒の余裕を見る
  return (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= since - 1_000 && isResendNotice(entry));
}

/** 作品の操作ログ（同期の記録もここへ書かれる。`.aiwriter/logs/actions.log`） */
async function actionsLog(session: E2ESession): Promise<string> {
  return readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 落ちた文に添える様子：知らせ（記録と右下）とログの末尾 */
async function situation(session: E2ESession, since: number): Promise<string> {
  const notices = (await recordedNotices(session))
    .filter((entry) => Date.parse(entry.at) >= since - 1_000)
    .map((entry) => `${entry.message.replace(/\s+/g, " ").slice(0, 120)}［${entry.items.join("／")}］`);
  const toasts = (await notificationTexts(session.page)).map((text) => text.replace(/\s+/g, " ").slice(0, 120));
  const log = (await actionsLog(session)).split(/\r?\n/).slice(-30).join("\n");
  return `記録の知らせ：${JSON.stringify(notices.slice(-8))}／右下の知らせ：${JSON.stringify(toasts)}\nログの末尾：\n${log}`;
}

async function bareCommitCount(bare: string): Promise<number> {
  return Number((await git(bare, ["rev-list", "--all", "--count"])).trim());
}

test("送る前に100MB超で止めた記録は、VS Code を起動し直しても覚えていて、自動の送り直しは送らず知らせも出さない", async () => {
  let bare = "";
  await withVsCode(
    "送信を断られた覚えの持ち越し",
    [{ name: "001_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const startedAt = Date.now();
      const bareBefore = await bareCommitCount(bare);
      const head = (await git(session.workFolder, ["rev-parse", "HEAD"])).trim();

      // 見張りに状態を読み直させる（登録の直後は、送っていない記録があることをまだ知らないことがある）。
      // `.git` の中の変化は見張りが拾わないので、作品フォルダーにメモを1つ置く
      await writeFile(path.join(session.workFolder, "e2ememo_きっかけ.txt"), "見張りに読み直させるためのメモ\n", "utf8");

      // 1回目：自動の送り直しの鼓動（1分ごと）が送る前に止め、知らせを1回出す
      await waitUntil(async () => (await resendNoticesSince(session, startedAt)).length > 0, "1回目：自動の送り直しの「送れない大きさ」の知らせが出る", 180_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}\n${await situation(session, startedAt)}`);
        }
      );
      const firstNoticeAfterMs = Date.now() - startedAt;
      await waitUntil(async () => (await actionsLog(session)).includes(RESEND_STOPPED_LOG), "1回目：ログに自動の送り直しの「送らなかった」が残る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}\n${await situation(session, startedAt)}`);
        }
      );
      const firstLog = await actionsLog(session);
      expect(countOf(firstLog, HANDOFF_STOPPED_LOG), "1回目は開いたときの点検でなく、自動の送り直しが止めている").toBe(0);
      expect((await resendNoticesSince(session, startedAt)).length, "1回目の送り直しの知らせは1回").toBe(1);
      expect(await bareCommitCount(bare), "1回目：送り先に記録が届いていない").toBe(bareBefore);

      // 閉じたところで、保管庫に覚えが写っていることをファイルで見る
      let saved: unknown;
      await restartVsCode(session, {
        beforeRelaunch: async () => {
          await editGlobalState(session.root, (values) => {
            saved = values[STORAGE_KEY];          });
        },
      });
      const heads =
        typeof saved === "object" && saved !== null
          ? Object.values(saved as Record<string, { head?: unknown }>).map((one) => one?.head)
          : [];
      expect(heads, `保管庫（${STORAGE_KEY}）に送らなかった記録の HEAD が入っている（中身：${JSON.stringify(saved)?.slice(0, 300)}）`).toContain(head);

      // 2回目：1回目に知らせが出るまでの時間＋余裕のあいだ、送り直しの知らせが出ない
      const restartedAt = Date.now();
      const logBefore = await actionsLog(session);
      const holdMs = Math.max(firstNoticeAfterMs + 30_000, 90_000);
      await holdsFor(async () => (await resendNoticesSince(session, restartedAt)).length === 0, "2回目：自動の送り直しの知らせが出ない", holdMs).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}\n${await situation(session, restartedAt)}`);
        }
      );
      const secondLog = (await actionsLog(session)).slice(logBefore.length);
      expect(
        countOf(secondLog, HANDOFF_STOPPED_LOG),
        `2回目：開いたときの点検は覚えで止め、大きさを調べ直していない（覚えが保管庫から読めている）\n${await situation(session, restartedAt)}`
      ).toBe(0);
      expect(countOf(secondLog, RESEND_STOPPED_LOG), "2回目：自動の送り直しは「送らなかった」を書き足していない").toBe(0);
      expect(await bareCommitCount(bare), "2回目：送り先に記録が届いていない").toBe(bareBefore);
    },
    {
      prepareWork: async ({ workFolder }) => {
        bare = path.join(path.resolve(workFolder, "..", ".."), "e2ememo_送り先.git");
        await initRepoWithFirstCommit(workFolder);
        await addLocalRemote(workFolder, bare);
        const big = path.join(workFolder, ...BIG_FILE.split("/"));
        await mkdir(path.dirname(big), { recursive: true });
        await writeFile(big, "");
        await truncate(big, BIG_SIZE);
        await git(workFolder, ["add", "--", BIG_FILE]);
        await git(workFolder, ["commit", "--quiet", "-m", "大きな素材を記録"]);
      },
    }
  );
}, 600_000);
