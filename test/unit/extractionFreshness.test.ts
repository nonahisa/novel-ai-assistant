import { describe, expect, test } from "vitest";
import {
  countUnextracted,
  OFFER_THRESHOLD,
  shouldOfferExtraction,
} from "../../src/core/extractionFreshness";

/**
 * まだ設定資料へ取り込んでいない話を数える（設計書6.21.1）。
 *
 * AIの独り言が「空き時間に資料抽出やっておきましょうか？」と申し出る材料。
 * **これまでは数えられず `undefined` を渡して黙らせていた**
 * （0を渡すと「抽出済み」と言い切ることになる）。
 *
 * **中身ではなく更新時刻で比べる。** キャッシュの鍵はモデル名と一緒に
 * 畳まれているので内容ハッシュだけでは引けず、モデルを変えると全話が
 * 「未抽出」になって「200話ぶん抽出しませんか」と言い出す。
 */
const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function episode(name: string, modifiedAt: number | undefined) {
  return { filePath: `C:/works/x/${name}`, modifiedAt };
}

describe("数える", () => {
  test("設定資料より新しい話を数える", () => {
    const result = countUnextracted(
      [
        episode("1.txt", NOW - 2 * HOUR),
        episode("2.txt", NOW + HOUR),
        episode("3.txt", NOW + 2 * HOUR),
      ],
      NOW
    );

    expect(result.extracted).toBe(true);
    expect(result.unextracted).toBe(2);
  });

  test("全部が古ければ0", () => {
    const result = countUnextracted([episode("1.txt", NOW - HOUR)], NOW);

    expect(result.unextracted).toBe(0);
  });

  test("同じ時刻は「新しい」と見なさない", () => {
    // 抽出したその瞬間のファイルを未抽出に数えない
    expect(countUnextracted([episode("1.txt", NOW)], NOW).unextracted).toBe(0);
  });
});

describe("**一度も抽出していない作品では、数を出さない**", () => {
  test("undefined を返す（0でも全話でもない）", () => {
    // **登録した直後に「19話ぶん抽出しませんか」は、申し出ではなく催促である**
    const result = countUnextracted(
      [episode("1.txt", NOW), episode("2.txt", NOW)],
      undefined
    );

    expect(result.extracted).toBe(false);
    expect(result.unextracted).toBeUndefined();
  });

  test("申し出もしない", () => {
    expect(
      shouldOfferExtraction(countUnextracted([episode("1.txt", NOW)], undefined))
    ).toBe(false);
  });
});

describe("時刻の取れない話", () => {
  test("数えない", () => {
    // **分からないものを「未抽出」へ寄せると、
    // 読めないファイルがあるだけで催促が始まる**
    const result = countUnextracted(
      [episode("1.txt", undefined), episode("2.txt", NOW + HOUR)],
      NOW
    );

    expect(result.unextracted).toBe(1);
  });

  test("全部読めなくても0で返す（黙る方向）", () => {
    expect(
      countUnextracted([episode("1.txt", undefined)], NOW).unextracted
    ).toBe(0);
  });
});

describe("申し出るかどうか", () => {
  test("1話だけでは申し出ない", () => {
    // **書いた直後に毎回言われると、独り言ではなく催促になる**
    expect(
      shouldOfferExtraction({ extracted: true, unextracted: 1 })
    ).toBe(false);
  });

  test("2話たまったら申し出る", () => {
    expect(shouldOfferExtraction({ extracted: true, unextracted: 2 })).toBe(
      true
    );
    expect(OFFER_THRESHOLD).toBe(2);
  });

  test("0話なら申し出ない", () => {
    expect(shouldOfferExtraction({ extracted: true, unextracted: 0 })).toBe(
      false
    );
  });

  test("分からなければ申し出ない", () => {
    expect(
      shouldOfferExtraction({ extracted: false, unextracted: undefined })
    ).toBe(false);
  });
});

describe("話が1つも無い作品", () => {
  test("0で返る（申し出ない）", () => {
    const result = countUnextracted([], NOW);

    expect(result.unextracted).toBe(0);
    expect(shouldOfferExtraction(result)).toBe(false);
  });
});
