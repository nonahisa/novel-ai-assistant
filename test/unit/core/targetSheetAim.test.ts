import { describe, expect, test } from "vitest";
import {
  applyAimToAuthorBlock,
  DEFAULT_AUTHOR_BLOCK,
  readAimReason,
  readAimTypes,
} from "../../../src/core/targetSheetDoc";

/**
 * 1段目「狙い」の答えを、シートの作者の欄へ書き込む（設計書6.108.6）。
 *
 * 作者の指摘④（2026-09-22 未明）：「どんな読者に読んでもらいたいか」の
 * 質問にすれば、シートの狙いと理由も埋まるのでは。
 *
 * **作者の欄は作者のもの**（実装ルール2）。書き換えるのは「狙い：」と
 * 「理由：」の2行だけで、作者が手で足したほかの行は1字も動かさない。
 */
describe("狙いと理由を作者の欄へ書き込む", () => {
  test("ひな形の欄へ、狙いと理由が入る", () => {
    const block = applyAimToAuthorBlock(DEFAULT_AUTHOR_BLOCK, {
      aims: ["lore_deep", "deep_pure"],
      reason: "伏線を拾ってくれる人に読んでほしい",
    });

    expect(readAimTypes(block)).toEqual(["lore_deep", "deep_pure"]);
    expect(readAimReason(block)).toBe("伏線を拾ってくれる人に読んでほしい");
  });

  test("作者が手で足した行は、そのまま残る", () => {
    const original = [
      "狙い：刺激層",
      "",
      "理由：昔の読者",
      "",
      "メモ：第2部からは考察層も意識する",
    ].join("\n");

    const block = applyAimToAuthorBlock(original, {
      aims: ["lore_deep"],
      reason: "考え直した",
    });

    expect(block.split("\n")).toEqual([
      "狙い：考察層",
      "",
      "理由：考え直した",
      "",
      "メモ：第2部からは考察層も意識する",
    ]);
  });

  test("理由を渡さなければ、理由の行は変えない", () => {
    const original = ["狙い：刺激層", "理由：昔の読者"].join("\n");

    const block = applyAimToAuthorBlock(original, { aims: ["light"] });

    expect(readAimTypes(block)).toEqual(["light"]);
    expect(readAimReason(block)).toBe("昔の読者");
  });

  test("狙いを渡さなければ、狙いの行は変えない", () => {
    const original = ["狙い：刺激層", "理由：昔の読者"].join("\n");

    const block = applyAimToAuthorBlock(original, { reason: "新しい理由" });

    expect(readAimTypes(block)).toEqual(["crave_pure"]);
    expect(readAimReason(block)).toBe("新しい理由");
  });

  test("欄に行が無ければ、先頭に足す（ほかの行は後ろへ残す）", () => {
    const block = applyAimToAuthorBlock("自由に書いたメモ", {
      aims: ["omnivore"],
      reason: "まだ決めきれない",
    });

    expect(block.split("\n")).toEqual([
      "狙い：雑食層",
      "理由：まだ決めきれない",
      "自由に書いたメモ",
    ]);
  });

  test("理由に改行が混ざっても、1行に畳む（読み取りの約束を崩さない）", () => {
    const block = applyAimToAuthorBlock(DEFAULT_AUTHOR_BLOCK, {
      reason: "一行目\n二行目",
    });

    expect(readAimReason(block)).toBe("一行目 二行目");
  });

  test("狙いは2つまで（3つ渡されても2つだけ書く）", () => {
    const block = applyAimToAuthorBlock(DEFAULT_AUTHOR_BLOCK, {
      aims: ["lore_deep", "deep_pure", "light"],
    });

    expect(readAimTypes(block)).toEqual(["lore_deep", "deep_pure"]);
  });

  test("理由の行が無ければ、理由は空", () => {
    expect(readAimReason("狙い：考察層")).toBe("");
  });

  test("CRLF の欄でも、改行の形を崩さない", () => {
    const original = ["狙い：刺激層", "理由：昔", "メモ"].join("\r\n");

    const block = applyAimToAuthorBlock(original, { aims: ["light"] });

    expect(block).toBe(["狙い：すきま層", "理由：昔", "メモ"].join("\r\n"));
  });
});
