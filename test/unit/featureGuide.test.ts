import { describe, expect, test } from "vitest";
import {
  buildFeatureGuide,
  buildFeatureGuideForQuestion,
  buildFeatureIndex,
  buildGuideBundles,
} from "../../src/features/featureGuide";
import { ACTION_TREE } from "../../src/views/actionList";

const guide = buildFeatureGuide();

function allActions() {
  // 写しの分類（「テスト中」）は案内に入れない。中身は元の操作の写しである
  return ACTION_TREE.filter((group) => !group.generated).flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.kind === "section" ? entry.items : [entry]
    )
  );
}

describe("使い方の説明", () => {
  test("操作メニューの全操作が漏れなく入る", () => {
    // 漏れると、AIは「その機能はありません」と嘘を答える。
    // 説明書を手で書かずメニューの定義から作るのは、これを防ぐため
    for (const action of allActions()) {
      // **画面に出ない操作は、案内にも入れない**（`browserOnly`）。
      // 試験は手元（Nodeあり）で走るので、ブラウザ版だけの操作は外れる
      if (action.browserOnly) continue;
      expect(guide, action.label).toContain(action.label);
    }
  });

  test("ブラウザ版だけの操作は、手元の案内に入れない", () => {
    // 画面に無い操作をAIが案内すると、探しても見つからない
    const browserOnly = allActions().filter((action) => action.browserOnly);

    expect(browserOnly.length).toBeGreaterThan(0);
    for (const action of browserOnly) {
      expect(guide, action.label).not.toContain(action.label);
    }
  });

  test("分類と小分類の見出しが、画面と同じ並びで入る", () => {
    // 並びが画面と違うと「どこにあるか」を答えられない
    // 写しの分類（「テスト中」）は案内に入れない
    const groupPositions = ACTION_TREE.filter((group) => !group.generated).map(
      (group) => guide.indexOf(`■ ${group.label}`)
    );

    expect(groupPositions.every((at) => at >= 0)).toBe(true);
    const sorted = [...groupPositions].sort((a, b) => a - b);
    expect(groupPositions).toEqual(sorted);
  });

  test("AIを使う操作には印を付ける", () => {
    // 料金がかかることを答えられないと、案内として役に立たない
    const line = guide
      .split("\n")
      .find((entry) => entry.includes("誤字脱字を検知"));

    expect(line).toContain("（AIを使う）");
  });

  test("AIを使わない操作には印を付けない", () => {
    const line = guide
      .split("\n")
      .find((entry) => entry.includes("表記ゆれを検知"));

    expect(line).not.toContain("（AIを使う）");
  });

  test("画面の説明を含む（操作メニューに出ないもの）", () => {
    for (const name of ["提案", "設定資料", "作品一覧", "右クリック"]) {
      expect(guide, name).toContain(name);
    }
  });

  test("ファイルの置き場所を含む", () => {
    expect(guide).toContain("設定/plot.md");
    expect(guide).toContain("設定/synopsis.md");
  });

  test("画面用の強調記号を落とす", () => {
    // ** はメニューのホバー表示用。AIへの指示と混ざると読みにくい
    expect(guide).not.toContain("**");
  });

  test("何ができるかの1文目は、そのまま入る", () => {
    // 言い換えると意味が変わる。**機械的に切るだけ**にする（2026-08-27）
    const action = allActions().find(
      (entry) => entry.command === "novelai.checkNotation"
    );
    const first = action!.detail.split("。")[0].split("*".repeat(2)).join("") + "。";

    expect(guide).toContain(first);
  });

  test("「〜ません」の断りは落とさない", () => {
    /*
      **毎回送る量を減らすために、説明を短くした**（8,111字→5,097字）。
      だが「AIは使いません」「原稿は書き換えません」を落とすと、
      **AIが逆を答えかねない。** しないことの断りは、作者がいちばん
      知りたいことである。
    */
    expect(guide).toContain("AIは使いません。");
  });

  test("但し書きまでは入れない（毎回送るので短くする）", () => {
    // 2文目以降の言い換え・使いどころは落とす。名前と1文目があれば、
    // 「どこにあるか」「何ができるか」には答えられる
    const action = allActions().find(
      (entry) => entry.command === "novelai.checkNotation"
    );
    const fullDetail = action!.detail.split("*".repeat(2)).join("");

    expect(guide).not.toContain(fullDetail);
    /*
      **ここには全体の字数の上限を置かない**（2026-08-29）。

      以前は6,300字の上限があった。毎回AIへ送っていたので、伸びるのを
      止める目印が要ったからである。だが機能を足すたびに上限を引き上げる
      ことになり（6,000→6,300）、**送る量が機能数に比例する形そのものが
      行き止まり**だった。

      いまは相談へ送るのは「目次＋関係する束」だけで、この全文は
      作者が読むマニュアル（`openManual.ts`）が使う。読み物は伸びてよい。
      代わりに目次と束の一つひとつに上限を置いてある（下の試験）。
    */
  });
});

describe("相談へ渡す目次", () => {
  const index = buildFeatureIndex();

  test("全操作の名前が入る", () => {
    // **名前だけは毎回全部渡す。** ここが欠けると、AIは
    // 「その機能はありません」と嘘を答える。説明を絞る代わりの担保である
    for (const action of allActions()) {
      if (action.browserOnly) continue;
      expect(index, action.label).toContain(action.label);
    }
  });

  test("目次は1,600字未満", () => {
    /*
      毎回送るのはこれと【この拡張機能の考え方】だけなので、ここが伸びると
      節約の意味が薄れる。**超えたら、まず説明が混ざっていないかを疑うこと。**
      名前が増えただけなら上限を上げてよいが、伸び方は操作1つで15字ほどである。
    */
    expect(index.length).toBeLessThan(1600);
  });

  test("原稿を勝手に書き換えない、という断りは必ず入る", () => {
    // **どんな相談でも、AIがこの逆を答えてはいけない。**
    // 質問に関係するかどうかで出し分けない
    expect(index).toContain("本文（原稿）は勝手に書き換えない");
  });
});

describe("説明の束", () => {
  const bundles = buildGuideBundles();

  test("1つの束は1,500字未満", () => {
    // 超えたら小分類を割る（渡す単位が大きすぎると、関係の薄い説明が
    // まとめて付いてくる）
    const tooLong = bundles.filter((bundle) => bundle.text.length >= 1500);

    expect(
      tooLong.map((bundle) => `${bundle.label}: ${bundle.text.length}字`)
    ).toEqual([]);
  });

  test("束を全部つなぐと、短い説明の全行が入る", () => {
    // **束から漏れた操作は、説明を誰も渡せない。** 分類の直下の操作は
    // 小分類が無いので落としやすい
    const joined = bundles.map((bundle) => bundle.text).join("\n");
    const lines = new Set(joined.split("\n").map((line) => line.trim()));

    // 操作の行だけを見る。全文の後半（画面・置き場所・考え方）にも
    // 「- 」で始まる行があるが、あれは操作ではない
    const expected = guide
      .slice(0, guide.indexOf("【画面】"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));

    expect(expected.length).toBeGreaterThan(0);
    for (const line of expected) {
      expect(lines.has(line), line).toBe(true);
    }
  });
});

describe("相談1回ぶんの組み立て", () => {
  test("本文の相談では、目次だけを渡す", () => {
    // 作品の相談に使い方の説明は要らない。ここが節約の本体である
    const built = buildFeatureGuideForQuestion({
      question: "この段落は冗長ですか",
    });

    expect(built.reason).toBe("none");
    expect(built.selected).toEqual([]);
    expect(built.text.length).toBeLessThan(1800);
  });

  test("機能名で聞かれたら、その小分類の説明を足す", () => {
    const built = buildFeatureGuideForQuestion({
      question: "誤字脱字はどこ？",
    });

    expect(built.selected.some((label) => label.includes("校正・校閲"))).toBe(
      true
    );
    // 目次は落とさない。説明のある操作だけが全部だと読まれては困る
    expect(built.text).toContain("表記ゆれを検知");
  });
});
