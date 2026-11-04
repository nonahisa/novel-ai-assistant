import { describe, expect, test } from "vitest";
import {
  canonicalPostingNotation,
  normalizePostingBody,
  postingBodyHash,
  postingNotationTextHash,
  postingTextHash,
  postingTextHashes,
  postingTitleHash,
  postingTitleHashCandidates,
  postingUnitsOf,
} from "../../../src/core/postingBodyHash";
import { fromSiteNotation } from "../../../src/core/ruby";

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
    expect(postingTextHashes("邂逅", body)).toMatchObject({
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

describe("ルビ・傍点の書き方を寄せた印（v3:。0.126.4。.md 化しただけの話を「直した」と言わない）", () => {
  /** 投稿サイトの書き方が全部入った本文（縦線あり・半角縦線・縦線なし・アルファポリス・傍点2通り） */
  const siteBody = [
    "　｜白銀《しろがね》の街に、雪《ゆき》が降っていた。",
    "　|漢字《かんじ》と#約束__やくそく__#。",
    "　《《それ》》は、｜誰《・》も知らない。",
  ].join("\n");

  test("頭に v3: が付き、今の話の印として記録に残す値になる", () => {
    expect(postingNotationTextHash("邂逅", siteBody)).toMatch(/^v3:[0-9a-f]{64}$/);
    expect(postingTextHashes("邂逅", siteBody).notation).toBe(postingNotationTextHash("邂逅", siteBody));
  });

  test(".md 化の取り込み（fromSiteNotation）を通した本文と題は、同じ印（誤検出を出さない）", () => {
    const converted = fromSiteNotation(siteBody);
    expect(converted).not.toBe(siteBody);
    expect(postingNotationTextHash(fromSiteNotation("｜雪《ゆき》の朝"), converted)).toBe(
      postingNotationTextHash("｜雪《ゆき》の朝", siteBody)
    );
  });

  test("寄せ方は、もう1度かけても変わらない（.md 化を2度通しても同じ印）", () => {
    const once = canonicalPostingNotation(siteBody);
    expect(canonicalPostingNotation(once)).toBe(once);
    expect(fromSiteNotation(once)).toBe(once);
  });

  test("縦線の有無や傍点の書き方の違いでは変わらない", () => {
    expect(postingNotationTextHash(null, "｜漢字《かんじ》")).toBe(postingNotationTextHash(null, "漢字《かんじ》"));
    expect(postingNotationTextHash(null, "《《強調》》")).toBe(postingNotationTextHash(null, "｜強調《・・》"));
  });

  test("見逃さない：読み・字・題を直せば印が変わる", () => {
    const base = postingNotationTextHash("邂逅", siteBody);
    expect(postingNotationTextHash("邂逅", siteBody.replace("しろがね", "ぎんいろ"))).not.toBe(base);
    expect(postingNotationTextHash("邂逅", siteBody.replace("降って", "舞って"))).not.toBe(base);
    expect(postingNotationTextHash("別離", siteBody)).not.toBe(base);
    // ルビを外す（読者にはルビが見えなくなる）
    expect(postingNotationTextHash("邂逅", siteBody.replace("｜白銀《しろがね》", "白銀"))).not.toBe(base);
  });

  test("古い印（v2:・無印）と比べる写しは、.md 化した本文から投稿サイトの書き方へ戻したもの", () => {
    const posted = "　｜白銀《しろがね》の街に、《《雪》》が降っていた。";
    const hashes = postingTextHashes("邂逅", fromSiteNotation(posted));
    expect(hashes.titled).not.toBe(postingTextHash("邂逅", posted));
    expect(hashes.titledCopies).toContain(postingTextHash("邂逅", posted));
    expect(hashes.bodyOnlyCopies).toContain(postingBodyHash(posted));
    // なろうの傍点（ルビでの代用）で出した話も戻せる
    const narou = "　｜白銀《しろがね》の街に、｜雪《・》が降っていた。";
    expect(hashes.titledCopies).toContain(postingTextHash("邂逅", narou));
  });

  test("記法の無い本文では、写しを増やさない", () => {
    const hashes = postingTextHashes("邂逅", "　雪が降っていた。");
    expect(hashes.titledCopies).toEqual([]);
    expect(hashes.bodyOnlyCopies).toEqual([]);
    expect(postingTitleHashCandidates("邂逅")).toEqual([postingTitleHash("邂逅")]);
  });

  test("題の印の候補には、題を投稿サイトの書き方へ戻した写しも入る（題の記録の取り方は変えない）", () => {
    const candidates = postingTitleHashCandidates(fromSiteNotation("｜雪《ゆき》の朝"));
    expect(candidates[0]).toBe(postingTitleHash("{雪|ゆき}の朝"));
    expect(candidates).toContain(postingTitleHash("｜雪《ゆき》の朝"));
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
