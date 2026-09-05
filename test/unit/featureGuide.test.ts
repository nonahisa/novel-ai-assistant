import { describe, expect, test } from "vitest";
import {
  buildFeatureGuideForQuestion,
  buildFeatureIndex,
  buildGuideBundles,
  EXTRA_GUIDE,
} from "../../src/features/featureGuide";
import { ACTION_TREE } from "../../src/views/actionList";

/**
 * 相談へ渡す「使い方の説明」（目次＋束）。
 *
 * ## 物差しを、全文から ACTION_TREE へ移した（0.25.2）
 *
 * 以前は `buildFeatureGuide()`（全文）を組み立て、束の中身が全文と
 * 一致するかを見ていた。だが全文は製品コードから呼ばれなくなっており、
 * **試験のためだけに残っている写し**だった。写しどうしを比べても、
 * 両方が同時にずれれば気づけない。
 *
 * いまは**元になる定義（`ACTION_TREE`）を直接歩いて**、そこにある操作が
 * 目次と束の両方に出ているかを見る。守っているものは変わらない——
 * **操作が漏れると、AIは「その機能はありません」と嘘を答える。**
 */

const bundles = buildGuideBundles();
/** 束をすべてつないだもの。「どれかの束に入っているか」を見るのに使う */
const bundleText = bundles.map((bundle) => bundle.text).join("\n");
const index = buildFeatureIndex();

function allActions() {
  // 写しの分類（「テスト中」）は案内に入れない。中身は元の操作の写しである
  return ACTION_TREE.filter((group) => !group.generated).flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.kind === "section" ? entry.items : [entry]
    )
  );
}

/** 手元（Nodeあり）の画面に出る操作 */
function visibleActions() {
  // **画面に出ない操作は、案内にも入れない**（`browserOnly`）。
  // 試験は手元で走るので、ブラウザ版だけの操作は外れる
  return allActions().filter((action) => !action.browserOnly);
}

/** `EXTRA_GUIDE` から【…】の節を1つ取り出す（製品側と同じ切り方） */
function extraSection(title: string): string {
  const lines = EXTRA_GUIDE.split("\n");
  const start = lines.indexOf(`【${title}】`);
  expect(start, `節が無い: ${title}`).toBeGreaterThanOrEqual(0);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("【"));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

describe("使い方の説明（目次と束）", () => {
  test("操作メニューの全操作が、目次にも束にも漏れなく入る", () => {
    // 漏れると、AIは「その機能はありません」と嘘を答える。
    // 説明書を手で書かずメニューの定義から作るのは、これを防ぐため
    for (const action of visibleActions()) {
      expect(index, `目次: ${action.label}`).toContain(action.label);
      expect(bundleText, `束: ${action.label}`).toContain(action.label);
    }
  });

  test("説明の行として（名前だけでなく）束に入る", () => {
    /*
      **束から漏れた操作は、説明を誰も渡せない。** 分類の直下にある操作は
      小分類が無いので落としやすい（束は小分類ごとに切っている）。

      名前が本文のどこかに出ているだけでは足りないので、`describeAction()`
      が作る「  - 名前…」の行として出ていることを見る。
    */
    const lines = bundleText.split("\n").map((line) => line.trimEnd());

    for (const action of visibleActions()) {
      const found = lines.some((line) =>
        line.startsWith(`  - ${action.label}`)
      );
      expect(found, action.label).toBe(true);
    }
  });

  test("ブラウザ版だけの操作は、手元の案内に入れない", () => {
    // 画面に無い操作をAIが案内すると、探しても見つからない
    const browserOnly = allActions().filter((action) => action.browserOnly);

    expect(browserOnly.length).toBeGreaterThan(0);
    for (const action of browserOnly) {
      expect(index, `目次: ${action.label}`).not.toContain(action.label);
      expect(bundleText, `束: ${action.label}`).not.toContain(action.label);
    }
  });

  test("分類の見出しが、画面と同じ並びで束に並ぶ", () => {
    // 並びが画面と違うと「どこにあるか」を答えられない。
    // 束は分類ごとに（分類直下 → 小分類の順で）積んであるので、
    // 各分類が最初に現れる位置が、画面の並びと同じ順になる
    const groups = ACTION_TREE.filter((group) => !group.generated);
    const positions = groups.map((group) =>
      bundles.findIndex(
        (bundle) =>
          bundle.label === group.label ||
          bundle.label.startsWith(`${group.label} → `)
      )
    );

    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("AIを使う操作には印を付ける", () => {
    // 料金がかかることを答えられないと、案内として役に立たない
    const line = bundleText
      .split("\n")
      .find((entry) => entry.includes("誤字脱字を検知"));

    expect(line).toContain("（AIを使う）");
  });

  test("AIを使わない操作には印を付けない", () => {
    const line = bundleText
      .split("\n")
      .find((entry) => entry.includes("表記ゆれを検知"));

    expect(line).not.toContain("（AIを使う）");
  });

  test("画面の説明を含む（操作メニューに出ないもの）", () => {
    for (const name of ["提案", "設定資料", "作品一覧", "右クリック"]) {
      expect(bundleText, name).toContain(name);
    }
  });

  test("メニューに出ないボタンと振る舞いが、名前で目次に載る", () => {
    /*
      パネルの中のボタン（相談・提案・EPUBエディター・執筆統計）と、
      作者が押さないのに働くもの（独り言・順番待ち）は `ACTION_TREE` に
      無い。**目次に名前が無ければ、AIは「そんな機能はありません」と
      答える**——操作の漏れとまったく同じ害である。

      名前は `EXTRA_GUIDE` の節から機械的に切り出しているので、
      節へ足したものは自動で目次に載る。ここではその切り出しが
      効いていることを見る。
    */
    const section = extraSection("メニューに出ないボタンと振る舞い");
    const names = section
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).split(": ")[0]);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(index, `目次: ${name}`).toContain(`・${name}`);
      expect(bundleText, `束: ${name}`).toContain(name);
    }
  });

  test("0.30〜0.33で足したものが、案内から消えていない", () => {
    // 上の検査は「節にあるものが目次へ回る」ことしか見ない。
    // **節から丸ごと消えたときに気づけない**ので、名前を名指しで置く
    for (const name of [
      "相談を資料へ反映",
      "AIに訊く",
      "EPUBエディターの右の並び",
      "貼り込み係へ渡す形でコピー",
      "Xへ貼り付ける",
      "サイトの記録",
      "AIの独り言の感想",
      "AI機能の順番待ち",
    ]) {
      expect(index, `目次: ${name}`).toContain(name);
      expect(bundleText, `束: ${name}`).toContain(name);
    }
  });

  test("メニューに出ないボタンにも、しないことの断りを残す", () => {
    // 「本文は書き換えません」「送信は作者が押します」が落ちると、
    // AIが逆を答えかねない（説明の短縮と同じ理由）
    for (const note of [
      "承認するまで資料は変わりません",
      "本文は書き換えません",
      "本には入りません",
      "送信は必ず作者が押します",
      "投稿ボタンは作者が押します",
      "自動でアクセスすることはありません",
    ]) {
      expect(bundleText, note).toContain(note);
    }
  });

  test("ファイルの置き場所を含む", () => {
    expect(bundleText).toContain("設定/plot.md");
    expect(bundleText).toContain("設定/synopsis.md");
  });

  test("画面用の強調記号を落とす", () => {
    // ** はメニューのホバー表示用。AIへの指示と混ざると読みにくい
    expect(bundleText).not.toContain("*".repeat(2));
    expect(index).not.toContain("*".repeat(2));
  });

  test("何ができるかの1文目は、そのまま入る", () => {
    // 言い換えると意味が変わる。**機械的に切るだけ**にする（2026-08-27）
    const action = allActions().find(
      (entry) => entry.command === "novelai.checkNotation"
    );
    const first =
      action!.detail.split("。")[0].split("*".repeat(2)).join("") + "。";

    expect(bundleText).toContain(first);
  });

  test("「〜ません」の断りは落とさない", () => {
    /*
      **毎回送る量を減らすために、説明を短くした**（8,111字→5,097字）。
      だが「AIは使いません」「原稿は書き換えません」を落とすと、
      **AIが逆を答えかねない。** しないことの断りは、作者がいちばん
      知りたいことである。
    */
    expect(bundleText).toContain("AIは使いません。");
  });

  test("但し書きまでは入れない（説明は短い版だけ）", () => {
    // 2文目以降の言い換え・使いどころは落とす。名前と1文目があれば、
    // 「どこにあるか」「何ができるか」には答えられる
    const action = allActions().find(
      (entry) => entry.command === "novelai.checkNotation"
    );
    const fullDetail = action!.detail.split("*".repeat(2)).join("");

    expect(bundleText).not.toContain(fullDetail);
  });
});

describe("相談へ渡す目次", () => {
  test("目次は1,800字未満", () => {
    /*
      毎回送るのはこれと【この拡張機能の考え方】だけなので、ここが伸びると
      節約の意味が薄れる。**超えたら、まず説明が混ざっていないかを疑うこと。**
      名前が増えただけなら上限を上げてよいが、伸び方は操作1つで15字ほどである。

      1,600→1,700：名前の点検（設計書6.37）で操作が3つ増えた。
      増えたのは名前だけで、説明は混ざっていない（`buildFeatureIndex` は
      `nameOnly` しか並べない）。

      1,700→1,750：更新告知（P-30）で操作が2つ増えた（約39字）。
      こちらも名前だけである。

      1,750→1,800：ストリーミング実験の入切（設計書6.63.1）で1つ増えた
      （名前だけで約30字）。**この1件は開発ビルドにしか無い**——本番ビルドでは
      `__DEV_HELPERS__` が false に畳まれて項目ごと落ちるので、
      作者へ実際に送られる目次は1,740字ほどのままである。試験は開発ビルドとして
      走るため、ここで測っているのは**多いほう**の値になる。

      1,800→1,850：EPUBエディター（設計書6.65.6）で1つ増えた（名前だけで
      約15字）。説明は混ざっていない。

      1,850→1,900：プロットモードの画面（設計書6.4.8）で1つ増えた
      （名前だけで約12字）。説明は混ざっていない。

      1,900→1,950：提供先別の設定資料の書き出し（設計書6.75）で1つ増えた
      （名前だけで約20字）。説明は混ざっていない。

      1,950→2,100：メニューに出ないボタンと振る舞い（0.30〜0.33で入った8件）
      の**名前だけ**を目次へ足した（約160字）。パネルの中のボタンは
      `ACTION_TREE` に項目が無く、目次に名前が無いとAIが「そんな機能は
      ありません」と答える——操作の漏れと同じ害なので、操作と同じ扱いにした。
      説明は束（`hidden`）の側にあり、目次には混ざっていない。

      **0.33.8で「その他支援」を「原稿づくり」「投稿・書き出し」へ割った。**
      小分類の見出しが1行増えるので、目次は約9字だけ伸びて2,096字になった
      （操作は1つも増えていない）。上限は上げていないが、**残りは4字**である
      ——次に操作を1つ足せばここが落ちる。**目次は全操作の名前を持つのが
      役目なので、束のように割って減らすことができない。** 落ちたときは
      「説明が混ざっていないか」だけ確かめて、名前が増えただけなら上限を
      上げてよい（この一覧の書き方で理由を残すこと）。
    */
    expect(index.length).toBeLessThan(2100);
  });

  test("原稿を勝手に書き換えない、という断りは必ず入る", () => {
    // **どんな相談でも、AIがこの逆を答えてはいけない。**
    // 質問に関係するかどうかで出し分けない
    expect(index).toContain("本文（原稿）は勝手に書き換えない");
  });
});

describe("説明の束", () => {
  test("1つの束は1,500字未満", () => {
    // 超えたら小分類を割る（渡す単位が大きすぎると、関係の薄い説明が
    // まとめて付いてくる）
    const tooLong = bundles.filter((bundle) => bundle.text.length >= 1500);

    expect(
      tooLong.map((bundle) => `${bundle.label}: ${bundle.text.length}字`)
    ).toEqual([]);
  });

  /*
    **上限に張りつく束を作らない**（0.33.8）。

    「執筆AI支援 → その他支援」は20項目まで育ち、**1,499字で上限1,500の
    1字下**になっていた。次に操作を1つ足せば落ちる状態で、そこで上限を
    上げれば「送る量が機能数に比例する」行き止まり（6.27）へ戻る。
    **上限を上げるのではなく、小分類そのものを割った。**

    割った線は「原稿を書き、整える」操作と「書き上がったものを外へ出す」
    操作のあいだである。どちらも作者が別の場面で使う——書いている最中と、
    投稿・出版の段——ので、詳細メニューの見た目としても筋が通る。
  */
  test("「その他支援」は、原稿づくりと投稿・書き出しに割ってある", () => {
    const labels = bundles.map((bundle) => bundle.label);

    expect(labels).toContain("執筆AI支援 → 原稿づくり");
    expect(labels).toContain("執筆AI支援 → 投稿・書き出し");
    expect(labels.some((label) => label.includes("その他支援"))).toBe(false);
  });

  test("割った2つの束は、どちらも1,000字未満（足す余地を残す）", () => {
    // **上限ぎりぎりに割り直しても意味が無い。** 割った直後から
    // 1字下に戻るなら、次の1操作でまた同じ作業になる
    const split = bundles.filter(
      (bundle) =>
        bundle.label === "執筆AI支援 → 原稿づくり" ||
        bundle.label === "執筆AI支援 → 投稿・書き出し"
    );

    expect(
      split
        .filter((bundle) => bundle.text.length >= 1000)
        .map((bundle) => `${bundle.label}: ${bundle.text.length}字`)
    ).toEqual([]);
  });

  /*
    **全体の字数の上限は置かない**（2026-08-29）。

    以前は全文に6,300字の上限があった。毎回AIへ送っていたので、伸びるのを
    止める目印が要ったからである。だが機能を足すたびに上限を引き上げる
    ことになり（6,000→6,300）、**送る量が機能数に比例する形そのものが
    行き止まり**だった。いまは相談へ送るのが「目次＋関係する束」だけなので、
    上限は目次と束の一つひとつに置いてある。
  */
});

describe("相談1回ぶんの組み立て", () => {
  test("本文の相談では、目次だけを渡す", () => {
    // 作品の相談に使い方の説明は要らない。ここが節約の本体である
    const built = buildFeatureGuideForQuestion({
      question: "この段落は冗長ですか",
    });

    expect(built.reason).toBe("none");
    expect(built.selected).toEqual([]);
    // 上限は目次と同じ（渡しているものが目次そのものなので、揃えておく）
    expect(built.text.length).toBeLessThan(2100);
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

  /*
    **割った2つの束が、互いに紛れないこと**（0.33.8）。

    束選び（`core/guideSelect.ts`）は文字2つ組みの一致で選ぶので、
    見出しの名前そのものも当たりの材料になる。**割った結果、どちらの
    質問でも両方が返るようでは割った意味が無い**（送る量が減らない）。
  */
  test("ルビの質問では、原稿づくりが先に来る", () => {
    const built = buildFeatureGuideForQuestion({ question: "ルビを振りたい" });

    // **「投稿・書き出し」が一緒に来るのは誤爆ではない。** あちらにも
    // 「投稿サイトのルビを取り込む」が実在する。見てほしいのはどちらが
    // 先かで、当たりの多い束が先に来ていれば、上限で削られるのは後ろになる
    expect(built.selected[0]).toBe("執筆AI支援 → 原稿づくり");
  });

  test("投稿の質問では、投稿・書き出しだけが選ばれる", () => {
    const built = buildFeatureGuideForQuestion({
      question: "新話を投稿するにはどうしますか",
    });

    expect(built.selected).toContain("執筆AI支援 → 投稿・書き出し");
    expect(built.selected).not.toContain("執筆AI支援 → 原稿づくり");
  });
});
