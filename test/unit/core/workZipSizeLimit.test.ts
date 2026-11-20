import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { inspectWorkZip, WORK_ZIP_SIZE_LIMITS, WorkZipError } from "../../../src/core/workZip";

/**
 * ZIPから作品を取り込むとき、展開したあとの大きさに上限を付ける（セキュリティ点検 2026-11-21）。
 *
 * 圧縮が効く中身（同じ字の繰り返し）は、数十KBのZIPが展開すると数GBになる。
 * 上限なしに `unzipSync` すると、VS Code の拡張機能ホストごと記憶を使い切る。
 *
 * **数十MBの中身は作らない。** 上限を差し替えられる形にして、小さな値で確かめる。
 */

const EPISODE = "第1話　はじまり\n\n本文です。\n";

describe("展開したあとの大きさの上限", () => {
  it("1件が上限を超えれば、理由を出して止める", () => {
    const zip = zipSync({
      "episode_0001.txt": strToU8(EPISODE),
      "episode_0002.txt": strToU8("あ".repeat(2000)),
    });
    let caught: unknown;
    try {
      inspectWorkZip(zip, "作品.zip", { perEntry: 1000, total: 1_000_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkZipError);
    expect((caught as WorkZipError).message).toContain("大きすぎる");
    expect((caught as WorkZipError).detail ?? "").toContain("episode_0002.txt");
  });

  it("1件ずつは小さくても、合計が上限を超えれば止める", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 1; i <= 5; i++) files[`episode_000${i}.txt`] = strToU8("い".repeat(300));
    expect(() =>
      inspectWorkZip(zipSync(files), "作品.zip", { perEntry: 1000, total: 3000 })
    ).toThrowError(/大きすぎる/);
  });

  it("上限の中なら今までどおり読む", () => {
    const zip = zipSync({ "episode_0001.txt": strToU8(EPISODE) });
    const result = inspectWorkZip(zip, "作品.zip", { perEntry: 1000, total: 3000 });
    expect(result.files).toHaveLength(1);
  });

  it("既定の上限は、長い連載（1000万字）の合本1つが入る大きさ", () => {
    // 日本語はUTF-8で1字3バイト。1000万字で約30MB
    expect(WORK_ZIP_SIZE_LIMITS.perEntry).toBeGreaterThanOrEqual(30 * 1024 * 1024);
    expect(WORK_ZIP_SIZE_LIMITS.total).toBeGreaterThanOrEqual(WORK_ZIP_SIZE_LIMITS.perEntry);
  });
});
