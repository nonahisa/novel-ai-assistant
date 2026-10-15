import { describe, expect, test } from "vitest";
import {
  MANUSCRIPT_RELOAD_JUMP_TTL_MS,
  makeManuscriptReloadJump,
  parseManuscriptReloadJump,
  takeManuscriptReloadJump,
} from "../../../src/core/manuscriptReloadJump";

/**
 * 再読み込みをまたいで「この原稿の、この行へ飛ぶ」を持ち越す（作者の裁定 2026-10-15。
 * 設計書6.25.11）。覚えの形を信用しないこと・古い頼みを使わないことを見る。
 */
const now = new Date("2026-10-15T05:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);

describe("頼みの形", () => {
  test("作った頼みは、そのまま読める", () => {
    const jump = makeManuscriptReloadJump("file:///c%3A/w/1.md", 12, now);
    expect(parseManuscriptReloadJump(jump, later(1000))).toEqual(jump);
  });

  test.each([
    ["空", undefined],
    ["文字列", "12"],
    ["鍵が無い", { line: 3, savedAt: now.toISOString() }],
    ["行が0", { key: "k", line: 0, savedAt: now.toISOString() }],
    ["行が小数", { key: "k", line: 1.5, savedAt: now.toISOString() }],
    ["時刻が読めない", { key: "k", line: 3, savedAt: "きのう" }],
  ])("壊れた形（%s）は使わない", (_label, raw) => {
    expect(parseManuscriptReloadJump(raw, now)).toBeUndefined();
  });

  test("期限を過ぎた頼みは使わない", () => {
    const jump = makeManuscriptReloadJump("k", 3, now);
    expect(parseManuscriptReloadJump(jump, later(MANUSCRIPT_RELOAD_JUMP_TTL_MS + 1))).toBeUndefined();
  });

  test("未来の時刻（時計のずれ）の頼みは使わない", () => {
    const jump = makeManuscriptReloadJump("k", 3, later(60_000));
    expect(parseManuscriptReloadJump(jump, now)).toBeUndefined();
  });
});

describe("作り直された画面が取り出す", () => {
  test("同じ原稿なら行を返し、覚えを消す", () => {
    const jump = makeManuscriptReloadJump("k", 7, now);
    expect(takeManuscriptReloadJump(jump, "k", later(3000))).toEqual({ line: 7, clear: true });
  });

  test("別の原稿への頼みは残す（その画面がまだ作られていないことがある）", () => {
    const jump = makeManuscriptReloadJump("other", 7, now);
    expect(takeManuscriptReloadJump(jump, "k", later(3000))).toEqual({ line: undefined, clear: false });
  });

  test("壊れた・古い頼みは消す", () => {
    expect(takeManuscriptReloadJump({ key: 1 }, "k", now)).toEqual({ line: undefined, clear: true });
    const old = makeManuscriptReloadJump("k", 7, now);
    expect(takeManuscriptReloadJump(old, "k", later(MANUSCRIPT_RELOAD_JUMP_TTL_MS + 1))).toEqual({
      line: undefined,
      clear: true,
    });
  });

  test("頼みが無ければ何もしない", () => {
    expect(takeManuscriptReloadJump(undefined, "k", now)).toEqual({ line: undefined, clear: false });
  });
});
