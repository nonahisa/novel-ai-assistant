import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { EXTRACTED_TEXT_FIELDS } from "../../../src/core/characterExtractionValidation";
import {
  WORLD_THING_GUIDES,
  isWorldGuideEcho,
  validateExtractedWorldItems,
} from "../../../src/core/settingsExtractionValidation";
import {
  SPEECH_STYLE_EXAMPLE,
  SPEECH_STYLE_MAX_CHARS,
  isSpeechStyleEcho,
} from "../../../src/core/speechStyle";
import {
  CHARACTER_EXTRACT_SCHEMA,
  buildCharacterExtractPrompt,
} from "../../../src/prompts/characterExtract";

/**
 * P-04a 5.6（作者の裁定、2026-09-25 昼。縛りの洗い出し8番・9番）。
 *
 * - 人物に口調（speechStyle）と根拠の台詞（speechEvidence）を足した
 * - 種族・魔物・固有の品物・人でない登場人物を、世界観の項目として出させる
 *
 * **新しく書いた指示語は、そのまま答えに返ってくる前提で見張る**
 * （CLAUDE.md「繰り返し起きた失敗」3番）。ここではプロンプトの文面から
 * 指示の言葉を取り出し、検算がそれを落とすことを確かめる——文面を
 * 書き換えても、見張りが同じ言葉を見ていることになる。
 */

const prompt = buildCharacterExtractPrompt({
  chunkText: "（本文）",
  chapterLabel: "第1話",
  knownCharacterNames: [],
});

const personSchema = CHARACTER_EXTRACT_SCHEMA.properties.characters.items;

describe("口調の欄", () => {
  test("スキーマに口調と根拠の台詞があり、省略させない（null は許す）", () => {
    expect(personSchema.properties.speechStyle).toEqual({
      type: ["string", "null"],
      maxLength: SPEECH_STYLE_MAX_CHARS,
    });
    expect(personSchema.properties.speechEvidence).toEqual({
      type: ["string", "null"],
    });
    expect(personSchema.required).toEqual(
      expect.arrayContaining(["speechStyle", "speechEvidence"])
    );
  });

  test("受け取る項目の白紙リストにも足してある（足し忘れると後段へ届かない）", () => {
    expect(EXTRACTED_TEXT_FIELDS).toEqual(
      expect.arrayContaining(["speechStyle", "speechEvidence"])
    );
  });

  test("プロンプトは口調の上限・例・台詞の根拠を示す", () => {
    expect(prompt).toContain(`${SPEECH_STYLE_MAX_CHARS}字以内`);
    expect(prompt).toContain(SPEECH_STYLE_EXAMPLE);
    expect(prompt).toContain("その人物自身の台詞を本文からそのまま1つ");
  });

  test("人物の引用は名前だけにせず、台詞とは別に写させる", () => {
    // 口調の欄を足したあと、gemma4:26b が人物の引用を名前だけで返す回が増えた
    expect(prompt).toContain("**名前だけを書いてはならない**");
    expect(prompt).toContain("人物の evidence は speechEvidence（台詞）とは別に");
  });

  test("プロンプトの説明の言葉がそのまま返ってきたら、検算が落とす", () => {
    // 説明の行から「〜など」の手前（欄の中身を並べた言葉）を取り出す
    const line = prompt
      .split("\n")
      .find((text) => text.includes("など、**台詞から実際に読み取れる特徴**"));
    expect(line).toBeDefined();
    const aspects = (line ?? "").trim().split("など、")[0];
    expect(isSpeechStyleEcho(aspects)).toBe(true);
    expect(isSpeechStyleEcho(SPEECH_STYLE_EXAMPLE)).toBe(true);
  });
});

describe("種族・魔物・品物・人でない登場人物は世界観へ", () => {
  test("世界観の規則に3種類の「もの」と分類 term が書いてある", () => {
    for (const guide of WORLD_THING_GUIDES) {
      expect(prompt).toContain(`・${guide.kind}（${guide.examples}）：${guide.aspects}`);
    }
    expect(prompt).toContain("これらの category は term にすること");
  });

  test("組織の規則は、魔物を「出さない」ではなく世界観へ回す", () => {
    expect(prompt).not.toContain("→ 出さない");
    expect(prompt).toContain("魔物・生物・種族（「赤熊」「雷竜」）→ 世界観へ");
  });

  test("人物との取り合い：名前のある個体は人物、種類の名前だけなら世界観", () => {
    expect(prompt).toContain("**固有の名前で呼ばれる個体**");
    expect(prompt).toContain("**種類の名前でしか呼ばれないもの**");
    expect(prompt).toContain("種族・生物種・魔物は、人物ではなく**世界観**に出すこと");
  });

  test("一族・家は組織のまま（種族として世界観へ移さない）", () => {
    // 実測（gemma4:26b）：この規則を足した直後、「コンストラクタ家」が
    // 3回とも組織から世界観へ移った
    expect(prompt).toContain("**一族・家（「〇〇家」）は種族ではなく組織である。**");
  });

  test("品物は能力ではない", () => {
    expect(prompt).toContain("**品物・道具そのもの（「聖剣」「転移の指輪」）は能力ではない。**");
  });

  const chunk: Chunk = {
    filePath: "001.txt",
    index: 0,
    text: "雷竜は山の頂に棲み、雷を吐いて麓の村を焼く。",
    startLine: 0,
    hash: "world",
    chapterStart: 1,
    chapterEnd: 1,
  };

  test("案内の言葉が説明の代わりに返ってきたら落とす", () => {
    for (const guide of WORLD_THING_GUIDES) {
      expect(isWorldGuideEcho(guide.aspects)).toBe(true);
      expect(isWorldGuideEcho(`${guide.aspects}。`)).toBe(true);
    }
    const result = validateExtractedWorldItems(
      [
        {
          name: "雷竜",
          category: "term",
          description: WORLD_THING_GUIDES[0].aspects,
          evidence: "雷竜は山の頂に棲み",
        },
      ],
      chunk
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "雷竜", reason: "instruction_echo" }]);
  });

  test("案内の語を含む本物の説明は落とさない", () => {
    expect(isWorldGuideEcho("雷竜の特徴：山の頂に棲み、雷を吐く")).toBe(false);
    const result = validateExtractedWorldItems(
      [
        {
          name: "雷竜",
          category: "term",
          description: "山の頂に棲む竜。雷を吐いて麓の村を焼く",
          evidence: "雷竜は山の頂に棲み、雷を吐いて麓の村を焼く。",
        },
      ],
      chunk
    );
    expect(result.accepted.map((item) => item.data.name)).toEqual(["雷竜"]);
    expect(result.accepted[0].category).toBe("term");
  });
});
