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

  test("語の前後に言葉が付いた不在文も弾く", () => {
    // 実データで取りこぼしていた形（2026-08-15）。
    // 「本文から」が前に付く、「記述」と「ない」の間に動詞が挟まる、の2つ
    for (const value of [
      "（本文から読み取れない）",
      "本文からは外見に関する具体的な記述は確認できない。",
      "本文に情報がありません",
      "該当する描写は見当たらない",
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

describe("要約と捏造を区別する", () => {
  test("要約は推測ではないと明示する", () => {
    // これを書かないと、AIは「本文に無いことは書けない」と受け取り、
    // 本文の語句を切り貼りするだけになる（実データで発生、2026-08-15）
    expect(BASE_SYSTEM_PROMPT).toContain("要約は推測ではない");
    expect(BASE_SYSTEM_PROMPT).toContain("まとめて言い換える");
  });

  test("禁じるのは事実の捏造だと書く", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("本文に無い事実");
  });

  test("性格は言い切らせ、根拠を添えさせる", () => {
    const prompt = buildCharacterExtractPrompt({
      chunkText: "本文",
      chapterLabel: "第1話",
      knownCharacterNames: [],
    });

    // 以前は「性質だけを書いてはならない」と、要約そのものを禁じていた
    expect(prompt).toContain("どういう人か");
    expect(prompt).toContain("根拠を括弧で添える");
    expect(prompt).not.toContain("性質だけを書いてはならない");
    // 名前や性別からの推論は引き続き禁じる
    expect(prompt).toContain("名前の響き／性別／作品のジャンル");
  });

  test("所作の羅列を悪い例として示す", () => {
    const prompt = buildCharacterExtractPrompt({
      chunkText: "本文",
      chapterLabel: "第1話",
      knownCharacterNames: [],
    });

    expect(prompt).toContain("所作を並べただけ");
  });

  test("外見に動作を入れさせない", () => {
    const prompt = buildCharacterExtractPrompt({
      chunkText: "本文",
      chapterLabel: "第1話",
      knownCharacterNames: [],
    });

    expect(prompt).toContain("動作や仕草は外見ではない");
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
