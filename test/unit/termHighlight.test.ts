import { describe, expect, test, vi } from "vitest";

// vscode.MarkdownString だけを使うので、必要最小限を差し替える
vi.mock("vscode", () => ({
  MarkdownString: class {
    value = "";
    supportThemeIcons = false;
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  },
  window: { createTextEditorDecorationType: () => ({}) },
  workspace: { onDidChangeTextDocument: () => ({ dispose() {} }) },
  Range: class {},
  Position: class {},
}));

import { buildHover } from "../../src/views/termHighlight";
import { emptyCharacter } from "../../src/models/character";
import { emptyAbility } from "../../src/models/ability";
import { emptyLocation } from "../../src/models/location";
import type { TermEntry } from "../../src/core/termIndex";

function settings(overrides: Partial<Parameters<typeof buildHover>[1]> = {}) {
  return {
    characters: new Map(),
    abilities: new Map(),
    locations: new Map(),
    abilityTerm: "能力",
    ...overrides,
  };
}

function entry(overrides: Partial<TermEntry>): TermEntry {
  return {
    text: "灯",
    kind: "character",
    id: "char_001",
    canonicalName: "灯",
    ...overrides,
  };
}

describe("ホバー資料", () => {
  test("人物の要点を並べる", () => {
    const character = {
      ...emptyCharacter("char_001", "月島 灯"),
      role: "主人公",
      personality: "内向的だが芯が強い",
      appearedChapters: [1, 2, 3],
    };
    character.firstPerson.default = "僕";

    const md = buildHover(
      entry({ text: "灯", canonicalName: "月島 灯" }),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).toContain("**月島 灯**");
    expect(md.value).toContain("登場人物");
    expect(md.value).toContain("- **役割**: 主人公");
    expect(md.value).toContain("- **一人称**: 僕");
    expect(md.value).toContain("第1〜3話");
  });

  test("別名で一致したらどの呼び方かを示す", () => {
    const character = emptyCharacter("char_002", "白瀬 澪");

    const md = buildHover(
      entry({ text: "白瀬さん", id: "char_002", canonicalName: "白瀬 澪" }),
      settings({ characters: new Map([["char_002", character]]) })
    );

    expect(md.value).toContain("「白瀬さん」として登場");
  });

  test("能力の種別名に作品の総称を使う", () => {
    const ability = {
      ...emptyAbility("abil_001", "灯火"),
      description: "指先に光を灯す",
    };

    const md = buildHover(
      entry({ kind: "ability", id: "abil_001", canonicalName: "灯火" }),
      settings({
        abilities: new Map([["abil_001", ability]]),
        abilityTerm: "神術",
      })
    );

    // 現代ものに「魔法」と出さないのと同じ理由で、総称は作品側の呼称を使う
    expect(md.value).toContain("_神術_");
    expect(md.value).toContain("- **効果**: 指先に光を灯す");
  });

  test("場所の地域と説明を出す", () => {
    const location = {
      ...emptyLocation("loc_001", "図書塔"),
      region: "王都リヴェルス",
      description: "魔導書庫",
    };

    const md = buildHover(
      entry({ kind: "location", id: "loc_001", canonicalName: "図書塔" }),
      settings({ locations: new Map([["loc_001", location]]) })
    );

    expect(md.value).toContain("_場所_");
    expect(md.value).toContain("- **地域**: 王都リヴェルス");
  });

  test("作者の判断待ちをホバーでも見せる", () => {
    const character = {
      ...emptyCharacter("char_001", "灯"),
      conflicts: [
        {
          field: "appearance",
          values: ["黒髪", "銀髪"],
          chapters: [],
          note: null,
        },
      ],
    };

    const md = buildHover(
      entry({}),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).toContain("要確認");
    expect(md.value).toContain("黒髪");
    expect(md.value).toContain("銀髪");
  });

  test("作者メモを末尾に添える", () => {
    const character = {
      ...emptyCharacter("char_001", "灯"),
      authorNotes: "第12話で正体が判明する",
    };

    const md = buildHover(
      entry({}),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).toContain("第12話で正体が判明する");
  });

  test("設定内のMarkdown記法をそのまま読ませる", () => {
    // 「*強調*」のような表記が設定に入っていても、装飾として解釈させない
    const character = {
      ...emptyCharacter("char_001", "灯"),
      personality: "*とても*内向的",
    };

    const md = buildHover(
      entry({}),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).toContain("\\*とても\\*内向的");
  });

  test("レコードが見つからなくても落ちない", () => {
    const md = buildHover(entry({ id: "char_999" }), settings());

    expect(md.value).toContain("**灯**");
  });
});
