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

/**
 * ホバーは**紹介だけ**にした（作者の指示、2026-08-16）。
 *
 * 以前は役割・性格・外見・一人称・能力・関係・登場話・食い違い・作者メモを
 * すべて並べており、本文の上に十数行の枠が覆いかぶさっていた。
 * 詳細は右クリック →「設定情報を表示」で開ける。
 */
describe("ホバー資料", () => {
  test("名前・種別・紹介の3つだけを出す", () => {
    const character = {
      ...emptyCharacter("char_001", "月島 灯"),
      summary: "図書塔に住む見習い司書",
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
    expect(md.value).toContain("図書塔に住む見習い司書");

    // 詳細はパネルにある。同じものを2か所へ出さない
    expect(md.value).not.toContain("一人称");
    expect(md.value).not.toContain("内向的");
    expect(md.value).not.toContain("第1〜3話");
  });

  test("どこで詳しく見られるかを書く", () => {
    // 出す量を減らすなら、残りがどこにあるかは示さないと只の欠落になる
    const character = emptyCharacter("char_001", "灯");

    const md = buildHover(
      entry({}),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).toContain("設定情報を表示");
  });

  test("紹介が無ければ役割で代える", () => {
    // 古い作品のデータや、作者が手で足した記録には summary が無い
    const character = { ...emptyCharacter("char_001", "灯"), role: "主人公" };

    const md = buildHover(
      entry({}),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).toContain("主人公");
  });

  test("紹介も役割も無ければ、無いと書く", () => {
    const md = buildHover(
      entry({}),
      settings({
        characters: new Map([["char_001", emptyCharacter("char_001", "灯")]]),
      })
    );

    expect(md.value).toContain("紹介はまだありません");
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
    // 紹介が無いので、説明が代わりに出る
    expect(md.value).toContain("指先に光を灯す");
    expect(md.value).not.toContain("**効果**");
  });

  test("場所も紹介だけにする", () => {
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
    expect(md.value).toContain("魔導書庫");
    expect(md.value).not.toContain("王都リヴェルス");
  });

  test("作者の判断待ちも出さない", () => {
    // はじめは「資料ではなく報せだから」と残したが、作者が要らないと判断した。
    // 書いている最中に警告が出ると、思い出す助けではなく手を止めさせるものになる。
    // 食い違いは設定資料集パネルの「参考」で見る
    const character = {
      ...emptyCharacter("char_001", "灯"),
      summary: "見習い司書",
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

    expect(md.value).not.toContain("変化かもしれない");
    expect(md.value).not.toContain("appearance");
    expect(md.value).not.toContain("黒髪");
  });

  test("作者メモは出さない", () => {
    // 作者が自分で書いたものなので、書いた本人に読み返させる必要はない
    const character = {
      ...emptyCharacter("char_001", "灯"),
      summary: "見習い司書",
      authorNotes: "第12話で正体が判明する",
    };

    const md = buildHover(
      entry({}),
      settings({ characters: new Map([["char_001", character]]) })
    );

    expect(md.value).not.toContain("第12話で正体が判明する");
  });

  test("設定内のMarkdown記法をそのまま読ませる", () => {
    // 「*強調*」のような表記が設定に入っていても、装飾として解釈させない
    const character = {
      ...emptyCharacter("char_001", "灯"),
      summary: "*とても*内向的",
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
