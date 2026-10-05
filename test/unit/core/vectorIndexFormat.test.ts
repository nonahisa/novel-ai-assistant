import { describe, expect, test } from "vitest";
import {
  VECTOR_INDEX_VERSION,
  decideSearchMethod,
  decodeVectors,
  isStoredMeta,
  nearestByCosine,
  type SearchMethodInput,
  type StoredMeta,
} from "../../../src/core/vectorIndexFormat";

const META: StoredMeta = { version: VECTOR_INDEX_VERSION, model: "bge-m3", dimensions: 2, hashes: ["a", "b"] };

function input(overrides: Partial<SearchMethodInput> = {}): SearchMethodInput {
  return {
    meta: META,
    vectorsOk: true,
    setting: { enabled: true, model: "bge-m3" },
    endpointLocal: true,
    covered: 10,
    total: 10,
    ...overrides,
  };
}

describe("decideSearchMethod（意味で引くか、語句で探すか）", () => {
  test("そろっていれば意味で引く", () => {
    expect(decideSearchMethod(input())).toEqual({ method: "vector" });
  });

  test.each([
    ["索引が無い", { meta: undefined }, "索引がありません"],
    ["版が古い", { meta: { ...META, version: 1 } }, "形式が古い"],
    ["ファイルが切れている", { vectorsOk: false }, "途中で切れて"],
    ["設定が切", { setting: { enabled: false, model: "bge-m3" } }, "「切」"],
    ["モデルが違う", { setting: { enabled: true, model: "e5" } }, "今の設定（e5）と違います"],
    ["手元でない", { endpointLocal: false }, "手元ではない"],
    ["追いついていない", { covered: 8, total: 10 }, "8/10"],
  ] as const)("%s → 語句の一致", (_name, overrides, reason) => {
    const decision = decideSearchMethod(input(overrides as Partial<SearchMethodInput>));
    expect(decision.method).toBe("wordMatch");
    expect(decision.method === "wordMatch" && decision.reason).toContain(reason);
  });

  test("写しが古く設定が分からなければ、設定との照合は飛ばす", () => {
    expect(decideSearchMethod(input({ setting: undefined }))).toEqual({ method: "vector" });
  });
});

describe("索引のファイル", () => {
  test("大きさの合わないベクトルは読まない", () => {
    expect(decodeVectors(META, new Uint8Array(12))).toBeUndefined();
    const floats = Float32Array.from([1, 0, 0, 1]);
    const map = decodeVectors(META, new Uint8Array(floats.buffer));
    expect([...(map?.get("b") ?? [])]).toEqual([0, 1]);
  });

  test("任意の欄（builtAt・endpoint）があっても、型が違えば読まない", () => {
    expect(isStoredMeta({ ...META, builtAt: "2026-10-05T00:00:00Z", endpoint: "http://localhost:11434" })).toBe(true);
    expect(isStoredMeta({ ...META, builtAt: 1 })).toBe(false);
  });

  test("近い順に並べる", () => {
    const vectors = new Map([
      ["a", Float32Array.from([1, 0])],
      ["b", Float32Array.from([0, 1])],
    ]);
    const hits = nearestByCosine((h) => vectors.get(h), Float32Array.from([0.1, 1]), [
      { id: "x", hash: "a" },
      { id: "y", hash: "b" },
    ], 2);
    expect(hits.map((hit) => hit.id)).toEqual(["y", "x"]);
  });
});
