import { describe, expect, test } from "vitest";
import {
  normalizePostingBody,
  postingBodyHash,
  postingTextHash,
  postingTextHashes,
  postingUnitsOf,
} from "../../../src/core/postingBodyHash";

/**
 * 投稿したときの本文の印（設計書6.68.7。作者の裁定 2026-11-03 昼）。
 *
 * **見逃しと誤検出の両方を見る。** 印が変わらなければ「直した」が見逃され、変わりすぎれば
 * 直していない話まで「出し直しますか」と出る。片方だけ測ると、何も言わない実装が満点になる。
 */

const body = ["　雪が降っていた。", "", "　|漢字《かんじ》を読む。"].join("\n");

describe("読者が読む本文が変わらない編集では、印を変えない（誤検出を出さない）", () => {
  test("改行コードの違い（CRLF／LF）", () => {
    expect(postingBodyHash(body.replace(/\n/g, "\r\n"))).toBe(postingBodyHash(body));
  });

  test("前後の空行", () => {
    expect(postingBodyHash(`\n\n${body}\n\n\n`)).toBe(postingBodyHash(body));
  });

  test("行末の空白（半角・全角・タブ）", () => {
    expect(postingBodyHash(body.replace("降っていた。", "降っていた。 　\t"))).toBe(
      postingBodyHash(body)
    );
  });

  test("シーンメモの行（投稿用の変換が落とす行）", () => {
    const withMemo = ["　雪が降っていた。", "// ここで伏線を回収する", "", "　|漢字《かんじ》を読む。"].join("\n");
    expect(postingBodyHash(withMemo)).toBe(postingBodyHash(body));
  });

  test("先頭の BOM", () => {
    expect(postingBodyHash(`\uFEFF${body}`)).toBe(postingBodyHash(body));
  });
});

describe("読者が読む本文が変わる編集では、印を変える（見逃さない）", () => {
  test("1文字の直し", () => {
    expect(postingBodyHash(body.replace("降って", "舞って"))).not.toBe(postingBodyHash(body));
  });

  test("行頭の全角空白（字下げ）を足す・消す", () => {
    expect(postingBodyHash(body.replace("　雪", "雪"))).not.toBe(postingBodyHash(body));
  });

  test("段落の間の空行を足す", () => {
    expect(postingBodyHash(body.replace("\n\n", "\n\n\n"))).not.toBe(postingBodyHash(body));
  });

  test("ルビの直し（サイトの記法へ変える前の本文で比べる）", () => {
    expect(postingBodyHash(body.replace("かんじ", "カンジ"))).not.toBe(postingBodyHash(body));
  });
});

test("正規化した本文は、前後の空行と行末の空白を落とし、行頭の字下げを残す", () => {
  expect(normalizePostingBody("\r\n　一行目　\r\n二行目 \r\n\r\n")).toBe("　一行目\n二行目");
});

test("印は16進64字（台帳が読み込みで確かめる形）", () => {
  expect(postingBodyHash(body)).toMatch(/^[0-9a-f]{64}$/);
});

describe("題と本文の両方の印（0.124.1。作者の答え 2026-11-03 昼「題だけ直した話も促す」）", () => {
  test("頭に v2: が付き、本文だけの印と見分けられる", () => {
    expect(postingTextHash("邂逅", body)).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(postingTextHashes("邂逅", body)).toEqual({
      titled: postingTextHash("邂逅", body),
      bodyOnly: postingBodyHash(body),
    });
  });

  test("題だけ直しても印が変わる（見逃さない）", () => {
    expect(postingTextHash("別離", body)).not.toBe(postingTextHash("邂逅", body));
  });

  test("題の前後の空白・題が無いことの書き方では変わらない（誤検出を出さない）", () => {
    expect(postingTextHash("　邂逅 ", body)).toBe(postingTextHash("邂逅", body));
    expect(postingTextHash(null, body)).toBe(postingTextHash("", body));
    expect(postingTextHash("邂逅", body.replace(/\n/g, "\r\n"))).toBe(postingTextHash("邂逅", body));
  });

  test("題の末尾を本文の頭へ移した直しも別の印にする（題と本文の境を印に入れる）", () => {
    expect(postingTextHash("邂逅", "そして本文")).not.toBe(postingTextHash("邂逅そして", "本文"));
  });
});

describe("投稿する単位への切り出し", () => {
  const collected = [
    "【タイトル】",
    "氷の街",
    "",
    "------------------------- エピソード1開始 -------------------------",
    "【エピソードタイトル】",
    "１話　邂逅",
    "",
    "【本文】",
    "",
    "　一話目の本文。",
    "",
    "------------------------- エピソード2開始 -------------------------",
    "【エピソードタイトル】",
    "２話　別離",
    "",
    "【本文】",
    "",
    "　二話目の本文。",
    "",
  ].join("\n");

  test("ふつうの話は1つ（話数の指し方を持たない）", () => {
    const result = postingUnitsOf(body, "邂逅");
    expect(result.collected).toBe(false);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].collected).toBeUndefined();
    expect(result.units[0].body).toBe(body);
  });

  test("合本は話ごとに分け、その話の本文だけで印を取る（別の話を直しても印は変わらない）", () => {
    const result = postingUnitsOf(collected, null);
    expect(result.collected).toBe(true);
    expect(result.units.map((unit) => unit.collected?.chapter)).toEqual([1, 2]);
    const edited = postingUnitsOf(collected.replace("二話目の本文。", "二話目を直した。"), null);
    expect(postingBodyHash(edited.units[0].body)).toBe(postingBodyHash(result.units[0].body));
    expect(postingBodyHash(edited.units[1].body)).not.toBe(postingBodyHash(result.units[1].body));
  });
});
