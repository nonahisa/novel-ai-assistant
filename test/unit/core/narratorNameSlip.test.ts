import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  describeNarratorNameSlip,
  findNarratorNameSlips,
  narratorNameForms,
  resolveWorkNarrator,
} from "../../../src/core/narratorNameSlip";
import {
  emptyCharacter,
  parseCharacter,
  type Character,
} from "../../../src/models/character";

/**
 * 一人称の作品で、語り手の名前が地の文に三人称で出る所（2026-09-25、人称のよじれ）。
 *
 * **見逃しと誤検出の両方を見る**（CLAUDE.md の失敗2）。何も出さない実装は
 * 誤検出0で満点になるので、答え付きの台に仕込んだ1か所を必ず拾うことと、
 * 三人称の作品・台詞の中の名前・名前で呼ばれる場面で出ないことを並べて確かめる。
 */

const SEEDED = join(__dirname, "../../fixtures/seeded/contradiction");
const THIRD_PERSON = join(__dirname, "../../fixtures/seeded/proofread");

function readPeople(folder: string): Character[] {
  const dir = join(folder, "設定/characters");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      parseCharacter(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown)
    );
}

function readEpisodes(folder: string): Map<string, string> {
  const dir = join(folder, "本文");
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    out.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

function person(options: {
  id: string;
  name: string;
  firstPerson?: string | null;
  aliases?: string[];
}): Character {
  return {
    ...emptyCharacter(options.id, options.name),
    aliases: options.aliases ?? [],
    firstPerson: { default: options.firstPerson ?? null, variants: [] },
  };
}

const HARUTO = person({
  id: "char_001",
  name: "相沢 春人",
  firstPerson: "俺",
  aliases: ["春人", "兄貴"],
});
const CHINATSU = person({
  id: "char_002",
  name: "黒瀬 千夏",
  firstPerson: "私",
  aliases: ["千夏"],
});
const NARRATOR = { firstPerson: "俺", name: "相沢 春人" };

/** 「俺」で語る地の文（1行に1回「俺」）。一人称の数を揃えるために使う */
function ore(times: number): string {
  return Array.from(
    { length: times },
    (_, index) => `　俺は坂の途中で足を止め、空を見上げた。${index}`
  ).join("\n");
}

describe("答え付きの台（seeded/contradiction）", () => {
  const people = readPeople(SEEDED);
  const episodes = readEpisodes(SEEDED);
  const workText = [...episodes.values()].join("\n");

  test("作品全体から、語り手を相沢 春人（俺）と決める", () => {
    expect(resolveWorkNarrator(workText, people)).toEqual(NARRATOR);
  });

  test("仕込み A（18行「相沢は損をした」）を拾い、「俺は」を修正案にする", () => {
    const first = episodes.get("001_九月の終わりの坂.txt") ?? "";
    const seeded = first.replace(
      "　最初にそれを聞いたとき、俺は損をしたのだと思った。",
      "　最初にそれを聞いたとき、相沢は損をしたのだと思った。"
    );
    expect(seeded).not.toBe(first);
    const narrator = resolveWorkNarrator(workText, people);
    expect(narrator).not.toBeNull();
    const found = findNarratorNameSlips({ text: seeded, narrator: narrator!, people });
    expect(found.skipped).toBeUndefined();
    expect(found.slips).toHaveLength(1);
    expect(found.slips[0]).toMatchObject({
      line: 18,
      original: "相沢は",
      suggestion: "俺は",
      nameForm: "相沢",
    });
    expect(describeNarratorNameSlip(found.slips[0])).toContain("相沢は");
    // 視点の札には、いつも「わざとなら」の断りを添える（夢や回想でわざと書くことがある）
    expect(describeNarratorNameSlip(found.slips[0])).toContain(
      "（わざとなら、このままで構いません）"
    );
  });

  test("仕込みの無い5話では1件も出さない（「相沢くん」と呼ばれる台詞がある）", () => {
    const narrator = resolveWorkNarrator(workText, people)!;
    for (const [name, text] of episodes) {
      const found = findNarratorNameSlips({ text, narrator, people });
      expect({ name, slips: found.slips }).toEqual({ name, slips: [] });
    }
  });
});

describe("三人称の作品では出さない", () => {
  test("台（seeded/proofread、海斗の三人称）は語り手が決まらない", () => {
    const people = readPeople(THIRD_PERSON);
    const text = [...readEpisodes(THIRD_PERSON).values()].join("\n");
    expect(resolveWorkNarrator(text, people)).toBeNull();
  });

  test("地の文に名前が主語で並ぶ三人称では、人物に一人称が登録されていても決まらない", () => {
    const text = Array.from(
      { length: 20 },
      (_, index) =>
        `　春人は坂の途中で足を止め、空を見上げた。「俺は行くよ」と言った。${index}`
    ).join("\n");
    expect(resolveWorkNarrator(text, [HARUTO, CHINATSU])).toBeNull();
  });

  test("三人称の地の文に心の声の「俺」が混じる書き方は、多すぎるので黙る", () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `　春人は足を止めた。俺はどうすればいい。${index}`
    ).join("\n");
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found).toEqual({ slips: [], skipped: "too_many" });
  });
});

describe("台詞と呼ばれ方", () => {
  test("台詞の中の名前は拾わない", () => {
    const text = `${ore(6)}\n「相沢は来ないのか」\n『相沢が来た』と書いてあった。`;
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips).toEqual([]);
  });

  test("名前で呼ばれる場面（敬称つき）は拾わない", () => {
    const text =
      `${ore(6)}\n　千夏は俺を相沢くんと呼ぶ。蓬田さんは春人さんが、と言いかけた。\n` +
      "　相沢さんのところの息子だろう、と老人は言った。";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips).toEqual([]);
  });

  test("括弧を付けずに言葉を引いた形（「相沢は、と」）は拾わない", () => {
    const text = `${ore(6)}\n　課長は、相沢は、と言いかけて口をつぐんだ。`;
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips).toEqual([]);
  });

  test("実測の誤検出①：台詞の中の『』で台詞が閉じたと見ない（入れ子のかぎ）", () => {
    // 2026-09-25 の測定（教科書チート18話49行）と同じ形。父の台詞の中に
    // 『地名』があり、その後ろの「相沢は」を地の文として拾っていた
    const text =
      `${ore(6)}\n` +
      "「俺が『死の谷』の奥地に行っている間、相沢は体調が戻るまで家にいなさい」";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips).toEqual([]);
  });

  test("『』だけの台詞・台詞の中の『』が閉じたあとの地の文は、地の文として見る", () => {
    const text =
      `${ore(6)}\n` +
      "『相沢は来ないのか』と手紙にあった。\n" +
      "「『谷』だ」と父は言い、相沢は黙った。";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips.map((slip) => [slip.line, slip.original])).toEqual([
      [8, "相沢は"],
    ]);
  });

  test("閉じ忘れの台詞は、次の台詞の始まりまでを台詞と見る（その先は地の文）", () => {
    const text =
      `${ore(6)}\n` +
      "「相沢は来ないのか\n" +
      "「来ない」\n" +
      "　相沢は黙った。";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips.map((slip) => slip.line)).toEqual([9]);
  });

  test("同じ行の台詞にも同じ形があるなら、修正案は空にする（台詞の側が書き換わる）", () => {
    const text = `${ore(6)}\n「相沢は？」と訊かれて、相沢は黙った。`;
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips).toHaveLength(1);
    expect(found.slips[0]).toMatchObject({ line: 7, original: "相沢は", suggestion: "" });
  });
});

describe("名前の形", () => {
  test("正式名称・詰めた形・各部分・名前の一部の別名。あだ名と1字は見ない", () => {
    expect(narratorNameForms(NARRATOR, [HARUTO, CHINATSU])).toEqual([
      "相沢 春人",
      "相沢春人",
      "相沢",
      "春人",
    ]);
  });

  test("ほかの人物と同じ苗字は見ない（どちらの話か決められない）", () => {
    const sister = person({ id: "char_003", name: "相沢 美咲", firstPerson: "私" });
    expect(narratorNameForms(NARRATOR, [HARUTO, sister])).toEqual([
      "相沢 春人",
      "相沢春人",
      "春人",
    ]);
  });

  test("正式名称で書いても、下の名前だけで書いても拾う。前に字が付いた別の語は拾わない", () => {
    const text =
      `${ore(10)}\n　相沢春人が改札を抜けた。\n　春人も後を追った。\n` +
      "　千春人形が棚に並んでいた。";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips.map((slip) => [slip.line, slip.original])).toEqual([
      [11, "相沢春人が"],
      [12, "春人も"],
    ]);
  });

  test("ルビをまたいで拾う。地名の「相沢が丘」は拾わない", () => {
    const text = `${ore(6)}\n　|相沢《あいざわ》は笑った。\n　相沢が丘の駅で降りた。`;
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips.map((slip) => slip.original)).toEqual(["|相沢《あいざわ》は"]);
  });
});

describe("その話の語り手", () => {
  test("多視点の作品で、別の人物の一人称の章に出る名前は拾わない", () => {
    const chinatsuChapter = Array.from(
      { length: 8 },
      (_, index) => `　私は窓口で伝票を数えた。春人は今日も坂を上っている。${index}`
    ).join("\n");
    const found = findNarratorNameSlips({
      text: chinatsuChapter,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found).toEqual({ slips: [], skipped: "not_narrator_episode" });
  });

  test("実測の誤検出②：場面の区切り（◆◇◆◇）の後の三人称の場面では拾わない", () => {
    // 2026-09-25 の測定（教科書チート127話131行）と同じ形。一人称の話の後半に
    // 区切りを挟んで宰相と国王の三人称の場面があり、そこの名前を拾っていた
    const text =
      `${ore(10)}\n\n◆◇◆◇\n\n` +
      "　宰相は書類を国王の前に置いた。\n" +
      "　相沢が学院に入ったという報せだった。\n" +
      "　国王は黙って頷いた。";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips).toEqual([]);
  });

  test("区切りの前後どちらでも、一人称の場面のよじれは拾う", () => {
    const text =
      `${ore(6)}\n　相沢は坂を見上げた。\n` +
      "＊＊＊\n" +
      "　宰相は書類を置いた。相沢が来たという。\n" +
      "◇\n" +
      `${ore(6)}\n　相沢は笑った。`;
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips.map((slip) => slip.line)).toEqual([7, 17]);
  });

  test("話のどの場面も語り手の一人称でなければ not_narrator_episode", () => {
    const text =
      "　宰相は書類を置いた。相沢が来たという。\n" +
      "◆◇◆◇\n" +
      "　国王は頷いた。相沢は若い。";
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found).toEqual({ slips: [], skipped: "not_narrator_episode" });
  });

  test("シーンメモの行は見ないが、行番号はずらさない", () => {
    const text = `${ore(6)}\n// 相沢は、ここで迷う\n　相沢は迷った。`;
    const found = findNarratorNameSlips({
      text,
      narrator: NARRATOR,
      people: [HARUTO, CHINATSU],
    });
    expect(found.slips.map((slip) => slip.line)).toEqual([8]);
  });
});
