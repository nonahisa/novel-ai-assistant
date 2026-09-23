import { describe, expect, test } from "vitest";
import {
  droppedTotal,
  insertMisattributedValue,
  parseMisattributedValues,
  planMisattributedRecord,
  resolveMisattributedDestination,
  type MisattributedValue,
} from "../../src/core/misattributedValues";
import { emptyCharacter, type Character } from "../../src/models/character";

/**
 * 「AIで再読込」ではじいた記述の受け皿（設計書6.31.2）。
 *
 * 実データ（アジャーノの記録に皇子の場面が混ざっていた）を写して試す。
 * 見るのは2つ——**捨てないこと**と、**AIの文字列が
 * そのまま書き込み先にならないこと**。
 */

const EXCERPT =
  "アジャーノは頭を垂れた。殿下は玉座から立ち上がり、諸侯を見渡した。" +
  "殿下は帝国の第一皇子である。";

const FIELDS = ["summary", "gender", "affiliation", "role", "personality", "appearance"];

function entry(overrides: Partial<MisattributedValue> = {}): MisattributedValue {
  return {
    belongsTo: "殿下",
    field: "role",
    value: "帝国の第一皇子",
    evidence: "殿下は帝国の第一皇子である。",
    ...overrides,
  };
}

describe("はじいた記述を読む", () => {
  test("本文と照合できた記述は残す", () => {
    const result = parseMisattributedValues([entry()], EXCERPT, FIELDS);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].belongsTo).toBe("殿下");
    expect(result.entries[0].value).toBe("帝国の第一皇子");
    expect(droppedTotal(result.dropped)).toBe(0);
  });

  test("本文に無い引用は落とし、件数を数える", () => {
    // 黙って消すと、出なかったのが「混入が無かった」のか
    // 「照合で全部落ちた」のか作者に区別できない
    const result = parseMisattributedValues(
      [entry({ evidence: "殿下は魔王を討ち果たした。" })],
      EXCERPT,
      FIELDS
    );

    expect(result.entries).toEqual([]);
    expect(result.dropped.ungrounded).toBe(1);
    expect(droppedTotal(result.dropped)).toBe(1);
  });

  test("呼び名が本文に無ければ落とす", () => {
    // 行き先の名前を捏造されると、実在しない人物の記録ができる
    const result = parseMisattributedValues(
      [entry({ belongsTo: "大神官" })],
      EXCERPT,
      FIELDS
    );

    expect(result.entries).toEqual([]);
    expect(result.dropped.ungrounded).toBe(1);
  });

  test("設定資料に無い項目名は落とす", () => {
    const result = parseMisattributedValues(
      [entry({ field: "好きな食べ物" })],
      EXCERPT,
      FIELDS
    );

    expect(result.entries).toEqual([]);
    expect(result.dropped.unknownField).toBe(1);
  });

  test("中身の無い文言は値にしない", () => {
    // 「不明」「記述なし」を値として返してくるのは繰り返し起きている失敗
    const result = parseMisattributedValues(
      [entry({ value: "不明" })],
      EXCERPT,
      FIELDS
    );

    expect(result.entries).toEqual([]);
    expect(result.dropped.emptyValue).toBe(1);
  });

  test("項目が欠けた応答は落とす", () => {
    const result = parseMisattributedValues(
      [{ belongsTo: "殿下", value: "帝国の第一皇子" }, "文字列", null],
      EXCERPT,
      FIELDS
    );

    expect(result.entries).toEqual([]);
    expect(result.dropped.malformed).toBe(3);
  });

  test("配列でなければ何も取り出さない", () => {
    // 小さいモデルは object や文字列を返してくることがある
    expect(parseMisattributedValues(undefined, EXCERPT, FIELDS).entries).toEqual(
      []
    );
    expect(
      parseMisattributedValues({ belongsTo: "殿下" }, EXCERPT, FIELDS).entries
    ).toEqual([]);
  });
});

describe("行き先を決める", () => {
  const characters = [
    { id: "char_001", name: "アジャーノ", aliases: ["アジャン"] },
    { id: "char_002", name: "リンセップ", aliases: ["殿下", "第一皇子"] },
  ];

  test("名前に当たる", () => {
    const destination = resolveMisattributedDestination("アジャーノ", characters);

    expect(destination).toEqual({
      kind: "existing",
      id: "char_001",
      name: "アジャーノ",
    });
  });

  test("別名に当たる", () => {
    const destination = resolveMisattributedDestination("殿下", characters);

    expect(destination.kind).toBe("existing");
    expect(destination).toMatchObject({ id: "char_002", name: "リンセップ" });
  });

  test("敬称が付いていても当たる", () => {
    // 抽出は「アジャーノ」とも「アジャーノさん」とも返してくる
    const destination = resolveMisattributedDestination(
      "アジャーノさん",
      characters
    );

    expect(destination).toMatchObject({ id: "char_001" });
  });

  test("名前での一致を、別名より先に採る", () => {
    // まとめ損ねた記録では、同じ別名が複数のレコードに残っていることがある
    const withStrayAlias = [
      { id: "char_003", name: "近衛兵", aliases: ["リンセップ"] },
      ...characters,
    ];

    expect(
      resolveMisattributedDestination("リンセップ", withStrayAlias)
    ).toMatchObject({ id: "char_002" });
  });

  test("当たらなければ、新しい記録を起こす道になる", () => {
    const destination = resolveMisattributedDestination("大神官", characters);

    expect(destination).toEqual({ kind: "new", name: "大神官" });
  });
});

describe("既存の人物へ入れる", () => {
  function prince(): Character {
    const character = emptyCharacter("char_002", "リンセップ");
    character.aliases = ["殿下"];
    return character;
  }

  test("空欄なら埋める", () => {
    const result = insertMisattributedValue(prince(), entry());

    expect(result.character.role).toBe("帝国の第一皇子");
    expect(result.filled).toBe(true);
    expect(result.conflicted).toBe(false);
    // 空欄を埋めるときにも履歴を残す（次に違う値が来たときの判断材料）
    expect(result.character.changes[0]).toMatchObject({
      field: "role",
      value: "帝国の第一皇子",
    });
  });

  test("既に値があれば上書きせず、作者の判断へ回す", () => {
    const target = prince();
    target.role = "近衛隊長";

    const result = insertMisattributedValue(target, entry());

    expect(result.character.role).toBe("近衛隊長");
    expect(result.conflicted).toBe(true);
    expect(result.character.conflicts[0].values).toEqual([
      "近衛隊長",
      "帝国の第一皇子",
    ]);
  });

  test("元のレコードを書き換えない", () => {
    // 作者がボタンを押すまで、画面の裏で値が変わってはいけない
    const target = prince();
    insertMisattributedValue(target, entry());

    expect(target.role).toBeNull();
    expect(target.changes).toEqual([]);
  });

  test("人物の項目でなければ入れない", () => {
    // 場所の「地域」を人物へ入れる道を作らない
    expect(() =>
      insertMisattributedValue(prince(), entry({ field: "region" }))
    ).toThrow();
  });
});

describe("新しい記録を起こす", () => {
  const existing = [emptyCharacter("char_001", "アジャーノ")];

  test("その値だけを持つ人物ができる", () => {
    const created = planMisattributedRecord(entry(), existing);

    expect(created.id).toBe("char_002");
    expect(created.name).toBe("殿下");
    expect(created.role).toBe("帝国の第一皇子");
    expect(created.summary).toBeNull();
  });

  test("自動生成のままにする", () => {
    // false にすると、以後の抽出が登場話数しか足さなくなり、
    // 中身の薄い記録が永久に埋まらない
    expect(planMisattributedRecord(entry(), existing).autoGenerated).toBe(true);
  });

  test("根拠を残す", () => {
    // どこを読んでそう書いたのかが無いと、作者は確かめようがない
    expect(planMisattributedRecord(entry(), existing).evidence).toBe(
      "殿下は帝国の第一皇子である。"
    );
  });

  test("呼び名が空なら起こさない", () => {
    expect(() =>
      planMisattributedRecord(entry({ belongsTo: "  " }), existing)
    ).toThrow();
  });
});
