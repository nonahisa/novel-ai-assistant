import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  SMALL_MODEL_NOTICE_FEATURES,
  describeSmallModelNotice,
  isSmallModelForNotice,
  needsSmallModelNotice,
  readDismissedKeys,
  smallModelNoticeKey,
  smallModelPickDetail,
} from "../../../src/core/smallModelNotice";
import {
  SMALL_MODEL_NOTICE,
  SMALL_MODEL_PICK_NOTE,
} from "../../../src/core/requirements";
import { LARGE_MODEL_MIN_BILLIONS } from "../../../src/ai/types";
import { useSmallModelTypoPrompt } from "../../../src/ai/capability";

/**
 * 小さいモデルで検知の機能を動かす前の知らせ（作者の裁定 2026-10-10。設計書6.28.9）。
 *
 * 見張ること：
 * - 大きさは API の申告だけで決める（名前で決め打ちしない）
 * - 線は製品の「小さいモデル」と同じ（同じモデルが、頼み方と知らせで食い違わない）
 * - 大きさが分からないモデル（クラウドの大きいモデル）には出さない
 * - 生成・相談には出さない
 */
describe("小さいモデルかどうか（申告の大きさだけで決める）", () => {
  test("e4b の申告 8.0B も 12b も小さい側、26b の 25.2B は大きい側", () => {
    expect(isSmallModelForNotice("8.0B")).toBe(true);
    expect(isSmallModelForNotice("12.2B")).toBe(true);
    expect(isSmallModelForNotice("3.2B")).toBe(true);
    expect(isSmallModelForNotice("270M")).toBe(true);
    expect(isSmallModelForNotice("25.2B")).toBe(false);
    expect(isSmallModelForNotice("31B")).toBe(false);
  });

  test("大きさが分からなければ出さない（クラウドの大きいモデルに「小さい」と言わない）", () => {
    expect(isSmallModelForNotice(null)).toBe(false);
    expect(isSmallModelForNotice(undefined)).toBe(false);
    expect(isSmallModelForNotice("")).toBe(false);
  });

  test("線は製品が頼み方を小さいモデル向けに切り替える線と同じ", () => {
    // 線の上下で、製品の判定（誤字脱字の小さいモデル向けの文）と同じ答えになる
    for (const size of ["8.0B", "19.9B", `${LARGE_MODEL_MIN_BILLIONS}B`, "25.2B"]) {
      expect(isSmallModelForNotice(size)).toBe(
        useSmallModelTypoPrompt({ providerId: "ollama", parameterSize: size })
      );
    }
  });
});

describe("どの機能で出すか", () => {
  test("検知と抽出には出し、生成と相談には出さない", () => {
    for (const feature of [
      "typo",
      "proofread",
      "contradiction",
      "factExtract",
      "deviation",
      "foreshadow",
      "extract",
    ]) {
      expect(needsSmallModelNotice(feature, "8.0B")).toBe(true);
    }
    expect(needsSmallModelNotice("generate", "8.0B")).toBe(false);
    expect(needsSmallModelNotice("chat", "8.0B")).toBe(false);
    // 機能の名前が表の外のもの（toString のような継承した名前）にも反応しない
    expect(needsSmallModelNotice("toString", "8.0B")).toBe(false);
  });

  test("大きいモデルでは、対象の機能でも出さない", () => {
    expect(needsSmallModelNotice("typo", "25.2B")).toBe(false);
  });
});

describe("覚える鍵", () => {
  test("作品ごと・モデルごとに別の鍵（機能は鍵に入れない）", () => {
    const a = smallModelNoticeKey("C:/作品A", "ollama", "m:8b");
    expect(smallModelNoticeKey("C:/作品A", "ollama", "m:8b")).toBe(a);
    expect(smallModelNoticeKey("C:/作品B", "ollama", "m:8b")).not.toBe(a);
    expect(smallModelNoticeKey("C:/作品A", "lmstudio", "m:8b")).not.toBe(a);
    expect(smallModelNoticeKey("C:/作品A", "ollama", "m:12b")).not.toBe(a);
  });

  test("区切りの字が名前に入っていても鍵が衝突しない", () => {
    expect(smallModelNoticeKey("a|b", "ollama", "c")).not.toBe(
      smallModelNoticeKey("a", "ollama", "b|c")
    );
  });

  test("保管庫の中身が壊れていても落ちない", () => {
    expect(readDismissedKeys(undefined)).toEqual([]);
    expect(readDismissedKeys("x")).toEqual([]);
    expect(readDismissedKeys(["a", 1, null, "b"])).toEqual(["a", "b"]);
  });
});

describe("文言", () => {
  test("知らせは作者の裁定の文そのままで、どのモデルの話かを頭に付ける", () => {
    expect(SMALL_MODEL_NOTICE).toBe(
      "このAIは小さいため、見落としや誤った指摘が多くなります。" +
        "大きいモデル（例：gemma4:26b）かクラウドのAIを勧めます。"
    );
    expect(describeSmallModelNotice(SMALL_MODEL_NOTICE, "m:8b", "8.0B")).toBe(
      `m:8b（8.0B）：${SMALL_MODEL_NOTICE}`
    );
  });

  test("選ぶ画面の注意は全角30字以内（1行に収める決まり）", () => {
    expect([...SMALL_MODEL_PICK_NOTE].length).toBeLessThanOrEqual(30);
  });

  test("選ぶ画面の注意は、割当で有効にしたときの小さいモデルにだけ先頭に付く", () => {
    expect(smallModelPickDetail(true, "8.0B", "対応: tools")).toBe(
      `${SMALL_MODEL_PICK_NOTE}　対応: tools`
    );
    expect(smallModelPickDetail(true, "8.0B", undefined)).toBe(SMALL_MODEL_PICK_NOTE);
    expect(smallModelPickDetail(true, "25.2B", "対応: tools")).toBe("対応: tools");
    expect(smallModelPickDetail(false, "8.0B", "対応: tools")).toBe("対応: tools");
    expect(smallModelPickDetail(false, "8.0B", undefined)).toBeUndefined();
  });

  test("画面に出す文言に内輪の呼び名を書かない", () => {
    for (const text of [SMALL_MODEL_NOTICE, SMALL_MODEL_PICK_NOTE]) {
      expect(text).not.toMatch(/母艦/);
    }
  });
});

describe("名前で決め打ちしない", () => {
  test("判定のファイルの文字列にモデルの系統名が無い（コメントの測定記録は除く）", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "core", "smallModelNotice.ts"),
      "utf8"
    );
    // コメントを外して、残ったコードの文字列リテラルを見る
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const literals = code.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
    for (const literal of literals) {
      expect(literal).not.toMatch(/\b(gemma|qwen|llama|e4b|26b|12b)/i);
    }
    // 対象の機能の表も、モデル名ではなく機能の名前だけ
    for (const label of Object.values(SMALL_MODEL_NOTICE_FEATURES)) {
      expect(label).not.toMatch(/gemma|qwen|e4b/i);
    }
  });
});
