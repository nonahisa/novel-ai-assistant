import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * 実行の札を、どの機能が取るか（設計書6.76）。
 *
 * ## なぜソースを見るのか
 *
 * 一括機能を本物どおりに走らせるには、作品フォルダー・設定資料・
 * キャッシュ・プロバイダをすべて用意することになり、確かめたい1点
 * （札を取っているか）に対して仕掛けが大きすぎる。
 * **書き忘れは「無い」ことなので、無いことを見る検査でよい。**
 *
 * 振る舞いそのものは `aiSequence.test.ts`（列の作り）と
 * `aiTurnFeatureOrder.test.ts`（2つ同時に起動したときの順番）が見ている。
 *
 * ## 取らない側も並べる理由
 *
 * 「うっかり付け忘れた」と同じくらい、「よかれと思って全部に付けた」が
 * 起きる。相談や独り言が10分待たされる作りになると道具として使えないので、
 * **取らないことも決めごととして書き留める。**
 */
const FEATURES = nodePath.join(__dirname, "..", "..", "src", "features");

function read(file: string): string {
  return fs.readFileSync(nodePath.join(FEATURES, file), "utf8");
}

/** 札を取る機能と、待ち表示に出す機能名 */
const HOLDS_TURN: Array<[file: string, label: string]> = [
  ["checkTypos.ts", "誤字脱字の検知"],
  ["checkProofread.ts", "推敲"],
  ["checkDeviations.ts", "プロットからの逸脱の検知"],
  ["checkContradictions.ts", "矛盾の検知"],
  ["checkForeshadows.ts", "伏線の検知"],
  ["checkForeshadows.ts", "伏線の回収の確認"],
  ["extractCharacters.ts", "設定資料の抽出"],
  ["generateSynopses.ts", "各話あらすじの生成"],
];

/**
 * 札を取らない機能。**1〜数回で終わるもの**は、リクエストの関所だけを
 * 通って一括処理のチャンクの合間へ滑り込める（設計書6.76）。
 */
const NO_TURN = [
  "workChatPanel.ts",
  "chatSettingsSync.ts",
  "notationAdvice.ts",
  "chatterComment.ts",
  "recheckProposal.ts",
  "generateBlurb.ts",
  "generateAnnouncement.ts",
  "generatePlot.ts",
  "proposeChapters.ts",
  "nameCheck.ts",
  "settingsPanel.ts",
  // 1回しかAIを呼ばない（冒頭3,000字を1度だけ見る／単話プロット1本を1度だけ見る）
  "checkOpening.ts",
  "checkEpisodePlot.ts",
];

describe("実行の札の配り先", () => {
  test.each(HOLDS_TURN)("%s は「%s」として札を取る", (file, label) => {
    const source = read(file);

    expect(source).toMatch(/from "\.\/aiTurn"/);
    expect(source).toContain(`label: "${label}"`);
  });

  test("チャンクを繰り返す機能が、素の進捗のまま残っていない", () => {
    // `withCancellableProgress` をそのまま使うと札を取り損ねる。
    // 矛盾検知だけは、2つの進捗を1つの札でまたぐので素のまま使う
    const offenders = HOLDS_TURN.map(([file]) => file)
      .filter((file) => file !== "checkContradictions.ts")
      .filter((file) => read(file).includes("withCancellableProgress("));

    expect(offenders).toEqual([]);
  });

  test.each(NO_TURN)("%s は札を取らない（合間に滑り込める）", (file) => {
    expect(read(file)).not.toMatch(/from "\.\/aiTurn"/);
  });
});
