import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  PROOFREADING_CHECKS,
  buildSuiteConfirm,
  checkFailed,
  checkSkipped,
  describeSuiteResult,
  isCancelledOutcome,
  isSuiteConfirmed,
  outcomeKindOf,
  outcomeNotesOf,
  outcomeReasonOf,
} from "../../src/core/proofreadingSuite";

/**
 * 有料の確認を「最初に1回だけ」にする（設計書6.80）。
 *
 * **7つの機能を順に呼ぶと、確認も7回出ていた。** 1回目に「実行」を押した
 * 作者は、残り6回も同じ意味で押すことになる——押し続けるうちに中身を
 * 読まなくなるので、**確認としては働かなくなる。** まとめ実行の側で、
 * 選んだ機能・送る量・課金の有無を1枚にまとめて1度だけ問い、各機能は
 * 「まとめ実行から呼ばれた」と分かるときだけ自分の確認を飛ばす。
 */

/** 有料のAIで、4機能・12チャンクを選んだとき（AIを使うのは3つ） */
const paid = {
  workTitle: "試しの作品",
  // **名前もAIの数も、この1つの配列から数える**（作者の指摘、2026-09-06）。
  // 別々に渡していたころは「走らせるもの…（5つ）」の直後に
  // 「選んだ4機能」と出て、1つずれて見えていた
  checks: [
    { label: "表記ゆれ", usesAI: false },
    { label: "誤字脱字", usesAI: true },
    { label: "推敲", usesAI: true },
    { label: "矛盾", usesAI: true },
  ],
  estimate: {
    totalChars: 41000,
    chunkCount: 12,
    providerNames: ["Gemini"],
    isPaid: true,
  },
};

describe("まとめ実行の確認（1回だけ）", () => {
  test("AIを使う機能が1つも無ければ、確認を出さない", () => {
    // 表記ゆれだけを選んだとき。機械判定なので、送る量も料金も発生しない
    expect(
      buildSuiteConfirm({
        workTitle: "試しの作品",
        checks: [{ label: "表記ゆれ", usesAI: false }],
        estimate: {
          totalChars: 41000,
          chunkCount: 12,
          providerNames: ["Ollama"],
          isPaid: false,
        },
      })
    ).toBeUndefined();
  });

  test("有料なら、機能数×チャンク数と課金の断りを出す", () => {
    const built = buildSuiteConfirm(paid);

    expect(built?.message).toBe("試しの作品 の校正をまとめて実行します。");
    // 選んだ機能の名前を、走る順のまま並べる
    expect(built?.detail).toContain(
      "走らせるもの（この順）：表記ゆれ・誤字脱字・推敲・矛盾"
    );
    expect(built?.detail).toContain("本文 41,000字 / 12チャンク");
    expect(built?.detail).toContain("使うAI：Gemini");
    // **並べた名前の数（4つ）と食い違わせない**（作者の指摘、2026-09-06）。
    // 表記ゆれはAIを使わないので3つに減る。減った理由まで書く
    expect(built?.detail).toContain(
      "選んだ4件のうち、AIを使う3機能が本文をチャンクごとに送ります" +
        "（最大 3×12＝36チャンク。処理済みのチャンクは飛ばします）。"
    );
    expect(built?.detail).toContain("チャンクごとに課金されます。");
    // **このあと聞かれない、と先に言う。** 言わないと、作者は機能ごとの
    // 確認を待ってしまう
    expect(built?.detail).toContain("このあと機能ごとの確認は出しません。");
  });

  test("無料なら、課金の文は出さず所要の目安だけを出す", () => {
    const built = buildSuiteConfirm({
      ...paid,
      estimate: { ...paid.estimate, providerNames: ["Ollama"], isPaid: false },
    });

    expect(built?.detail).not.toContain("課金");
    expect(built?.detail).toContain("目安");
  });

  test("見積もりが取れなければ、チャンク数の話をしない", () => {
    // モデルの詳細が引けない（サーバーが止まっている）ときでも、
    // **確認そのものは出す**——押した覚えのないまま走り始めるのが最も困る
    const built = buildSuiteConfirm({ ...paid, estimate: undefined });

    expect(built?.detail).toContain("走らせるもの（この順）：");
    expect(built?.detail).not.toContain("チャンク");
  });

  /**
   * **並べた名前の数と、送る機能の数を食い違わせない**（作者の指摘、
   * 2026-09-06）。「走らせるもの：表記ゆれ・誤字脱字・推敲・プロット逸脱・
   * 矛盾」（5つ）の直後に「選んだ4機能それぞれが…」と出ており、
   * 読み手には数え間違いに見えていた。
   */
  test("並べた名前の数と、AIを使う機能の数がずれて見えない", () => {
    const built = buildSuiteConfirm({
      workTitle: "試しの作品",
      checks: [
        { label: "表記ゆれ", usesAI: false },
        { label: "誤字脱字", usesAI: true },
        { label: "推敲", usesAI: true },
        { label: "プロット逸脱", usesAI: true },
        { label: "矛盾", usesAI: true },
      ],
      estimate: {
        totalChars: 41000,
        chunkCount: 12,
        providerNames: ["Gemini"],
        isPaid: true,
      },
    });

    expect(built?.detail).toContain(
      "走らせるもの（この順）：表記ゆれ・誤字脱字・推敲・プロット逸脱・矛盾"
    );
    // 「選んだ4機能」と裸で書かない。5つ並べたうちの4つだと分かる形にする
    expect(built?.detail).toContain("選んだ5件のうち、AIを使う4機能が");
    expect(built?.detail).not.toContain("選んだ4機能");
  });

  test("全部がAIを使うなら、わざわざ「うち」と言わない", () => {
    const built = buildSuiteConfirm({
      workTitle: "試しの作品",
      checks: [
        { label: "誤字脱字", usesAI: true },
        { label: "推敲", usesAI: true },
      ],
      estimate: {
        totalChars: 41000,
        chunkCount: 12,
        providerNames: ["Ollama"],
        isPaid: false,
      },
    });

    expect(built?.detail).toContain("選んだ2機能それぞれが本文を");
    expect(built?.detail).not.toContain("うち");
  });
});

describe("走らせる機能の表", () => {
  test("AIを使うかどうかを、表が持っている", () => {
    // まとめ実行の確認は「AIを使う機能がいくつか」で文面が変わる。
    // 判定を呼ぶ側に写すと、機能を足したときに片方だけ古くなる
    const byId = new Map(
      PROOFREADING_CHECKS.map((check) => [check.id, check.usesAI])
    );

    expect(byId.get("notation")).toBe(false);
    expect(byId.get("typos")).toBe(true);
    expect(byId.get("foreshadows")).toBe(true);
  });
});

describe("確認を飛ばしてよいかの判定", () => {
  test("まとめ実行から渡された印だけを、飛ばしてよいと読む", () => {
    expect(isSuiteConfirmed({ suite: { confirmed: true } })).toBe(true);
  });

  test("印が無ければ飛ばさない（メニューからの単独実行）", () => {
    expect(isSuiteConfirmed(undefined)).toBe(false);
    expect(isSuiteConfirmed({})).toBe(false);
    expect(isSuiteConfirmed({ suite: {} })).toBe(false);
    // 作品ノードがそのまま渡ってきても、確認は飛ばさない
    expect(isSuiteConfirmed({ type: "work" })).toBe(false);
  });
});

describe("前提が無くて走れなかったときの一言", () => {
  test("失敗の印は、理由を持てる", () => {
    const outcome = checkFailed("矛盾：突き合わせる設定資料がまだありません。");

    expect(outcome.kind).toBe("failed");
    expect(outcomeNotesOf(outcome)).toEqual([
      "矛盾：突き合わせる設定資料がまだありません。",
    ]);
  });

  test("理由を持たない印から、理由を読もうとしない", () => {
    expect(outcomeNotesOf(undefined)).toEqual([]);
    expect(outcomeNotesOf({ kind: "failed" })).toEqual([]);
  });

  test("まとめの知らせの末尾へ、理由を並べる", () => {
    /*
      **黙って失敗にしない。** 「矛盾は失敗しました」だけでは、作者は
      AIが落ちたのだと思って原因を探しに行く。走れなかった理由が
      「設定資料がまだ無い」なら、そう書けば次の一手が分かる。
    */
    const message = describeSuiteResult({
      done: [
        { label: "誤字脱字", count: 3 },
        {
          label: "矛盾",
          failed: true,
          notes: ["矛盾：突き合わせる設定資料がまだありません。"],
        },
      ],
      remaining: [],
    });

    expect(message).toBe(
      "校正をまとめて実行しました。誤字脱字3件・矛盾は失敗しました。" +
        "提案パネルで確認できます。" +
        "矛盾：突き合わせる設定資料がまだありません。"
    );
  });
});

/**
 * 前提が足りないだけのものを「失敗」と言わない（作者の指摘、2026-09-06）。
 *
 * プロットの無い作品で「校正をまとめて実行」を走らせると、完走の知らせに
 * 「…推敲3件・**プロット逸脱は失敗しました**・矛盾0件」と出ていた。
 * 作者は「失敗」を見た時点で不具合を疑い、原因を探しに行く。
 * **壊れてはおらず、足りないものを足せば走る**ことが伝わらなければならない。
 */
describe("前提が足りなくて飛ばしたとき", () => {
  test("飛ばした印は、短い理由と次の一手を分けて持てる", () => {
    const outcome = checkSkipped(
      "プロットがまだ無いため",
      "プロット逸脱は、「プロットをつくる」で作ってから実行してください。"
    );

    expect(outcome.kind).toBe("skipped");
    expect(outcomeKindOf(outcome)).toBe("skipped");
    expect(outcomeReasonOf(outcome)).toBe("プロットがまだ無いため");
    expect(outcomeNotesOf(outcome)).toEqual([
      "プロット逸脱は、「プロットをつくる」で作ってから実行してください。",
    ]);
  });

  test("飛ばしたものは、残りを止める合図にしない", () => {
    // 中止（cancelled）だけが列を止める。前提はこの検知だけのものなので、
    // 関係のない機能まで走らずに終わってはいけない
    expect(isCancelledOutcome(checkSkipped("プロットがまだ無いため"))).toBe(
      false
    );
  });

  test("内訳では「飛ばしました（◯◯がまだ無いため）」と書く", () => {
    const message = describeSuiteResult({
      done: [
        { label: "推敲", count: 3 },
        {
          label: "プロット逸脱",
          skipped: true,
          reason: "プロットがまだ無いため",
          notes: [
            "プロット逸脱は、「プロットをつくる」か「本文からプロットを起こす」で" +
              "プロットを作ってから実行してください。",
          ],
        },
        { label: "矛盾", count: 0 },
      ],
      remaining: [],
    });

    expect(message).toContain("プロット逸脱は飛ばしました（プロットがまだ無いため）");
    // **「失敗」と言わない。** 作者はここで不具合を疑って原因を探しに行く
    expect(message).not.toContain("プロット逸脱は失敗しました");
    // 次の一手は、これまでどおり末尾へ並べる
    expect(message).toContain("「プロットをつくる」");
  });

  test("飛ばした機能は、パネルの残り件数として数えない", () => {
    // 走っていないので、パネルに残っている数はその機能の成果ではない
    const message = describeSuiteResult({
      done: [
        { label: "プロット逸脱", skipped: true, reason: "プロットがまだ無いため" },
      ],
      remaining: [],
    });

    expect(message).toBe(
      "校正をまとめて実行しました。プロット逸脱は飛ばしました（プロットがまだ無いため）。"
    );
  });
});

describe("各機能が、まとめ実行のときは自分の確認を出さない", () => {
  /*
    **各機能を丸ごと走らせる試験は無い**（AI・ファイル・進捗の差し替えが
    要るため）。そこで、確認を出す5つの機能が「まとめ実行から呼ばれたら
    飛ばす」分岐を持っていることを、原文から確かめる。

    見ているのは2つだけである——`suiteConfirmed` を受けていること、
    飛ばしたときに `logStep` へ残していること。**飛ばした中身を捨てない**
    のがこの機能でいちばん大事な点で、逸脱検知の「小さめのモデルでは
    ほとんど働きません」のような断りは、確認の中にしか書かれていない。
  */
  const files = [
    "checkTypos",
    "checkProofread",
    "checkContradictions",
    "checkDeviations",
    "checkForeshadows",
  ];

  for (const name of files) {
    test(`${name} は確認を飛ばし、飛ばした中身をログへ残す`, () => {
      const source = readFileSync(
        new URL(`../../src/features/${name}.ts`, import.meta.url),
        "utf8"
      );

      expect(source, `${name}: まとめ実行の印を受けていない`).toContain(
        "suiteConfirmed"
      );
      expect(source, `${name}: 飛ばした中身をログへ残していない`).toContain(
        "まとめ実行のため確認を省略"
      );
    });
  }
});
