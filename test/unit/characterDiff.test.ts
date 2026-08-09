import { describe, expect, test } from "vitest";
import {
  diffCharacter,
  formatDiff,
  summarizeDiff,
} from "../../src/core/characterDiff";
import { emptyCharacter, type Character } from "../../src/models/character";

function character(overrides: Partial<Character> = {}): Character {
  return { ...emptyCharacter("char_001", "灯"), ...overrides };
}

describe("更新案の差分", () => {
  test("変わらなければ何も出さない", () => {
    const diff = diffCharacter(character(), character());

    expect(diff.changes).toEqual([]);
    expect(summarizeDiff(diff)).toBe("変更なし");
  });

  test("未設定から値が入る場合は「追加」と示す", () => {
    const diff = diffCharacter(
      character({ role: null }),
      character({ role: "主人公" })
    );

    expect(diff.changes).toEqual([
      { label: "役割", before: "", after: "主人公" },
    ]);
    expect(summarizeDiff(diff)).toBe("役割を追加");
  });

  test("値が入れ替わる場合は「変更」と示す", () => {
    const diff = diffCharacter(
      character({ role: "村人" }),
      character({ role: "主人公" })
    );

    expect(summarizeDiff(diff)).toBe("役割を変更");
  });

  test("登場話と別名の増加を拾う", () => {
    const diff = diffCharacter(
      character({ appearedChapters: [1], aliases: [] }),
      character({ appearedChapters: [1, 2, 3], aliases: ["ともり"] })
    );

    const labels = diff.changes.map((change) => change.label);
    expect(labels).toContain("登場話");
    expect(labels).toContain("別名");
  });

  test("作者メモの変化は必ず出す", () => {
    // 抽出では書き換えない約束の項目。変化していたら見逃せない
    const diff = diffCharacter(
      character({ authorNotes: "作者のメモ" }),
      character({ authorNotes: "" })
    );

    expect(diff.changes).toContainEqual({
      label: "作者メモ",
      before: "作者のメモ",
      after: "",
    });
  });

  test("読める形に整える", () => {
    const diff = diffCharacter(
      character({ role: null }),
      character({ role: "主人公" })
    );

    const text = formatDiff(diff);

    expect(text).toContain("## 灯");
    expect(text).toContain("### 役割");
    expect(text).toContain("- 現在: （未設定）");
    expect(text).toContain("- 更新案: 主人公");
  });

  test("呼称の変化も示す", () => {
    const after = character({
      addressTerms: [
        {
          targetName: "澪",
          targetId: null,
          authorLocked: false,
          forms: [
            {
              term: "澪さん",
              category: null,
              context: null,
              firstChapter: null,
              lastChapter: null,
              status: "current",
              evidence: null,
            },
          ],
        },
      ],
    });

    const diff = diffCharacter(character(), after);

    expect(diff.changes.map((change) => change.label)).toContain("呼称");
  });

  test("モブ扱いになる変更を差分に出す", () => {
    // 一覧の下へ回り、用語ハイライトとIME辞書からも外れる。
    // 黙って反映すると、作者は人物が消えたようにしか見えない
    const diff = diffCharacter(
      character({ isMob: false }),
      character({ isMob: true })
    );

    expect(diff.changes).toEqual([
      { label: "モブ扱い", before: "いいえ", after: "はい" },
    ]);
  });
});
