import iconv from "iconv-lite";
import { describe, expect, test } from "vitest";
import {
  SJIS_FALLBACK_PAIRS,
  SJIS_UNENCODABLE_MARK,
  describeUnencodable,
  findUnencodableShiftJis,
  planShiftJisSave,
  substituteForShiftJis,
} from "../../../src/core/sjisFallback";

/** 製品の判定（`encodeTextFragment`）と同じ往復：iconv で符号にし、iconv で戻して同じ字か */
const roundTrips = (text: string): boolean =>
  iconv.decode(iconv.encode(text, "shift_jis"), "shift_jis") === text;

/** 同じ往復を、ブラウザの復号（WHATWG の shift_jis）で戻しても同じ字か（母艦の確かめ方） */
const roundTripsInBrowser = (text: string): boolean =>
  new TextDecoder("shift_jis").decode(iconv.encode(text, "shift_jis")) === text;

describe("Shift_JIS へ書くときの置き換えの表", () => {
  test("表の全行：元の字は往復できず、置き換え先は往復でき、2つは違う字", () => {
    expect(SJIS_FALLBACK_PAIRS.length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const [from, to] of SJIS_FALLBACK_PAIRS) {
      if (from === to) bad.push(`${from}: 同じ字`);
      if (roundTrips(from)) bad.push(`${from}: もともと書ける（置き換えると字が黙って変わる）`);
      if (!roundTrips(to)) bad.push(`${from}→${to}: 置き換え先が書けない`);
      if (!roundTripsInBrowser(to)) bad.push(`${from}→${to}: ブラウザの復号で戻らない`);
      if (Array.from(from).length !== 1 || Array.from(to).length !== 1) bad.push(`${from}→${to}: 1字ではない`);
    }
    expect(bad).toEqual([]);
  });

  test("元の字に重なりが無い", () => {
    const froms = SJIS_FALLBACK_PAIRS.map(([from]) => from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  test("元の字は、Shift_JIS のどのバイト列を復号しても出てこない（元の本文に紛れていない）", () => {
    const froms = new Set(SJIS_FALLBACK_PAIRS.map(([from]) => from));
    const found: string[] = [];
    for (let lead = 0x81; lead <= 0xfc; lead += 1) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail += 1) {
        for (const char of iconv.decode(Buffer.from([lead, trail]), "shift_jis")) {
          if (froms.has(char)) found.push(`${lead.toString(16)}${trail.toString(16)}→${char}`);
        }
      }
    }
    for (let single = 0; single < 0x100; single += 1) {
      for (const char of iconv.decode(Buffer.from([single]), "shift_jis")) {
        if (froms.has(char)) found.push(`${single.toString(16)}→${char}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("置き換えて数える（字ごとに何個）", () => {
    const { text, substitutions } = substituteForShiftJis("a〜b〜\u{20b9f}");
    expect(text).toBe("a～b～叱");
    expect(substitutions).toEqual([
      { from: "〜", to: "～", count: 2 },
      { from: "\u{20b9f}", to: "叱", count: 1 },
    ]);
  });

  test("元の本文の読めないバイト（U+FFFD）は場所に数えない。作者が入れた字の行だけを出す", () => {
    // 元のバイトのまま置くので書けるのに、数えると3件の枠を埋めて本当の字が知らせから落ちる
    const found = findUnencodableShiftJis("\ufffd\ufffd\ufffd\n二行目に♡");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ char: "♡", line: 2 });
  });

  test("書けない字の場所は、行と前後の数文字で出す（サロゲートの字も1字に数える）", () => {
    const found = findUnencodableShiftJis("一\n\u{20b9f}あいうえおかきくけ♡さしすせそたちつてと");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ char: "\u{20b9f}", line: 2 });
    expect(found[1].char).toBe("♡");
    expect(found[1].context).toBe("かきくけ♡さしすせ");
    expect(describeUnencodable(found)).toContain("2行目");
    expect(describeUnencodable(found)).toContain("「♡」");
  });
});

/**
 * 作者が VS Code で打って保存する道の、置き換え先の無い字の扱い（設計書5.4.2、0.148.3。
 * 作者の答え 2026-11-09「目印に置き換えた上で、メモ校正パネルに説明を残して、ポップアップもあげてください」）。
 * 表に無く書けない字は、目印の「〓」（U+3013。CP932 で 81 AC）にする。
 */
describe("保存の直前の置き換えの計画（表の字と目印の「〓」）", () => {
  test("目印の「〓」は Shift_JIS で往復でき、81 AC になる", () => {
    expect(SJIS_UNENCODABLE_MARK).toBe("〓");
    expect(Array.from(iconv.encode(SJIS_UNENCODABLE_MARK, "shift_jis"))).toEqual([0x81, 0xac]);
    expect(roundTrips(SJIS_UNENCODABLE_MARK)).toBe(true);
    expect(roundTripsInBrowser(SJIS_UNENCODABLE_MARK)).toBe(true);
  });

  test("表の字は表のとおり、表に無く書けない字（♡）は「〓」に。位置は元の本文の単位で取る", () => {
    const plan = planShiftJisSave("あ〜\n\u{20b9f}かきくけ♡さしすせ");
    expect(plan.spans).toEqual([
      { index: 1, length: 1, to: "～" },
      // 𠮟 はサロゲートの2単位
      { index: 3, length: 2, to: "叱" },
      { index: 9, length: 1, to: "〓" },
    ]);
    expect(plan.text).toBe("あ～\n叱かきくけ〓さしすせ");
    expect(plan.substitutions).toEqual([
      { from: "〜", to: "～", count: 1 },
      { from: "\u{20b9f}", to: "叱", count: 1 },
    ]);
    // 前後は置き換えたあとの本文で取る（指摘の原文として、保存したあとの本文から探し直すため）
    expect(plan.marks).toEqual([{ char: "♡", line: 2, context: "かきくけ〓さしすせ" }]);
  });

  test("CP932 にあって往復できる字は「〓」にしない（①・Ⅰ・髙・﨑・…・‥・―・〝〟・＂＇）", () => {
    const text = "①Ⅰ髙﨑…‥―〝〟＂＇";
    for (const char of Array.from(text)) expect(roundTrips(char), char).toBe(true);
    const plan = planShiftJisSave(text);
    expect(plan.spans).toEqual([]);
    expect(plan.marks).toEqual([]);
    expect(plan.text).toBe(text);
  });

  test("書けない字を全部拾う（知らせの3件の枠で切らない）", () => {
    const plan = planShiftJisSave("♡一\n♡二\n♡三\n♡四\n♡五");
    expect(plan.marks.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.text).toBe("〓一\n〓二\n〓三\n〓四\n〓五");
  });

  test("1つの字に見える並び（❤\ufe0f・👍🏻・家族の絵文字）は「〓」1つにする", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    const plan = planShiftJisSave(`a❤\ufe0fb\u{1f44d}\u{1f3fb}c${family}d`);
    expect(plan.text).toBe("a〓b〓c〓d");
    expect(plan.marks.map(({ char }) => char)).toEqual(["❤\ufe0f", "\u{1f44d}\u{1f3fb}", family]);
  });

  test("書ける字に付いた結合の記号は、記号だけを「〓」にする（元の字を消さない）", () => {
    const plan = planShiftJisSave("か\u309aき");
    expect(plan.text).toBe("か〓き");
  });

  test("元の本文の読めないバイト（U+FFFD）は「〓」にしない", () => {
    const plan = planShiftJisSave("\ufffd\n♡");
    expect(plan.text).toBe("\ufffd\n〓");
    expect(plan.marks).toEqual([{ char: "♡", line: 2, context: "〓" }]);
  });

  test("行をまとめて確かめても、まとまりの境の行・CRLF・前からある〓・𠮟の後ろでも、拾う字と行と前後は1行ずつ見たときと同じ", () => {
    // 約6万字ずつまとめて確かめる（大きな合本で持ち時間に収めるため。2026-11-14）。1行約260字なので、
    // まとまりの境は250行目あたり。境の前後の行すべてと、最初と最後の行に置く
    const lines = Array.from({ length: 600 }, (_, index) => `第${index + 1}行。${"あ".repeat(250)}`);
    lines[0] = "〓は前からある目印。♡";
    const near = Array.from({ length: 21 }, (_, offset) => 240 + offset);
    for (const index of near) lines[index] = `\u{20b9f}${"あ".repeat(250)}${index % 2 === 0 ? "♡" : "😀"}`;
    lines[599] = "最後の行♡";
    const text = lines.join("\r\n");
    expect(text.length).toBeGreaterThan(65536 * 2);
    const plan = planShiftJisSave(text);
    expect(plan.marks).toEqual([
      { char: "♡", line: 1, context: "る目印。〓" },
      ...near.map((index) => ({ char: index % 2 === 0 ? "♡" : "😀", line: index + 1, context: "ああああ〓" })),
      { char: "♡", line: 600, context: "最後の行〓" },
    ]);
    // 前からある〓（作者が置いたもの）は置き換えの対象にしない
    expect(plan.spans.filter(({ to }) => to === "〓")).toHaveLength(near.length + 2);
    expect(plan.text.split("\r\n")[0]).toBe("〓は前からある目印。〓");
    // 𠮟 は境の前後でも表のとおり置き換える
    expect(plan.substitutions).toEqual([{ from: "\u{20b9f}", to: "叱", count: near.length }]);
  });

  test("CRLF・CR の改行でも、行は正しく数え、位置は元の本文の単位で取る", () => {
    const plan = planShiftJisSave("一\r\n二\r三♡");
    expect(plan.spans).toEqual([{ index: 6, length: 1, to: "〓" }]);
    expect(plan.marks).toEqual([{ char: "♡", line: 3, context: "三〓" }]);
  });

  test("全部書ける本文では何も返さない", () => {
    expect(planShiftJisSave("終電を逃した駅のホーム。")).toEqual({
      spans: [],
      substitutions: [],
      marks: [],
      text: "終電を逃した駅のホーム。",
    });
  });
});