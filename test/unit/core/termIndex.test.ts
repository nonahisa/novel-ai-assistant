import { describe, expect, test } from "vitest";
import { TermIndex, type TermEntry } from "../../src/core/termIndex";

function entry(
  text: string,
  kind: TermEntry["kind"] = "character",
  id = text
): TermEntry {
  return { text, kind, id, canonicalName: text };
}

describe("用語の検出", () => {
  test("複数の用語を1回の走査で見つける", () => {
    const index = new TermIndex([
      entry("灯"),
      entry("図書塔", "location"),
      entry("灯火", "ability"),
    ]);

    const matches = index.find("灯は図書塔で灯火を唱えた");

    expect(matches.map((m) => m.entry.text)).toEqual(["灯", "図書塔", "灯火"]);
    expect(matches.map((m) => m.entry.kind)).toEqual([
      "character",
      "location",
      "ability",
    ]);
  });

  test("位置を正しく返す", () => {
    const index = new TermIndex([entry("図書塔", "location")]);
    const text = "灯は図書塔へ入った";

    const [match] = index.find(text);

    expect(text.slice(match.start, match.end)).toBe("図書塔");
  });

  test("長い用語を優先して重なりを避ける", () => {
    // 「灯」と「灯火」が両方登録されていると、
    // 「灯火」の一部を「灯」として二重に装飾してしまう
    const index = new TermIndex([entry("灯"), entry("灯火", "ability")]);

    const matches = index.find("灯火を使う");

    expect(matches).toHaveLength(1);
    expect(matches[0].entry.text).toBe("灯火");
  });

  test("重ならない同名は複数回検出する", () => {
    const index = new TermIndex([entry("灯")]);

    const matches = index.find("灯と灯");

    expect(matches).toHaveLength(2);
    expect(matches[0].start).toBe(0);
    expect(matches[1].start).toBe(2);
  });

  test("別名で一致しても正式名称を返す", () => {
    const index = new TermIndex([
      { text: "白瀬さん", kind: "character", id: "char_002", canonicalName: "白瀬 澪" },
    ]);

    const [match] = index.find("「白瀬さん、それは違う」");

    expect(match.entry.canonicalName).toBe("白瀬 澪");
    expect(match.entry.id).toBe("char_002");
  });

  test("登録が無ければ何も返さない", () => {
    expect(new TermIndex([]).find("灯は歩いた")).toEqual([]);
  });

  test("空白だけの用語は登録しない", () => {
    const index = new TermIndex([entry("  "), entry("灯")]);

    expect(index.size).toBe(1);
  });

  test("サロゲートペアを含む本文でも位置がずれない", () => {
    const index = new TermIndex([entry("灯")]);
    const text = "𩸽を焼く灯";

    const [match] = index.find(text);

    expect(text.slice(match.start, match.end)).toBe("灯");
  });

  test("用語が本文の先頭・末尾にあっても見つける", () => {
    const index = new TermIndex([entry("灯"), entry("塔", "location")]);

    const matches = index.find("灯は塔");

    expect(matches.map((m) => m.entry.text)).toEqual(["灯", "塔"]);
  });
});

describe("大規模作品での応答性", () => {
  test("73万字・500語でも編集をふさがない", () => {
    // 用語ごとに本文を走査すると、この規模で数秒かかる。
    // 1回の走査で全用語を照合する方式にしているため短時間で終わる。
    const entries = Array.from({ length: 500 }, (_, i) =>
      entry(`人物${i}`, "character", `char_${i}`)
    );
    const index = new TermIndex(entries);
    const text = "あいうえお人物42かきくけこ".repeat(50000);

    const started = performance.now();
    const matches = index.find(text);
    const elapsed = performance.now() - started;

    expect(matches.length).toBe(50000);
    // 編集のたびに走るので、余裕を持って1秒未満であること
    expect(elapsed).toBeLessThan(1000);
  });
});
