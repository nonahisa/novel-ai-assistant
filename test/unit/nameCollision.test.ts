import { describe, expect, test } from "vitest";
import {
  findNameCollisions,
  normalizeReading,
  toMoras,
  type NameEntry,
} from "../../src/core/nameCollision";

/** 人物を1件作る。読みはカタカナ名なら省略できる */
function person(id: string, name: string, extra: Partial<NameEntry> = {}): NameEntry {
  return { id, kind: "character", name, ...extra };
}

/** その2人の組を取り出す。並び順に縛られないため */
function pairOf(
  result: ReturnType<typeof findNameCollisions>,
  first: string,
  second: string
) {
  return result.collisions.find(
    (collision) =>
      (collision.a.id === first && collision.b.id === second) ||
      (collision.a.id === second && collision.b.id === first)
  );
}

describe("読みの正規化", () => {
  test("カタカナはひらがなにする", () => {
    expect(normalizeReading("アリア").reading).toBe("ありあ");
  });

  test("長音は直前の母音へ開く", () => {
    // 「ほんごー」と「ほんごお」は同じ響き。開かないと別物として通り抜ける
    expect(normalizeReading("ホンゴー").reading).toBe("ほんごお");
    expect(normalizeReading("カッパー").reading).toBe("かっぱあ");
  });

  test("区切りは落とす", () => {
    expect(normalizeReading("ヴァン＝ヘルシング").reading).toBe("ゔぁんへるしんぐ");
    expect(normalizeReading("リンセップ・アウクト").reading).toBe(
      "りんせっぷあうくと"
    );
  });

  test("清音化した形も返す", () => {
    expect(normalizeReading("ガナ").dakutenFree).toBe("かな");
    expect(normalizeReading("パンダ").dakutenFree).toBe("はんた");
  });

  test("小書きは前の音とくっつけ、促音は1音として数える", () => {
    expect(toMoras("きゃく")).toEqual(["きゃ", "く"]);
    // 「あっさり」を3音にすると「あさり」と音数が並んでしまう
    expect(toMoras("あっさり")).toEqual(["あ", "っ", "さ", "り"]);
  });
});

describe("衝突の判定（設計書6.37.1の①〜⑥）", () => {
  test("①読みが同じ", () => {
    const result = findNameCollisions([
      person("a", "ホンゴー"),
      person("b", "本郷", { reading: "ほんごお" }),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(1);
    expect(hit?.strength).toBe("strong");
    expect(hit?.reason).toContain("読みが同じ");
  });

  test("②片方がもう片方の先頭", () => {
    const result = findNameCollisions([
      person("a", "ミナ"),
      person("b", "ミナモト"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(2);
    expect(hit?.strength).toBe("strong");
  });

  test("③頭2音が同じで音数も近い", () => {
    const result = findNameCollisions([
      person("a", "アリア"),
      person("b", "アリサ"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(3);
    expect(hit?.strength).toBe("medium");
  });

  test("④音数が同じで1音だけ違う", () => {
    const result = findNameCollisions([
      person("a", "マリア"),
      person("b", "サリア"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(4);
  });

  test("⑤清音化すると重なる", () => {
    // 2音が違うので①〜④には当たらない。濁点を外すと同じになる
    const result = findNameCollisions([
      person("a", "ハンソウ"),
      person("b", "バンゾウ"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(5);
    expect(hit?.reason).toContain("濁点");
  });

  test("⑥表記の先頭2文字が同じ", () => {
    const result = findNameCollisions([
      person("a", "小鳥遊隼", { reading: "たかなしはやぶさ" }),
      person("b", "小鳥丸", { reading: "こがらすまる" }),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(6);
    expect(hit?.strength).toBe("weak");
  });

  test("響きも表記も離れていれば当てない", () => {
    const result = findNameCollisions([
      person("a", "アリア"),
      person("b", "ゴンザレス"),
    ]);
    expect(pairOf(result, "a", "b")).toBeUndefined();
  });

  test("同じ組に複数の理由を重ねない", () => {
    // 「ありあ」と「ありさ」は③にも④にも当たるが、出るのは強いほうだけ
    const result = findNameCollisions([
      person("a", "アリア"),
      person("b", "アリサ"),
    ]);
    expect(
      result.collisions.filter(
        (collision) => collision.a.id === "a" && collision.b.id === "b"
      )
    ).toHaveLength(1);
  });
});

describe("姓・名を分けて見る", () => {
  test("姓どうしの一致は弱くする", () => {
    // 家族なら姓が重なって当然で、作者はそれを知っている
    const result = findNameCollisions([
      person("a", "ミナモト アリア"),
      person("b", "ミナモト ジュンイチロウ"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.strength).toBe("weak");
    expect(hit?.a.part).toBe("ミナモト");
    expect(hit?.b.part).toBe("ミナモト");
    expect(hit?.reason).toContain("姓どうし");
  });

  test("名どうしの一致は弱くしない", () => {
    const result = findNameCollisions([
      person("a", "ミナモト アリア"),
      person("b", "タカクラ アリア"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(1);
    expect(hit?.strength).toBe("strong");
    expect(hit?.a.part).toBe("アリア");
  });

  test("1文字の部分は比べない", () => {
    // 「灯」のような一字は普通名詞と重なりやすい
    const result = findNameCollisions([
      person("a", "月島 灯", { reading: "つきしまあかり" }),
      person("b", "北原 灯", { reading: "きたはらあかり" }),
    ]);
    // 部分では当たらない。当たるとすれば読み全体の規則のほうである
    expect(pairOf(result, "a", "b")?.a.part).not.toBe("灯");
  });
});

describe("見ないもの", () => {
  test("同じ人物の中では比べない", () => {
    const result = findNameCollisions([
      person("a", "ミナ", { aliases: ["ミナモト"] }),
    ]);
    expect(result.collisions).toHaveLength(0);
  });

  test("人物以外どうしは見ない", () => {
    const result = findNameCollisions([
      { id: "a", kind: "location", name: "アリア" },
      { id: "b", kind: "ability", name: "アリサ" },
    ]);
    expect(result.collisions).toHaveLength(0);
  });

  test("相手が人物以外なら強さを1段落とす", () => {
    const result = findNameCollisions([
      person("a", "アリア"),
      { id: "b", kind: "location", name: "アリサ" },
    ]);
    const hit = pairOf(result, "a", "b");
    // 人物どうしなら medium。相手が場所なので weak になる
    expect(hit?.rule).toBe(3);
    expect(hit?.strength).toBe("weak");
    expect(hit?.reason).toContain("場所");
  });
});

describe("読みが分からない名前", () => {
  test("比較せずに unreadable へ入れる", () => {
    // 黙って見たことにしない。画面で「読みが無いので見ていません」と断る
    const result = findNameCollisions([
      person("a", "月島灯"),
      person("b", "月島冬"),
    ]);
    expect(result.unreadable).toEqual([
      { id: "a", name: "月島灯" },
      { id: "b", name: "月島冬" },
    ]);
    expect(result.collisions).toHaveLength(0);
  });

  test("読みがあれば比較の相手になる", () => {
    const result = findNameCollisions([
      person("a", "月島灯", { reading: "つきしまあかり" }),
      person("b", "ツキシマアカリ"),
    ]);
    expect(result.unreadable).toHaveLength(0);
    expect(pairOf(result, "a", "b")?.rule).toBe(1);
  });
});

describe("別名も名前と同じ扱い", () => {
  test("別名と本名の衝突を拾い、どの呼び方で当たったかを残す", () => {
    const result = findNameCollisions([
      person("a", "タカクラ", { aliases: ["アリア"] }),
      person("b", "アリサ"),
    ]);
    const hit = pairOf(result, "a", "b");
    expect(hit?.rule).toBe(3);
    expect(hit?.a.part).toBe("アリア");
    expect(hit?.a.name).toBe("タカクラ");
  });
});

describe("実データに近い並び", () => {
  test("6人ぶんの当たりと外れ", () => {
    const result = findNameCollisions([
      person("mina", "ミナ"),
      person("minamoto", "ミナモト"),
      person("aria", "アリア"),
      person("arisa", "アリサ"),
      person("maria", "マリア"),
      person("saria", "サリア"),
    ]);

    expect(pairOf(result, "mina", "minamoto")?.rule).toBe(2);
    expect(pairOf(result, "aria", "arisa")?.rule).toBe(3);
    expect(pairOf(result, "aria", "maria")?.rule).toBe(4);
    expect(pairOf(result, "maria", "saria")?.rule).toBe(4);

    // 「ミナ」と「アリア」は響きが離れている。拾うと数が読めなくなる
    expect(pairOf(result, "mina", "aria")).toBeUndefined();
    // 「アリサ」と「サリア」は2音違う
    expect(pairOf(result, "arisa", "saria")).toBeUndefined();

    // 強い順に並ぶ
    expect(result.collisions[0].strength).toBe("strong");
  });
});
