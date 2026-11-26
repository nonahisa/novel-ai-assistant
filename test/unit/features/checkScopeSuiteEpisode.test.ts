import { describe, expect, test } from "vitest";
import "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import { resolveCheckScope } from "../../../src/features/typoCheckScope";

/**
 * まとめ実行の中の範囲（設計書6.80）と、原稿エディターの「この話を校正」
 * （作者の答え 2026-11-27）。
 *
 * まとめ実行では範囲を訊かない。作品全体の道は「全体」のまま、話の道は
 * 押した話だけ（`current`）になる。完了の知らせの「（この話）」もこの種類から出る。
 */

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

describe("まとめ実行の中の範囲", () => {
  test("作品全体の道（話の印なし）は、今までどおり全体", async () => {
    const scope = await resolveCheckScope(work, "contradiction", {
      suiteConfirmed: true,
    });
    expect(scope).toEqual({ kind: "all" });
  });

  test("「この話を校正」から来たら、訊かずにその話だけ", async () => {
    const file = "C:/works/試しの作品/本文/003.txt";
    for (const feature of ["typo", "proofread", "deviation", "contradiction"] as const) {
      const scope = await resolveCheckScope(work, feature, {
        suiteConfirmed: true,
        suiteOnlyFile: file,
      });
      expect(scope, feature).toEqual({ kind: "current", filePaths: [file] });
    }
  });
});
