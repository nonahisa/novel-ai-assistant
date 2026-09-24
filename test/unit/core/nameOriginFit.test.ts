import { describe, expect, test } from "vitest";
import {
  fitNameCandidates,
  planNameOrigin,
  toKatakana,
} from "../../../src/core/nameOriginFit";
import type { NameCandidate } from "../../../src/prompts/nameSuggest";

/**
 * 名前の候補（P-29）の系統を、作品に合わせて揃える（設計書6.37.2）。
 *
 * **作者の裁定（2026-09-25 朝）**：系統の指定が無ければ、作品の世界観
 * （設定資料・既存の人物名）に合わせて揃える。
 *
 * 測定（引継ぎ書8章「【測定】2026-09-25 深夜（2巡目）」）で、指定なしのとき
 * gemma4:e4b は7系統を混ぜ（アジャーノの付け直しに、ドイツ・北欧・英語圏・
 * フランス・アラビア・架空語・イタリア）、gemma4:26b は外国系の名前を英字
 * （Lukas・Friedrich・Benedetto）で返した。下の材料はその答えの写し。
 */

function candidate(name: string, reading: string, origin: string): NameCandidate {
  return { name, reading, origin, note: "" };
}

/** 写しの作品の人物名（`r2/work/*` の設定資料から。読みは省いた） */
const MIBOJIN = [
  "コリンナ",
  "精霊姫ナイン",
  "孤児院の院長",
  "プラム",
  "エルシー",
  "ウィーネ",
  "支部長",
  "指輪の男",
  "革鎧の男",
  "皇帝",
  "宰相",
  "宰相の側近",
  "マーフ",
  "殿下",
  "勇者アジャン",
  "ガイ",
  "おっさん",
  "リザードマン",
];
const IJIME = [
  "三門太志",
  "おばあさん",
  "密倉文佳",
  "純也",
  "奥原",
  "圭織",
  "春原月夜",
  "斉藤",
  "黒木",
  "お手伝いさん",
  "母さん",
  "教頭先生",
  "武藤",
  "久滋",
];
const GUILD = ["ホンゴー", "ジャック", "ケンプ", "ヒッコリー", "ケイン", "グレイ", "ジャンヌ"];

describe("指定が無いときの系統をコードで決める", () => {
  test("人物名が漢字中心の作品は、和風に決める（AIに見立てさせない）", () => {
    const plan = planNameOrigin({ existingNames: IJIME, setting: "" });
    expect(plan.choices).toEqual(["和風"]);
    expect(plan.script).toBe("kanji");
    expect(plan.chosen).toBe(false);
    expect(plan.basis).toContain("漢字");
  });

  test("人物名がカタカナ中心の作品は、カタカナで書く系統だけから選ばせる", () => {
    // 役どころの呼び名（皇帝・宰相・指輪の男）は漢字でも、名前の並びを映さない
    for (const names of [MIBOJIN, GUILD]) {
      const plan = planNameOrigin({ existingNames: names, setting: "" });
      expect(plan.script).toBe("katakana");
      expect(plan.choices).not.toContain("和風");
      expect(plan.choices).not.toContain("中華");
      expect(plan.choices).toContain("架空語");
      expect(plan.basis).toContain("カタカナ");
    }
  });

  test("世界観に系統がはっきり書いてあれば、それに決める", () => {
    const plan = planNameOrigin({ existingNames: GUILD, setting: "北欧神話をもとにした氷の国" });
    expect(plan.choices).toEqual(["北欧"]);
    expect(plan.basis).toContain("北欧");
    // 中華ファンタジーは漢字の系統
    expect(
      planNameOrigin({ existingNames: ["李雪蓮", "王"], setting: "中華風の後宮" }).choices
    ).toEqual(["中華"]);
  });

  test("世界観の系統が人物名の表記と食い違えば、人物名を採る（書いてある名前のほうが実際）", () => {
    const plan = planNameOrigin({ existingNames: IJIME, setting: "北欧の小さな港町" });
    expect(plan.choices).toEqual(["和風"]);
  });

  test("手がかりが無ければ、どの系統からでも1つ選ばせる（揃えるのはコードの検算）", () => {
    const plan = planNameOrigin({ existingNames: [], setting: "" });
    expect(plan.script).toBeUndefined();
    expect(plan.choices.length).toBeGreaterThan(5);
  });

  test("作者が選んだ系統は、そのまま使う", () => {
    const plan = planNameOrigin({ chosen: "ドイツ", existingNames: IJIME, setting: "" });
    expect(plan).toMatchObject({ choices: ["ドイツ"], script: "katakana", chosen: true });
  });
});

describe("返ってきた候補の系統が揃っているかをコードで確かめる", () => {
  test("e4b が7系統を混ぜた答え：見立てた系統と違うものを落とす（黙って減らさない）", () => {
    const plan = planNameOrigin({ existingNames: MIBOJIN, setting: "" });
    const answer = [
      candidate("ルカリア", "るかりあ", "イタリア・スペイン"),
      candidate("バルカス", "ばるかす", "ドイツ"),
      candidate("シグルド", "しぐるど", "北欧"),
      candidate("エドガル", "えどがる", "英語圏"),
      candidate("ジャン＝ピエール", "じゃんぴえーる", "フランス"),
      candidate("ニコラス", "にこらす", "アラビア"),
      candidate("アレクシオス", "あれくしおす", "架空語"),
      candidate("コンスタンティノス", "こんすたんてぃのす", "イタリア・スペイン"),
      candidate("ヴィクトル", "ゔぃくとる", "フランス"),
      candidate("ファビウス", "ふぁびうす", "イタリア・スペイン"),
    ];
    // 見立てた系統の申告が無いときは、候補の系統の多数で決める
    const fit = fitNameCandidates(answer, plan);
    expect(fit.origin).toBe("イタリア・スペイン");
    expect(fit.kept.map((item) => item.name)).toEqual(["ルカリア", "コンスタンティノス", "ファビウス"]);
    expect(fit.dropped).toHaveLength(7);
    expect(fit.dropped[0].reason).toContain("系統が揃っていません");
    // 申告があれば、申告した系統で揃える
    const declared = fitNameCandidates(answer, plan, "フランス");
    expect(declared.kept.map((item) => item.name)).toEqual(["ジャン＝ピエール", "ヴィクトル"]);
  });

  test("26b が英字で返した名前：読みからカタカナに直し、直したことを残す", () => {
    const plan = planNameOrigin({ existingNames: MIBOJIN, setting: "" });
    const fit = fitNameCandidates(
      [
        candidate("Lukas", "るかす", "ドイツ"),
        candidate("Friedrich", "ふりーどりっく", "ドイツ"),
        candidate("Sebastian", "ぜばすてぃあん", "ドイツ"),
        candidate("Otto", "", "ドイツ"),
      ],
      plan,
      "ドイツ"
    );
    expect(fit.kept.map((item) => item.name)).toEqual(["ルカス", "フリードリック", "ゼバスティアン"]);
    expect(fit.converted).toEqual([
      { from: "Lukas", to: "ルカス" },
      { from: "Friedrich", to: "フリードリック" },
      { from: "Sebastian", to: "ゼバスティアン" },
    ]);
    // 読みが無ければ直せない。落として理由を言う
    expect(fit.dropped.map((item) => item.candidate.name)).toEqual(["Otto"]);
    expect(fit.dropped[0].reason).toContain("英字");
  });

  test("カタカナの作品に漢字の名前、漢字の作品にカタカナ・英字の名前が混ざったら落とす", () => {
    const katakana = fitNameCandidates(
      [candidate("エルマー", "えるまー", "ドイツ"), candidate("相沢", "あいざわ", "ドイツ")],
      planNameOrigin({ existingNames: GUILD, setting: "" }),
      "ドイツ"
    );
    expect(katakana.kept.map((item) => item.name)).toEqual(["エルマー"]);
    expect(katakana.dropped[0].reason).toContain("カタカナ");

    const kanji = fitNameCandidates(
      [
        candidate("霧島", "きりしま", "和風"),
        candidate("さくら", "さくら", "和風"),
        candidate("ケイ", "けい", "和風"),
        candidate("Ren", "れん", "和風"),
      ],
      planNameOrigin({ existingNames: IJIME, setting: "" })
    );
    expect(kanji.kept.map((item) => item.name)).toEqual(["霧島", "さくら"]);
    expect(kanji.dropped.map((item) => item.candidate.name)).toEqual(["ケイ", "Ren"]);
  });

  test("直した名前が、ほかの候補と同じになったら後のほうを落とす", () => {
    const fit = fitNameCandidates(
      [candidate("ルカス", "るかす", "ドイツ"), candidate("Lukas", "るかす", "ドイツ")],
      planNameOrigin({ chosen: "ドイツ", existingNames: [], setting: "" })
    );
    expect(fit.kept.map((item) => item.name)).toEqual(["ルカス"]);
    expect(fit.dropped).toHaveLength(1);
  });

  test("系統の書いてない候補は、表記だけで確かめる（空の申告で落とさない）", () => {
    const fit = fitNameCandidates(
      [candidate("燈真", "とうま", ""), candidate("海斗", "かいと", "和風")],
      planNameOrigin({ existingNames: ["少年"], setting: "" })
    );
    expect(fit.kept.map((item) => item.name)).toEqual(["燈真", "海斗"]);
  });
});

test("ひらがなの読みをカタカナへ（ゔ・長音も）", () => {
  expect(toKatakana("ゔぃくとる")).toBe("ヴィクトル");
  expect(toKatakana("ふりーどりっく")).toBe("フリードリック");
});
