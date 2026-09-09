import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  MAX_LOGGED_RESPONSE_CHARS,
  responseExcerptForLog,
} from "../../src/core/logger";
import { MAX_EXCERPT_CHARS } from "../../src/core/deviationValidation";
import { PLOT_OPENING_EXCERPT_CHARS } from "../../src/features/generatePlot";
import { BLURB_OPENING_EXCERPT_CHARS } from "../../src/features/generateBlurb";

/**
 * 大きさの予算の共通化・**第2段**（設計書6.77）の重複4件。
 *
 * 第1段（`sizeBudget.test.ts`）と同じで、ここは「良い値か」を問うテスト
 * ではない。**寄せたあとも、同じ意味の値が1つしか無い**ことを見張る。
 * 写しが復活する壊れ方は目視では見つからないので、ソースを読んで確かめる
 * （`modelTuningLookup.test.ts` の「6つのプロバイダが台帳を通る」と同じ手）。
 */

const root = path.join(__dirname, "..", "..");

function readSource(...parts: readonly string[]): string {
  return fs.readFileSync(path.join(root, ...parts), "utf8");
}

/**
 * AIの応答を失敗ログへ載せている機能（A-1）。
 *
 * **ここへ足したら、必ず共有の切り詰めを通す。** 各ファイルが自分で
 * `slice(0, 300)` と書いていたころは、同じ意味の字数が400と300に割れていた。
 */
const RESPONSE_LOG_FEATURES = [
  "chatSettingsSync.ts",
  "checkContradictions.ts",
  "checkDeviations.ts",
  "checkEpisodePlot.ts",
  "checkForeshadows.ts",
  "checkOpening.ts",
  "checkProofread.ts",
  "generateAnnouncement.ts",
  "generateBlurb.ts",
  "generatePlot.ts",
  "generateSynopses.ts",
  "nameCheck.ts",
  "notationAdvice.ts",
  "proposeChapters.ts",
] as const;

describe("A-1 AI応答をログに残すときの字数は1つだけ", () => {
  test("共有の字数は400字（多いほうへ揃えた）", () => {
    // 14ファイル中9ファイル・17か所中11か所が400字だった。
    // 少ないほうへ揃えるとログの手がかりが減るので、最頻値を採る
    expect(MAX_LOGGED_RESPONSE_CHARS).toBe(400);
  });

  test("上限より長い応答は、先頭だけを残す", () => {
    const long = "あ".repeat(MAX_LOGGED_RESPONSE_CHARS + 50);
    expect(responseExcerptForLog(long)).toBe(
      "あ".repeat(MAX_LOGGED_RESPONSE_CHARS)
    );
  });

  test("上限に収まる応答は、1字も落とさない", () => {
    // **切り詰めの印を足さない。** 足すと、ログに残る文字列が
    // 「AIが返した本文そのもの」でなくなる
    const short = "読み取れなかった応答";
    expect(responseExcerptForLog(short)).toBe(short);
    const exact = "い".repeat(MAX_LOGGED_RESPONSE_CHARS);
    expect(responseExcerptForLog(exact)).toBe(exact);
  });

  test("14の機能が、どれも共有の切り詰めを通る", () => {
    for (const file of RESPONSE_LOG_FEATURES) {
      const code = readSource("src", "features", file);
      expect(code, file).toContain("responseExcerptForLog");
      // 自前の切り詰めへ戻っていないこと（`応答: text.slice(0, 300)` の形）
      expect(code, file).not.toMatch(/応答: [^,\n]*\.slice\(0, \d+\)/);
    }
  });
});

describe("A-2 引用の長さの上限は、逸脱検知の1つだけ", () => {
  test("値は80字のまま", () => {
    expect(MAX_EXCERPT_CHARS).toBe(80);
  });

  test("単話プロットの検証は、自前で持たずに借りる", () => {
    const code = readSource("src", "core", "episodePlotValidation.ts");
    expect(code).toContain("MAX_EXCERPT_CHARS");
    // 同名の定義が2つある状態へ戻っていないこと
    expect(code).not.toMatch(/const MAX_EXCERPT_CHARS/);
  });
});

describe("A-3 冒頭の抜粋は、用途の分かる名前を持つ", () => {
  test("値は変えない（プロット3,000字・紹介文6,000字）", () => {
    // **同じ意味の値ではない。** プロットは構成をつかむための冒頭、
    // 紹介文は文体まで見せるための冒頭で、必要な長さが違う
    expect(PLOT_OPENING_EXCERPT_CHARS).toBe(3_000);
    expect(BLURB_OPENING_EXCERPT_CHARS).toBe(6_000);
  });

  test("同名・別値の取り違えが起きない", () => {
    for (const file of ["generatePlot.ts", "generateBlurb.ts"] as const) {
      const code = readSource("src", "features", file);
      // `_` は語の文字なので、`\b` は `PLOT_OPENING_…` の途中には立たない
      expect(code, file).not.toMatch(/\bOPENING_EXCERPT_CHARS\b/);
    }
  });
});

/**
 * A-4 ログのバイト上限。
 *
 * **値は寄せない。** 3つは別の用途の別のファイルで、載る中身の重さが違う。
 * 寄せるのは名前だけで、取り違えを防ぐために互いの居場所を書き合う。
 */
describe("A-4 ログのバイト上限は、用途の分かる名前を持つ", () => {
  const files = [
    {
      file: path.join("src", "core", "logger.ts"),
      name: "MAX_ACTION_LOG_BYTES",
      bytes: "1_000_000",
    },
    {
      file: path.join("src", "core", "chatLog.ts"),
      name: "MAX_CHAT_LOG_BYTES",
      bytes: "2_000_000",
    },
    {
      file: path.join("src", "core", "usageLog.ts"),
      name: "MAX_USAGE_LOG_BYTES",
      bytes: "2_000_000",
    },
  ] as const;

  test.each(files)("$name は $bytes のまま", ({ file, name, bytes }) => {
    const code = readSource(file);
    expect(code).toContain(`const ${name} = ${bytes};`);
    // 3つとも `MAX_LOG_BYTES` だったころは、どれの話か読んで分からなかった
    expect(code).not.toMatch(/const MAX_LOG_BYTES\b/);
  });

  test("3つが互いの居場所を書いている", () => {
    for (const { file, name } of files) {
      const code = readSource(file);
      for (const other of files) {
        if (other.name === name) continue;
        expect(code, `${name} → ${other.name}`).toContain(other.name);
      }
    }
  });
});
