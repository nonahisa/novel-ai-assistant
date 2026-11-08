import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { parseLaunchServicesHttpsHandler } from "./externalBrowser";

/**
 * Mac の既定のブラウザ（https を開くアプリ）の名札（bundle id）を、LaunchServices の記録から読む
 * （作者の決定 2026-11-08「Mac でも既定のブラウザが Chrome かを調べて、Windows と同じ案内を出す」）。
 *
 * **Node 専用である。** 拡張機能からは `canRunProcesses()` と `isMacHost()` を確かめてから
 * **動的 import** する（実装ルール7。`browserReach.test.ts` が見張る）。
 *
 * 記録は2進の plist なので、Mac に元からある `plutil` で文字にする。まず JSON にし、
 * JSON で表せない値（日付など）があって断られたら XML にする。**読めなければ undefined**
 * （Windows の登録簿と同じく、理由は問わない。案内を出さずにリンクを開くだけになる）。
 * シェルを介さず（`execFile`）、短い時間で打ち切る（リンクを開くのを待たせない）。
 */
export function launchServicesPlistPath(home: string = homedir()): string {
  // Mac だけで呼ぶので区切りは「/」で足りる（`path` を持ち込まない。実装ルール7）
  return `${home.replace(/\/+$/, "")}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`;
}

/** `plutil` を呼ぶ口（試験で差し替える）。失敗したら undefined */
export type RunPlutil = (args: readonly string[]) => Promise<string | undefined>;

const runPlutil: RunPlutil = (args) =>
  new Promise((resolve) => {
    try {
      execFile(
        "/usr/bin/plutil",
        [...args],
        { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolve(error ? undefined : String(stdout ?? ""))
      );
    } catch {
      resolve(undefined);
    }
  });

export async function readDefaultBrowserBundleId(
  run: RunPlutil = runPlutil,
  plistPath: string = launchServicesPlistPath()
): Promise<string | undefined> {
  for (const format of ["json", "xml1"]) {
    const text = await run(["-convert", format, "-o", "-", plistPath]);
    if (text === undefined) continue;
    const found = parseLaunchServicesHttpsHandler(text);
    // 文字にできたのに https の行が無ければ、形を変えても同じなので打ち切る
    return found;
  }
  return undefined;
}
