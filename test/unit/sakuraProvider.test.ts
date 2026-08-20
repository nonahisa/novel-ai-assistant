import { describe, expect, test } from "vitest";
import { parseParameterSize } from "../../src/ai/sakuraProvider";
import { inferTier } from "../../src/ai/types";

/**
 * さくらのAI Engine アダプタ。
 *
 * APIはOpenAI互換なので、`generate` や `listModels` の道は ChatGPT と同じ
 * 部品（`fetchJson` / `isChatModel` / `isUnsupportedParameter`）を使い回す。
 * **ここで確かめるのは、さくらに固有の判断のほうである。**
 */
describe("モデル名からパラメータ数を読む", () => {
  test.each([
    ["preview/gemma-4-31B-it", "31B"],
    ["gemma-4-9b-it", "9B"],
    ["llama-3.3-70B-instruct", "70B"],
    ["some-model-1.5B", "1.5B"],
  ])("%s → %s", (id, expected) => {
    expect(parseParameterSize(id)).toBe(expected);
  });

  test.each([
    // 大きさが名前に無いもの
    "preview/some-model-it",
    "gpt-4o",
    "",
  ])("読めなければ null: %s", (id) => {
    expect(parseParameterSize(id)).toBeNull();
  });

  test("版番号を大きさと読み違えない", () => {
    // 「llama-3.3」の 3.3 はパラメータ数ではない。
    // B か M が続くものだけを拾う
    expect(parseParameterSize("llama-3.3-instruct")).toBeNull();
  });
});

/**
 * **「クラウドだから最上位」と決めつけない。**
 *
 * さくらが出しているのは公開重みのモデルで、名前に大きさが入っている。
 * 中身が非公開の Claude や ChatGPT とは事情が違う。
 *
 * ここを最上位にすると、31Bのモデルへ 70B級を想定した長さのプロンプトと
 * チャンクが渡る。**手元の12Bで駄目だった仕事を投げることになる。**
 */
describe("大きさに見合った扱いにする", () => {
  test("31Bは最上位として扱う", () => {
    expect(inferTier(parseParameterSize("preview/gemma-4-31B-it"), "ollama")).toBe(
      "high"
    );
  });

  test("9Bは中位として扱う", () => {
    expect(inferTier(parseParameterSize("gemma-4-9b-it"), "ollama")).toBe(
      "standard"
    );
  });

  test("小さいモデルは軽い扱いにする", () => {
    expect(inferTier(parseParameterSize("some-model-3B"), "ollama")).toBe(
      "light"
    );
  });

  test("大きさが分からなければ、控えめに見る", () => {
    // **分からないものを最上位にしない。** 重い仕事を投げて失敗するより、
    // 軽い扱いで確実に返るほうがよい
    expect(inferTier(parseParameterSize("preview/unknown-it"), "ollama")).toBe(
      "light"
    );
  });

  test("他のクラウドは今までどおり最上位", () => {
    // さくらの扱いを変えたことで、ChatGPTやClaudeが巻き込まれていないか
    expect(inferTier(null, "openai")).toBe("high");
    expect(inferTier(null, "claude")).toBe("high");
    expect(inferTier(null, "gemini")).toBe("high");
  });
});
