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
const FEATURES = nodePath.join(__dirname, "..", "..", "..", "src", "features");

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
  ["checkFactContradictions.ts", "矛盾の検知（事実の照合）"],
  // 外部AIからの依頼（MCP の run.request）も、画面から押したときと同じ一括処理である
  ["runRequestRunners.ts", "各話あらすじの生成（外部AIからの依頼）"],
  ["runRequestSettings.ts", "設定資料の抽出（外部AIからの依頼）"],
  /*
    校正のまとめ実行（設計書6.80）。札を1枚取って、中の機能をまたぐ側である。
    中の機能は alreadyHeld で取り直さない
  */
  ["proofreadingSuite.ts", "校正一括実行"],
];

/**
 * 札を取る側でも、素の進捗（withCancellableProgress）を使ってよいもの。
 * **札の中で進捗を出している**か、**その進捗は札を取らない仕事**である。
 */
const RAW_PROGRESS_OK: ReadonlyMap<string, string> = new Map([
  ["checkContradictions.ts", "2つの進捗（検出と検証）を1つの札でまたぐ"],
  ["checkFactContradictions.ts", "抽出と判定を1つの札（withAiTurn）の中で回す"],
  [
    "runRequestRunners.ts",
    "素の進捗は索引づくりのもの。索引づくりは札を取らない（設計書6.76 の15）",
  ],
]);

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
  /*
    口述の整文（設計書6.83）。AIを呼ぶのは1回で、しかも**作者が話し終えた
    直後に押す**操作である（本体の裁定、2026-09-06）。誤字脱字の10分の裏で
    押したときに「完了を待っています…」で止まる作りは、口述の道具として
    使えない。
  */
  "dictationClean.ts",
  /*
    読み上げの読みの確かめ（設計書6.42.1）。1話を数回に分けて送るだけで、
    作者が読み上げの前に押す操作である。誤字脱字の裏で待たされると使えない。
  */
  "readingDictionary.ts",
  /*
    執筆統計の「AIに助言をもらう」（設計書6.79.7.3）。AIを呼ぶのは1回だけ。
    札を取っていたのは自由回答へ変えたときの名残で、理由の記録は無かった
    （2026-10-25 に外した）。
  */
  "readerAdvice.ts",
];

describe("実行の札の配り先", () => {
  test.each(HOLDS_TURN)("%s は「%s」として札を取る", (file, label) => {
    const source = read(file);

    expect(source).toMatch(/from "\.\/aiTurn"/);
    expect(source).toContain(`label: "${label}"`);
  });

  test("チャンクを繰り返す機能が、素の進捗のまま残っていない", () => {
    // `withCancellableProgress` をそのまま使うと札を取り損ねる。
    // 例外は RAW_PROGRESS_OK（理由つき）だけ
    const offenders = HOLDS_TURN.map(([file]) => file)
      .filter((file) => !RAW_PROGRESS_OK.has(file))
      .filter((file) => read(file).includes("withCancellableProgress("));

    expect(offenders).toEqual([]);
  });

  test.each(NO_TURN)("%s は札を取らない（合間に滑り込める）", (file) => {
    expect(read(file)).not.toMatch(/from "\.\/aiTurn"/);
  });

  /*
    網。一覧に載っていないファイルは、上のどの検査にも掛からず素通りする
    （2026-10-25 に5ファイルが漏れていた）。札を取る機能を足したら、
    ここが落ちて一覧へ載せることを求める。
  */
  test("src/features で ./aiTurn を引くファイルは、どれも一覧に載っている", () => {
    const listed = new Set([...HOLDS_TURN.map(([file]) => file), ...NO_TURN]);
    const unlisted = fs
      .readdirSync(FEATURES)
      .filter((file) => file.endsWith(".ts") && file !== "aiTurn.ts")
      .filter((file) => /from "\.\/aiTurn"/.test(read(file)))
      .filter((file) => !listed.has(file));

    expect(unlisted).toEqual([]);
  });
});
