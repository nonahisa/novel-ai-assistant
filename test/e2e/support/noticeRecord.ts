/**
 * 拡張機能が出した知らせを、**知らせの記録ファイル**から読む（設計書6.113。MCP の `notices.recent` と
 * 同じ記録。`core/noticeLog.ts`）。
 *
 * 右下の知らせ（トースト）は数秒で畳まれ、続けて出た別の知らせに押し流される。
 * 「保存した直後に出る知らせの文」を画面で待つと、待つ側の 100ms の刻みや焦点の動きで取りこぼす
 * （2026-10-10 の写真撮りで、知らせが写っていなかった）。製品は出した知らせを1秒まとめて
 * `<保管庫>/.aiwriter/notices/<窓>.json` へ書き留めるので、それを読む。**製品には何も足さない。**
 *
 * 保管庫は使い捨ての user-data の中（`user-data/User/globalStorage/<拡張機能>/`）。
 * 拡張機能の id の綴りに頼らず、`.aiwriter/notices` の形のフォルダーを歩いて探す
 * （`chatWorkRemembered.test.ts` が窓の札を探すのと同じ手）。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseNoticeLog, type NoticeEntry } from "../../../src/core/noticeLog";
import type { E2ESession } from "./vscodeApp";
import { waitUntil } from "./wait";
import { notificationTexts } from "./workbenchDom";

/** 記録ファイルにある知らせ（古い順）。記録がまだ無ければ空 */
export async function recordedNotices(session: E2ESession): Promise<NoticeEntry[]> {
  const files: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (
        entry.name.endsWith(".json") &&
        path.basename(folder) === "notices" &&
        path.basename(path.dirname(folder)) === ".aiwriter"
      ) {
        files.push(full);
      }
    }
  };
  await walk(path.join(session.root, "user-data", "User", "globalStorage"), 0);
  const notices: NoticeEntry[] = [];
  for (const file of files) {
    // 書いている最中のファイルは読めないことがある。次の回で読めればよい
    const parsed = parseNoticeLog(await readFile(file, "utf8").catch(() => ""));
    if (parsed) notices.push(...parsed.notices);
  }
  return notices.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
}

/** 知らせの文（記録ファイルと、いま右下に出ているもの）。落ちた文に添える用 */
export async function describeNotices(session: E2ESession, since = 0): Promise<string> {
  const recorded = (await recordedNotices(session))
    .filter((entry) => Date.parse(entry.at) >= since)
    .map((entry) => entry.message.replace(/\s+/g, " ").slice(0, 160));
  const toasts = (await notificationTexts(session.page)).map((text) => text.replace(/\s+/g, " ").slice(0, 160));
  return `記録の知らせ：${JSON.stringify(recorded.slice(-8))}／右下の知らせ：${JSON.stringify(toasts)}`;
}

/**
 * `since`（`Date.now()` の値）より後に出た知らせのうち、`matches` に合うものが出るまで待ち、その文を返す。
 * 記録ファイルと右下の知らせの両方を見る（記録は1秒まとめて書かれるので、先に右下で見えることがある）
 */
export async function waitForNotice(
  session: E2ESession,
  matches: (message: string) => boolean,
  label: string,
  options: { since?: number; timeoutMs?: number } = {}
): Promise<string> {
  const since = options.since ?? 0;
  let found: string | undefined;
  await waitUntil(
    async () => {
      for (const text of await notificationTexts(session.page)) {
        if (matches(text)) {
          found = text;
          return true;
        }
      }
      for (const entry of await recordedNotices(session)) {
        // 時刻は秒の端数で前後しうるので、1秒の余裕を見る
        if (Date.parse(entry.at) >= since - 1_000 && matches(entry.message)) {
          found = entry.message;
          return true;
        }
      }
      return false;
    },
    label,
    options.timeoutMs ?? 30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session, since - 1_000)}）`);
  });
  return found ?? "";
}
