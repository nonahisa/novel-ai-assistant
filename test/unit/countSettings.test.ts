import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseCountMode,
  pickCount,
  countModeLabel,
  DEFAULT_COUNT_MODE,
} from "../../src/core/countSettings";
import { countChars } from "../../src/core/charCount";

/**
 * 数え方の設定（設計書6.4）。
 *
 * **どの画面でも同じ数え方にする。** 以前はステータスバーにしか効いておらず、
 * 作品一覧はいつも純文字数だった。総文字数を選んでいる作者には、
 * 右下と一覧で違う数字が出続けていた（2026-08-21、作者の指摘）。
 */

describe("parseCountMode", () => {
  it("設定値を読み取る", () => {
    expect(parseCountMode("net")).toBe("net");
    expect(parseCountMode("gross")).toBe("gross");
  });

  it("知らない値は既定に倒す", () => {
    // 作者が settings.json を手で書き換えることがある。
    // 落ちるより、これまで通りの数え方で動くほうがよい
    expect(parseCountMode("こんぶ")).toBe(DEFAULT_COUNT_MODE);
    expect(parseCountMode(undefined)).toBe(DEFAULT_COUNT_MODE);
    expect(parseCountMode("")).toBe(DEFAULT_COUNT_MODE);
  });

  it("既定は純文字数", () => {
    expect(DEFAULT_COUNT_MODE).toBe("net");
  });
});

describe("pickCount", () => {
  // 空白（全角・半角）を含む本文。純と総で数が変わる
  const counts = countChars("あい　うえ お\nかき");

  it("純文字数は空白を数えない", () => {
    expect(pickCount(counts, "net")).toBe(7);
  });

  it("総文字数は空白を数える", () => {
    expect(pickCount(counts, "gross")).toBe(9);
  });

  it("改行はどちらでも数えない", () => {
    const single = countChars("あいう");
    const wrapped = countChars("あ\nい\nう");
    expect(pickCount(single, "gross")).toBe(pickCount(wrapped, "gross"));
    expect(pickCount(single, "net")).toBe(pickCount(wrapped, "net"));
  });
});

describe("countModeLabel", () => {
  it("総文字数のときだけ印を付ける", () => {
    expect(countModeLabel("gross")).toBe("総");
  });

  it("純文字数のときは何も付けない", () => {
    // 既定なので、付けると全画面が「純」だらけになって読みにくい
    expect(countModeLabel("net")).toBe("");
  });
});

describe("数え方を読む場所は1か所だけ", () => {
  function collect(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) collect(p, out);
      else if (name.endsWith(".ts")) out.push(p.split("\\").join("/"));
    }
    return out;
  }

  /**
   * **画面ごとに設定を読み直すと、片方だけ直したときにずれる。**
   * 実際にそうなっていた（ステータスバーは `countMode` を見て、
   * 作品一覧は純文字数で固定だった）。読むのは `countSettings.ts` だけにする。
   */
  it("countMode を直接読むのは countSettings.ts だけ", () => {
    const offenders = collect("src")
      .filter((file) => !file.endsWith("core/countSettings.ts"))
      .filter((file) => readFileSync(file, "utf-8").includes('"countMode"'));
    expect(offenders).toEqual([]);
  });

  it("純と総の選び分けを自前で書いていない", () => {
    // `mode === "gross" ? counts.gross : counts.net` を各所に書くと、
    // 新しい画面を足したときに書き忘れる
    const offenders = collect("src")
      .filter((file) => !file.endsWith("core/countSettings.ts"))
      .filter((file) =>
        /===\s*"gross"\s*\?/.test(readFileSync(file, "utf-8"))
      );
    expect(offenders).toEqual([]);
  });
});
