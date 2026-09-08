import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 機能側で `logLine` を呼ぶなら、作品のログファイルへ向けてから呼ぶ
 * （49 の指摘、2026-09-08）。`useLogFile` を通さないと出力チャンネルにしか
 * 出ず、VS Code を閉じると消える——「変換中の本文を捨てた」「外部の資料を
 * 守った」「飛び先が無い」の手がかりが3つとも残っていなかった。
 *
 * プロバイダ（`src/ai`）と `src/core` は、呼ぶ側の機能が先に向けているので対象外。
 */
const FEATURES = resolve(__dirname, "../../src/features");

describe("機能のログは作品のログファイルへ向ける", () => {
  test("logLine を呼ぶ features のファイルは、useLogFile か logForDocument を通す", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(FEATURES)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(resolve(FEATURES, name), "utf8");
      if (!source.includes("logLine(")) continue;
      if (source.includes("useLogFile(") || source.includes("logForDocument(")) continue;
      offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
