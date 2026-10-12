import { describe, expect, test } from "vitest";
import {
  OLD_FORM_EXAMPLES,
  PHOTO_EXAMPLE_CHARS,
  PHOTO_TRANSCRIBE_HINTS,
  PHOTO_TRANSCRIBE_SYSTEM_PROMPT,
  PHOTO_TRANSCRIBE_VERSION,
  buildPhotoTranscribePrompt,
  buildPhotoTranscribeRequest,
} from "../../../src/prompts/photoTranscribe";

/**
 * P-48 の 1.1（0.105.3。作者の裁定、2026-10-12「1と2を両方」）。
 *
 * 1. 旧字体の漢字・異体字・踊り字も「直さない」に入れる
 * 2. 作者からの頼みを依頼文の末尾に添える。原則より弱いことを言い切る。空なら添えない
 */

describe("旧字体も直させない（原則2）", () => {
  test("旧字体の漢字の例（國・學・體）を、直さない例として書く", () => {
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain(
      "「國」を「国」に、「學」を「学」に、「體」を「体」に直さない"
    );
    expect(OLD_FORM_EXAMPLES.map((one) => one.old)).toEqual(["國", "學", "體"]);
  });

  test("昔の仮名遣い・言い回しの例は残す", () => {
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain("「云う」を「言う」に");
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain("「言へば」を「言えば」に");
  });

  test("異体字・踊り字もそのまま写させる", () => {
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain("異体字や踊り字（々・ゝ・ゞ）");
  });

  test("答えに出たら目立たせる字は、例の旧字体とゝ・ゞ（今の文にも多い々は入れない）", () => {
    expect(PHOTO_EXAMPLE_CHARS).toEqual(["國", "學", "體", "ゝ", "ゞ"]);
  });

  test("例の言い方が行ごと返ってきたら捨てられるよう、指示の言葉に入れてある", () => {
    expect(PHOTO_TRANSCRIBE_HINTS).toContain("「國」を「国」に直さない");
    expect(PHOTO_TRANSCRIBE_HINTS).toContain("異体字や踊り字");
  });

  test("プロンプトの版を上げた（キャッシュの鍵・記録で区別する）", () => {
    expect(PHOTO_TRANSCRIBE_VERSION).toBe("1.1");
  });
});

describe("作者からの頼み", () => {
  const REQUEST = "旧字体はそのまま。\nルビの小さい字は（）に入れる。";

  test("頼みがあれば、依頼文の末尾に【作者からの頼み】として添える（改行もそのまま）", () => {
    const prompt = buildPhotoTranscribePrompt("1枚目", REQUEST);
    const at = prompt.indexOf("【作者からの頼み】");
    expect(at).toBeGreaterThan(prompt.indexOf("【答え方】"));
    expect(prompt.slice(at)).toContain("＜頼みのはじめ＞\n旧字体はそのまま。\nルビの小さい字は（）に入れる。\n＜頼みのおわり＞");
    expect(prompt.endsWith("＜頼みのおわり＞")).toBe(true);
  });

  test("頼みは原則より弱いと言い切る（ぶつかるときは原則を守る）", () => {
    const prompt = buildPhotoTranscribePrompt("1枚目", REQUEST);
    expect(prompt).toContain("頼みが原則や答え方とぶつかるときは、原則と答え方を守り");
    expect(prompt).toContain("一字一句写す・推測で補わない・指定のJSONだけで答える");
    expect(prompt).toContain("頼みの文そのものは、答えに書かないでください");
  });

  test("空・空白だけの頼みなら、何も添えない（頼みの無い依頼文と同じ）", () => {
    const plain = buildPhotoTranscribePrompt("1枚目");
    expect(buildPhotoTranscribePrompt("1枚目", "")).toBe(plain);
    expect(buildPhotoTranscribePrompt("1枚目", " \n　\n")).toBe(plain);
    expect(plain).not.toContain("作者からの頼み");
  });

  test("頼みを変えると依頼文が変わる（同じ写真でも、頼みを変えたら読み直す）", () => {
    const base = { pageLabel: "1枚目", image: { mimeType: "image/jpeg", base64: "AAAA" }, model: "m", numCtx: 8192 };
    const a = buildPhotoTranscribeRequest({ ...base, request: "旧字体はそのまま" });
    const b = buildPhotoTranscribeRequest({ ...base, request: "ルビは（）に" });
    const none = buildPhotoTranscribeRequest(base);
    expect(a.userPrompt).not.toBe(b.userPrompt);
    expect(a.userPrompt).not.toBe(none.userPrompt);
    // システム指示（原則）は頼みで変わらない
    expect(a.systemPrompt).toBe(none.systemPrompt);
  });

  test("頼みの見出しと挟む印は、返ってきたら捨てる指示の言葉に入れてある", () => {
    expect(PHOTO_TRANSCRIBE_HINTS).toEqual(
      expect.arrayContaining(["作者からの頼み", "＜頼みのはじめ＞", "＜頼みのおわり＞"])
    );
  });
});
