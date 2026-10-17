import { describe, it, expect } from "vitest";
import "../support/sweepTimeout";
import { srcSources } from "../support/srcSources";
import {
  parseCountMode,
  pickCount,
  countModeLabel,
  DEFAULT_COUNT_MODE,
} from "../../../src/core/countSettings";
import { countChars } from "../../../src/core/charCount";

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
  /*
    **src 全体は共通の読み込みで1回だけ読む**（2026-10-17。`support/srcSources.ts`）。
    ファイルごとに歩いて読み直していたため、並列の負荷の中で時間切れになった。
    読む中身は同じで、確かめることは変わらない。
  */
  /** `src/...` の形の道と中身（以前の `collect("src")` と同じ道の形） */
  function collect(): Array<{ file: string; body: string }> {
    return srcSources().map(({ file, body }) => ({ file: `src/${file}`, body }));
  }

  /**
   * **画面ごとに設定を読み直すと、片方だけ直したときにずれる。**
   * 実際にそうなっていた（ステータスバーは `countMode` を見て、
   * 作品一覧は純文字数で固定だった）。読むのは `countSettings.ts` だけにする。
   */
  it("countMode を直接読むのは countSettings.ts だけ", () => {
    const offenders = collect()
      .filter(({ file }) => !file.endsWith("core/countSettings.ts"))
      .filter(({ body }) => body.includes('"countMode"'))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("純と総の選び分けを自前で書いていない", () => {
    // `mode === "gross" ? counts.gross : counts.net` を各所に書くと、
    // 新しい画面を足したときに書き忘れる。選び分けは VS Code に依存しない
    // `countMode.ts` の1か所に置く（J1。`countSettings.ts` は書き出し直すだけ）
    const offenders = collect()
      .filter(({ file }) => !file.endsWith("core/countMode.ts"))
      // 設定値の読み取り・印（「総」）の選び分けは、こちらに残っている
      .filter(({ file }) => !file.endsWith("core/countSettings.ts"))
      .filter(({ body }) => /===\s*"gross"\s*\?/.test(body))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
