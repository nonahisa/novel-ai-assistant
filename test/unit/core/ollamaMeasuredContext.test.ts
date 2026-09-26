import { describe, expect, test } from "vitest";
import { preferMeasuredContextWindow } from "../../../src/core/modelTuning";
import { formatModelContext } from "../../../src/ai/registry";
import type { ModelInfo } from "../../../src/ai/types";

/**
 * 手元の Ollama の読める長さは、**作者の機械で測った値が申告に勝つ**
 * （作者の裁定、2026-09-26 夕。残課題 J3。設計書 6.49.6 の保留を閉じた）。
 *
 * 実例：`gemma4:26b` は `/api/show` で 262,144 読めると申告しながら、
 * 作者の機械ではメモリに載らなかった（6.28.11）。申告のまま分割すると、
 * 載らない長さで送り続ける。
 */
describe("申告と実測が食い違ったとき（J3）", () => {
  test("測っていなければ申告を使う", () => {
    expect(preferMeasuredContextWindow(262_144, undefined)).toEqual({
      tokens: 262_144,
      origin: "declared",
    });
    expect(preferMeasuredContextWindow(262_144, { timeoutSeconds: 300 })).toEqual({
      tokens: 262_144,
      origin: "declared",
    });
  });

  test("実測が申告より短ければ、実測を使う", () => {
    expect(
      preferMeasuredContextWindow(262_144, {
        contextWindow: 61_000,
        contextHitCeiling: false,
      })
    ).toEqual({ tokens: 61_000, origin: "measured" });
  });

  test("手で書いた実測（天井の印なし）も、作者の値として使う", () => {
    expect(
      preferMeasuredContextWindow(131_072, { contextWindow: 40_000 })
    ).toEqual({ tokens: 40_000, origin: "measured" });
  });

  /*
    **申告を超えては送らない。** 学習した長さを超える num_ctx を渡しても、
    モデルは読めない（切り捨てか、崩れた答えになる）。測定は申告を天井に
    しているので、申告より長い実測は手書きの値か写し間違いである。
  */
  test("実測が申告より長ければ、申告で頭打ちにする", () => {
    expect(
      preferMeasuredContextWindow(131_072, { contextWindow: 300_000 })
    ).toEqual({ tokens: 131_072, origin: "declared" });
  });

  /*
    **天井に届いた測定は「申告どおり読めた」の意味である。** 台帳に入る
    トークン数は、送った字数を換算したもので、応答の枠と詰め物の外側の
    ぶんだけ申告より少し短い。それを「実測」として使うと、読めると
    確かめたのに申告より短く絞ることになる。
  */
  test("測定が申告の天井に届いていたら、申告を使う", () => {
    expect(
      preferMeasuredContextWindow(131_072, {
        contextWindow: 118_000,
        contextHitCeiling: true,
      })
    ).toEqual({ tokens: 131_072, origin: "declared" });
  });

  test("小さすぎる値・壊れた値は使わない", () => {
    expect(
      preferMeasuredContextWindow(131_072, { contextWindow: 500 })
    ).toEqual({ tokens: 131_072, origin: "declared" });
    expect(
      preferMeasuredContextWindow(131_072, { contextWindow: Number.NaN })
    ).toEqual({ tokens: 131_072, origin: "declared" });
  });
});

describe("モデル選択に出どころを出す（J3）", () => {
  function model(overrides: Partial<ModelInfo>): ModelInfo {
    return {
      id: "gemma4:26b",
      displayName: "gemma4:26b",
      contextWindow: 262_144,
      parameterSize: "25.8B",
      capabilities: [],
      tier: "high",
      ...overrides,
    };
  }

  test("実測を使っているときは「実測」と申告の値を添える", () => {
    const label = formatModelContext(
      model({
        contextWindow: 61_000,
        declaredContextWindow: 262_144,
        contextWindowSource: "measured",
      })
    );
    expect(label).toContain("文脈 60k");
    expect(label).toContain("実測");
    expect(label).toContain("申告 256k");
  });

  test("申告のままなら、これまでどおりの表示", () => {
    expect(formatModelContext(model({}))).toBe("文脈 256k");
    expect(
      formatModelContext(
        model({ declaredContextWindow: 262_144, contextWindowSource: "declared" })
      )
    ).toBe("文脈 256k");
  });
});
