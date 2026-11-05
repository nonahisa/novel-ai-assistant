import { describe, expect, test } from "vitest";
import "../support/sweepTimeout";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 単体テストで一時フォルダーを作る（`mkdtemp`）ファイルには、**消す後始末がある**。
 *
 * ## なぜ機械で止めるか
 *
 * 後始末の無いテストが、実行のたびに %TEMP% へ使い捨てのフォルダーを置いていき、
 * 2026-08 から約29万個溜まっていた（`novelai-diverge-` などが各数万個）。
 * 1個ずつは小さいが、数が増えるとエクスプローラーでの開き直しや検索が遅くなる。
 *
 * ここで見るのは「消す呼び出しが書かれているか」だけである。本当に消えたかは
 * テストの前後で %TEMP% の数を数えて確かめる（重いので毎回は走らせない）。
 * `gitTemplate`（雛形を写す部品）は、自分で後始末を登録するので、それを使うファイルは
 * 自分で `mkdtemp` を呼ばない限り対象外にできる。
 */
const UNIT_DIR = path.resolve(__dirname, "..");

function collect(dir: string, found: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (/\.ts$/.test(entry.name)) found.push(full);
  }
}

describe("テストの一時フォルダーの後始末", () => {
  test("mkdtemp を呼ぶファイルは、rm／rmSync／rmdir で消している", () => {
    const files: string[] = [];
    collect(UNIT_DIR, files);

    const offenders: string[] = [];
    for (const full of files) {
      // この検査自身は、書き方の例として mkdtemp の語を含む
      if (path.basename(full) === "testTempCleanup.test.ts") continue;
      const body = fs.readFileSync(full, "utf8");
      if (!/\bmkdtemp(Sync)?\s*\(/.test(body)) continue;
      if (/\brm(Sync)?\s*\(|\brmdir(Sync)?\s*\(/.test(body)) continue;
      offenders.push(path.relative(UNIT_DIR, full).split(path.sep).join("/"));
    }

    expect(
      offenders,
      "mkdtemp で作った一時フォルダーを rm で消す後始末（afterEach／afterAll）を足す"
    ).toEqual([]);
  });
});
