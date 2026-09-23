import { describe, expect, test } from "vitest";
import {
  foreshadowQueryText,
  narrowTargetsByMeaning,
} from "../../../src/core/foreshadowRelevance";

/**
 * 伏線の回収の確認で、照らす箇所を意味の近さで絞る（設計書6.19.10）。
 *
 * 守りたいのは「**分からないものは絞らない**」——ベクトルが取れなかった
 * 伏線や、索引に場面が載っていない箇所を落とすと、確かめもせずに
 * 回収を見逃す。絞るのは、近さを測れた組の中だけ。
 */

const f = (id: string) => ({ id });

describe("narrowTargetsByMeaning", () => {
  const vectors = new Map<string, Float32Array>([
    ["契約", new Float32Array([1, 0, 0])],
    ["古竜", new Float32Array([0, 1, 0])],
  ]);

  const entries = [
    { key: "第5話", targets: [f("契約"), f("古竜")], vectors: [new Float32Array([0.9, 0.1, 0])] },
    { key: "第6話", targets: [f("契約"), f("古竜")], vectors: [new Float32Array([0.1, 0.9, 0])] },
    { key: "第7話", targets: [f("契約"), f("古竜")], vectors: [new Float32Array([0, 0, 1])] },
    // 索引に場面が載っていない箇所
    { key: "第8話", targets: [f("契約"), f("古竜")], vectors: [] },
  ];

  test("伏線ごとに、近い箇所だけへ掛ける", () => {
    const narrowed = narrowTargetsByMeaning(entries, vectors, 1);
    const byKey = new Map(narrowed.map((entry) => [entry.key, entry]));
    expect(byKey.get("第5話")!.targets.map((t) => t.id)).toEqual(["契約"]);
    expect(byKey.get("第6話")!.targets.map((t) => t.id)).toEqual(["古竜"]);
    expect(byKey.get("第7話")!.targets).toEqual([]);
  });

  test("索引に載っていない箇所は絞らない（確かめずに見逃さない）", () => {
    const narrowed = narrowTargetsByMeaning(entries, vectors, 1);
    const eighth = narrowed.find((entry) => entry.key === "第8話")!;
    expect(eighth.targets.map((t) => t.id)).toEqual(["契約", "古竜"]);
    expect(eighth.narrowed).toBe(false);
  });

  test("ベクトルが取れなかった伏線は絞らない", () => {
    const narrowed = narrowTargetsByMeaning(
      [{ key: "第7話", targets: [f("契約"), f("謎の手紙")], vectors: [new Float32Array([0, 0, 1])] }],
      vectors,
      1
    );
    // 「契約」は第7話しか候補が無いので残る。「謎の手紙」は測れないので残す
    expect(narrowed[0].targets.map((t) => t.id)).toEqual(["契約", "謎の手紙"]);
  });

  test("絞ったかどうかの印（鍵を分けるのに使う）", () => {
    const narrowed = narrowTargetsByMeaning(entries, vectors, 1);
    expect(narrowed.find((entry) => entry.key === "第5話")!.narrowed).toBe(true);
  });

  test("残す数を増やせば、落とす組は減る", () => {
    const tight = narrowTargetsByMeaning(entries, vectors, 1);
    const loose = narrowTargetsByMeaning(entries, vectors, 3);
    const count = (list: typeof tight) =>
      list.reduce((sum, entry) => sum + entry.targets.length, 0);
    expect(count(loose)).toBeGreaterThan(count(tight));
    expect(count(loose)).toBe(8);
  });

  test("必ず残す組（張った話）は、上位の枠を食わない", () => {
    // 第5話で張った「契約」。第5話は近さで必ず1位に来るが、枠の外で残し、
    // 上位1か所の枠は後の話（第6話・第7話）の中で決める
    const narrowed = narrowTargetsByMeaning(
      entries.slice(0, 3).map((entry) => ({ ...entry, targets: [f("契約")] })),
      new Map([["契約", new Float32Array([1, 0, 0])]]),
      1,
      (_target, key) => key === "第5話"
    );
    const kept = narrowed.filter((entry) => entry.targets.length > 0).map((entry) => entry.key);
    expect(kept).toEqual(["第5話", "第6話"]);
  });

  test("もとの並びを保つ（話の早い順に見る決まりを崩さない）", () => {
    const narrowed = narrowTargetsByMeaning(entries, vectors, 3);
    expect(narrowed.map((entry) => entry.key)).toEqual(["第5話", "第6話", "第7話", "第8話"]);
  });
});

describe("foreshadowQueryText", () => {
  test("名・示唆・引用をつなぐ（空の項目は飛ばす）", () => {
    expect(
      foreshadowQueryText({ label: "契約", note: "", plantedQuote: "おひいさま。" })
    ).toBe("契約\nおひいさま。");
  });
});
