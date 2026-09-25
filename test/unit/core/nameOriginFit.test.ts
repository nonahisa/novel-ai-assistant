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

  describe("現代・近代の話は和風と見立てる（作者の裁定、2026-09-25 午前）", () => {
    /*
      作者の実例（現代ダンジョン）で、系統をAIに見立てさせると e4b も 26b も
      ドイツと見立てた。0.87.0 ではプロットモード（P-45）の指示文にだけ
      「現代ものは和風と見立てて」と書いていたが、名前点検（P-29）には無かった。
      **コードが決めて、両方が同じ決め方を使う**
    */
    test("人物名の手がかりが無く、世界観が現代なら和風に決め、根拠を返す", () => {
      const plan = planNameOrigin({
        existingNames: [],
        setting: "- 現代。各地にダンジョンが出現した",
      });
      expect(plan.choices).toEqual(["和風"]);
      expect(plan.script).toBe("kanji");
      expect(plan.chosen).toBe(false);
      expect(plan.basis).toContain("「現代」");
      expect(plan.basis).toContain("日本の話");
    });

    test.each([
      ["近代の港町。蒸気船が行き交う", "近代"],
      ["東京の下町の商店街", "東京"],
      ["昭和の終わりの地方都市", "昭和"],
      ["大日本帝国の末期", "日本"],
      ["現代ファンタジー。高校に魔法部がある", "現代"],
    ])("「%s」は和風（手がかりの語：%s）", (setting, word) => {
      const plan = planNameOrigin({ existingNames: [], setting });
      expect(plan.choices).toEqual(["和風"]);
      expect(plan.basis).toContain(`「${word}」`);
    });

    test.each([
      "異世界に転移した現代日本の高校生",
      "現代のロンドン。アメリカから来た探偵",
      "現代によく似た架空の国",
      "近代化を進める王国",
    ])("外国や架空の世界の語があれば見立てない：「%s」", (setting) => {
      const plan = planNameOrigin({ existingNames: [], setting });
      expect(plan.choices).not.toEqual(["和風"]);
    });

    test("人物名がカタカナ中心なら、現代でも人物名を採る（書いてある名前のほうが実際）", () => {
      const plan = planNameOrigin({ existingNames: GUILD, setting: "現代の東京" });
      expect(plan.script).toBe("katakana");
      expect(plan.choices).not.toContain("和風");
    });

    test("作者が系統を選べば、現代でもそれを使う", () => {
      const plan = planNameOrigin({ chosen: "北欧", existingNames: [], setting: "現代" });
      expect(plan.choices).toEqual(["北欧"]);
    });
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

  test("漢字のあいだの「ノ」「ヶ」「ケ」「ヵ」は日本の名前の一部として通す（26b の「一ノ瀬 莉子」が落ちた、2026-09-25）", () => {
    const fit = fitNameCandidates(
      [
        candidate("一ノ瀬 莉子", "いちのせ りこ", "和風"),
        candidate("霞ヶ浦 透", "かすみがうら とおる", "和風"),
        candidate("三ケ田", "みけた", "和風"),
        candidate("八ヵ岳", "やつがたけ", "和風"),
        // 漢字に挟まれていないカタカナは今までどおり落とす
        candidate("ノア", "のあ", "和風"),
        candidate("一ノ", "いちの", "和風"),
      ],
      planNameOrigin({ existingNames: IJIME, setting: "" })
    );
    expect(fit.kept.map((item) => item.name)).toEqual([
      "一ノ瀬 莉子",
      "霞ヶ浦 透",
      "三ケ田",
      "八ヵ岳",
    ]);
    expect(fit.dropped.map((item) => item.candidate.name)).toEqual(["ノア", "一ノ"]);
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

/**
 * 系統の札だけ揃えて、名前の中身は別の系統を出す（実機確認 3巡目、2026-09-25 午後、
 * gemma4:e4b）。「ドイツ」の札で「ギヨーム」「エリオット」、「北欧」の札で「シングル」
 * 「フレイム」。札が揃っているので、それまでの検算（札の照合）は素通りだった。
 *
 * 完全な判定は無理なので、**はっきり言えるものだけ**を見る：
 *   - 英語のふつうの言葉（名前として使わない語だけ）
 *   - ほかの系統でよく使う名前の短い表（複数の系統で使う名前は、その全部を持つ）
 */
describe("系統の札と名前の中身が合っているか（札だけ揃えた答え）", () => {
  test("「ドイツ」の札のフランス・英語の名前と英語の言葉を落とす（e4b の実物）", () => {
    const fit = fitNameCandidates(
      [
        candidate("ヴェルナー", "ゔぇるなー", "ドイツ"),
        candidate("フリードリヒ", "ふりーどりひ", "ドイツ"),
        candidate("ヴォルフガング", "ゔぉるふがんぐ", "ドイツ"),
        candidate("アルベルト", "あるべると", "ドイツ"),
        candidate("ギヨーム", "ぎよーむ", "ドイツ"),
        candidate("フリーメン", "ふりーめん", "ドイツ"),
        candidate("ラウル", "らうる", "ドイツ"),
        candidate("エリオット", "えりおっと", "ドイツ"),
        candidate("ルートヴィヒ", "るーとゔぃひ", "ドイツ"),
      ],
      planNameOrigin({ existingNames: GUILD, setting: "" }),
      "ドイツ"
    );

    expect(fit.kept.map((item) => item.name)).toEqual([
      "ヴェルナー",
      "フリードリヒ",
      "ヴォルフガング",
      "アルベルト",
      "ルートヴィヒ",
    ]);
    expect(fit.dropped.map((item) => item.candidate.name)).toEqual([
      "ギヨーム",
      "フリーメン",
      "ラウル",
      "エリオット",
    ]);
    // 作者が読める理由（どの系統の名前に見えるか）を添える
    expect(fit.dropped[0].reason).toContain("フランス");
    expect(fit.dropped[1].reason).toContain("英語の言葉");
  });

  test("「北欧」の札の英語の言葉と英語圏の名前を落とす（e4b の実物）", () => {
    const fit = fitNameCandidates(
      [
        candidate("シングル", "しんぐる", "北欧"),
        candidate("バルドゥル", "ばるどぅる", "北欧"),
        candidate("ホルン", "ほるん", "北欧"),
        candidate("ビヨルン", "びよるん", "北欧"),
        candidate("エリス", "えりす", "北欧"),
        candidate("トールヴィ", "とーるゔぃ", "北欧"),
        candidate("ハラルド", "はらるど", "北欧"),
        candidate("フィンバル", "ふぃんばる", "北欧"),
        candidate("トービン", "とーびん", "北欧"),
        candidate("フレイム", "ふれいむ", "北欧"),
      ],
      planNameOrigin({ existingNames: GUILD, setting: "" }),
      "北欧"
    );

    expect(fit.kept.map((item) => item.name)).toEqual([
      "バルドゥル",
      "ホルン",
      "ビヨルン",
      "トールヴィ",
      "ハラルド",
    ]);
    expect(fit.dropped.map((item) => item.candidate.name)).toEqual([
      "シングル",
      "エリス",
      "フィンバル",
      "トービン",
      "フレイム",
    ]);
  });

  test("26b の答え（札と中身が合っている）は1件も落とさない", () => {
    const plan = planNameOrigin({ existingNames: GUILD, setting: "" });
    const answers: Array<[string, string[]]> = [
      ["ドイツ", ["ヴォルフガング", "フリードリヒ", "ジークフリート", "ルドルフ", "ラインハルト", "アルブレヒト", "ディーター"]],
      ["北欧", ["ヴィダル", "グンナー", "ハルデン", "イヴァル", "スヴェン", "ロルケ", "エリック", "トールム", "ビョルン", "シグルド", "エギル"]],
      ["イタリア・スペイン", ["ロレンツォ", "ディエゴ", "マルコ", "エンリケ", "ルカ", "フェリペ", "マテオ", "サンティアゴ", "ラファエル", "ニコラ"]],
      ["フランス", ["ジャン＝ピエール", "アラン", "セバスチャン", "エティエンヌ", "フィリップ", "マルセル", "オノレ", "アントワーヌ"]],
      ["英語圏", ["ミラー", "ベネット", "ロビン", "ハリス", "クーパー", "ディラン", "ライリー", "スコット", "ダグラス", "ブライト"]],
    ];
    for (const [origin, names] of answers) {
      const fit = fitNameCandidates(
        names.map((name) => candidate(name, "", origin)),
        plan,
        origin
      );
      expect(fit.dropped, origin).toEqual([]);
    }
  });

  test("複数の系統で使う名前は、そのどれかの札なら通す（ラウルはフランスにもスペインにもある）", () => {
    const fit = fitNameCandidates(
      [candidate("ラウル", "らうる", "イタリア・スペイン")],
      planNameOrigin({ existingNames: GUILD, setting: "" }),
      "イタリア・スペイン"
    );
    expect(fit.kept.map((item) => item.name)).toEqual(["ラウル"]);
  });

  test("架空語の札では、実在の名前の表を当てない（英語の言葉だけ見る）", () => {
    const fit = fitNameCandidates(
      [candidate("エリオット", "えりおっと", "架空語"), candidate("シャドウ", "しゃどう", "架空語")],
      planNameOrigin({ chosen: "架空語", existingNames: GUILD, setting: "" })
    );
    expect(fit.kept.map((item) => item.name)).toEqual(["エリオット"]);
    expect(fit.dropped.map((item) => item.candidate.name)).toEqual(["シャドウ"]);
  });

  test("「・」「＝」でつないだ名前は、部分ごとに見る", () => {
    const fit = fitNameCandidates(
      [candidate("ハンス・ギヨーム", "はんす ぎよーむ", "ドイツ")],
      planNameOrigin({ chosen: "ドイツ", existingNames: [], setting: "" })
    );
    expect(fit.dropped[0]?.reason).toContain("ギヨーム");
  });
});

test("ひらがなの読みをカタカナへ（ゔ・長音も）", () => {
  expect(toKatakana("ゔぃくとる")).toBe("ヴィクトル");
  expect(toKatakana("ふりーどりっく")).toBe("フリードリック");
});
