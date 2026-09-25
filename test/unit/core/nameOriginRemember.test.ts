import { describe, expect, test } from "vitest";
import {
  REMEMBERED_ORIGIN_BASIS,
  fitNameCandidates,
  originToRemember,
  parseNameOrigin,
  planNameOrigin,
} from "../../../src/core/nameOriginFit";
import { parseWorkConfig } from "../../../src/core/workRegistry";
import type { NameCandidate } from "../../../src/prompts/nameSuggest";

/**
 * カタカナの作品の名前の系統を、作品ごとに覚えて固定する
 * （設計書6.37.2。作者の裁定、2026-09-25 昼）。
 *
 * 覚える前は、カタカナの作品で系統をAIが回ごとに選び、同じ作品でも回ごとに
 * 変わった（gemma4:e4b で、ギルドの作品がフランス → ドイツ）。
 */

const GUILD = ["ホンゴー", "ジャック", "ケンプ", "ヒッコリー", "ケイン", "グレイ", "ジャンヌ"];
const IJIME = ["三門太志", "密倉文佳", "純也", "奥原", "圭織", "春原月夜"];

function candidate(name: string, reading: string, origin: string): NameCandidate {
  return { name, reading, origin, note: "" };
}

describe("覚えている系統で決める", () => {
  test("カタカナの作品で覚えている系統があれば、その1つだけをAIへ渡す", () => {
    const plan = planNameOrigin({ remembered: "ドイツ", existingNames: GUILD, setting: "" });
    expect(plan.choices).toEqual(["ドイツ"]);
    expect(plan.script).toBe("katakana");
    expect(plan.remembered).toBe(true);
    expect(plan.chosen).toBe(false);
    expect(plan.basis).toBe(REMEMBERED_ORIGIN_BASIS);
  });

  test("覚えていなければ、これまでどおりカタカナの系統から選ばせる（覚える作品と印を付ける）", () => {
    const plan = planNameOrigin({ existingNames: GUILD, setting: "" });
    expect(plan.choices.length).toBeGreaterThan(1);
    expect(plan.remembered).toBeFalsy();
    expect(plan.fixable).toBe(true);
  });

  test("回ごとに違う系統を名乗っても、覚えている系統で揃える（フランス → ドイツが起きない）", () => {
    const plan = planNameOrigin({ remembered: "フランス", existingNames: GUILD, setting: "" });
    const fit = fitNameCandidates(
      [candidate("ルートヴィヒ", "るーとゔぃひ", "ドイツ"), candidate("ジュリアン", "じゅりあん", "フランス")],
      plan,
      "ドイツ"
    );
    expect(fit.origin).toBe("フランス");
    expect(fit.kept.map((item) => item.name)).toEqual(["ジュリアン"]);
  });

  test("作者が選んだ系統は、覚えている系統より先に採る", () => {
    const plan = planNameOrigin({
      chosen: "北欧",
      remembered: "ドイツ",
      existingNames: GUILD,
      setting: "",
    });
    expect(plan.choices).toEqual(["北欧"]);
    expect(plan.chosen).toBe(true);
    expect(plan.fixable).toBe(true);
  });

  test("漢字の作品では、覚えている系統を使わない（作品の実際を採る）", () => {
    const plan = planNameOrigin({ remembered: "ドイツ", existingNames: IJIME, setting: "" });
    expect(plan.choices).toEqual(["和風"]);
    expect(plan.remembered).toBeFalsy();
    expect(plan.fixable).toBe(false);
  });

  test("世界観に系統が書いてあれば、覚えている系統よりそちらを採る", () => {
    const plan = planNameOrigin({
      remembered: "ドイツ",
      existingNames: GUILD,
      setting: "北欧神話をもとにした氷の国",
    });
    expect(plan.choices).toEqual(["北欧"]);
    expect(plan.remembered).toBeFalsy();
  });

  test("カタカナで書かない系統が覚えてあっても使わない（手で書き換えられた値）", () => {
    const plan = planNameOrigin({ remembered: "和風", existingNames: GUILD, setting: "" });
    expect(plan.choices.length).toBeGreaterThan(1);
    expect(plan.remembered).toBeFalsy();
  });
});

describe("何を覚えるか", () => {
  const auto = planNameOrigin({ existingNames: GUILD, setting: "" });

  test("まだ覚えていないカタカナの作品では、AIが選んだ系統を覚える", () => {
    expect(originToRemember(auto, undefined, "フランス", 5)).toBe("フランス");
  });

  test("候補が1つも残らなかった回の名乗りは覚えない", () => {
    expect(originToRemember(auto, undefined, "フランス", 0)).toBeUndefined();
  });

  test("揃える系統が決まらなかった回（名乗りも候補も無い）は覚えない", () => {
    expect(originToRemember(auto, undefined, undefined, 0)).toBeUndefined();
  });

  test("覚えている系統で出した回は、何も覚え直さない", () => {
    const plan = planNameOrigin({ remembered: "ドイツ", existingNames: GUILD, setting: "" });
    expect(originToRemember(plan, "ドイツ", "ドイツ", 8)).toBeUndefined();
  });

  test("作者が選び直したカタカナの系統は、覚えている系統を置き換える", () => {
    const plan = planNameOrigin({
      chosen: "フランス",
      remembered: "ドイツ",
      existingNames: GUILD,
      setting: "",
    });
    expect(originToRemember(plan, "ドイツ", "フランス", 0)).toBe("フランス");
  });

  test("作者がカタカナの作品で和風を選んだ回は、覚え直さない（1人だけ別の出自）", () => {
    const plan = planNameOrigin({ chosen: "和風", existingNames: GUILD, setting: "" });
    expect(originToRemember(plan, "ドイツ", "和風", 10)).toBeUndefined();
  });

  test("漢字の作品では、作者が選んだ系統も覚えない", () => {
    const plan = planNameOrigin({ chosen: "ドイツ", existingNames: IJIME, setting: "" });
    expect(originToRemember(plan, undefined, "ドイツ", 10)).toBeUndefined();
  });

  test("世界観で1つに決まる作品では覚えない（毎回同じ決め方で同じになる）", () => {
    const plan = planNameOrigin({ existingNames: GUILD, setting: "ドイツ風の城塞都市" });
    expect(originToRemember(plan, undefined, "ドイツ", 10)).toBeUndefined();
  });
});

describe("作品の設定ファイルに覚える形", () => {
  const base = {
    schemaVersion: "0.1",
    workTitle: "ギルド",
    manuscriptDir: "本文",
    settingsDir: "設定",
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  test("系統は設定ファイルを読み書きしても残る", () => {
    expect(parseWorkConfig({ ...base, nameOrigin: "ドイツ" }).nameOrigin).toBe("ドイツ");
  });

  test("知らない値は無かったことにする（作品は開ける）", () => {
    const config = parseWorkConfig({ ...base, nameOrigin: "火星風" });
    expect(config.nameOrigin).toBeUndefined();
    expect("nameOrigin" in config).toBe(false);
  });

  test("系統を持たない設定ファイルに欄を足さない（差分を濁さない）", () => {
    expect("nameOrigin" in parseWorkConfig(base)).toBe(false);
  });

  test("系統の読み取りは前後の空白を許し、型の違う値は捨てる", () => {
    expect(parseNameOrigin(" フランス ")).toBe("フランス");
    expect(parseNameOrigin(3)).toBeUndefined();
    expect(parseNameOrigin(undefined)).toBeUndefined();
  });
});
