import { describe, expect, test } from "vitest";
import {
  isArchaicForm,
  onlyScriptDifference,
  onlyTrailingPunctuation,
  validateTypoIssues,
} from "../../src/core/typoCheckValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 誤字脱字を、**作者の10作品・44,000字**で実際に走らせて分かったこと
 * （`gemma4:e4b`、辞書は空、2026-08-17）。
 *
 * **64件挙がって62件が通っていた。** 検査がほとんど何もしていなかった。
 * ここに固定するのは、そのとき実際に返ってきたものである。
 *
 * **設定資料をまだ抽出していない作品では、固有名詞の辞書が空になる。**
 * それが新しい作品の実際の姿なので、この条件で測った。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/x/episode_0001.txt",
    text,
    startLine: 0,
    hash: "h",
  } as Chunk;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    line: 1,
    original: "",
    target: "",
    suggestion: "",
    reason: "誤変換",
    confidence: "medium",
    ...overrides,
  };
}

function judge(text: string, target: string, suggestion: string) {
  return validateTypoIssues(
    { issues: [issue({ original: text, target, suggestion })] },
    chunkOf(text),
    []
  );
}

describe("同じ語を修正案として返してくる（62件中25件）", () => {
  test.each([
    ["保険の話をする。", "保険", "保険"],
    ["どこかの安宿を確保している。", "どこかの安宿を", "どこかの安宿を"],
    ["敷居を跨いだ。", "跨いだ", "跨いだ"],
    ["二束三文だが、高値がつく。", "二束三文", "二束三文"],
  ])("弾く: %s の「%s」→「%s」", (text, target, suggestion) => {
    const result = judge(text, target, suggestion);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("no_change");
  });
});

describe("末尾に句読点を足すだけ（日本語の小説では台詞に句点を打たない）", () => {
  test.each([
    ["ナイン様が会頭だ", "会頭だ", "会頭だ。"],
    ["ナイン様のことらしいからな", "からな", "からな。"],
  ])("弾く: 「%s」", (text, target, suggestion) => {
    expect(judge(text, target, suggestion).rejected[0].reason).toBe(
      "punctuation_only"
    );
  });

  test("中の読点を直す指摘は本物なので通す", () => {
    // 「占め部活は」→「占め、部活は」は本当の脱字
    const text = "２／３以上を占め部活は剣道をしていた。";
    expect(judge(text, "占め部活は", "占め、部活は").accepted).toHaveLength(1);
  });
});

describe("読みが同じで書き方だけ違う（表記ゆれであって誤字ではない）", () => {
  test.each([
    ["ハメになった", "はめになった"],
    ["2回転ほど回る", "二回転ほど回る"],
    ["１０分", "10分"],
  ])("弾く: 「%s」→「%s」", (target, suggestion) => {
    expect(onlyScriptDifference(target, suggestion)).toBe(true);
  });

  test.each([
    // **本物の誤字を取りこぼさない**
    ["ｈっきりと", "はっきりと"],
    ["ことはことは", "ことは"],
    ["溢れ出だした", "溢れ出した"],
    ["波うった", "波打った"],
    ["書き止め", "書き留め"],
  ])("通す: 「%s」→「%s」", (target, suggestion) => {
    expect(onlyScriptDifference(target, suggestion)).toBe(false);
  });
});

describe("正しい文語・旧字を「誤変換」として直そうとする", () => {
  /**
   * 作者の作品に、**戦前の文語体で書かれた祖父の自分史**がある。
   * そこだけで9か所挙がった。どれも正しい日本語で、直せば文書が壊れる。
   */
  test.each([
    "然し",
    "於いて",
    "可成り",
    "極く",
    "与へて呉れた",
    "聯隊",
    "吾々",
    "入営する迄の間に",
  ])("弾く: %s", (target) => {
    expect(isArchaicForm(target)).toBe(true);
  });

  test.each(["はっきりと", "溢れ出だした", "あるある", "波うった"])(
    "本物の誤字を巻き込まない: %s",
    (target) => {
      expect(isArchaicForm(target)).toBe(false);
    }
  );

  test("検証の流れの中でも弾かれる", () => {
    const text = "然し間もなく平静を取り戻した。";
    const result = judge(text, "然し", "しかし");

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("archaic_form");
  });
});

describe("本物の誤字は、最後まで通る", () => {
  test.each([
    // 半角の h が混ざった変換ミス
    ["手足の冷たさがｈっきりとわかる。", "ｈっきりと", "はっきりと"],
    // 衍字
    ["今更翻すことはことはできない。", "ことはことは", "ことは"],
    ["ツヤのあるあるアッシュブロンド。", "あるある", "ある"],
    // 送り仮名
    ["箱から溢れ出だした星々は。", "溢れ出だした", "溢れ出した"],
  ])("通す: %s", (text, target, suggestion) => {
    const result = judge(text, target, suggestion);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe(suggestion);
  });
});

describe("末尾の句読点だけかを見分ける", () => {
  test("足すのも取るのも同じ扱い", () => {
    expect(onlyTrailingPunctuation("会頭だ", "会頭だ。")).toBe(true);
    expect(onlyTrailingPunctuation("会頭だ。", "会頭だ")).toBe(true);
  });

  test("同じものは対象外（no_change が先に見る）", () => {
    expect(onlyTrailingPunctuation("会頭だ", "会頭だ")).toBe(false);
  });

  test("中身が変わっていれば対象外", () => {
    expect(onlyTrailingPunctuation("会頭だ", "会長だ。")).toBe(false);
  });
});
