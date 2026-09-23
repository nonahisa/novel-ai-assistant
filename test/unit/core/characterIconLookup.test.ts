import { describe, expect, test } from "vitest";
import {
  buildCharacterIconIndex,
  characterIconKeys,
  characterIconNotice,
  compareIconPaths,
  iconNameKey,
  resolveCharacterIconPath,
} from "../../../src/core/characterIconLookup";

/**
 * 人物イラストを素材置き場から名前で引く（作者の指定、2026-09-13
 * 「というか、素材置き場から読んでください」）。
 *
 * 台帳の `icon` 欄を埋める画面がどこにも無かったため、実機では人物紹介に
 * 載る全員が「イラストが見つからない」になっていた。ここで見るのは
 * **名前の突き合わせ方と、どれを選ぶかの決め方**である——ファイルを
 * 実際に置かずに確かめられるようにしてある。
 */

function who(
  name: string,
  overrides: { aliases?: string[]; icon?: string | null } = {}
): { name: string; aliases: readonly string[]; icon: string | null } {
  return {
    name,
    aliases: overrides.aliases ?? [],
    icon: overrides.icon ?? null,
  };
}

describe("名前の揃え方", () => {
  test("前後の空白だけを落とす（名前の中の空白は残す）", () => {
    expect(iconNameKey("  月島 灯  ")).toBe("月島 灯");
  });

  test("大文字小文字は区別しない", () => {
    expect(iconNameKey("Tina")).toBe(iconNameKey("TINA"));
  });

  test("名前が先、別名はその並びのまま。空と重複は落ちる", () => {
    expect(
      characterIconKeys({
        name: "月島灯",
        aliases: ["  ", "あかり", "月島灯", "Akari"],
      })
    ).toEqual(["月島灯", "あかり", "akari"]);
  });
});

describe("素材置き場の索引", () => {
  test("拡張子を除いたファイル名で引ける", () => {
    const index = buildCharacterIconIndex(["素材/月島灯.png"]);

    expect(resolveCharacterIconPath(who("月島灯"), index)).toBe(
      "素材/月島灯.png"
    );
  });

  test("別名でも引ける", () => {
    const index = buildCharacterIconIndex(["素材/あかり.png"]);

    expect(
      resolveCharacterIconPath(who("月島灯", { aliases: ["あかり"] }), index)
    ).toBe("素材/あかり.png");
  });

  test("名前の絵が別名の絵より先に選ばれる", () => {
    const index = buildCharacterIconIndex([
      "素材/あかり.png",
      "素材/月島灯.png",
    ]);

    expect(
      resolveCharacterIconPath(who("月島灯", { aliases: ["あかり"] }), index)
    ).toBe("素材/月島灯.png");
  });

  test("大文字小文字が違っても当たる", () => {
    const index = buildCharacterIconIndex(["素材/TINA.PNG"]);

    expect(resolveCharacterIconPath(who("tina"), index)).toBe("素材/TINA.PNG");
  });

  /** 下の階層も見る（作者の並べ方は決められない） */
  test("素材の下のフォルダーの絵も当たる", () => {
    const index = buildCharacterIconIndex(["素材/人物/ターナ先生.png"]);

    expect(resolveCharacterIconPath(who("ターナ先生"), index)).toBe(
      "素材/人物/ターナ先生.png"
    );
  });

  test("Windowsの区切りで書かれていても読める", () => {
    const index = buildCharacterIconIndex(["素材\\人物\\月島灯.png"]);

    expect(resolveCharacterIconPath(who("月島灯"), index)).toBe(
      "素材/人物/月島灯.png"
    );
  });

  test("素材置き場の外は拾わない", () => {
    const index = buildCharacterIconIndex([
      "本文/月島灯.png",
      "設定/月島灯.png",
      "月島灯.png",
      "../外/月島灯.png",
      "素材/../本文/月島灯.png",
    ]);

    expect(index.size).toBe(0);
    expect(resolveCharacterIconPath(who("月島灯"), index)).toBeNull();
  });

  test("画像でないものは拾わない", () => {
    const index = buildCharacterIconIndex([
      "素材/月島灯.txt",
      "素材/月島灯.psd",
    ]);

    expect(index.size).toBe(0);
  });

  test("見つからなければ null（その人物は名前だけになる）", () => {
    const index = buildCharacterIconIndex(["素材/別人.png"]);

    expect(resolveCharacterIconPath(who("月島灯"), index)).toBeNull();
  });
});

describe("同じ名前の絵が複数あるとき", () => {
  /**
   * **実行のたびに変わらないこと。** 変わると、本を作り直すたびに違う絵が
   * 入る（作者から見れば原因の分からない揺れになる）。
   */
  test("拡張子違いは IMAGE_EXTENSIONS の並び順で決まる", () => {
    const forward = buildCharacterIconIndex([
      "素材/月島灯.png",
      "素材/月島灯.jpg",
      "素材/月島灯.webp",
    ]);
    const backward = buildCharacterIconIndex([
      "素材/月島灯.webp",
      "素材/月島灯.jpg",
      "素材/月島灯.png",
    ]);

    expect(forward.get("月島灯")).toBe("素材/月島灯.png");
    expect(backward.get("月島灯")).toBe("素材/月島灯.png");
  });

  test("フォルダーが違うときは浅いほうが勝つ", () => {
    const index = buildCharacterIconIndex([
      "素材/人物/主要/月島灯.png",
      "素材/月島灯.png",
      "素材/人物/月島灯.png",
    ]);

    expect(index.get("月島灯")).toBe("素材/月島灯.png");
  });

  test("同じ深さなら相対パスの順で、渡す順に左右されない", () => {
    const forward = buildCharacterIconIndex([
      "素材/あ/月島灯.png",
      "素材/い/月島灯.png",
    ]);
    const backward = buildCharacterIconIndex([
      "素材/い/月島灯.png",
      "素材/あ/月島灯.png",
    ]);

    expect(forward.get("月島灯")).toBe(backward.get("月島灯"));
  });

  test("並べ方そのもの（浅さ→拡張子→綴り）", () => {
    expect(
      compareIconPaths("素材/月島灯.jpg", "素材/人物/月島灯.png")
    ).toBeLessThan(0);
    expect(compareIconPaths("素材/月島灯.png", "素材/月島灯.jpg")).toBeLessThan(
      0
    );
    expect(compareIconPaths("素材/あ/絵.png", "素材/い/絵.png")).toBeLessThan(0);
    expect(compareIconPaths("素材/絵.png", "素材/絵.png")).toBe(0);
  });
});

describe("icon 欄との関係", () => {
  test("icon 欄が入っていれば、そちらが勝つ", () => {
    const index = buildCharacterIconIndex(["素材/月島灯.png"]);

    expect(
      resolveCharacterIconPath(who("月島灯", { icon: "素材/手で選んだ絵.png" }), index)
    ).toBe("素材/手で選んだ絵.png");
  });

  test("icon 欄は素材置き場の外でもよい（手で指した場所を尊重する）", () => {
    expect(
      resolveCharacterIconPath(
        who("月島灯", { icon: "設定/画像/月島灯.png" }),
        new Map()
      )
    ).toBe("設定/画像/月島灯.png");
  });

  /** 使えない値のために名前だけにするより、実際にある絵を出す */
  test("icon 欄が作品フォルダの外を指していたら、素材置き場から引く", () => {
    const index = buildCharacterIconIndex(["素材/月島灯.png"]);

    expect(
      resolveCharacterIconPath(who("月島灯", { icon: "C:/秘密/絵.png" }), index)
    ).toBe("素材/月島灯.png");
    expect(
      resolveCharacterIconPath(who("月島灯", { icon: "../外/絵.png" }), index)
    ).toBe("素材/月島灯.png");
  });
});

describe("人物紹介の欄に出す知らせ", () => {
  test("全員に付いていれば、そう言う", () => {
    expect(characterIconNotice(3, [])).toBe("全員にイラストが付きます。");
  });

  test("付いた人数・付かない人の名前・置き場を伝える", () => {
    const notice = characterIconNotice(5, ["イント", "ターナ先生"]);

    expect(notice).toContain("3人");
    expect(notice).toContain("イント・ターナ先生");
    expect(notice).toContain("素材フォルダー");
  });

  test("多いときは先頭3人と「ほか◯人」にする", () => {
    const notice = characterIconNotice(19, [
      "一郎",
      "二郎",
      "三郎",
      "四郎",
      "五郎",
    ]);

    expect(notice).toContain("一郎・二郎・三郎ほか2人");
    expect(notice).not.toContain("四郎");
  });

  /** 1人も見つからないのが、いまの実機の状態である */
  test("1人も付いていないときは、0人と言わずに理由へ導く", () => {
    const notice = characterIconNotice(2, ["イント", "ターナ先生"]);

    expect(notice).toContain("まだ1人も見つかりません");
    expect(notice).toContain("素材フォルダー");
  });

  test("Markdownの記号を混ぜない", () => {
    const notice = characterIconNotice(19, ["一郎", "二郎", "三郎", "四郎"]);

    expect(notice).not.toContain("**");
    expect(notice.trimStart().startsWith("#")).toBe(false);
  });
});
