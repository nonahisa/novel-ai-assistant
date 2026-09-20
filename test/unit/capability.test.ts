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

    expect(capabilityCacheTag(profile, "contradiction")).toBe("");
  });

  test("絞るときは印を付ける", () => {
    // 7観点で作った古い結果を、3観点の結果として再利用しないため。
    // **パラメータ数が取れないと抑制も残る**ので、印は2つ並ぶ
    const profile = capabilityProfile({ tier: "standard", providerId: "ollama" });

    expect(capabilityCacheTag(profile, "contradiction")).toBe("light:strict:");
  });

  test("観点だけを絞るときは、抑制の印を付けない", () => {
    // 大きいモデルでも観点は絞られることがある（境目が違う）。
    // **並びは「絞り → 抑制」で固定する**——揺れると鍵が二重に積み上がる
    const profile = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "26.0B",
    });

    expect(profile.narrowContradictionCategories).toBe(true);
    expect(profile.suppressUncertainContradictions).toBe(false);
    expect(capabilityCacheTag(profile, "contradiction")).toBe("light:");
  });

  test("プロット逸脱の鍵には、抑制の印を混ぜない", () => {
    // **抑制は矛盾検知にしか無い。** 逸脱の鍵に混ぜると、
    // 関係のない変更で逸脱の結果まで総入れ替えになる
    const profile = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "8.0B",
    });

    expect(profile.suppressUncertainContradictions).toBe(true);
    expect(capabilityCacheTag(profile, "deviation")).toBe("light:");
    expect(capabilityCacheTag(profile, "contradiction")).toBe("light:strict:");
  });

  test("抑制のあるなしで、鍵が分かれる", () => {
    // **プロンプトそのものが変わる。** 混ぜないと、抑制ありで作った
    // 古い結果を、ゆるめた結果として再利用する（実装ルール4）
    const small = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "8.0B",
    });
    const large = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "26.0B",
    });

    expect(capabilityCacheTag(small, "contradiction")).not.toBe(capabilityCacheTag(large, "contradiction"));
  });
});

/*
  矛盾検知の抑制を、モデルの大きさで切り替える（設計書6.10.8）。

  実測（製品の経路で3回ずつ）——`e4b` は 0/4 のまま誤検出が 1〜2件 増え、
  `12b` は罠に掛かり、`26b` だけが 4/4・誤検出0 だった。
  **小さいモデルは「疑わしい」の線引きごと失う。**
*/
describe("矛盾検知の抑制は、モデルの大きさで決める（6.10.8）", () => {
  test("20B未満の手元のモデルには、抑制を残す", () => {
    const profile = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "8.0B",
    });

    expect(profile.suppressUncertainContradictions).toBe(true);
  });

  test("12B でも抑制を残す（罠に掛かった）", () => {
    const profile = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "12.2B",
    });

    expect(profile.suppressUncertainContradictions).toBe(true);
  });

  test("20B以上の手元のモデルでは、ゆるめる", () => {
    // 26b は 4/4・誤検出0。**ティアの境目（27B）を流用すると、
    // 満点を出したこのモデルが抑制される側に入る**
    const profile = capabilityProfile({
      tier: "standard",
      providerId: "ollama",
      parameterSize: "26.0B",
    });

    expect(profile.suppressUncertainContradictions).toBe(false);
  });

  test("LM Studio も大きさで決める", () => {
    const small = capabilityProfile({
      tier: "light",
      providerId: "lmstudio",
      parameterSize: "3.0B",
    });
    const large = capabilityProfile({
      tier: "light",
      providerId: "lmstudio",
      parameterSize: "32.0B",
    });

    expect(small.suppressUncertainContradictions).toBe(true);
    expect(large.suppressUncertainContradictions).toBe(false);
  });

  test("パラメータ数が取れないときは抑える", () => {
    // **分からないことを理由に挙動を変えない。** 矛盾検知にとっての
    // 「これまで」は 1.5＝抑制ありである
    expect(
      capabilityProfile({ tier: "standard", providerId: "ollama" })
        .suppressUncertainContradictions
    ).toBe(true);
    expect(
      capabilityProfile({
        tier: "standard",
        providerId: "ollama",
        parameterSize: null,
      }).suppressUncertainContradictions
    ).toBe(true);
    // 読み取れない表記も同じ扱い
    expect(
      capabilityProfile({
        tier: "standard",
        providerId: "ollama",
        parameterSize: "不明",
      }).suppressUncertainContradictions
    ).toBe(true);
  });

  test("大きさが分からないクラウドではゆるめる", () => {
    // クラウドの主力は大きいモデルなので、`inferTier` が high 扱いに
    // しているのと同じ理由でゆるめる側に置く
    for (const providerId of ["claude", "openai", "gemini", "sakura"] as const) {
      expect(
        capabilityProfile({ providerId }).suppressUncertainContradictions
      ).toBe(false);
    }
  });

  /*
    **大きさが分かるなら、どこで動いていようと大きさで決める**（0.70.12）。

    さくらのAIと LM Studio は公開されている重みを動かすので、モデルIDから
    `parseParameterSize` が大きさを読める。名前で門を作っていたときは、
    さくらの `12b` に「観点は絞るのに抑制はゆるめる」が渡っていた——
    実測で「当たりが増えないまま誤検出だけ増える」と結論した組み合わせである。
  */
  test("さくらの小さいモデルにも、抑制を残す", () => {
    const profile = capabilityProfile({
      tier: "light",
      providerId: "sakura",
      parameterSize: "12.2B",
    });

    // 観点を絞るなら、抑制も残す。**片方だけは、いちばん出来が悪かった**
    expect(profile.narrowContradictionCategories).toBe(true);
    expect(profile.suppressUncertainContradictions).toBe(true);
  });

  test("さくらの大きいモデルでは、これまでどおりゆるめる", () => {
    const profile = capabilityProfile({
      tier: "high",
      providerId: "sakura",
      parameterSize: "32.0B",
    });

    expect(profile.suppressUncertainContradictions).toBe(false);
  });

  test("同じ大きさなら、手元でもクラウドでも同じ判定になる", () => {
    // **名前で門を作らない。** 実測が見ていたのはモデルの大きさであって、
    // どこで動いているかではない
    for (const parameterSize of ["12.2B", "26.0B"]) {
      const ollama = capabilityProfile({
        tier: "standard",
        providerId: "ollama",
        parameterSize,
      });
      const sakura = capabilityProfile({
        tier: "standard",
        providerId: "sakura",
        parameterSize,
      });

      expect(sakura.suppressUncertainContradictions).toBe(
        ollama.suppressUncertainContradictions
      );
    }
  });
});

describe("作者へ見せる説明", () => {
  test("絞ったことを言う", () => {
    // 指摘の件数が減るので、理由が画面に出ていないと分からない。
    // **抑制を残したことも言う**（6.10.8）——同じモデル名でも送っている
    // 指示が違うので、出しておかないとログから読み取れない
    const input = { tier: "standard", providerId: "ollama" } as const;
    const text = describeCapability(
      input,
      capabilityProfile(input),
      "contradiction"
    );

    expect(text).toBe("標準・観点を絞る・確信の持てない指摘は抑える");
  });

  test("大きい手元のモデルでは、抑制のことを言わない", () => {
    const input = {
      tier: "standard",
      providerId: "ollama",
      parameterSize: "26.0B",
    } as const;
    const text = describeCapability(
      input,
      capabilityProfile(input),
      "contradiction"
    );

    expect(text).toBe("標準・観点を絞る");
  });

  /*
    **プロット逸脱検知に抑制の仕組みは無い**（0.70.12で直した）。

    機能を問わず1つの文へ畳んでいたため、Ollama / LM Studio で逸脱検知を
    回すと**毎回・必ず**「確信の持てない指摘は抑える」と出ていた。
    70B のモデルでも同じ文が出た（パラメータ数を渡していなかったため）。
  */
  test("プロット逸脱では、抑制のことを言わない", () => {
    const input = {
      tier: "standard",
      providerId: "ollama",
      parameterSize: "8.0B",
    } as const;
    const profile = capabilityProfile(input);

    expect(profile.suppressUncertainContradictions).toBe(true);
    expect(describeCapability(input, profile, "deviation")).toBe(
      "標準・観点を絞る"
    );
    expect(describeCapability(input, profile, "contradiction")).toBe(
      "標準・観点を絞る・確信の持てない指摘は抑える"
    );
  });

  test("パラメータ数が取れなくても、逸脱では抑制を名乗らない", () => {
    // 逸脱検知はパラメータ数を持たないことがある。取れないと抑制は
    // 「残す」に落ちるので、機能で分けていないと必ずこの文が出る
    const input = { tier: "high", providerId: "ollama" } as const;
    const text = describeCapability(
      input,
      capabilityProfile(input),
      "deviation"
    );

    expect(text).toBe("高性能");
  });

  test("絞らないときは地力だけを言う", () => {
    const input = { tier: "high", providerId: "claude" } as const;
    const text = describeCapability(
      input,
      capabilityProfile(input),
      "contradiction"
    );

    expect(text).toBe("高性能");
  });

  test("地力が分からないときは、そう言う", () => {
    const input = { providerId: "gemini" } as const;
    const text = describeCapability(
      input,
      capabilityProfile(input),
      "contradiction"
    );

    expect(text).toBe("地力は不明");
  });
});
