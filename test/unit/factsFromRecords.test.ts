import { describe, expect, it } from "vitest";
import { buildAttributeIntervals } from "../../src/core/attributeIntervals";
import { findIntervalConflicts } from "../../src/core/contradictionMatch";
import { factsFromCharacters } from "../../src/core/factsFromRecords";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { RecordChange } from "../../src/models/jsonValidation";

/**
 * 既にある設定資料から事実を組む（設計書6.88.6の第2段）。
 *
 * **`changes` は作者が確定させた作中の変化**なので、話が変われば変化イベントを
 * 置いて区間を切る。切らないと、作者が一度判断したことを毎回蒸し返す（6.18）。
 * 逆に**同じ話の中に別の値が2つある形**は、両方が同時に正しいことはないので
 * 候補として返す。
 */

function change(overrides: Partial<RecordChange> & { field: string; value: string }): RecordChange {
  return {
    chapters: [],
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
    ...overrides,
  };
}

function character(overrides: Partial<Character> = {}): Character {
  return {
    ...emptyCharacter("char_001", "月島 灯"),
    appearedChapters: [3, 5, 9],
    ...overrides,
  };
}

describe("人物レコードから事実を組む", () => {
  it("changes 2件と現在値1件から、事実3件になる", () => {
    const facts = factsFromCharacters([
      character({
        gender: "女性",
        changes: [
          change({ field: "appearance", value: "黒髪", chapters: [3] }),
          change({ field: "affiliation", value: "窓口課", chapters: [5] }),
        ],
      }),
    ]);

    expect(facts).toHaveLength(3);
    expect(facts.map((fact) => fact.value).sort()).toEqual([
      "女性",
      "窓口課",
      "黒髪",
    ]);
    // 項目名は作者が読める言葉にする（年表と同じ表を使う）
    expect(facts.map((fact) => fact.predicate).sort()).toEqual([
      "外見",
      "性別",
      "所属",
    ]);
  });

  it("現在値は、登場話数の最初の話に置く", () => {
    const facts = factsFromCharacters([character({ gender: "女性" })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].chapter).toBe(3);
    expect(facts[0].id).toBe("fact:char_001:gender:1");
    expect(facts[0].lineRange).toEqual([0, 0]);
    expect(facts[0].modality).toBe("narration");
  });

  it("登場話数が無ければ話数は null（推測で埋めない）", () => {
    const facts = factsFromCharacters([
      character({ appearedChapters: [], gender: "女性" }),
    ]);
    expect(facts[0].chapter).toBeNull();
  });

  it("作中で変わる項目は state、変わらない項目は static", () => {
    const facts = factsFromCharacters([
      character({ gender: "女性", affiliation: "窓口課", appearance: "黒髪" }),
    ]);
    const kindOf = (predicate: string) =>
      facts.find((fact) => fact.predicate === predicate)?.kind;
    expect(kindOf("所属")).toBe("state");
    expect(kindOf("性別")).toBe("static");
    expect(kindOf("外見")).toBe("static");
  });

  it("時期ID（年表）から相対時期は作らない", () => {
    const facts = factsFromCharacters([
      character({
        changes: [
          change({
            field: "appearance",
            value: "銀髪",
            chapters: [7],
            timepointId: "tp_003",
          }),
        ],
      }),
    ]);
    expect(facts[0].storyTime).toBeNull();
  });

  it("conflicts は事実にしない（作者の判断へ既に回っている）", () => {
    const facts = factsFromCharacters([
      character({
        gender: "女性",
        conflicts: [
          {
            field: "appearance",
            values: ["黒髪", "銀髪"],
            chapters: [3, 7],
            note: null,
          },
        ],
      }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts.map((fact) => fact.value)).toEqual(["女性"]);
  });

  it("値の空いている項目は事実にしない", () => {
    expect(factsFromCharacters([character()])).toEqual([]);
  });

  it("変化のある項目は、現在値を重ねて足さない", () => {
    const facts = factsFromCharacters([
      character({
        appearance: "銀髪",
        changes: [
          change({ field: "appearance", value: "黒髪", chapters: [3] }),
          change({ field: "appearance", value: "銀髪", chapters: [7] }),
        ],
      }),
    ]);
    // 値2件＋そのあいだの変化イベント1件
    expect(facts.filter((fact) => fact.kind !== "event")).toHaveLength(2);
  });
});

describe("組んだ事実を区間の照合へ通す", () => {
  it("話数の違う変化は候補にならない（区間が切れる）", () => {
    const facts = factsFromCharacters([
      character({
        changes: [
          change({ field: "appearance", value: "黒髪", chapters: [3] }),
          change({ field: "appearance", value: "銀髪", chapters: [7] }),
        ],
      }),
    ]);
    expect(findIntervalConflicts(buildAttributeIntervals(facts))).toEqual([]);
  });

  it("同じ話に別の値が2つあれば候補になる", () => {
    const facts = factsFromCharacters([
      character({
        changes: [
          change({ field: "appearance", value: "黒髪", chapters: [3] }),
          change({ field: "appearance", value: "銀髪", chapters: [3] }),
        ],
      }),
    ]);
    const candidates = findIntervalConflicts(buildAttributeIntervals(facts));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].subject).toBe("char_001");
    expect(candidates[0].predicate).toBe("外見");
  });

  it("話数の分からない変化は、前後を決められないので候補にする", () => {
    const facts = factsFromCharacters([
      character({
        changes: [
          change({ field: "appearance", value: "黒髪", chapters: [] }),
          change({ field: "appearance", value: "銀髪", chapters: [7] }),
        ],
      }),
    ]);
    expect(
      findIntervalConflicts(buildAttributeIntervals(facts))
    ).toHaveLength(1);
  });

  it("別の人物の同じ項目は突き合わせない", () => {
    const facts = factsFromCharacters([
      character({ appearance: "黒髪" }),
      character({
        ...emptyCharacter("char_002", "白鳥 文佳"),
        appearedChapters: [3],
        appearance: "銀髪",
      }),
    ]);
    expect(findIntervalConflicts(buildAttributeIntervals(facts))).toEqual([]);
  });
});
