import { describe, expect, it } from "vitest";
import {
  hasAppearedBy,
  isEmptyAfterRollback,
  recordAsOf,
  valueAsOf,
} from "../../src/core/settingsAsOf";
import type { RecordChange } from "../../src/models/jsonValidation";

/**
 * 設定資料を「第N話の時点で分かっていること」に絞る（設計書6.10.3）。
 *
 * 作者の指摘（2026-08-23）：「矛盾検知の時系列把握が甘いです。4話で判明する
 * 内容を3話で矛盾として検知していました」。
 *
 * **設定資料は作品全体から作られている。** 第4話で「退学扱いになった」と
 * 明かされれば資料にはそう入る。それを第3話と突き合わせれば、
 * **まだ明かされていない事実**と食い違って見えるのは当たり前である。
 */

function change(
  field: string,
  value: string,
  chapters: number[]
): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
  };
}

describe("その時点の値", () => {
  /** 作者の環境で実際に起きた形 */
  it("あとの話で分かったことは、前の話では出さない", () => {
    const changes = [change("role", "定時制高校生（退学扱い）", [4])];
    expect(valueAsOf(changes, "role", "定時制高校生（退学扱い）", 3)).toBeNull();
  });

  it("その話までに分かっていることは出す", () => {
    const changes = [change("role", "定時制高校生（退学扱い）", [4])];
    expect(valueAsOf(changes, "role", "定時制高校生（退学扱い）", 4)).toBe(
      "定時制高校生（退学扱い）"
    );
  });

  /** 作中で変わったものは、その時点の値へ戻す */
  it("変化があれば、その時点の値になる", () => {
    const changes = [
      change("role", "男子小学生", [1]),
      change("role", "転校生", [5]),
    ];
    expect(valueAsOf(changes, "role", "転校生", 3)).toBe("男子小学生");
    expect(valueAsOf(changes, "role", "転校生", 5)).toBe("転校生");
  });

  /**
   * **記録の無い項目は落とさない。**
   * この仕組みより前の資料や、作者が手で書いた項目には話数が無い。
   * 消すと作者の書いたものが黙って消える。
   */
  it("変化の記録が無ければ、そのまま通す", () => {
    expect(valueAsOf([], "role", "定時制高校生", 3)).toBe("定時制高校生");
  });

  it("話数の分からない記録は「それ以前」として扱う", () => {
    const changes = [change("role", "同級生", [])];
    expect(valueAsOf(changes, "role", "同級生", 1)).toBe("同級生");
  });

  it("話が分からないときは絞らない", () => {
    const changes = [change("role", "転校生", [5])];
    expect(valueAsOf(changes, "role", "転校生", null)).toBe("転校生");
  });

  it("他の項目の記録は見ない", () => {
    const changes = [change("appearance", "美少女", [4])];
    expect(valueAsOf(changes, "role", "同級生", 3)).toBe("同級生");
  });
});

describe("その時点で登場しているか", () => {
  it("まだ出ていない人物は、突き合わせない", () => {
    expect(hasAppearedBy([4, 5], 3)).toBe(false);
  });

  it("出ている人物は、突き合わせる", () => {
    expect(hasAppearedBy([2, 5], 3)).toBe(true);
  });

  /** 判断できないものは通す（落とさない側へ倒す） */
  it("登場話数が空なら、通す", () => {
    expect(hasAppearedBy([], 3)).toBe(true);
  });

  it("話が分からないときは通す", () => {
    expect(hasAppearedBy([4], null)).toBe(true);
  });
});

describe("レコードごと巻き戻す", () => {
  const fields = ["role", "appearance"];

  it("項目ごとに、その時点の値へ戻す", () => {
    const record = {
      name: "フミカ",
      role: "転校生",
      appearance: "超絶美少女",
      changes: [
        change("role", "男子小学生", [1]),
        change("role", "転校生", [5]),
        change("appearance", "超絶美少女", [4]),
      ],
    };
    const rolled = recordAsOf(record, fields, 3);
    expect(rolled.role).toBe("男子小学生");
    // 第4話で分かった容姿は、第3話では出さない
    expect(rolled.appearance).toBeNull();
    // 名前は巻き戻さない（誰の話か分からなくなる）
    expect(rolled.name).toBe("フミカ");
  });

  it("元のレコードを書き換えない", () => {
    const record = {
      role: "転校生",
      changes: [change("role", "転校生", [5])],
    };
    recordAsOf(record, fields, 3);
    expect(record.role).toBe("転校生");
  });

  /** 場所には変化の記録が無い。巻き戻せないので、そのまま通す */
  it("変化の記録を持たない種類は、そのまま通す", () => {
    const record = { role: "商店街", appearance: null };
    expect(recordAsOf(record, fields, 3).role).toBe("商店街");
  });

  it("話が分からないときは、そのまま返す", () => {
    const record = {
      role: "転校生",
      changes: [change("role", "転校生", [5])],
    };
    expect(recordAsOf(record, fields, null).role).toBe("転校生");
  });
});

describe("巻き戻して空になったか", () => {
  /**
   * **名前しか分かっていない記録を送っても、材料にならない。**
   * 送るだけ指示が長くなり、AIが「材料がある」と誤解する。
   */
  it("すべて空なら空と言う", () => {
    expect(
      isEmptyAfterRollback({ role: null, appearance: null }, [
        "role",
        "appearance",
      ])
    ).toBe(true);
  });

  it("1つでも残っていれば空ではない", () => {
    expect(
      isEmptyAfterRollback({ role: "同級生", appearance: null }, [
        "role",
        "appearance",
      ])
    ).toBe(false);
  });

  it("空白だけの値は、無いものとして扱う", () => {
    expect(isEmptyAfterRollback({ role: "  " }, ["role"])).toBe(true);
  });
});
