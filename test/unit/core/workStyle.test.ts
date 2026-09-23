import { describe, it, expect } from "vitest";
import {
  detectFirstPerson,
  collectWorkStyle,
  buildStyleNote,
} from "../../src/core/workStyle";
import { looksArchaicText } from "../../src/core/typoCheckValidation";

/**
 * 作品の作法（設計書6.8.14）。
 *
 * **知らないことを伝えるための仕組みである。** 間違ったことを伝えると、
 * 正しい直しまで出なくなる。**決められないときは黙る**ことを重く見る。
 */

/** 地の文が「僕」で、台詞では別の一人称を使う本文 */
function narrationWith(pronoun: string, hits: number): string {
  const line = `　${pronoun}は歩き出した。${pronoun}の足は重かった。`;
  return Array.from({ length: hits }, () => line).join("\n");
}

describe("語り手の一人称を数える", () => {
  it("地の文で使われている一人称を見つける", () => {
    expect(detectFirstPerson(narrationWith("僕", 30))).toBe("僕");
  });

  it("台詞の中の一人称に引きずられない", () => {
    // 登場人物はそれぞれ違う一人称を使う。混ぜると語り手のものが埋もれる
    const dialogue = Array.from(
      { length: 60 },
      () => "「俺がやる」「俺に任せろ」"
    ).join("\n");
    const text = `${narrationWith("僕", 30)}\n${dialogue}`;
    expect(detectFirstPerson(text)).toBe("僕");
  });

  it("三人称の作品では決めない", () => {
    // 誰の一人称も突出しない。無理に決めると嘘を教えることになる
    const text = Array.from(
      { length: 60 },
      () => "　彼は歩き出した。彼女はそれを見ていた。少年は黙っていた。"
    ).join("\n");
    expect(detectFirstPerson(text)).toBeNull();
  });

  it("競っているときは決めない", () => {
    const text = `${narrationWith("僕", 20)}\n${narrationWith("私", 20)}`;
    expect(detectFirstPerson(text)).toBeNull();
  });

  it("短すぎる本文では決めない", () => {
    expect(detectFirstPerson("　僕は歩いた。")).toBeNull();
  });

  it("「私たち」を「私」と数えない", () => {
    // 長い候補から取り除いていく。複数形は語り手の一人称ではない
    const text = Array.from(
      { length: 40 },
      () => "　私たちは歩き出した。私たちの足は重かった。"
    ).join("\n");
    expect(detectFirstPerson(text)).not.toBe("私");
  });
});

describe("文語体かどうか", () => {
  it("戦前の文語体を見分ける", () => {
    const text = Array.from(
      { length: 30 },
      () =>
        "　然し乍ら、其の頃は未だ幼く、父が與へて呉れた本を讀み耽つて居た。" +
        "尤も、當時の記憶は曖昧である。"
    ).join("\n");
    expect(looksArchaicText(text)).toBe(true);
  });

  it("現代文を文語体と間違えない", () => {
    const text = Array.from(
      { length: 40 },
      () => "　僕は歩き出した。空が青い。風が頬を撫でていく。"
    ).join("\n");
    expect(looksArchaicText(text)).toBe(false);
  });

  it("旧字が少し混ざるだけでは文語体と言わない", () => {
    const text =
      Array.from({ length: 60 }, () => "　彼は静かに歩いていた。").join("\n") +
      "\n　然し、それは違った。";
    expect(looksArchaicText(text)).toBe(false);
  });

  it("短すぎる本文では判断しない", () => {
    expect(looksArchaicText("然し乍ら")).toBe(false);
  });
});

describe("AIへ渡す形", () => {
  it("分かっていることを1行ずつ書く", () => {
    const note = buildStyleNote({
      narrativePerson: "一人称",
      firstPerson: "僕",
      keepWords: ["はよ", "急いどる"],
      archaic: false,
    });
    expect(note).toContain("語り手の一人称は「僕」");
    expect(note).toContain("はよ、急いどる");
    expect(note).not.toContain("文語体");
  });

  it("何も分からなければ空文字を返す", () => {
    // 「登録されていません」と送るのは、送信量を増やすだけで何も伝えない
    expect(
      buildStyleNote({
        narrativePerson: "",
        firstPerson: null,
        keepWords: [],
        archaic: false,
      })
    ).toBe("");
  });

  it("一人称を決められなければ、プロットの人称で代える", () => {
    const note = buildStyleNote({
      narrativePerson: "三人称一元",
      firstPerson: null,
      keepWords: [],
      archaic: false,
    });
    expect(note).toContain("三人称一元");
  });

  it("文語体なら、現代表記へ直さないよう伝える", () => {
    const note = buildStyleNote({
      narrativePerson: "",
      firstPerson: null,
      keepWords: [],
      archaic: true,
    });
    expect(note).toContain("文語体");
    expect(note).toContain("然し");
  });
});

describe("本文と設定からまとめる", () => {
  it("一人称・直さない語・文語かどうかを揃える", () => {
    const facts = collectWorkStyle({
      bodyText: narrationWith("俺", 30),
      narrativePerson: "一人称",
      keepWords: ["  はよ  ", "", "急いどる"],
    });
    expect(facts.firstPerson).toBe("俺");
    // 前後の空白と空の項目は落とす
    expect(facts.keepWords).toEqual(["はよ", "急いどる"]);
    expect(facts.archaic).toBe(false);
  });
});
