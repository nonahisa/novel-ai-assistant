import { describe, expect, test } from "vitest";
import {
  checkVectorsNote,
  describeVectorUnavailable,
  isVectorUseInChecksEnabled,
  openCheckVectors,
  vectorSetupCommand,
  vectorSetupHint,
} from "../../../src/features/vectorSearch";
import type { WorkEntry } from "../../../src/models/types";

/**
 * ベクトル検索の共通の口（設計書6.19.10）のうち、使えないときの扱い。
 *
 * 4つの使い道（場面検索・矛盾と伏線・執筆再開・似た場面）が同じ案内を
 * 出すので、ここで言い方を1つに決めて見る。
 */

const work: WorkEntry = {
  id: "w",
  title: "作品",
  folderPath: "C:/作品",
  registeredAt: new Date(0).toISOString(),
};

describe("使えないときの案内", () => {
  test("設定が切なら、メニューにある名前の「ベクトル検索準備」を案内する", () => {
    const hint = vectorSetupHint("disabled", "意味で探せます");
    expect(hint).toContain("ベクトル検索準備");
    expect(hint).toContain("意味で探せます");
    expect(vectorSetupCommand("disabled")).toBe("novelai.setupVectorSearch");
  });

  test("索引が無い・古いなら、「検索索引作成／更新」を案内する", () => {
    for (const reason of ["noIndex", "stale"] as const) {
      expect(vectorSetupHint(reason, "意味で探せます")).toContain("検索索引作成／更新");
      expect(vectorSetupCommand(reason)).toBe("novelai.buildVectorIndex");
    }
  });

  test("記録に残す理由は日本語", () => {
    expect(describeVectorUnavailable("stale")).toContain("追いついていない");
  });
});

describe("検知にも使うか（既定は切）", () => {
  test("既定では使わない", () => {
    expect(isVectorUseInChecksEnabled()).toBe(false);
  });

  test("使わない設定では索引を開かず、確認の画面にも何も足さない", async () => {
    // 索引を開きにいくと、作り物のファイル操作が無いので例外になる。
    // `off` が返ることが、何も読まなかったことの証になる
    const vectors = await openCheckVectors(work, ["a", "b"]);
    expect(vectors).toEqual({ kind: "off" });
    expect(checkVectorsNote(vectors, "意味の近い前の場面も渡せます")).toBe("");
  });

  test("使う設定なのに使えないときだけ、何をすれば使えるかを添える", () => {
    const note = checkVectorsNote(
      { kind: "unavailable", reason: "noIndex" },
      "意味の近い前の場面も渡せます"
    );
    expect(note).toContain("検索索引作成／更新");
    expect(note).toContain("意味の近い前の場面も渡せます");
  });
});
