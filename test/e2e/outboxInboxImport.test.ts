/**
 * 出先の原稿エディター（claude.ai のページ）から GitHub へ送られた本文が、パソコンの
 * ［原稿箱を取り込む］で本文に入る（画面の自動テスト、設計書6.115「GitHub 経由」・6.116。
 * 2026-10-10 に、本物のテスト用リポジトリから clone した写しで一度確かめた往復を、
 * GitHub に繋がずに何度でも回せる形にしたもの）。
 *
 * 何を見張るか：
 * - **箱（`.aiwriter/inbox/*.json`）の本文が、話のファイルの末尾に1行足した形で入る**
 * - **改行（CRLF の話は CRLF のまま、LF の話は LF のまま）・BOM が無いこと・末尾に改行が
 *   付かないこと**が元のまま（作者の原稿を壊さない。実装ルール1）。足した行以外は1バイトも変わらない
 * - 済んだ箱は `inbox/done/` へ移り、隣に `.result.json` が置かれ、受け取り箱は空になる
 * - **2度目は入れない**：箱を受け取り箱へ戻してもう一度押すと「前に入れ済み」と出て、本文は変わらない
 *
 * GitHub は呼ばない。clone の代わりに、起こす前（`prepareWork`）に箱を作品の下へ置く。
 * 本物の往復では、箱の `baseBlobSha` は **リポジトリ側（LF）の blob** で、手元は
 * `core.autocrlf` で CRLF になっている——ここでも同じ組み合わせ（CRLF の話に、LF の blob の鍵）で置く。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications } from "./support/workbenchDom";

const CRLF_EPISODE = "episode_9906_CRLFの確認.md";
const LF_EPISODE = "episode_9907_LFの確認.md";
const ADDED = "（出先から足した1行）";
const BOX = "20261009T151045Z-pc-editor.json";

/** 元の本文（末尾に改行なし——作者の原稿によくある形）。LF の空間で持つ */
const CRLF_BODY_LF = "【タイトル】\n第9906話\n\n【本文】\n　一行目。\n\n　二行目の文。感じ感じ";
const LF_BODY = "【タイトル】\n第9907話\n\n【本文】\n　LFの話の一行目。\n\n　二行目の文。";

/** git の blob SHA（`blob <長さ>\0<中身>` の SHA-1）。リポジトリ側＝LF の形で求める */
function blobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\u0000`, "utf8"), bytes])).digest("hex");
}

function bodyRecord(id: string, episode: string, baseText: string, newText: string) {
  return {
    id,
    kind: "body",
    at: "2026-10-09T15:10:45.576Z",
    device: "パソコン",
    episode,
    baseBlobSha: blobSha(baseText),
    text: newText,
  };
}

async function notificationTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast")).map((toast) => (toast as HTMLElement).innerText)
  );
}

async function waitForNotification(page: Page, part: string): Promise<void> {
  await waitUntil(
    async () => (await notificationTexts(page)).some((text) => text.includes(part)),
    `「${part}」を含む知らせが出る`,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（出ている知らせ：${(await notificationTexts(page)).join(" / ")}）`);
  });
}

async function readBytes(file: string): Promise<Buffer> {
  return readFile(file);
}

test("出先の原稿エディターから送った本文が、［原稿箱を取り込む］で改行と文字コードを保ったまま末尾に入り、2度目は入れない", async () => {
  const crlfOriginal = Buffer.from(CRLF_BODY_LF.replace(/\n/g, "\r\n"), "utf8");
  const lfOriginal = Buffer.from(LF_BODY, "utf8");
  const inboxFolder = (session: Pick<E2ESession, "workFolder">) => path.join(session.workFolder, ".aiwriter", "inbox");

  await withVsCode(
    "原稿箱の取り込み",
    [],
    async (session) => {
      const { page } = session;
      const crlfFile = path.join(session.manuscriptFolder, CRLF_EPISODE);
      const lfFile = path.join(session.manuscriptFolder, LF_EPISODE);
      const inbox = inboxFolder(session);

      // 起こす前の形が、期待どおりに置けている（取り違えの目印）
      expect((await readBytes(crlfFile)).equals(crlfOriginal)).toBe(true);
      expect((await readBytes(lfFile)).equals(lfOriginal)).toBe(true);

      await clearNotifications(page);
      await runCommand(page, "原稿箱を取り込む");
      await waitForNotification(page, "2件を入れました");

      // --- 本文：足した行だけが増え、ほかの1バイトも変わらない ---
      const crlfAfter = await readBytes(crlfFile);
      const crlfExpected = Buffer.concat([crlfOriginal, Buffer.from(`\r\n${ADDED}`, "utf8")]);
      expect(crlfAfter.equals(crlfExpected)).toBe(true);
      expect(crlfAfter.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(crlfAfter.toString("utf8").replace(/\r\n/g, "")).not.toContain("\n");
      expect(crlfAfter[crlfAfter.length - 1]).not.toBe(0x0a);

      const lfAfter = await readBytes(lfFile);
      const lfExpected = Buffer.concat([lfOriginal, Buffer.from(`\n${ADDED}`, "utf8")]);
      expect(lfAfter.equals(lfExpected)).toBe(true);
      expect(lfAfter.includes(0x0d)).toBe(false);

      // --- 箱：受け取り箱は空、済んだ箱は done/ へ、結果のファイルが隣に ---
      const pending = (await readdir(inbox)).filter((name) => name.endsWith(".json"));
      expect(pending).toEqual([]);
      const done = await readdir(path.join(inbox, "done"));
      expect(done).toContain(BOX);
      expect(done.some((name) => name.endsWith(".result.json"))).toBe(true);

      // --- 2度目：箱を受け取り箱へ戻して押しても、本文は変わらず「入れ済み」 ---
      await copyFile(path.join(inbox, "done", BOX), path.join(inbox, BOX));
      await clearNotifications(page);
      await runCommand(page, "原稿箱を取り込む");
      await waitForNotification(page, "2件は前に入れ済みでした");
      expect((await readBytes(crlfFile)).equals(crlfExpected)).toBe(true);
      expect((await readBytes(lfFile)).equals(lfExpected)).toBe(true);
      await holdsFor(
        async () => (await readBytes(crlfFile)).equals(crlfExpected),
        "2度目の取り込みのあとも本文が同じ",
        1_500
      );
    },
    {
      prepareWork: async ({ workFolder, manuscriptFolder }) => {
        await writeFile(path.join(manuscriptFolder, CRLF_EPISODE), crlfOriginal);
        await writeFile(path.join(manuscriptFolder, LF_EPISODE), lfOriginal);
        const inbox = path.join(workFolder, ".aiwriter", "inbox");
        await mkdir(inbox, { recursive: true });
        const box = {
          format: "novelai-outbox-inbox",
          version: 2,
          sentAt: "2026-10-09T15:10:45.576Z",
          device: "パソコン",
          writer: "editor",
          records: [
            // 本物の往復と同じ：リポジトリ側の blob は LF、送る本文は LF。
            // `episode` は作品フォルダーからの相対（この見本は本文フォルダーの下なので `本文/`。
            // 取り違えると「本文のファイルではありません」で断られる）
            bodyRecord("b-crlf", `本文/${CRLF_EPISODE}`, CRLF_BODY_LF, `${CRLF_BODY_LF}\n${ADDED}`),
            bodyRecord("b-lf", `本文/${LF_EPISODE}`, LF_BODY, `${LF_BODY}\n${ADDED}`),
          ],
        };
        await writeFile(path.join(inbox, BOX), `${JSON.stringify(box, null, 2)}\n`, "utf8");
      },
    }
  );
});
