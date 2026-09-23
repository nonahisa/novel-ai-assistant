import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  CHECK_FAILED,
  DEFAULT_PROOFREADING_CHECK_IDS,
  PROOFREADING_CHECKS,
  PROOFREADING_SUITE_COMMAND,
  describeStep,
  describeSuiteResult,
  isCancelledOutcome,
  outcomeKindOf,
  parseStoredSelection,
  serializeSelection,
  sortToRunOrder,
} from "../../src/core/proofreadingSuite";
import { allActions } from "../../src/views/actionList";

/**
 * 校正のまとめ実行（設計書6.80）の、順番と控えを守る。
 *
 * **順番と分類名の置き場は1か所しかない。** 写しを作ると、まとめ実行が
 * 数える分類名だけが古いまま残り、**件数がいつも0件と出る**——しかも
 * 例外は出ないので、作者からは「指摘が無かった」としか見えない。
 */

interface PackageManifest {
  contributes: { commands: Array<{ command: string }> };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as PackageManifest;

const declared = new Set(
  manifest.contributes.commands.map((entry) => entry.command)
);

/**
 * 分類名を提案パネルへ渡している呼び出し（と、既定値を持つ受け口）。
 *
 * `showResults` は宣言の側に既定値（`category = "誤字脱字"`）を持つので、
 * 引数の並びを切り出せば既定値も一緒に見える。
 */
const PANEL_CATEGORY_CALLS = [
  "showResults",
  "showContradictions",
  "showDeviations",
  "replaceContents",
  "showRecordUpdates",
];

/**
 * `name(...)` の丸括弧の中身を、対応する閉じ括弧まで切り出す。
 *
 * **完璧な構文解析ではない。** 文字列の中の丸括弧だけは数えないように
 * してあり、それで足りる（この3ファイルの該当箇所は素直な呼び出しである）。
 * 釣り合いが取れなければ**黙って空を返さず**に落とす——「分類が無い」と
 * 誤って報告するより、切り出せなかったと言うほうがよい。
 */
function callArguments(source: string, name: string): string[] {
  const found: string[] = [];
  const opener = new RegExp(`\\b${name}\\s*\\(`, "g");
  let match: RegExpExecArray | null;

  while ((match = opener.exec(source)) !== null) {
    const from = match.index + match[0].length;
    let depth = 1;
    let quote: string | undefined;
    let cursor = from;

    for (; cursor < source.length && depth > 0; cursor++) {
      const char = source[cursor];
      if (quote) {
        if (char === "\\") cursor++;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    if (depth !== 0) {
      throw new Error(`${name}( の閉じ括弧を見つけられませんでした`);
    }
    found.push(source.slice(from, cursor - 1));
  }
  return found;
}

describe("走らせる順番", () => {
  test("軽いものから重いものへ、固定の順に並んでいる", () => {
    // 先に軽い結果が届くほうが、待ちながら読み始められる（設計書6.80）
    expect(PROOFREADING_CHECKS.map((check) => check.id)).toEqual([
      "notation",
      "typos",
      "proofread",
      "opening",
      "deviations",
      "contradictions",
      "foreshadows",
    ]);
  });

  test("選んだ順ではなく、固定の順に並べ直す", () => {
    const order = sortToRunOrder(["foreshadows", "typos", "notation"]);

    expect(order.map((check) => check.id)).toEqual([
      "notation",
      "typos",
      "foreshadows",
    ]);
  });

  test("知らないidは捨てる", () => {
    // 控えは古い版のまま残ることがある。名前が変わったものは黙って落とす
    const order = sortToRunOrder(["typos", "novelai.checkTypos", ""]);

    expect(order.map((check) => check.id)).toEqual(["typos"]);
  });

  test("同じidが2つあっても、走らせるのは1度だけ", () => {
    const order = sortToRunOrder(["typos", "typos"]);

    expect(order.map((check) => check.id)).toEqual(["typos"]);
  });
});

describe("前回の選択の控え", () => {
  test("既定は、誤字脱字・表記ゆれ・推敲・矛盾の4つ", () => {
    expect([...DEFAULT_PROOFREADING_CHECK_IDS]).toEqual([
      "notation",
      "typos",
      "proofread",
      "contradictions",
    ]);
  });

  test("書いて読み戻しても、選択は変わらない", () => {
    const stored = serializeSelection(
      sortToRunOrder(["contradictions", "typos"])
    );

    expect(stored).toEqual(["typos", "contradictions"]);
    expect(parseStoredSelection(stored)).toEqual(["typos", "contradictions"]);
  });

  test("控えの中の知らないidは捨てる", () => {
    expect(parseStoredSelection(["typos", "むかしの名前"])).toEqual(["typos"]);
  });

  test("控えが無い・壊れているときは既定に戻す", () => {
    const fallback = [...DEFAULT_PROOFREADING_CHECK_IDS];

    expect(parseStoredSelection(undefined)).toEqual(fallback);
    expect(parseStoredSelection(null)).toEqual(fallback);
    // 配列でないもの（版を跨いだ書き換えで起こりうる）
    expect(parseStoredSelection("typos")).toEqual(fallback);
    expect(parseStoredSelection([1, 2])).toEqual(fallback);
    // 全部が知らないidだったときも、空で走らせるより既定に戻す
    expect(parseStoredSelection(["むかしの名前"])).toEqual(fallback);
  });
});

describe("表が実物と噛み合っている", () => {
  test("走らせるコマンドは、すべて package.json に登録されている", () => {
    for (const check of PROOFREADING_CHECKS) {
      expect(declared, `${check.command} が package.json にない`).toContain(
        check.command
      );
    }
  });

  test("走らせるコマンドは、すべて詳細メニューに並んでいる", () => {
    // メニューから消えた機能をまとめ実行だけが呼び続ける、を防ぐ
    const inMenu = new Set(allActions().map((action) => action.command));

    for (const check of PROOFREADING_CHECKS) {
      expect(inMenu, `${check.command} が詳細メニューにない`).toContain(
        check.command
      );
    }
  });

  test("まとめ実行そのものも、package.json と詳細メニューにある", () => {
    expect(declared).toContain(PROOFREADING_SUITE_COMMAND);
    expect(allActions().map((action) => action.command)).toContain(
      PROOFREADING_SUITE_COMMAND
    );
  });

  test("数える分類名が、提案パネルへ渡している名前と揃っている", () => {
    /*
      **分類名は文字列でしか結ばれていない。** 片方だけ改名すると、
      まとめ実行は存在しない分類を数えて必ず0件と出す（例外は出ない）。

      **ソースのどこかに同じ文字列があること、では弱い**（0.33.7のレビュー）。
      ログの文言や進捗の題にも「推敲」「矛盾」は出てくるので、分類名を
      渡している側を消してもテストは通ってしまう。**分類名を受け取る
      呼び出し式の引数の中にあること**まで見る。
    */
    const sources = [
      "src/features/proposalPanel.ts",
      "src/features/checkForeshadows.ts",
      "src/extension.ts",
    ].map((file) =>
      readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
    );

    const handedOver = sources
      .flatMap((source) =>
        PANEL_CATEGORY_CALLS.flatMap((name) => callArguments(source, name))
      )
      .join("\n");

    for (const check of PROOFREADING_CHECKS) {
      if (!check.category) continue;
      expect(
        handedOver,
        `分類「${check.category}」が、提案パネルへ渡す呼び出しの中にない`
      ).toContain(`"${check.category}"`);
    }
  });

  test("番人はログの文言では通らない", () => {
    // 検出そのものを確かめる。呼び出しの外にある文字列は拾わない
    const fake =
      'logStep("推敲を開始");\n' + 'panel.showResults(work, issues, "推敲");';

    expect(callArguments(fake, "showResults").join("")).toContain('"推敲"');
    expect(callArguments(fake, "showResults").join("")).not.toContain(
      "推敲を開始"
    );
    expect(callArguments('logStep("矛盾");', "showResults")).toEqual([]);
  });

  test("冒頭診断だけは、提案パネルへ出さないので数えない", () => {
    // 結果は文書として開く（設計書6.80）。分類を持たせると0件が並ぶ
    const opening = PROOFREADING_CHECKS.find((check) => check.id === "opening");

    expect(opening?.category).toBeUndefined();
  });
});

describe("進み具合と、終わったときの知らせ", () => {
  test("進み具合は「2/4：推敲」の形で出す", () => {
    expect(describeStep(2, 4, "推敲")).toBe("2/4：推敲");
  });

  test("完走したら、機能ごとの件数を並べる", () => {
    const message = describeSuiteResult({
      done: [
        { label: "誤字脱字", count: 3 },
        { label: "推敲", count: 12 },
        { label: "矛盾", count: 0 },
      ],
      remaining: [],
    });

    expect(message).toBe(
      "校正をまとめて実行しました。誤字脱字3件・推敲12件・矛盾0件。" +
        "提案パネルで確認できます。"
    );
  });

  test("中止したら、残りを名指しで伝える", () => {
    // 「終わりました」とだけ出すと、走らなかった機能まで済んだと読める
    const message = describeSuiteResult({
      done: [{ label: "表記ゆれ", count: 2 }],
      remaining: ["推敲", "矛盾"],
    });

    expect(message).toBe(
      "校正をまとめて実行：ここまで実行しました（残り：推敲・矛盾）。" +
        "表記ゆれ2件。提案パネルで確認できます。"
    );
  });

  test("1件も実行せずに止まったら、その旨と残りを伝える", () => {
    /*
      **黙って何もしない、を作らない**（0.33.7のレビュー）。
      1件目で止まると `done` が空になり、通知が1つも出なかった。
      作者からは「押したのに何も起きない」としか見えない。
    */
    expect(describeSuiteResult({ done: [], remaining: ["推敲", "矛盾"] })).toBe(
      "校正をまとめて実行：1件も実行せずに止まりました（残り：推敲・矛盾）。"
    );
  });

  test("走らせるものが無ければ、何も知らせない", () => {
    // 報告することが無い（選択画面のEscは、この道すら通らない）
    expect(describeSuiteResult({ done: [], remaining: [] })).toBe("");
  });

  test("失敗した機能は、件数ではなく失敗したと書く", () => {
    /*
      **失敗は次へ進む**（0.33.7のレビュー）。結果が出ていないので件数は
      数えない——数えると、前の実行でパネルに残っていた分を今回の成果として
      並べることになる。
    */
    const message = describeSuiteResult({
      done: [
        { label: "表記ゆれ", count: 2 },
        { label: "推敲", failed: true },
        { label: "矛盾", count: 0 },
      ],
      remaining: [],
    });

    expect(message).toBe(
      "校正をまとめて実行しました。表記ゆれ2件・推敲は失敗しました・矛盾0件。" +
        "提案パネルで確認できます。"
    );
  });

  test("失敗しかしていなければ、提案パネルへ誘わない", () => {
    expect(
      describeSuiteResult({ done: [{ label: "推敲", failed: true }], remaining: [] })
    ).toBe("校正をまとめて実行しました。推敲は失敗しました。");
  });

  test("指摘が1件も無ければ、提案パネルへ誘わない", () => {
    const message = describeSuiteResult({
      done: [{ label: "誤字脱字", count: 0 }],
      remaining: [],
    });

    expect(message).toBe(
      "校正をまとめて実行しました。誤字脱字0件。" +
        "手を付ける指摘は残っていません。"
    );
  });

  test("パネルに出ない機能は、件数の代わりに出どころを添える", () => {
    const message = describeSuiteResult({
      done: [{ label: "冒頭診断" }],
      remaining: [],
    });

    expect(message).toBe(
      "校正をまとめて実行しました。冒頭診断（結果は別の文書に出しました）。"
    );
  });
});

describe("終わり方の印", () => {
  test("止めた・失敗した・走り切ったを分ける", () => {
    /*
      **失敗を中止と読まない**（0.33.7のレビュー）。AIの失敗や応答の
      読み取り失敗は、次の検知を止める理由にならない。
    */
    expect(outcomeKindOf(CHECK_CANCELLED)).toBe("cancelled");
    expect(outcomeKindOf(CHECK_FAILED)).toBe("failed");
    expect(outcomeKindOf(CHECK_COMPLETED)).toBe("completed");

    expect(isCancelledOutcome(CHECK_CANCELLED)).toBe(true);
    expect(isCancelledOutcome(CHECK_FAILED)).toBe(false);
    expect(isCancelledOutcome(CHECK_COMPLETED)).toBe(false);
  });

  test("何も返さないコマンドは、走り切ったものとして扱う", () => {
    // 戻り値を持たない入口から呼ばれても、まとめ実行が勝手に止まらない
    expect(outcomeKindOf(undefined)).toBe("completed");
    expect(outcomeKindOf(null)).toBe("completed");
    expect(outcomeKindOf("cancelled")).toBe("completed");
    expect(outcomeKindOf({ kind: "むかしの印" })).toBe("completed");
  });
});
