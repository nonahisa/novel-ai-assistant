import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_PROOFREADING_CHECK_IDS,
  PROOFREADING_CHECKS,
  PROOFREADING_SUITE_COMMAND,
  describeStep,
  describeSuiteResult,
  isCancelledOutcome,
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
      提案パネルへ分類名を渡している3か所のソースを直に見て、
      同じ文字列が実在することだけを確かめる。
    */
    const sources = [
      "src/features/proposalPanel.ts",
      "src/features/checkForeshadows.ts",
      "src/extension.ts",
    ]
      .map((file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"))
      .join("\n");

    for (const check of PROOFREADING_CHECKS) {
      if (!check.category) continue;
      expect(sources, `分類「${check.category}」が実物にない`).toContain(
        `"${check.category}"`
      );
    }
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

  test("1つも走らないうちに取りやめたら、何も知らせない", () => {
    // 作者が最初の確認で取りやめただけなので、報告することが無い
    expect(describeSuiteResult({ done: [], remaining: ["推敲"] })).toBe("");
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

describe("中止の印", () => {
  test("コマンドが返した中止だけを、中止と読む", () => {
    expect(isCancelledOutcome({ cancelled: true })).toBe(true);
    expect(isCancelledOutcome({ cancelled: false })).toBe(false);
  });

  test("何も返さないコマンドは、走り切ったものとして扱う", () => {
    // 戻り値を持たない入口から呼ばれても、まとめ実行が勝手に止まらない
    expect(isCancelledOutcome(undefined)).toBe(false);
    expect(isCancelledOutcome(null)).toBe(false);
    expect(isCancelledOutcome("cancelled")).toBe(false);
  });
});
