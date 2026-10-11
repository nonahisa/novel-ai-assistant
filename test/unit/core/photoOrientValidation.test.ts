import { describe, expect, test } from "vitest";
import { imageSupportFor } from "../../../src/ai/imageInput";
import {
  SPREAD_ASPECT,
  combinePhotoOrient,
  describePhotoOrientGuess,
  parsePhotoOrient,
  photoOrientSettled,
  placePhotoByGuess,
  shouldAskPhotoOrient,
  type PhotoOrientAnswer,
} from "../../../src/core/photoOrientValidation";
import {
  ORIENT_PROBE_TURNS,
  PHOTO_ORIENT_SCHEMA,
  buildPhotoOrientPrompt,
  buildPhotoOrientRequest,
} from "../../../src/prompts/photoOrient";

/**
 * 写真の向きと見開きを手元のAIに尋ねる（P-49、設計書6.117.11）。
 * 答えの検算・突き合わせ・画面の置き方・尋ねてよいかの決まり。
 */

const answer = (top: string, layout: string): string => JSON.stringify({ top, layout });
const yes = { kind: "yes" } as const;

describe("答えの検算（parsePhotoOrient）", () => {
  test("字の頭の向きを、時計回りに回す角度へ読み替える", () => {
    expect(parsePhotoOrient(answer("up", "single"))).toEqual({ rotation: 0, spread: false });
    // 頭が左を向いていれば、時計回りに90度回すと直る（横倒しの「手書き2」）
    expect(parsePhotoOrient(answer("left", "single"))).toEqual({ rotation: 90, spread: false });
    expect(parsePhotoOrient(answer("down", "spread"))).toEqual({ rotation: 180, spread: true });
    expect(parsePhotoOrient(answer("right", "single"))).toEqual({ rotation: 270, spread: false });
  });

  test("列挙に無い値・欠けた項目は推さない（指示の言葉がそのまま返っても）", () => {
    expect(parsePhotoOrient(answer("上の辺", "single"))).toBeUndefined();
    expect(parsePhotoOrient(answer("up", "見開き"))).toBeUndefined();
    expect(parsePhotoOrient(answer("up|right|down|left", "single"))).toBeUndefined();
    expect(parsePhotoOrient(JSON.stringify({ top: "up" }))).toBeUndefined();
    expect(parsePhotoOrient(JSON.stringify({ top: 0, layout: "single" }))).toBeUndefined();
    expect(parsePhotoOrient("写真は横倒しです。")).toBeUndefined();
    expect(parsePhotoOrient("")).toBeUndefined();
  });

  test("コードフェンスに包まれた答えも読む", () => {
    expect(parsePhotoOrient("```json\n" + answer("left", "single") + "\n```")).toEqual({
      rotation: 90,
      spread: false,
    });
  });
});

describe("回した写しの答えの突き合わせ（combinePhotoOrient）", () => {
  const one = (rotation: 0 | 90 | 180 | 270, spread = false): PhotoOrientAnswer => ({ rotation, spread });

  test("写真を見ずにいつも同じ辺を答えるモデルは推さない（gemma4:e4b の実測の形）", () => {
    // どの写しにも「上」（回さない）と答える → 読み替えると 0・90・270 にばらける
    const probes = ORIENT_PROBE_TURNS.map((turn) => ({ turn, answer: one(0) }));
    expect(combinePhotoOrient(probes)).toBeUndefined();
  });

  test("読み替えた向きが2つ一致したら推す", () => {
    // 見えている写真は右へ90度回せば直る：0度の写しに90、90度回した写しに0
    const guess = combinePhotoOrient([
      { turn: 0, answer: one(90) },
      { turn: 90, answer: one(0) },
    ]);
    expect(guess).toEqual({ rotation: 90, spread: false });
  });

  test("2つ目が外れても、3つ目が1つ目と一致すれば推す", () => {
    const guess = combinePhotoOrient([
      { turn: 0, answer: one(90) },
      { turn: 90, answer: one(90) },
      { turn: 270, answer: one(180) }, // 270 + 180 = 90
    ]);
    expect(guess?.rotation).toBe(90);
  });

  test("1つしか無い・同じ数で割れた・読めなかったときは推さない", () => {
    expect(combinePhotoOrient([{ turn: 0, answer: one(90) }])).toBeUndefined();
    expect(
      combinePhotoOrient([
        { turn: 0, answer: one(90) },
        { turn: 90, answer: undefined },
        { turn: 270, answer: undefined },
      ])
    ).toBeUndefined();
    expect(combinePhotoOrient([])).toBeUndefined();
  });

  test("見開きは、一致した答えどうしで揃ったときだけ推す", () => {
    expect(
      combinePhotoOrient([
        { turn: 0, answer: one(0, true) },
        { turn: 90, answer: one(270, true) },
      ])
    ).toEqual({ rotation: 0, spread: true });
    expect(
      combinePhotoOrient([
        { turn: 0, answer: one(0, true) },
        { turn: 90, answer: one(270, false) },
      ])
    ).toEqual({ rotation: 0, spread: undefined });
  });

  test("2つ一致したら残りは尋ねない", () => {
    expect(photoOrientSettled([{ turn: 0, answer: one(0) }])).toBe(false);
    expect(
      photoOrientSettled([
        { turn: 0, answer: one(0) },
        { turn: 90, answer: one(270) },
      ])
    ).toBe(true);
  });
});

describe("推しを画面の置き方へ直す（placePhotoByGuess）", () => {
  test("横倒しの1ページ（2576×1932）は、右へ90度回して切らない（真ん中で切らない）", () => {
    expect(placePhotoByGuess({ rotation: 90, spread: false }, 2576, 1932)).toEqual({
      rotation: 90,
      split: false,
    });
    // 見開きを推せなかったときも、回したあとの縦横比で決めるので切らない
    expect(placePhotoByGuess({ rotation: 90, spread: undefined }, 2576, 1932)).toEqual({
      rotation: 90,
      split: false,
    });
  });

  test("見開きの写真は、そのまま左右に切る", () => {
    expect(placePhotoByGuess({ rotation: 0, spread: true }, 2576, 1932)).toEqual({
      rotation: 0,
      split: true,
    });
    expect(placePhotoByGuess({ rotation: 0, spread: undefined }, 2576, 1932).split).toBe(true);
  });

  test("横長でも「1ページ」と推せたら切らない。縦長でも「見開き」と推せたら切る", () => {
    expect(placePhotoByGuess({ rotation: 0, spread: false }, 2576, 1932).split).toBe(false);
    expect(placePhotoByGuess({ rotation: 0, spread: true }, 1932, 2576).split).toBe(true);
  });

  test("縦横比の境目は画面の既定と同じ", () => {
    expect(placePhotoByGuess({ rotation: 0, spread: undefined }, 120 * SPREAD_ASPECT, 120).split).toBe(true);
    expect(placePhotoByGuess({ rotation: 0, spread: undefined }, 119 * SPREAD_ASPECT, 120).split).toBe(false);
  });
});

describe("尋ねてよいか（shouldAskPhotoOrient）", () => {
  test("手元のAIで、写真を読めると申告したモデルだけ", () => {
    expect(shouldAskPhotoOrient("ollama", yes)).toBe(true);
    expect(shouldAskPhotoOrient("lmstudio", yes)).toBe(true);
  });

  test("クラウドのAIには尋ねない（写真を読めても）", () => {
    for (const id of ["claude", "gemini", "openai", "sakura", "vscode-lm"]) {
      expect(shouldAskPhotoOrient(id, yes), id).toBe(false);
    }
  });

  test("手元のAIでも、写真を読めない・申告が無いモデルには尋ねない", () => {
    expect(shouldAskPhotoOrient("ollama", imageSupportFor("ollama", { imageInput: false }))).toBe(false);
    expect(shouldAskPhotoOrient("ollama", imageSupportFor("ollama", {}))).toBe(false);
    expect(shouldAskPhotoOrient("lmstudio", imageSupportFor("lmstudio"))).toBe(false);
  });
});

describe("札の文", () => {
  test("向きと見開きを出し、手元のAIだと分かるようにする", () => {
    expect(describePhotoOrientGuess({ rotation: 90, spread: false })).toContain(
      "向きを推しました：右へ90度・1ページ（手元のAI）"
    );
    expect(describePhotoOrientGuess({ rotation: 270, spread: true })).toContain("左へ90度・見開き");
    expect(describePhotoOrientGuess({ rotation: 0, spread: undefined })).toContain(
      "向きを推しました：そのまま（手元のAI）"
    );
  });
});

describe("依頼の形（P-49）", () => {
  test("写真1枚・温度0・思考なし・num_ctx を明示・スキーマは列挙だけ", () => {
    const request = buildPhotoOrientRequest({
      image: { mimeType: "image/jpeg", base64: "AAAA" },
      model: "gemma4:26b",
      numCtx: 4096,
    });
    expect(request.images).toHaveLength(1);
    expect(request.temperature).toBe(0);
    expect(request.disableThinking).toBe(true);
    expect(request.numCtx).toBe(4096);
    expect(request.jsonSchema).toBe(PHOTO_ORIENT_SCHEMA);
    expect(PHOTO_ORIENT_SCHEMA.properties.top.enum).toEqual(["up", "right", "down", "left"]);
    expect(PHOTO_ORIENT_SCHEMA.properties.layout.enum).toEqual(["single", "spread"]);
    expect(PHOTO_ORIENT_SCHEMA.additionalProperties).toBe(false);
  });

  test("指示に列挙の値をすべて書いている（書いていない値を選ばせない）", () => {
    const prompt = buildPhotoOrientPrompt();
    for (const value of ["up", "right", "down", "left", "spread", "single"]) {
      expect(prompt).toContain(value);
    }
  });

  test("逆さ（180度）の写しは尋ねない（いちばん当たらない向き）", () => {
    expect([...ORIENT_PROBE_TURNS]).toEqual([0, 90, 270]);
  });
});
