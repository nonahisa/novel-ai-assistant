// 外から呼ぶ束（MCP サーバー）の起点。**ここが唯一の定義**（設計書6.87.3）。
//
// `scripts/bundleCore.mjs`（束ねられるかを機械で確かめる）と
// `test/unit/mcpReach.test.ts`（`vscode` へ届かないかを見る）の両方が
// ここを読む。**写すと、片方だけ増えて検査が素通りする。**
import fs from "node:fs";
import path from "node:path";

/**
 * `core` 側の起点——**検算と、材料の組み立て**。
 *
 * ここに挙げたものが、外から呼びたい「判断」の入口である。
 * 増やすときは、`vscode` を持ち込まない形で書けるものだけにする。
 */
export const CORE_ENTRY_NAMES = [
  "proofreadValidation",
  // 誤字脱字の検算（0.64.1）。**外から測り直したい筆頭**——実データでの
  // 測定は「64件中62件が素通り」から始まり、何度も直してきた
  "typoCheckValidation",
  "contradictionValidation",
  "contradictionMaterial",
  "foreshadowValidation",
  "deviationValidation",
  "characterExtractionValidation",
  "settingsExtractionValidation",
  "storyFactValidation",
  "chunker",
  "episodeChunks",
  "guideSelect",
  "settingsSummary",
  "collectedFile",
  "episodeLabel",
  // バイト列の読み方（`textFile.ts` の `vscode` が要らない部分）。
  // MCP は Node の `fs` でバイト列を取り、解釈はこれに任せる（6.87.8 の7）
  "textDecode",
  // 作品の書き方（文体メモ）。**渡さないと文語体で指摘が乱発する**（F-21）
  "workStyleFacts",
  /*
    相談（0.64.2）。**3つの診断のうち、読めるのは読者診断だけ**——
    作品の `設定/読者像.json` に在るからである。助言方針と執筆スタイルは
    `globalState`（VS Code の持ち物）に在るので、答えを渡してもらって
    製品の関数（`scoreAnswers`・`buildWriterStyle`）で組み立てる。
  */
  "advicePolicy",
  "writerStyle",
  "readerProfileParse",
  /*
    残りの機能（0.64.3で一気に足した）。設定資料の抽出・各話あらすじ・
    プロット逸脱・単話プロットの緩み・表記ゆれ。**どれも検算は core に在り、
    vscode に依存していない**ことを mcpReach.test.ts が見張る。
  */
  "synopsisValidation",
  "episodePlotValidation",
  "episodePlotDoc",
  "notationAdviceValidation",
  "notationVariants",
  "knownCharacterNames",
  /*
    外から呼びたい「判断」を足した（0.66.0。作者の指示「ありそう部分を
    実装してください」）。冒頭診断・名前の候補・プロット逆算・章立て・
    紹介文——**どれも判断がAIの外に在る**（字数・衝突・実在する話数）。
  */
  "plotDoc",
  "plotReverseValidation",
  "chapterProposalValidation",
  "blurbValidation",
  "nameCollision",
];

/**
 * MCP サーバーの入口（設計書6.87.8 の1）。
 *
 * **束ねる側（`bundleCore.mjs`）はここを見ない。** あちらは入口を
 * 名前空間として `import` して「生えているか」まで確かめるが、
 * `server.ts` は読み込むと stdio を掴んで待ち始めるので、
 * 読み込ませるわけにいかない。`server.ts` が本当に束ねられるかは
 * `npm run build`（3つ目の束）と `scripts/smokeMcp.mjs` が見る。
 *
 * たどる側（`test/unit/mcpReach.test.ts`）だけがここを足して歩く。
 */
export const MCP_ENTRY_NAMES = ["server"];

/** `src/prompts/*.ts` は全部。プロンプトの組み立ては丸ごと外へ出す */
export function promptEntryFiles(src) {
  const dir = path.join(src, "prompts");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => path.join(dir, name));
}

export function coreEntryFiles(src) {
  return CORE_ENTRY_NAMES.map((name) => path.join(src, "core", `${name}.ts`));
}

export function mcpEntryFiles(src) {
  return MCP_ENTRY_NAMES.map((name) => path.join(src, "mcp", `${name}.ts`));
}

/** 束ねる起点の全部（プロンプト＋検算・材料） */
export function allEntryFiles(src) {
  return [...promptEntryFiles(src), ...coreEntryFiles(src)];
}

/** たどる起点の全部。**MCP サーバーの入口も含める**（6.87.8 の1） */
export function reachEntryFiles(src) {
  return [...allEntryFiles(src), ...mcpEntryFiles(src)];
}
