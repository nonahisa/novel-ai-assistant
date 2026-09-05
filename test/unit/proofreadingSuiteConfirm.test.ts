import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  PROOFREADING_CHECKS,
  buildSuiteConfirm,
  checkFailed,
  describeSuiteResult,
  isSuiteConfirmed,
  outcomeNotesOf,
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

/** 有料のAIで、4機能・12チャンクを選んだとき */
const paid = {
  workTitle: "試しの作品",
  labels: ["表記ゆれ", "誤字脱字", "推敲", "矛盾"],
  aiCheckCount: 3,
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
        labels: ["表記ゆれ"],
        aiCheckCount: 0,
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
    expect(built?.detail).toContain(
      "選んだ3機能それぞれが本文をチャンクごとに送ります" +
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
