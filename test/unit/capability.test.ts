import { describe, expect, test } from "vitest";
import {
  capabilityCacheTag,
  capabilityProfile,
  describeCapability,
} from "../../src/ai/capability";

describe("モデルの地力で、機能の重さを決める", () => {
  test("高性能なモデルには、観点を全部渡す", () => {
    const profile = capabilityProfile({ tier: "high", providerId: "claude" });

    expect(profile.narrowContradictionCategories).toBe(false);
    expect(profile.narrowDeviationTypes).toBe(false);
    expect(profile.warnDeviationIneffective).toBe(false);
  });

  test("標準のモデルでも観点を絞る", () => {
    // gemma4:e4b（8B・standard）で逸脱検知が全話0件だった。
    // 境目は light と standard の間ではない
    const profile = capabilityProfile({ tier: "standard", providerId: "ollama" });

    expect(profile.narrowContradictionCategories).toBe(true);
    expect(profile.warnDeviationIneffective).toBe(true);
  });

  test("軽量なモデルでも観点を絞る", () => {
    const profile = capabilityProfile({ tier: "light", providerId: "lmstudio" });

    expect(profile.narrowContradictionCategories).toBe(true);
    expect(profile.narrowDeviationTypes).toBe(true);
  });

  test("LM Studio の小さいモデルにも、絞った観点を渡す", () => {
    // **これがいちばん直したかったこと。** 判定が `id === "ollama"` の
    // 文字列一致だったため、LM Studio 経由の3Bにはフルの7観点が渡っていた
    const lmstudio = capabilityProfile({ tier: "light", providerId: "lmstudio" });
    const ollama = capabilityProfile({ tier: "light", providerId: "ollama" });

    expect(lmstudio).toEqual(ollama);
  });

  test("クラウドでも小さいモデルなら絞る", () => {
    // さくらは公開されている重みを動かすので、名前から大きさが分かる。
    // 手元か外かではなく、モデルの地力で決める
    const profile = capabilityProfile({ tier: "light", providerId: "sakura" });

    expect(profile.narrowContradictionCategories).toBe(true);
  });
});

describe("モデルの情報が取れなかったとき", () => {
  test("Ollama は、これまでどおり絞る", () => {
    // **分からないことを理由に挙動を変えない。** モデル情報の取得は
    // 通信を伴うので失敗しうる。「取れなかった日だけ結果が違う」のは
    // いちばん追いにくい不具合になる
    const unknown = capabilityProfile({ providerId: "ollama" });
    const known = capabilityProfile({ tier: "standard", providerId: "ollama" });

    expect(unknown).toEqual(known);
  });

  test("Ollama 以外は、これまでどおり絞らない", () => {
    const unknown = capabilityProfile({ providerId: "claude" });

    expect(unknown.narrowContradictionCategories).toBe(false);
  });

  test("LM Studio は、情報が取れないと絞れない", () => {
    // 取れないときの判定は「これまでと同じ」なので、LM Studio は
    // 絞られない。**モデル情報が取れれば直る**ことを、ここに記しておく
    const unknown = capabilityProfile({ providerId: "lmstudio" });

    expect(unknown.narrowContradictionCategories).toBe(false);
  });
});

describe("キャッシュの鍵に混ぜる印", () => {
  test("絞らないときは空にする", () => {
    // **有料AIで処理済みのキャッシュを飛ばさないため。**
    // 印が空なら、high のモデルの鍵はこれまでと同じままになる
    const profile = capabilityProfile({ tier: "high", providerId: "claude" });

    expect(capabilityCacheTag(profile)).toBe("");
  });

  test("絞るときは印を付ける", () => {
    // 7観点で作った古い結果を、3観点の結果として再利用しないため
    const profile = capabilityProfile({ tier: "standard", providerId: "ollama" });

    expect(capabilityCacheTag(profile)).toBe("light:");
  });
});

describe("作者へ見せる説明", () => {
  test("絞ったことを言う", () => {
    // 指摘の件数が減るので、理由が画面に出ていないと分からない
    const input = { tier: "standard", providerId: "ollama" } as const;
    const text = describeCapability(input, capabilityProfile(input));

    expect(text).toBe("標準・観点を絞る");
  });

  test("絞らないときは地力だけを言う", () => {
    const input = { tier: "high", providerId: "claude" } as const;
    const text = describeCapability(input, capabilityProfile(input));

    expect(text).toBe("高性能");
  });

  test("地力が分からないときは、そう言う", () => {
    const input = { providerId: "gemini" } as const;
    const text = describeCapability(input, capabilityProfile(input));

    expect(text).toBe("地力は不明");
  });
});
