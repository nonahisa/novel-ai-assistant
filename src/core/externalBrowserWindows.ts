import { execFile } from "node:child_process";
import { parseRegProgId } from "./externalBrowser";

/**
 * Windows の既定のブラウザ（https を開くもの）の ProgId を登録簿から読む。
 *
 * **Node 専用である。** 拡張機能からは `canRunProcesses()` と `isWindowsHost()` を
 * 確かめてから**動的 import** する（実装ルール7。`browserReach.test.ts` が見張る）。
 *
 * **読めなければ undefined。** 失敗の理由は問わない——ここで分からなければ
 * 案内を出さずにリンクを開くだけなので、作者の操作は止まらない。
 * シェルを介さず（`execFile`）、短い時間で打ち切る（リンクを開くのを待たせない）。
 */
const USER_CHOICE_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

export function readDefaultBrowserProgId(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        "reg",
        ["query", USER_CHOICE_KEY, "/v", "ProgId"],
        { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }
          resolve(parseRegProgId(String(stdout ?? "")));
        }
      );
    } catch {
      resolve(undefined);
    }
  });
}
