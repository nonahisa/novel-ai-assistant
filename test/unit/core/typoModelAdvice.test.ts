import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  EXTRACT_MODEL_ADVICE,
  EXTRACT_MODEL_ADVICE_SHORT,
  FORESHADOW_MODEL_ADVICE,
  FORESHADOW_MODEL_ADVICE_SHORT,
  TYPO_MODEL_ADVICE,
  TYPO_MODEL_ADVICE_SHORT,
} from "../../../src/core/requirements";

/**
 * 誤字脱字は、大きいモデルを勧める（作者の裁定 2026-09-06）。
 *
 * 実測（プロンプト設計書 P-09 の実測メモ 2026-09-06）：`gemma4:e4b`（4B）は
 * 「目を覚まさ」「思わなかつた」型の誤りを2回とも見逃し、12b は拾った。
 * **活用の誤りと促音の誤りは、モデルの大きさで結果が変わる。**
 *
 * **既定は変えない。** 勝手に重いモデルへ切り替えると、非力な機械で
 * 動かなくなる。**選ぶところで一言添えるだけ**にする。
 *
 * 文言は `src/core/requirements.ts` の1か所が持ち、
 * 機能別AI割当とOllamaのセットアップの両方が読む（写しを作らない）。
 */
function read(relative: string): string {
  return readFileSync(
    path.join(__dirname, "..", "..", "..", "src", relative),
    "utf8"
  );
}

describe("誤字脱字に向くモデルの案内", () => {
  test("手元の大きいモデルと、外部AIの両方を挙げる", () => {
    // 「26bにする」だけでは、鍵を持っている作者の道が閉じる。
    // 2026-09-26 の比べ（確実19件）で 12b は5件だったので、勧めを 26b へ上げた
    expect(TYPO_MODEL_ADVICE).toContain("gemma4:26b");
    expect(TYPO_MODEL_ADVICE).not.toContain("gemma4:12b 以上");
    expect(TYPO_MODEL_ADVICE).toContain("Kimi-K2.6");
    // 何を見逃すのか・どれだけ違うのかを数で言う（言わないと、勧めの理由が伝わらない）
    expect(TYPO_MODEL_ADVICE).toMatch(/4B|4b/);
    expect(TYPO_MODEL_ADVICE).toContain("19件");
    expect(TYPO_MODEL_ADVICE).toContain("2026-09-26");
  });

  test("既定のモデルは変えない（作者の判断 2026-09-26「このまま」）", () => {
    expect(read("core/requirements.ts")).toContain('RECOMMENDED_CHAT_MODEL = "gemma4:e4b"');
  });

  test("機能別AI割当の「誤字脱字」の説明が、この定数を読む", () => {
    const source = read("features/assignFeatureAI.ts");
    expect(source).toContain("TYPO_MODEL_ADVICE");
    // 写しを作らない（文言をそのまま書き込んでいない）
    expect(source).not.toContain("gemma4:26b");
    expect(source).not.toContain("Kimi-K2.6");
  });

  test("Ollamaのセットアップの説明も、この定数を読む", () => {
    const source = read("features/setupOllama.ts");
    expect(source).toContain("TYPO_MODEL_ADVICE");
    expect(source).not.toContain("gemma4:26b");
    expect(source).not.toContain("Kimi-K2.6");
  });
});

/**
 * 設定資料の抽出も、モデルの大きさで結果が変わる（実測 2026-09-08）。
 *
 * 本番のプロンプトとスキーマを1文字も変えず、同じ話でモデルだけ替えた：
 * qwen3:8b は別名0件・呼称0件、gemma4:12b は別名0件・呼称3件、
 * gemma4:26b は別名3件・呼称3件で、**しかも8bより速かった**（65秒対159秒）。
 * 別名が返らないと同じ人物が別レコードのまま残り、呼び名が重ならないので
 * 「重複をまとめる」の候補にも上がらない（実機確認A-18）。
 */
describe("設定資料の抽出に向くモデルの案内", () => {
  test("手元の大きいモデルと、外部AIの両方を挙げる", () => {
    expect(EXTRACT_MODEL_ADVICE).toContain("gemma4:26b");
    expect(EXTRACT_MODEL_ADVICE).toContain("Gemini");
    // 何が起きるのかを言う（言わないと、勧めの理由が伝わらない）
    expect(EXTRACT_MODEL_ADVICE).toContain("別名");
    expect(EXTRACT_MODEL_ADVICE).toContain("2026-09-08");
  });

  test("抽出だけ大きいモデルにできることを添える", () => {
    // 既定を重くはしない。非力な機械では26Bが動かない
    expect(EXTRACT_MODEL_ADVICE).toContain("機能別AI割当");
  });

  test("機能別AI割当の「設定資料の抽出」が、この定数を読む", () => {
    const source = read("features/assignFeatureAI.ts");
    expect(source).toContain("EXTRACT_MODEL_ADVICE");
    // 写しを作らない（文言をそのまま書き込んでいない）
    expect(source).not.toContain("26B");
  });
});

/**
 * 伏線（検知と回収の確認）も、大きいモデルを勧める（2026-09-26 の測定。設計書6.35.8）。
 * 回収の確認で、既定の e4b は回収のある21件中0件——張った箇所そのものを返し続けた。
 * **既定は変えない**（誤字脱字と同じ）。選ぶところで一言添えるだけ。
 */
describe("伏線に向くモデルの案内", () => {
  test("手元の大きいモデルと外部AIの両方を挙げ、数と日付で理由を言う", () => {
    expect(FORESHADOW_MODEL_ADVICE).toContain("gemma4:26b");
    expect(FORESHADOW_MODEL_ADVICE).toContain("Kimi-K2.6");
    expect(FORESHADOW_MODEL_ADVICE).toContain("21件");
    expect(FORESHADOW_MODEL_ADVICE).toContain("2026-09-26");
  });

  test("機能別AI割当の「伏線」の説明が、この定数を読む", () => {
    const source = read("features/assignFeatureAI.ts");
    expect(source).toContain("foreshadow: FORESHADOW_MODEL_ADVICE");
  });
});

/**
 * 機能別AI割当の選ぶ画面は説明を1行しか出さない。長いと「…」で切れる
 * （写真 2026-10-09b の389。作者の裁定 2026-10-10「短くして全部見せる」）。
 * 表示幅（全角2・半角1）で60以内に収める。理由と測定日は長い文のほうに残し、
 * 割り当てたあとの知らせで出す。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) < 0x100 ? 1 : 2;
  return width;
}

describe("選ぶ画面の1行の案内", () => {
  const shorts = [
    ["誤字脱字", TYPO_MODEL_ADVICE_SHORT],
    ["設定資料の抽出", EXTRACT_MODEL_ADVICE_SHORT],
    ["伏線", FORESHADOW_MODEL_ADVICE_SHORT],
  ] as const;

  test.each(shorts)("%s：表示幅60以内で、モデル名は Ollama の書き方", (_name, text) => {
    expect(displayWidth(text)).toBeLessThanOrEqual(60);
    expect(text).toContain("gemma4:26b");
    expect(text).not.toMatch(/26B/);
  });

  test("選ぶ画面の行は短い形を読み、理由は割り当てたあとの知らせへ回す", () => {
    const source = read("features/assignFeatureAI.ts");
    expect(source).toContain("typo: TYPO_MODEL_ADVICE_SHORT");
    expect(source).toContain("extract: EXTRACT_MODEL_ADVICE_SHORT");
    expect(source).toContain("foreshadow: FORESHADOW_MODEL_ADVICE_SHORT");
    expect(source).toContain("notes.push(reason)");
  });

  test("長い文のモデル名も gemma4:26b に揃っている", () => {
    for (const text of [TYPO_MODEL_ADVICE, EXTRACT_MODEL_ADVICE, FORESHADOW_MODEL_ADVICE]) {
      expect(text).not.toMatch(/26B/);
    }
  });
});
