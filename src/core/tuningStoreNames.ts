/**
 * AIチューニングの台帳の**名前だけ**（ファイル名と、機能の行の鍵の頭）。
 *
 * **なぜ分けたか**（MCP の `ai.settings`。作者の裁定、2026-10-01）。
 * 台帳を読み書きする `modelTuningStore.ts`・`featureOutputTokens.ts` は
 * `vscode` を import しているので、MCP の束からは借りられない。
 * かといって MCP 側に同じ文字を写すと、片方だけ名前を変えたときに
 * MCP が黙って空の台帳を読む。**名前はここ1か所に置き、両方が借りる。**
 *
 * VS Code API に依存しない（`mcpReach.test.ts` が見張る）。
 */

/** 台帳のファイル名。**保管庫の直下に置く**（生成文書とは別の階） */
export const TUNING_STORE_FILE = "model-tuning.json";

/**
 * 機能の行に付ける、鍵の頭。
 *
 * **モデルの鍵（`プロバイダID/モデル名`）と混ざらないようにする印。**
 * 詳しい理由は `featureOutputTokens.ts` の同名の定数の説明にある。
 */
export const FEATURE_OUTPUT_KEY_PREFIX = "出力見込み/";
