import { describe, expect, test } from "vitest";
import {
  looksLikeExample,
  OPENING_DIRECTION_HINTS,
  OPENING_DIRECTIONS_MAX,
  readOpeningDirections,
} from "../../../src/core/openingDirections";

/**
 * 冒頭診断（P-24 1.2）の「読者に向けて直す方向」の検査。
 *
 * 作者の裁定（2026-10-01）：読者タイプを踏まえて直す方向を数件並べる。
 * **例文・書き直し案は出さない**。そして「無理してひねり出さなくても良い」
 * ——0件は普通の答えである。
 *
 * 見るのは3つ。
 * 1. **例文入りの答えを弾く**（プロンプトで禁じても返ってくる。失敗3）
 * 2. **根拠の引用が本文に無ければ弾く**（規則3）
 * 3. **0件を通す**（1.9。件数を埋めさせない）
 */

const OPENING =
  "目が覚めると、図書塔の最上階だった。窓の外では、灰色の雪が上へ向かって降っている。\n" +
  "「また遅刻よ、リラ」と師匠が言った。\n" +
  "母の遺した手紙は、今日も読めないままだった。";

function direction(overrides: Partial<Record<"direction" | "quote" | "why", string>> = {}) {
  return {
    direction: "異変を先に見せる",
    quote: "灰色の雪が上へ向かって降っている",
    why: "設定の説明より先に異常を置くと、謎を追いたい読者が最初の段落で掴まれる。",
    ...overrides,
  };
}

describe("0件は普通の答え（1.9）", () => {
  test("空の配列はそのまま0件として通る（失敗にしない）", () => {
    const read = readOpeningDirections([], OPENING);
    expect(read.items).toEqual([]);
    expect(read.notFound + read.exampleLike + read.overLimit + read.empty).toBe(0);
  });

  test("欄が配列でなくても落ちない（0件）", () => {
    expect(readOpeningDirections(undefined, OPENING).items).toEqual([]);
    expect(readOpeningDirections("なし", OPENING).items).toEqual([]);
  });

  test("「特になし」の埋め草は、方向の1件として並べない", () => {
    const read = readOpeningDirections(
      [direction({ direction: "特になし", why: "特になし" })],
      OPENING
    );
    expect(read.items).toEqual([]);
    expect(read.empty).toBe(1);
  });
});

describe("根拠の引用を本文と照らす（規則3）", () => {
  test("本文に在る引用は通る", () => {
    const read = readOpeningDirections([direction()], OPENING);
    expect(read.items).toHaveLength(1);
    expect(read.items[0].quote).toBe("灰色の雪が上へ向かって降っている");
  });

  test("かぎ括弧で包んで返した引用も、中身が本文に在れば通る", () => {
    const read = readOpeningDirections(
      [direction({ quote: "「母の遺した手紙は、今日も読めないままだった」" })],
      OPENING
    );
    expect(read.items).toHaveLength(1);
  });

  test("本文に無い引用は落とし、数える", () => {
    const read = readOpeningDirections(
      [direction({ quote: "空から巨大な塔が落ちてきた" })],
      OPENING
    );
    expect(read.items).toEqual([]);
    expect(read.notFound).toBe(1);
  });

  test("前半だけ本物で後半が作文の引用も落とす", () => {
    const read = readOpeningDirections(
      [direction({ quote: "目が覚めると、世界はすでに終わっていた" })],
      OPENING
    );
    expect(read.notFound).toBe(1);
  });
});

describe("例文・書き直した文を弾く", () => {
  test("本文に無いかぎ括弧の台詞を理由に書いたら落とす", () => {
    const read = readOpeningDirections(
      [
        direction({
          why: "冒頭を「雪が、上へ降っていた。」で始めると、読者はすぐに異変に気づく。",
        }),
      ],
      OPENING
    );
    expect(read.items).toEqual([]);
    expect(read.exampleLike).toBe(1);
  });

  test("短くても、文の終わりの記号がある括弧は作った台詞と見る", () => {
    expect(looksLikeExample("師匠に「逃げろ！」と叫ばせる", OPENING)).toBe(true);
  });

  test("本文の台詞を括って指すのは通す", () => {
    expect(
      looksLikeExample("「また遅刻よ、リラ」の一言で関係が見えるのを活かす", OPENING)
    ).toBe(false);
  });

  test("概念を括った短い語（「謎」「引き」）は例文と見ない", () => {
    expect(looksLikeExample("「謎」を先に置き、「引き」を強める", OPENING)).toBe(false);
  });

  test("5W1Hの要素名や読者層の呼び名を括るのは例文ではない", () => {
    expect(looksLikeExample("「どのように」を後ろへ回す", OPENING)).toBe(false);
    expect(looksLikeExample("「考察層」が拾う手がかりを残す", OPENING)).toBe(false);
  });

  test("「たとえば「〜」」の前置きで文を差し出したら落とす", () => {
    expect(looksLikeExample("たとえば「手紙」を先に出す", OPENING)).toBe(true);
    expect(looksLikeExample("例：雪が上へ降る場面から始める", OPENING)).toBe(true);
  });

  test("括弧なしで「〜という書き出し」を差し出したら落とす", () => {
    expect(
      looksLikeExample("雪が上へ降る朝だったという書き出しにする", OPENING)
    ).toBe(true);
  });

  test("本文を括って「〜という書き出し」と指すのは通す", () => {
    expect(
      looksLikeExample("「目が覚めると、図書塔の最上階だった」という書き出しを活かす", OPENING)
    ).toBe(false);
  });

  test("方向の名前が長すぎる（文になっている）ものは落とす", () => {
    const read = readOpeningDirections(
      [direction({ direction: "目が覚めた瞬間に雪が上へ降っていることへ主人公が驚く場面にする" })],
      OPENING
    );
    expect(read.exampleLike).toBe(1);
  });

  test("「書き直す」という方向の言い方は落とさない（文を差し出してはいない）", () => {
    const read = readOpeningDirections(
      [direction({ direction: "一文目を短く書き直す" })],
      OPENING
    );
    expect(read.items).toHaveLength(1);
  });
});

describe("指示の言葉がそのまま返ってきたら弾く（失敗3）", () => {
  test.each([
    ["例文", "例文：雪が上へ降る"],
    ["書き直し案", "書き直し案を参考にしてください"],
    ["書き換え案", "書き換え案は省略します"],
    ["改善案", "改善案として、謎を先に置く"],
  ])("「%s」の語が入っていれば落とす", (_word, text) => {
    const read = readOpeningDirections([direction({ why: text })], OPENING);
    expect(read.exampleLike).toBe(1);
  });

  test.each(Object.entries(OPENING_DIRECTION_HINTS))(
    "欄の説明（%s）をそのまま書いてきたら落とす",
    (_key, hint) => {
      expect(looksLikeExample(hint, OPENING)).toBe(true);
      expect(
        readOpeningDirections([direction({ why: hint })], OPENING).exampleLike
      ).toBe(1);
    }
  );
});

describe("件数", () => {
  test("上限を超えたぶんは落とし、数える", () => {
    const quotes = [
      "目が覚めると、図書塔の最上階だった",
      "灰色の雪が上へ向かって降っている",
      "また遅刻よ、リラ",
      "母の遺した手紙は、今日も読めないままだった",
      "窓の外では",
    ];
    const read = readOpeningDirections(
      quotes.map((quote, index) => direction({ direction: `方向${index + 1}`, quote })),
      OPENING
    );
    expect(read.items).toHaveLength(OPENING_DIRECTIONS_MAX);
    expect(read.overLimit).toBe(1);
  });

  test("落ちる答えが上限の枠を埋めない（検査を通ったものに上限を掛ける）", () => {
    const bad = Array.from({ length: 4 }, (_, index) =>
      direction({ direction: `作り物${index}`, quote: "本文に無い作り物の一文です" })
    );
    const read = readOpeningDirections([...bad, direction()], OPENING);
    expect(read.items).toHaveLength(1);
    expect(read.notFound).toBe(4);
  });

  test("同じ方向を2度挙げたら1件にまとめる", () => {
    const read = readOpeningDirections([direction(), direction()], OPENING);
    expect(read.items).toHaveLength(1);
  });
});
