import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * 本物の一時フォルダーの「中身の指紋」を取る部品（2026-10-17。単体テストの前準備の写しを寄せた）。
 *
 * ## なぜここにあるのか
 *
 * MCP の道具（`src/mcp/tools/`）の試験は、「読むだけの道具が作品フォルダーを
 * 1バイトも変えていない」「案を積んでも台帳は変えていない」を、**前と後の指紋を
 * 比べて**確かめる。そのための「`readdirSync` を歩いて `hash.update`」が
 * 10ファイル近くに写されていた。
 *
 * ## 指紋の値そのものは比べない
 *
 * どの試験も、**同じ関数で取った前と後**を比べるだけで、値を定数と比べてはいない。
 * そのため、名前の並べ方や道の書き方（作品からの道か、`設定/` からの道か）が
 * 写しごとに少しずつ違っていても、1本に揃えて確かめる中身は変わらない——
 * **どこかのファイルの名前か中身が1バイトでも変われば、指紋が変わる。**
 *
 * 歩く起点が無ければ、写す前と同じく `readdirSync` が投げる（黙って空にしない）。
 */

export interface FolderFingerprintOptions {
  /** 作品フォルダーの中の、歩く起点（既定は作品フォルダー全体）。`["設定"]`・`["本文", "設定"]` など */
  readonly under?: readonly string[];
  /** この名前のフォルダーは、どの深さでも歩かない（自動で増える記録を外すため。例 `history`） */
  readonly skipFolderNames?: readonly string[];
}

/** フォルダーの下の全ファイルの名前と中身から作った指紋（sha256 の16進） */
export function folderFingerprint(folder: string, options: FolderFingerprintOptions = {}): string {
  const hash = createHash("sha256");
  const skip = new Set(options.skipFolderNames ?? []);
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = nodePath.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (!skip.has(name)) walk(full);
        continue;
      }
      // 道も混ぜる。中身が同じまま名前だけ変わった（移した・付け替えた）ときも変わるように
      hash.update(nodePath.relative(folder, full));
      hash.update(fs.readFileSync(full));
    }
  };
  for (const start of options.under ?? ["."]) walk(nodePath.join(folder, start));
  return hash.digest("hex");
}

/**
 * フォルダーの下の全ファイルを「作品からの道 → 中身の sha256」の表にする。
 * 落ちたときに**どのファイルが変わったか**を試験の差分に出したいときはこちら。
 *
 * `allowMissing` を立てると、起点が無ければ空の表を返す（まだ作られていない `設定/` など）。
 */
export function fileHashes(
  folder: string,
  under: string,
  options: { readonly allowMissing?: boolean } = {}
): Map<string, string> {
  const result = new Map<string, string>();
  const base = nodePath.join(folder, under);
  if (options.allowMissing && !fs.existsSync(base)) return result;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        result.set(
          nodePath.relative(folder, full),
          createHash("sha256").update(fs.readFileSync(full)).digest("hex")
        );
      }
    }
  };
  walk(base);
  return result;
}

/**
 * フォルダーの下の全ファイルを「作品からの道 → 中身（UTF-8）」の表にする。
 * 読むだけの道具が何も書いていないことを、**変わった中身ごと**差分に出して確かめる。
 */
export function folderSnapshot(folder: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[nodePath.relative(folder, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(folder);
  return result;
}
