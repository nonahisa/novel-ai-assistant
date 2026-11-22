import { describe, expect, test } from "vitest";
import {
  describeDiscardedUpdatesNotice,
  staleCharacterUpdates,
} from "../../../src/core/narratorMoveChoices";

describe("staleCharacterUpdates：移したあとの人物の更新案を選ぶ（消さない）", () => {
  const updates = [
    { kind: "update", filePath: "p/char_001_a.json", character: { id: "char_001" } },
    { kind: "update", filePath: "p/char_001_b.json", character: { id: "char_001" } },
    { kind: "update", filePath: "p/char_002.json", character: { id: "char_002" } },
    // 新しく作る案は仮IDなので照らさない
    { kind: "creation", filePath: "p/new.json", character: { id: "char_003" } },
  ];

  test("渡した人物の更新案だけを、人物の順に返す", () => {
    expect(
      staleCharacterUpdates(updates, [
        { id: "char_002", name: "ターナ" },
        { id: "char_001", name: "マイナ" },
      ])
    ).toEqual({
      filePaths: ["p/char_002.json", "p/char_001_a.json", "p/char_001_b.json"],
      names: ["ターナ", "マイナ"],
    });
  });

  test("更新案の無い人物と、作る案の人物は名前に入らない", () => {
    expect(
      staleCharacterUpdates(updates, [
        { id: "char_003", name: "新顔" },
        { id: "char_009", name: "誰か" },
      ])
    ).toEqual({ filePaths: [], names: [] });
  });

  test("知らせは片づけが無ければ null", () => {
    expect(describeDiscardedUpdatesNotice([])).toBeNull();
    expect(describeDiscardedUpdatesNotice(["マイナ"])).toContain("「マイナ」の承認待ちの更新案を片づけました");
  });
});
