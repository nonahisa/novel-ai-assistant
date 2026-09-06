import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  postingCopyTargets,
  type PostingCopyTarget,
} from "../../src/core/postingCopyTargets";
import { POSTING_SITES } from "../../src/models/posting";
import { toSiteNotation } from "../../src/core/ruby";

/**
 * 「投稿サイト用に変換してコピー」で訊くこと（作者の裁定、2026-09-06）。
 *
 * **訊くのは貼り付け先だけにする。** それまでは2段だった——
 *
 *   1. どの形で書き出すか（投稿サイト用／アルファポリス旧記法／HTML）
 *   2. 傍点があるときだけ、貼り付け先はどのサイトか
 *
 * 1段目は**記法**を訊いており、作者は自分の貼り付け先がどの記法なのかを
 * 逆算させられていた。**サイトが決まれば記法は決まる**（`POSTING_SITES` の
 * `notation`・`emphasis`）ので、訊く必要が無い。
 */

const labelsOf = (targets: readonly PostingCopyTarget[]): string[] =>
  targets.map((target) => target.label);

describe("選択肢の並び", () => {
  test("投稿状態の台帳に登録した投稿先を先頭に出す", () => {
    // 毎回同じサイトへ貼る作者に、毎回同じだけ探させない
    const targets = postingCopyTargets(["alphapolis", "kakuyomu"]);

    // 登録済みどうしの順は `POSTING_SITES` の並び（作者が投稿する順）
    expect(labelsOf(targets).slice(0, 2)).toEqual(["カクヨム", "アルファポリス"]);
  });

  test("登録していないサイトも消さない（あとから増やせる）", () => {
    const labels = labelsOf(postingCopyTargets(["note"]));

    for (const site of POSTING_SITES) {
      expect(labels, site.id).toContain(site.label);
    }
  });

  test("登録が無ければ、既定の並びのまま出す", () => {
    expect(labelsOf(postingCopyTargets([])).slice(0, POSTING_SITES.length)).toEqual(
      POSTING_SITES.map((site) => site.label)
    );
  });

  test("サイトではない書き出し先（HTML）は、いちばん後ろに置く", () => {
    // サイトを選びに来た作者の目の前に、機械向けの形を先に出さない
    const targets = postingCopyTargets([]);
    expect(targets[targets.length - 1].style).toBe("html");
  });

  test("登録済みには印を持たせる（画面で先頭の理由を言えるように）", () => {
    const targets = postingCopyTargets(["kakuyomu"]);
    expect(targets[0].registered).toBe(true);
    expect(targets[1].registered).toBe(false);
  });
});

describe("サイトを選べば記法が決まる", () => {
  const find = (label: string): PostingCopyTarget => {
    const found = postingCopyTargets([]).find(
      (target) => target.label === label
    );
    if (!found) throw new Error(`選択肢「${label}」がありません`);
    return found;
  };

  test("カクヨムは傍点をカクヨムの書き方で出す", () => {
    const target = find("カクヨム");
    expect(toSiteNotation("{{大事}}", target.style, target.emphasis)).toBe(
      "《《大事》》"
    );
  });

  test("なろう・アルファポリスは傍点をルビで代用する", () => {
    for (const label of ["小説家になろう", "アルファポリス"]) {
      const target = find(label);
      expect(
        toSiteNotation("{{大事}}", target.style, target.emphasis),
        label
      ).toBe("｜大事《・・》");
    }
  });

  test("noteはルビの記法が無いので括弧書きにする", () => {
    const target = find("note");
    expect(toSiteNotation("{漢字|かんじ}", target.style, target.emphasis)).toBe(
      "漢字（かんじ）"
    );
  });

  test("対応は `POSTING_SITES` から引く（写しを作らない）", () => {
    // ここに書き写すと、サイトの記法が変わったとき片方だけが直る
    for (const site of POSTING_SITES) {
      const target = find(site.label);
      expect(target.style, site.id).toBe(site.notation);
      expect(target.emphasis, site.id).toBe(site.emphasis);
    }
  });
});

describe("説明は選ぶ手がかりになる", () => {
  test("どの選択肢にも、何が起きるかの一言がある", () => {
    for (const target of postingCopyTargets([])) {
      expect(target.detail.length, target.label).toBeGreaterThan(0);
    }
  });
});

/**
 * **逃げ道を黙って塞がない。**
 *
 * アルファポリスの別記法（`#漢字__かんじ__#`）は、`｜漢字《かんじ》` で
 * 不都合が出たときのためにある。サイトを選ぶ形にすると既定では通らなく
 * なるので、サイトの一覧の後ろへ名前で残す。
 */
describe("記法だけで決まる書き出し先", () => {
  test("アルファポリスの別記法は、サイトの後ろに名前で残す", () => {
    const targets = postingCopyTargets([]);
    const found = targets.find((target) => target.style === "alphapolis-hash");

    expect(found, "別記法の選択肢が消えている").toBeTruthy();
    // 記号ではなくサイト名で見つけられる
    expect(found?.label).toContain("アルファポリス");
    // 4つのサイトより後ろ
    expect(targets.indexOf(found!)).toBeGreaterThanOrEqual(POSTING_SITES.length);
  });
});

/**
 * 画面の側（`features/ruby.ts`）。**単体では動かせない**ので、
 * 書いてあるコードの形で見る（`chatRunEntry.test.ts` と同じやり方）。
 */
describe("「投稿サイト用に変換してコピー」は1段しか訊かない", () => {
  const source = readFileSync("src/features/ruby.ts", "utf8");

  /** copyForPosting の中身（次の関数の手前まで） */
  function copyForPosting(): string {
    const start = source.indexOf("export async function copyForPosting(");
    expect(start, "copyForPosting が見つからない").toBeGreaterThan(-1);
    const end = source.indexOf("export async function pickPostingTarget(", start);
    expect(end, "pickPostingTarget が見つからない").toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("記法を先に訊く画面を通らない", () => {
    // 「どの形で書き出すか」→「貼り付け先」の2段だった
    expect(copyForPosting()).not.toContain("pickStyle()");
  });

  test("傍点があるときだけ貼り付け先を訊く、という分岐を持たない", () => {
    // **原稿の中身で手順が変わらない。** 作者からは「なぜ今日は
    // 2回訊かれるのか」が分からない
    const body = copyForPosting();
    expect(body).not.toContain("hasEmphasis");
    expect(body).not.toContain("pickEmphasisSite()");
  });

  test("訊くのは貼り付け先だけ", () => {
    expect(copyForPosting()).toContain("pickPostingTarget(registered)");
  });
});

/**
 * **入口は3つある**（設計書6.12.4）。普通のエディタ（`features/ruby.ts`）、
 * 作品一覧の右クリック（`features/episodeCopy.ts`）、原稿エディタ
 * （`features/manuscriptEditor.ts`）。**同じ操作なのに訊かれ方が違う**と、
 * 作者からは別の機能に見える——0.36.5 では普通のエディタだけが1段だった。
 */
describe("残る2つの入口も、同じ1段の訊き方を通る", () => {
  /**
   * 関数の中身だけを切り出す。
   *
   * **波括弧を数えて閉じるところまでにする。** 「次の関数の手前まで」だと
   * 関数のあいだにある説明文まで拾い、そこに書かれた語で判定が揺れる。
   */
  function bodyOf(file: string, signature: string): string {
    const source = readFileSync(file, "utf8");
    const start = source.indexOf(signature);
    expect(start, `${signature} が ${file} にない`).toBeGreaterThan(-1);

    const open = source.indexOf("{", source.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error(`${signature} の終わりが見つかりません`);
  }

  const entries = [
    {
      name: "作品一覧の右クリック（本文を投稿サイト用にコピー）",
      body: () =>
        bodyOf(
          "src/features/episodeCopy.ts",
          "export async function copyBodyForPosting("
        ),
    },
    {
      name: "原稿エディタ（投稿サイト用にコピー）",
      body: () =>
        bodyOf(
          "src/features/manuscriptEditor.ts",
          "private async copyForPosting("
        ),
    },
  ];

  for (const entry of entries) {
    test(`${entry.name}：記法を先に訊く画面を通らない`, () => {
      expect(entry.body()).not.toContain("pickStyle()");
    });

    test(`${entry.name}：傍点の有無で訊く回数を変えない`, () => {
      const body = entry.body();
      expect(body).not.toContain("pickEmphasisSite()");
      expect(body).not.toContain("hasEmphasis");
      expect(body).not.toContain("needsEmphasisSite");
    });

    test(`${entry.name}：訊くのは貼り付け先だけ`, () => {
      expect(entry.body()).toContain("pickPostingTarget(");
    });

    test(`${entry.name}：登録済みの投稿先を渡す（先頭に出すため）`, () => {
      // 台帳を読む処理の写しを作らない（`features/postingCopyRegistered.ts`）
      expect(entry.body()).toContain("registeredPostingSites(");
    });
  }

  test("使われなくなった2段目の画面は残さない", () => {
    // 呼ぶ人のいない入口を残すと、次に足す画面がそちらを写す
    const ruby = readFileSync("src/features/ruby.ts", "utf8");
    expect(ruby).not.toContain("export async function pickStyle(");
    expect(ruby).not.toContain("export async function pickEmphasisSite(");
  });

  test("台帳を読む処理は1か所にまとめる（3入口で共有）", () => {
    const shared = readFileSync(
      "src/features/postingCopyRegistered.ts",
      "utf8"
    );
    expect(shared).toContain("export async function registeredPostingSites(");

    // extension.ts も自前で持たない（写しがあると片方だけ直る日が来る）
    const extension = readFileSync("src/extension.ts", "utf8");
    expect(extension).not.toContain("async function registeredPostingSites(");
  });
});
