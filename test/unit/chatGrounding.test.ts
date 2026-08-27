import { describe, expect, test } from "vitest";
import {
  SETTINGS_ASSISTANT_SYSTEM_PROMPT,
  SETTINGS_CHAT_VERSION,
} from "../../src/prompts/settingsChat";
import {
  WORK_CHAT_SYSTEM_PROMPT,
  WORK_CHAT_VERSION,
} from "../../src/prompts/workChat";
import { BASE_SYSTEM_PROMPT } from "../../src/prompts/characterExtract";

/**
 * 「分からない」で突き放す指示が、考えるための問いにまで掛かっていた
 * 不具合の再現（作者の指摘、2026-08-16）。
 *
 * 実データ（いじめられっ子18話）で測ったところ：
 *
 * | 指示 | 幻覚 | 「テーマは？」への答え |
 * |---|---|---|
 * | 強い禁止 | 0/6 | **「分かりません」（6字）** |
 * | 区別させる | 0/6 | 792字（引用と解釈） |
 * | 制限なし | 2/6 | 1667字（世辞と冗長） |
 *
 * **禁止を強めても幻覚は減らず、答えだけが痩せる。**
 * 区別させるほうが、同じ安全さでずっと役に立つ。
 */

const CHAT_PROMPTS: Array<[string, string]> = [
  ["相談パネル（P-21）", WORK_CHAT_SYSTEM_PROMPT],
  ["設定資料パネル（P-18）", SETTINGS_ASSISTANT_SYSTEM_PROMPT],
];

describe("相談では、禁じるのではなく区別させる", () => {
  test.each(CHAT_PROMPTS)("%s は推測を「区別して書け」と言う", (_, prompt) => {
    expect(prompt).toContain("区別");
    expect(prompt).toMatch(/〜と読める|と読めます/);
  });

  test.each(CHAT_PROMPTS)("%s は考えるための問いで突き放さない", (_, prompt) => {
    // ここが無いと「この作品のテーマは？」に「分かりません」とだけ返る
    expect(prompt).toContain("突き放さない");
  });

  test.each(CHAT_PROMPTS)("%s は事実の問いに限って「見当たりません」と言う", (_, prompt) => {
    // 限定が外れると、解釈を求める問いまで拒む
    expect(prompt).toMatch(/出来事・数値・固有名詞/);
    expect(prompt).toContain("見当たりません");
  });

  test.each(CHAT_PROMPTS)("%s は無条件の「分かりませんと答えよ」を持たない", (_, prompt) => {
    // 「答えが無いときは分かりませんと答えること」という無条件の指示が
    // 残っていると、限定を書いても引っ張られる
    expect(prompt).not.toMatch(/答えが無いときは.{0,20}分かりません/);
  });
});

describe("抽出は厳しいままにする", () => {
  test("本文に無いことを書かせない指示は残す", () => {
    // 抽出結果は設定資料として**保存され**、後の判断の土台になる。
    // 読んで終わりの相談とは扱いを変える
    expect(BASE_SYSTEM_PROMPT).toMatch(
      /本文に(書かれていない|明示されていない)|推測/
    );
  });
});

describe("版", () => {
  test("プロンプトを変えたら版も上がっている", () => {
    // 版を止めたままだと、古い応答がキャッシュから返る
    expect(WORK_CHAT_VERSION).toBe("3.1");
    expect(SETTINGS_CHAT_VERSION).toBe("3.0");
  });
});
