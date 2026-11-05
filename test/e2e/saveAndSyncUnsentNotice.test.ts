/**
 * 「保存・同期」で GitHub へ届かなかったときの知らせ（画面の自動テスト、設計書5.5.18・6.113。
 * 実機確認リスト 0.125.3 の項目「ネットを切ったまま下の帯から『保存・同期』…」を機械へ移した。
 * 作者の裁定 2026-11-03 夜「作者が押した同期で GitHub へ届かなかったときは1回だけ知らせる」）。
 *
 * 見張ること：
 * 1. 送り先へ届かない作品で本文を書き換え、下の帯の「未記録 N」→「N か所を同期します」の確認の窓で
 *    ［同期する］を押すと、「手元には記録しました。GitHub へは届いていません（1作品）。ネットにつながったら
 *    自動で送ります。」で**始まる**警告が出る。旧文言「記録 1か所を済ませました。」では始まらない
 * 2. その警告は**1回だけ**。閉じたあと、自動の送り直しが失敗しても（ログに「自動の送り直しに失敗」が
 *    残るのを待つ）、同じ文の知らせは増えない
 * 3. 送り先を元に戻すと、自動の送り直し（きっかけ interval か focus）で送り先に記録が届き、そのときは
 *    知らせ（右下・中央の窓）を何も出さない。製品が出すのは下の帯の消える一言だけ（`describeResent`）
 *
 * **ネットは切らない。** 送り先（origin）の URL を、同じ一時フォルダーの中の「無い置き場」へ差し替える。
 * 製品と同じ `git push` が失敗すればよく、取りに行く（fetch）も同じく失敗する——回線の無いときと同じ形
 * （単体の `syncAllWorksRun.test.ts`「送信が届かなかったとき」も fetch・push の両方を落としている）。
 * **GitHub は呼ばない。** 送り先は裸の置き場（`support/gitFixture.ts` の `addLocalRemote`）。
 *
 * 送り直しは interval（鼓動1分ごと、間隔を最小の1分に設定）で起きるのを待つ。テストから focus
 * （ウィンドウへ戻ったとき）は起こさない——画面テストの窓は作者の画面の焦点を取らない決まり
 * （`vscodeApp.ts` の `keepOutOfTheWay`）で、焦点を移すと作者の打鍵を奪う。ただ VS Code が勝手に
 * focus を出して先に送ることがあるので、どちらのきっかけでも通す。そのぶん1件が数分かかる。
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit, porcelainLines } from "./support/gitFixture";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, pressDialogButton, quickInputWaitContext, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "　一話の本文。";
const EDITED_LINE = "　一話の本文（ネットの無いあいだに直した）。";

/** 届かなかった知らせの書き出し（`core/syncAllPlan.ts` の `describeUnsent`）。作品は1つ */
const UNSENT_HEAD = "手元には記録しました。GitHub へは届いていません（1作品）。";
const UNSENT_KEY = "GitHub へは届いていません";
/** 0.125.3 より前の書き出し。作者が「同期しました」と読んだ文 */
const OLD_HEAD = "記録 1か所を済ませました。";

function launchOptions(): LaunchOptions {
  return {
    // 送り直しは入（既定）のまま、間隔だけ最小の1分にする。取りに行く見張りは切る（押す前の状態を崩さない）
    settings: { "novelai.git.autoResend": true, "novelai.git.autoResendIntervalMinutes": 1, "novelai.git.autoFetch": false },
    prepareWork: async ({ workFolder }) => {
      await initRepoWithFirstCommit(workFolder);
      await addLocalRemote(workFolder, remoteFolderOf(workFolder));
    },
  };
}

function remoteFolderOf(workFolder: string): string {
  return path.join(path.dirname(path.dirname(workFolder)), "送り先.git");
}

/** 差し替え先。作らないので、git はここへ送れない */
function missingRemoteOf(workFolder: string): string {
  return path.join(path.dirname(path.dirname(workFolder)), "届かない送り先.git");
}

/** 作品の操作ログ（`.aiwriter/logs/actions.log`）。同期・送り直しの行もここへ書かれる（`features/syncLog.ts`） */
async function actionsLog(session: E2ESession): Promise<string> {
  return readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
}

/** `since` より後に記録された知らせのうち、届かなかった知らせの文 */
async function unsentNotices(session: E2ESession, since: number): Promise<string[]> {
  return (await recordedNotices(session))
    .filter((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(UNSENT_KEY))
    .map((entry) => entry.message);
}

test("送り先へ届かないまま下の帯から「保存・同期」を押すと、「手元には記録しました。GitHub へは届いていません」で始まる警告が1回だけ出て、送り先を戻すと自動の送り直しで届き、そのときは何も知らせない", async () => {
  await withVsCode(
    "保存・同期で届かなかったときの知らせ",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page, workFolder } = session;
      const remote = remoteFolderOf(workFolder);

      // 登録の印を記録して送っておく（以後の「未記録」「未送信」を本文の書き換えだけにする）
      await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "作品の登録の印（config.json）ができる", 30_000);
      await page.waitForTimeout(2_500);
      await gitWhileRunning(workFolder, ["add", "-A"]);
      await gitWhileRunning(workFolder, ["commit", "--quiet", "--allow-empty", "-m", "登録の印"]);
      await gitWhileRunning(workFolder, ["push", "--quiet"]);
      await clearNotifications(page);

      // ネットを切る代わりに、送り先を無い置き場へ差し替える
      await gitWhileRunning(workFolder, ["remote", "set-url", "origin", missingRemoteOf(workFolder)]);
      const remoteBefore = (await git(remote, ["rev-parse", "main"])).trim();

      await writeFile(path.join(session.manuscriptFolder, EPISODE), `${EDITED_LINE}\n`, "utf8");
      const bar = page.locator(".part.statusbar .statusbar-item", { hasText: "未記録" }).first();
      await waitUntil(async () => (await bar.count()) > 0 && (await bar.isVisible()), "下の帯に「未記録 N」が出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}）`);
      });
      await bar.locator("a, .statusbar-item-label").first().click();

      let confirm = "";
      await waitUntil(async () => /\d+か所を同期します/.test((confirm = (await dialogText(page)) ?? "")), "「N か所を同期します」の確認の窓が出る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(confirm)}）${await quickInputWaitContext(page)}`);
        }
      );
      const pressedAt = Date.now();
      await pressDialogButton(page, "同期する");

      // 記録はできた（手元の書き換えが記録待ちに残らない）
      await waitUntil(async () => (await porcelainLines(workFolder)).length === 0, "書き換えが手元に記録される", 60_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（git status：${JSON.stringify(await porcelainLines(workFolder))}／${await describeNotices(session, pressedAt)}）`);
      });

      // 届かなかった警告（中央の窓）が出る。書き出しは「手元には記録しました。GitHub へは届いていません」
      let warning = "";
      await waitUntil(async () => (warning = (await dialogText(page)) ?? "").includes(UNSENT_KEY), "「GitHub へは届いていません」の警告が出る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(warning)}／${await describeNotices(session, pressedAt)}）`);
        }
      );
      // 窓の DOM は題・本文・説明が続いて並ぶので、文の始まりは記録の知らせ（製品が出した message そのもの）で確かめる
      let messages: string[] = [];
      await waitUntil(async () => (messages = await unsentNotices(session, pressedAt)).length > 0, "届かなかった知らせが記録される", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeNotices(session, pressedAt)}）`);
      });
      expect(messages, `記録の知らせ：${JSON.stringify(messages)}`).toHaveLength(1);
      expect(messages[0].startsWith(UNSENT_HEAD), `知らせの文：${messages[0]}`).toBe(true);
      expect(messages[0].startsWith(OLD_HEAD), `旧文言で始まっています：${messages[0]}`).toBe(false);
      expect(messages[0], `知らせの文：${messages[0]}`).toContain("ネットにつながったら自動で送ります。");
      expect(warning, `窓の文：${warning}`).toContain(UNSENT_HEAD);
      // git の文（原因の当て推量の材料）は画面に出さない
      expect(warning, `窓の文：${warning}`).not.toContain("fatal");
      // 送り先は進んでいない
      expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(remoteBefore);

      await page.keyboard.press("Escape");
      await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });

      // 閉じたあと、2枚目は出ない（遅れて開く窓・右下の知らせを数秒見る）
      await holdsFor(
        async () => (await dialogText(page)) === undefined && !(await notificationTexts(page)).some((text) => text.includes(UNSENT_KEY)),
        "届かなかった知らせが2つ目を出さない",
        5_000
      );

      // 自動の送り直しが届かない送り先へ試して失敗しても、知らせは増えない（失敗はログだけ）
      await waitUntil(async () => (await actionsLog(session)).includes("自動の送り直しに失敗"), "自動の送り直しが1回試して失敗する（ログに残る）", 150_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（ログの末尾：${JSON.stringify((await actionsLog(session)).slice(-800))}／${await describeNotices(session, pressedAt)}）`);
        }
      );
      expect(await unsentNotices(session, pressedAt), "送り直しの失敗で、届かなかった知らせがまた出ました").toHaveLength(1);
      expect(await dialogText(page), "送り直しの失敗で窓が出ました").toBeUndefined();

      // ネットを戻す代わりに、送り先を元へ戻す。次の鼓動（間隔1分）で送り直される
      await gitWhileRunning(workFolder, ["remote", "set-url", "origin", remote]);
      const restoredAt = Date.now();
      const head = (await gitWhileRunning(workFolder, ["rev-parse", "HEAD"])).trim();
      await waitUntil(async () => (await git(remote, ["rev-parse", "main"])).trim() === head, "自動の送り直しで送り先に記録が届く", 180_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（送り先：${(await git(remote, ["rev-parse", "main"])).trim()}／手元：${head}／ログの末尾：${JSON.stringify(
              (await actionsLog(session)).slice(-800)
            )}）`
          );
        }
      );
      // きっかけは問わない。テストは焦点を動かさないが、画面の外の窓でも VS Code が焦点の合図
      // （focus）を出すことがあり、1回目の走りは interval より先に focus で送った（2026-11-04）
      //
      // **ログの行が書かれるのを待ってから見る。** 記録の書き込みは1秒まとめなので、送り先に届いた直後に
      // 読むと行がまだ無いことがある（2026-11-05、母艦の全件と単独3回のうち1回で、届いているのに行が無いまま
      // 落ちた）。待っても無ければ、ほかの道で送ったということなので、ログの末尾を添えて落とす
      const RESENT = /自動の送り直し：送った（[^）]*きっかけ (interval|focus|wake|wake-retry)/;
      await waitUntil(async () => RESENT.test(await actionsLog(session)), "ログに「自動の送り直し：送った」が書かれる", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（送ったのが自動の送り直しではない見込み。ログの末尾：${JSON.stringify((await actionsLog(session)).slice(-800))}）`);
        }
      );

      // 届いたときは知らせを出さない（右下・中央の窓とも）。記録の書き込みは1秒まとめなので、数秒見続ける
      await holdsFor(
        async () => {
          const since = (await recordedNotices(session)).filter((entry) => Date.parse(entry.at) >= restoredAt - 1_000);
          return since.length === 0 && (await dialogText(page)) === undefined && (await notificationTexts(page)).length === 0;
        },
        "送り直しで届いたときは知らせを出さない",
        5_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeNotices(session, restoredAt)}／窓：${JSON.stringify(await dialogText(page))}）`);
      });
      expect(await unsentNotices(session, pressedAt), "届かなかった知らせの数").toHaveLength(1);
    },
    launchOptions()
  );
}, 480_000);
