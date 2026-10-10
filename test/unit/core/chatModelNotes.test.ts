import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { buildFeatureGuideForQuestion } from "../../../src/core/featureGuide";
import {
  CHAT_MODEL_NOTES,
  DETECTION_MODEL_NOTES,
} from "../../../src/core/chatModelNotes";
import { TYPO_MODEL_ADVICE } from "../../../src/core/requirements";

/**
 * 相談に向くモデルの比べ（会話の比べ 2026-10-05、1作品・15件）は、
 * 画面で勧めず、作者が相談パネルで訊いたときだけ答える材料にする
 * （作者の裁定 2026-10-09「テストケースが一件だけなので」）。
 */
function read(relative: string): string {
  return readFileSync(path.join(__dirname, "../../../src", relative), "utf8");
}

describe("機能別AI割当の画面に、相談の比べの案内を出さない", () => {
  test("相談の行に案内を付ける対応が無い", () => {
    expect(read("features/assignFeatureAI.ts")).not.toContain("CHAT_MODEL_ADVICE");
  });

  test("案内の定数そのものが requirements.ts に残っていない", () => {
    expect(read("core/requirements.ts")).not.toContain("CHAT_MODEL_ADVICE");
  });

  test("誤字脱字の案内は残る", () => {
    expect(TYPO_MODEL_ADVICE).toContain("gemma4:26b");
    expect(read("features/assignFeatureAI.ts")).toContain("typo: TYPO_MODEL_ADVICE");
  });
});

describe("相談の材料としての記録", () => {
  test("件数・時間・日付・目安であることを言う", () => {
    for (const word of ["2026-10-05", "15件", "26b", "e4b", "8件", "約3倍", "1作品", "目安"]) {
      expect(CHAT_MODEL_NOTES, word).toContain(word);
    }
  });

  test("作者が読むマニュアルに載る EXTRA_GUIDE には入れない", () => {
    expect(read("core/featureGuide.ts")).toContain("CHAT_MODEL_NOTES");
    const guide = read("core/featureGuide.ts");
    const extra = guide.slice(guide.indexOf("export const EXTRA_GUIDE"), guide.indexOf(".trim();"));
    expect(extra).not.toContain("会話の比べ");
  });
});

describe("相談で訊かれたときだけ、その材料が渡る", () => {
  const asked = [
    "［AIに相談］にはどのモデルが向く？",
    "相談に使うモデルはどれがいい？",
    "相談で向くモデルを教えて",
  ];
  for (const question of asked) {
    test(`「${question}」で渡る`, () => {
      const guide = buildFeatureGuideForQuestion({ question });
      expect(guide.text, question).toContain("会話の比べ");
      expect(guide.text, question).toContain("2026-10-05");
    });
  }

  const notAsked = [
    "主人公の性格をどうしたい？",
    "この場面、もっと良くできる？",
    "誤字脱字はどこで検知できますか？",
    "AIに相談パネルはどこですか？",
    "ルビを振りたい",
    "主人公のモデルは実在の人物です。どう思う？",
    "もっと緊張感を出したい",
  ];
  for (const question of notAsked) {
    test(`「${question}」では渡らない`, () => {
      const guide = buildFeatureGuideForQuestion({ question });
      expect(guide.text, question).not.toContain("会話の比べ");
    });
  }
});

/**
 * 検知の機能に向くモデルの記録（作者の裁定 2026-10-10 朝、A11「やっぱこれも
 * 相談の時だけ答える形にしましょう」）。0.101.0 では小さいモデルで検知を動かす前に
 * 右下へ知らせていたが、それを外し、数字は相談で訊かれたときだけ渡す材料にした。
 */
describe("検知に向くモデルの記録（相談で訊かれたときだけ）", () => {
  test("機能ごとの数字・日付・目安であることを言う", () => {
    for (const word of [
      "誤字脱字",
      "矛盾検知",
      "プロット逸脱",
      "伏線",
      "設定資料の抽出",
      "gemma4:26b",
      "e4b",
      "2026-10-10",
      "2026-09-26",
      "目安",
      "機能別AI割当",
    ]) {
      expect(DETECTION_MODEL_NOTES, word).toContain(word);
    }
  });

  test("作者が読むマニュアルに載る EXTRA_GUIDE には入れない", () => {
    const guide = read("core/featureGuide.ts");
    expect(guide).toContain("DETECTION_MODEL_NOTES");
    const extra = guide.slice(guide.indexOf("export const EXTRA_GUIDE"), guide.indexOf(".trim();"));
    expect(extra).not.toContain("DETECTION_MODEL_NOTES");
    expect(extra).not.toContain("検知の機能に使うモデルの目安");
  });

  const asked = [
    "検知にはどのモデルが向く？",
    "誤字脱字に向くモデルは？",
    "矛盾検知はどのモデルがいい？",
    "伏線の確認にはどのモデルが向きますか",
  ];
  for (const question of asked) {
    test(`「${question}」で渡る`, () => {
      const guide = buildFeatureGuideForQuestion({ question });
      expect(guide.text, question).toContain("検知の機能に使うモデルの目安");
    });
  }

  // **機能の使い方を訊いただけでは渡さない。** 本文に「誤字脱字」「検知」が
  // 並ぶので、2文字組みで当てると使い方の問いにもモデルの話が付き、
  // 相談が自分からモデルを勧める形に戻ってしまう
  const notAsked = [
    "誤字脱字はどこで検知できますか？",
    "矛盾検知の使い方を教えて",
    "伏線の追跡はどう使う？",
    "プロット逸脱の検知を動かしたい",
    "設定資料の抽出をやり直したい",
    "主人公のモデルは実在の人物です。どう思う？",
  ];
  for (const question of notAsked) {
    test(`「${question}」では渡らない`, () => {
      const guide = buildFeatureGuideForQuestion({ question });
      expect(guide.text, question).not.toContain("検知の機能に使うモデルの目安");
    });
  }
});
