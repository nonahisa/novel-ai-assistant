import { describe, expect, test } from "vitest";
import {
  diffCharacter,
  formatDiff,
  summarizeDiff,
} from "../../src/core/characterDiff";
import {
  emptyCharacter,
  type AddressForm,
  type AddressTerm,
  type Character,
} from "../../src/models/character";

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

/**
 * 更新案の中の「1つだけ」を指せるようにする（作者の依頼、2026-09-12）。
 *
 * 「呼称にハヤブサ先生があり、これが間違いです。この画面でここだけ
 * 消したりできないでしょうか？」——項目ごと見送るか、間違ったまま
 * 反映するかの二択しかなかった。**呼び方1つずつ**まで分ける。
 */
describe("1つずつ落とせる葉", () => {
  function form(term: string): AddressForm {
    return {
      term,
      category: null,
      context: null,
      firstChapter: null,
      lastChapter: null,
      status: "current",
      evidence: null,
    };
  }

  function addressTerm(
    targetName: string,
    terms: string[],
    authorLocked = false
  ): AddressTerm {
    return {
      targetName,
      targetId: null,
      forms: terms.map(form),
      authorLocked,
    };
  }

  function entriesOf(diff: ReturnType<typeof diffCharacter>, label: string) {
    return diff.changes.find((change) => change.label === label)?.entries;
  }

  test("呼称は、呼び方1つずつに分かれる", () => {
    const diff = diffCharacter(
      character({ addressTerms: [addressTerm("中神隼人", ["センパイ"])] }),
      character({
        addressTerms: [
          addressTerm("中神隼人", ["ハヤブサ先生", "先生", "センパイ"]),
        ],
      })
    );

    expect(entriesOf(diff, "呼称")).toEqual([
      {
        key: "address:中神隼人:ハヤブサ先生",
        text: "中神隼人→ハヤブサ先生",
        state: "added",
      },
      { key: "address:中神隼人:先生", text: "中神隼人→先生", state: "added" },
      {
        key: "address:中神隼人:センパイ",
        text: "中神隼人→センパイ",
        state: "kept",
      },
    ]);
  });

  test("消える呼び方は removed として残す", () => {
    const diff = diffCharacter(
      character({ addressTerms: [addressTerm("澪", ["澪さん", "澪"])] }),
      character({ addressTerms: [addressTerm("澪", ["澪さん"])] })
    );

    expect(entriesOf(diff, "呼称")).toEqual([
      { key: "address:澪:澪さん", text: "澪→澪さん", state: "kept" },
      { key: "address:澪:澪", text: "澪→澪", state: "removed" },
    ]);
  });

  test("関係も1つずつに分かれる", () => {
    const diff = diffCharacter(
      character({ relations: [{ name: "澪", relation: "同僚" }] }),
      character({
        relations: [
          { name: "澪", relation: "同僚" },
          { name: "中神隼人", relation: "上司" },
        ],
      })
    );

    expect(entriesOf(diff, "関係")).toEqual([
      { key: "relation:澪:同僚", text: "澪=同僚", state: "kept" },
      {
        key: "relation:中神隼人:上司",
        text: "中神隼人=上司",
        state: "added",
      },
    ]);
  });

  test("別名も1つずつに分かれる", () => {
    const diff = diffCharacter(
      character({ aliases: ["ともり"] }),
      character({ aliases: ["ともり", "灯ちゃん"] })
    );

    expect(entriesOf(diff, "別名")).toEqual([
      { key: "alias:ともり", text: "ともり", state: "kept" },
      { key: "alias:灯ちゃん", text: "灯ちゃん", state: "added" },
    ]);
  });

  test("作者が固定した呼称は、落とせる葉にしない", () => {
    // 触らない約束の値に ✕ を出すと、押せるのに何も起きない形になる
    const diff = diffCharacter(
      character({ addressTerms: [] }),
      character({ addressTerms: [addressTerm("澪", ["澪さん"], true)] })
    );

    expect(entriesOf(diff, "呼称")).toEqual([
      { key: "address:澪:澪さん", text: "澪→澪さん", state: "kept" },
    ]);
  });

  test("ほかの項目には葉を付けない", () => {
    const diff = diffCharacter(
      character({ role: null, summary: null }),
      character({ role: "主人公", summary: "転校生" })
    );

    for (const change of diff.changes) {
      expect(change.entries).toBeUndefined();
    }
  });
});
