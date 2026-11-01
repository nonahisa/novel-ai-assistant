/**
 * ［原稿箱を取り込む］は、先に GitHub から受け取ってから箱を入れる（画面の自動テスト、設計書6.115・6.116・6.113。
 * 実機確認リスト 0.121.0 の 342 行を機械へ移した。作者の判断 2026-11-01「同期を探しに行かせない」）。
 *
 * 1. 出先の原稿箱から［パソコンへ送る］を押したあと（＝箱が GitHub に載ったあと）、パソコンで同期せずに
 *    「原稿箱を取り込む」を押すと、先に GitHub から受け取って、そのまま箱の本文が話に入る
 *    （受け取る前の手元には箱が無い。押した1回で、手元の記録が送り先と同じところまで進み、話に1行足される）
 * 2. 1 と同じことを、**押す少し前に原稿エディターで話を開いていた**とき（作者のふだんの形）にも見る。
 *    素のテキストエディターで開いたときの裏の取りに行き（`gitSync` の `onDidChangeActiveTextEditor`）と、
 *    そのあとの間引きとの関係はここでは見ていない（原稿エディターはカスタムエディターなので、その道は通らない見込み）
 * 3. つながらないとき（送り先の置き場の名前を一時的に変えて、取りに行けない形を作る）に押すと、手元に
 *    届いている箱だけが入り、知らせの末尾に「GitHub からは受け取れなかったため、手元に届いていた分だけを
 *    取り込みました。」が出る
 *
 * **GitHub は呼ばない。** 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts`）。
 * 「出先」は送り先を clone したフォルダーで、箱（`.aiwriter/inbox/*.json`）を置いて送る（出先のページが
 * GitHub へ箱を置くのと同じ形）。箱の形は `outboxInboxImport.test.ts` と同じ。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { addLocalRemote, git, gitWhileRunning, initRepoWithFirstCommit } from "./support/gitFixture";
import { openEpisode } from "./support/manuscriptFrame";
import { describeNotices } from "./support/noticeRecord";
import { runCommand } from "./support/quickInput";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, quickInputWaitContext, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_港.txt";
/** 元の本文（末尾に改行なし）。置き場は LF のまま（core.autocrlf を切ってある） */
const BASE = "　港の朝は早い。";
const ADDED = "（出先から足した1行）";
const BOX_NAME = "20261101T151045Z-phone.json";

const RECEIVE_FAILED_NOTE = "GitHub からは受け取れなかったため、手元に届いていた分だけを取り込みました。";

/** git の blob SHA（`blob <長さ>\0<中身>` の SHA-1）。リポジトリ側＝LF の形で求める */
function blobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\u0000`, "utf8"), bytes])).digest("hex");
}

/** 出先のページが置く箱（`outboxInboxImport.test.ts` と同じ形）。本文1件 */
function box(id: string, baseText: string, newText: string): string {
  return `${JSON.stringify(
    {
      format: "novelai-outbox-inbox",
      version: 2,
      sentAt: "2026-11-01T15:10:45.576Z",
      device: "スマホ",
      writer: "editor",
      records: [
        {
          id,
          kind: "body",
          at: "2026-11-01T15:10:45.576Z",
          device: "スマホ",
          episode: `本文/${EPISODE}`,
          baseBlobSha: blobSha(baseText),
          text: newText,
        },
      ],
    },
    null,
    2
  )}\n`;
}

/**
 * 自動の送り直しだけ切る（押す前に勝手に送られると、手元の記録の位置が読めなくなる）。
 * **自動の取りに行き（`novelai.git.autoFetch`）は作者の既定のまま入れておく**——受け取りの口
 * （`gitSync.receive`）は、この設定と「直前に取りに行ったか」の間引きを通って取りに行くので、
 * 切ると製品の道と違う形を見ることになる
 */
const LAUNCH: LaunchOptions = {
  settings: { "novelai.git.autoResend": false },
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    await initRepoWithFirstCommit(workFolder);
    await addLocalRemote(workFolder, path.join(root, "送り先.git"));
  },
};

function remoteOf(session: E2ESession): string {
  return path.join(path.dirname(path.dirname(session.workFolder)), "送り先.git");
}

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/** 登録の印を記録して送る（以後、手元の記録待ちが受け取りを止めないように） */
async function settleRegistration(session: E2ESession): Promise<void> {
  const { page, workFolder } = session;
  await waitUntil(() => existsSync(path.join(workFolder, ".aiwriter", "config.json")), "登録の印（config.json）ができる", 30_000);
  await page.waitForTimeout(2_500);
  await gitWhileRunning(workFolder, ["add", "-A"]);
  await gitWhileRunning(workFolder, ["commit", "--quiet", "--allow-empty", "-m", "登録の印"]);
  await gitWhileRunning(workFolder, ["push", "--quiet"]);
}

/** 出先（送り先の clone）で箱を置いて送る。送ったあとの送り先の先頭を返す */
async function sendBoxFromPhone(session: E2ESession): Promise<string> {
  const root = path.dirname(path.dirname(session.workFolder));
  const remote = remoteOf(session);
  const there = path.join(root, "出先");
  await git(root, ["clone", "--quiet", remote, there]);
  await git(there, ["config", "user.name", "出先"]);
  await git(there, ["config", "user.email", "e2e-there@example.invalid"]);
  await git(there, ["config", "core.autocrlf", "false"]);
  await mkdir(path.join(there, ".aiwriter", "inbox"), { recursive: true });
  await writeFile(path.join(there, ".aiwriter", "inbox", BOX_NAME), box("first", BASE, `${BASE}\n${ADDED}`), "utf8");
  await git(there, ["add", "-A"]);
  await git(there, ["commit", "--quiet", "-m", "出先の原稿箱"]);
  await git(there, ["push", "--quiet"]);
  // 手元にはまだ箱が無い（同期していない）
  if (existsSync(path.join(session.workFolder, ".aiwriter", "inbox", BOX_NAME))) throw new Error("受け取る前から手元に箱があります");
  return (await git(remote, ["rev-parse", "main"])).trim();
}

/** ［原稿箱を取り込む］を押し、「N件を入れました」か「取り込み待ちのものはありません」の知らせを返す */
async function pressImport(session: E2ESession): Promise<string> {
  const { page } = session;
  await clearNotifications(page);
  await runCommand(page, "原稿箱を取り込む");
  let shown = "";
  await waitUntil(
    async () => {
      shown = (await notificationTexts(page)).find((text) => text.includes("件を入れました") || text.includes("取り込み待ちのものはありません")) ?? "";
      return shown !== "";
    },
    "原稿箱の取り込みの知らせが出る",
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}／下の帯：${JSON.stringify(await statusBarTexts(page))}／${await describeNotices(session)}）${await quickInputWaitContext(page)}`
    );
  });
  return shown;
}

/** 受け取ってから箱が入ったことを、知らせ・本文・手元の記録の位置で確かめる */
async function expectReceivedAndImported(session: E2ESession, shown: string, remoteHead: string): Promise<void> {
  const local = (await gitWhileRunning(session.workFolder, ["rev-parse", "HEAD"])).trim();
  expect(shown, `受け取ってから箱を入れたはずの知らせ：${shown}（手元の記録 ${local}／送り先 ${remoteHead}）`).toContain("1件を入れました");
  expect(await readEpisode(session), "箱の本文が話に入っていません").toBe(`${BASE}\n${ADDED}`);
  // 押した1回で、手元の記録が送り先と同じところまで進んだ（受け取った）
  expect(local, "手元の記録が送り先まで進んでいません（受け取っていない）").toBe(remoteHead);
  expect(shown, `受け取れたのに断りが付いています：${shown}`).not.toContain("受け取れなかった");
}

test("出先から箱を GitHub へ送ったあと、同期せずに［原稿箱を取り込む］を押すと、先に受け取ってそのまま箱が入る", async () => {
  await withVsCode(
    "原稿箱は先に受け取ってから入れる",
    [{ name: EPISODE, text: BASE }],
    async (session) => {
      await settleRegistration(session);
      const remoteHead = await sendBoxFromPhone(session);
      await expectReceivedAndImported(session, await pressImport(session), remoteHead);
    },
    LAUNCH
  );
}, 300_000);

test("原稿エディターで話を開いていたあとに出先から箱が届いても、［原稿箱を取り込む］で受け取ってそのまま箱が入る", async () => {
  await withVsCode(
    "原稿を開いたあとの原稿箱の受け取り",
    [{ name: EPISODE, text: BASE }],
    async (session) => {
      await settleRegistration(session);
      // 作者のふだんの形：原稿エディターで話を開いて書いている
      await openEpisode(session.page, EPISODE, "港の朝は早い");
      await session.page.waitForTimeout(3_000);
      const remoteHead = await sendBoxFromPhone(session);
      await expectReceivedAndImported(session, await pressImport(session), remoteHead);
    },
    LAUNCH
  );
}, 300_000);

test("つながらないときに［原稿箱を取り込む］を押すと、手元に届いている箱だけが入り、知らせの末尾に「GitHub からは受け取れなかったため…」が出る", async () => {
  await withVsCode(
    "つながらないときの原稿箱",
    [{ name: EPISODE, text: BASE }],
    async (session) => {
      const { workFolder } = session;
      await settleRegistration(session);
      // 前に受け取って手元に届いている箱
      await mkdir(path.join(workFolder, ".aiwriter", "inbox"), { recursive: true });
      await writeFile(path.join(workFolder, ".aiwriter", "inbox", BOX_NAME), box("first", BASE, `${BASE}\n${ADDED}`), "utf8");
      // 送り先の名前を変えて、取りに行けなくする（ネットを切ったときの代わり）
      const remote = remoteOf(session);
      const offline = `${remote}.つながらない`;
      await rename(remote, offline);
      try {
        const shown = await pressImport(session);
        expect(shown, `手元に届いていた箱を入れていません：${shown}`).toContain("1件を入れました");
        expect(await readEpisode(session), "手元に届いていた箱の本文が話に入っていません").toBe(`${BASE}\n${ADDED}`);
        // 落ちたときに「取りに行って失敗したのか・取りに行かなかったのか」を分けるため、操作の記録の git の行を添える
        const log = await readFile(path.join(workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
        const gitLines = log
          .split(/\r?\n/)
          .filter((line) => /fetch|受け取|原稿箱/.test(line))
          .slice(-8)
          .join(" ／ ");
        expect(shown.replace(/\s+/g, ""), `知らせの末尾に断りがありません：${shown}（操作の記録：${gitLines}）`).toContain(RECEIVE_FAILED_NOTE.replace(/\s+/g, ""));
      } finally {
        await rename(offline, remote).catch(() => undefined);
      }
    },
    LAUNCH
  );
}, 300_000);
