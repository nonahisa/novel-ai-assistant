import { describe, expect, test } from "vitest";
import {
  emptyCharacter,
  keepProtagonistMark,
  parseCharacter,
} from "../../../src/models/character";

/**
 * 主人公（中心人物）の印（作者の裁定、2026-10-17）。
 *
 * 作者だけが付け外しする印で、AIの抽出・マージ・提案の採用では動かさない
 * （CLAUDE.md 規則2）。古い資料（印が無い）はそのまま読めなければならない。
 */
describe("主人公の印の読み込み", () => {
  test("印の無い古い資料は、そのまま読める（欄を足さない）", () => {
    const character = parseCharacter({ id: "char_001", name: "灯" });

    expect(character.isProtagonist).toBeUndefined();
    expect("isProtagonist" in character).toBe(false);
  });

  test("印が付いた資料は印を持って読める", () => {
    const character = parseCharacter({
      id: "char_001",
      name: "灯",
      isProtagonist: true,
    });

    expect(character.isProtagonist).toBe(true);
  });

  test("手で false と書かれた資料も、印なしと同じ形にそろえる", () => {
    const character = parseCharacter({
      id: "char_001",
      name: "灯",
      isProtagonist: false,
    });

    expect("isProtagonist" in character).toBe(false);
  });

  test("真偽値でない印は読み込みエラーにする（黙って捨てない）", () => {
    expect(() =>
      parseCharacter({ id: "char_001", name: "灯", isProtagonist: "はい" })
    ).toThrow();
  });
});

describe("承認待ちの写しで印を戻さない", () => {
  test("いまの記録に印があれば、写しに無くても残す", () => {
    const next = emptyCharacter("char_001", "灯");
    const kept = keepProtagonistMark(next, { isProtagonist: true });

    expect(kept.isProtagonist).toBe(true);
  });

  test("いまの記録で外した印は、写しに残っていても戻さない", () => {
    const next = { ...emptyCharacter("char_001", "灯"), isProtagonist: true };
    const kept = keepProtagonistMark(next, {});

    expect("isProtagonist" in kept).toBe(false);
  });
});
