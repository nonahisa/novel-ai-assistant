import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * `src/` の `.ts` を**1回だけ歩いて読み、使い回す**（2026-10-17。単体テストの重さの見直し）。
 *
 * ## なぜ共通にするのか
 *
 * 「外した部品の名前が戻っていない」「設定を読むのは1か所だけ」などの網は、
 * `src/` 全体（約1,000ファイル・1,100万字）を読む。1回で 250〜300ms かかるのに、
 * `test.each` の行ごとや `it` ごとに読み直すテストがあり（多いものは11回）、
 * 並列で走る負荷の中では既定の5秒を越えて時間切れで落ちていた。
 * 読む中身は同じなので、1回読んだものを渡しても確かめることは変わらない。
 *
 * ## 覚えている範囲
 *
 * **テストのファイル1つの中だけ。** Vitest はテストのファイルごとに部品を
 * 読み込み直す（`isolate`）ので、ファイルをまたいでは共有されない。
 * 走っている間に `src/` を書き換える試験は無い（ここを使うのは読むだけの網）。
 */

/** `src/` の絶対の道 */
export const SRC_DIR = nodePath.resolve(__dirname, "../../../src");

export interface SourceFile {
  /** `src/` からの道。区切りは `/`（Windows でも同じ形で比べられるように） */
  readonly file: string;
  /** 絶対の道（`fs` や TypeScript の構文解析へ渡す） */
  readonly fullPath: string;
  readonly body: string;
}

let cached: readonly SourceFile[] | undefined;

/** `src/` の下の `.ts` をすべて（歩く順は `readdirSync` のまま） */
export function srcSources(): readonly SourceFile[] {
  if (cached) return cached;
  const found: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      found.push({
        file: nodePath.relative(SRC_DIR, full).split(nodePath.sep).join("/"),
        fullPath: full,
        body: fs.readFileSync(full, "utf8"),
      });
    }
  };
  walk(SRC_DIR);
  cached = found;
  return found;
}

const single = new Map<string, string>();

/**
 * `src/` からの道（`/` 区切り）で1つ読み、覚えておく。
 *
 * **全体を読まずに済むときは、そのファイルだけを読む。** 決まった数ファイルだけを
 * 見るテストが、全体を歩く重さを背負わないようにする。
 */
export function srcSource(file: string): string {
  const hit = cached?.find((one) => one.file === file)?.body ?? single.get(file);
  if (hit !== undefined) return hit;
  const body = fs.readFileSync(nodePath.join(SRC_DIR, ...file.split("/")), "utf8");
  single.set(file, body);
  return body;
}
