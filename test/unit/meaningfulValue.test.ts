import { describe, expect, test } from "vitest";
import { isMeaningfulValue } from "../../src/core/characterExtractionValidation";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { emptyCharacter } from "../../src/models/character";
import {
  BASE_SYSTEM_PROMPT,
  buildCharacterExtractPrompt,
} from "../../src/prompts/characterExtract";

/**
 * AIは null にする代わりに「（本文から読み取れる性格に関する記述なし）」と
 * 書いてくることがあり、そのまま設定資料へ載っていた（実データで発生）。
 * プロンプトでも禁じているが、指示だけでは守られないのでコード側でも弾く。
 */

describe("値が無いことを述べた文言を弾く", () => {
  test("実データで入り込んだ文言を弾く", () => {
    expect(
      isMeaningfulValue("（本文から読み取れる性格に関する記述なし）")
    ).toBe(false);
    expect(isMeaningfulValue("（本文から具体的な外見の記述は少ない）")).toBe(
      true
    );
  });

  test("短い言い換えも弾く", () => {
    for (const value of [
      "なし",
      "不明",
      "記述なし",
      "記載なし",
      "（記述なし）",
      "本文に記述はない",
      "読み取れない",
      "null",
      "N/A",
    ]) {
      expect(isMeaningfulValue(value), `${value} を弾けていない`).toBe(false);
    }
  });

  test("中身のある記述は通す", () => {
    for (const value of [
      "命令口調で指示を出し、部下の反論を最後まで聞かない",
      "超絶美少女",
      "冷静沈着",
      "危険と分かっている場面へ真っ先に飛び込む",
      // 「ない」で終わるが中身がある
      "他人に弱みを見せない",
      "感情を表に出さない",
      // 名前としては無効でも、役割の値としては正しい
      "主人公",
      "誰か",
    ]) {
      expect(isMeaningfulValue(value), `${value} を弾いてしまった`).toBe(true);
    }
  });

  test("不在を述べたあとに中身が続く文は残す", () => {
    // 実データでは、後半に本当の情報が入っていることがある
    expect(
      isMeaningfulValue(
        "（生前の具体的な外見の記述は本文中になし。憑依後は、手足がスラリとして顔が非常に整った体となっている）"
      )
    ).toBe(true);
  });

  test("空欄はそのまま未設定として扱う", () => {
    expect(isMeaningfulValue("")).toBe(false);
    expect(isMeaningfulValue("   ")).toBe(false);
    expect(isMeaningfulValue(null)).toBe(false);
    expect(isMeaningfulValue(undefined)).toBe(false);
  });

  test("マージでレコードへ入れない", () => {
    const merged = mergeExtractedCharacters(
      [emptyCharacter("char_001", "灯")],
      [
        {
          data: {
            name: "灯",
            personality: "（本文から読み取れる性格に関する記述なし）",
            appearance: "黒髪",
          },
          chapters: [1],
        },
      ]
    );

    expect(merged.characters[0].personality).toBeNull();
    expect(merged.characters[0].appearance).toBe("黒髪");
  });
});

describe("性格だけは推論を認める", () => {
  test("システムプロンプトに例外を書く", () => {
    // 原則1が全面禁止のままだと、本文のルールと食い違って指示が効かない
    expect(BASE_SYSTEM_PROMPT).toContain("personality");
    expect(BASE_SYSTEM_PROMPT).toContain("推論を認める");
  });

  test("根拠となる振る舞いを添えさせる", () => {
    const prompt = buildCharacterExtractPrompt({
      chunkText: "本文",
      chapterLabel: "第1話",
      knownCharacterNames: [],
    });

    expect(prompt).toContain("どう振る舞ったか");
    // 名前や性別からの推論は引き続き禁じる
    expect(prompt).toContain("名前の響き／性別／作品のジャンル");
  });

  test("「記述なし」を値として書かせない", () => {
    const prompt = buildCharacterExtractPrompt({
      chunkText: "本文",
      chapterLabel: "第1話",
      knownCharacterNames: [],
    });

    expect(prompt).toContain("「記述なし」「不明」のような文言を値として");
  });
});
