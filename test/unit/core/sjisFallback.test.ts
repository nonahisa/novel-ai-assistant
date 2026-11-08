import iconv from "iconv-lite";
import { describe, expect, test } from "vitest";
import {
  SJIS_FALLBACK_PAIRS,
  describeUnencodable,
  findUnencodableShiftJis,
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
