import { describe, expect, it } from "vitest";
import { emptyCharacter, type Character } from "../../../src/models/character";
import {
  buildFutureFacts,
  describeFutureKnownAt,
  lookupFutureKnownAt,
} from "../../../src/core/contradictionFutureFacts";
import { contradictionVerifyPromptVersion } from "../../../src/core/contradictionAssembly";
import { parseVerifyOutcome } from "../../../src/core/contradictionVerifyValidation";

/**
 * 「あとで判明する事実」の一覧と、そこから来た指摘の「この設定が分かる話」
 * （P-12b 1.3、作者の裁定 2026-10-19 夜「C」）。
 *
 * 測定の台（ff-bench）と同じ人物：ミナ（第4話で「三ヶ月前に退学」）・瀬戸（第5話で
 * 「元刑事」）・渚（第6話で「絵筆を折った」、別名「叔母さん」）。
 */
function person(
  id: string,
  name: string,
  summary: string,
  changes: Array<{ value: string; chapter: number }>,
  aliases: string[] = []
): Character {
  return {
    ...emptyCharacter(id, name),
    aliases,
    summary,
    changes: changes.map((change) => ({
      field: "summary",
      value: change.value,
      chapters: [change.chapter],
      timepointId: null,
      note: null,
      evidence: null,
      source: "author" as const,
    })),
  } as Character;
}

const MINA_LATER = "十七歳の少女。三ヶ月前に高校を退学している。昼間は瀬戸書房に通い、画集を読んでいる。渚の姪。";
const SETO_LATER = "古書店「瀬戸書房」の店主。五十代の男。元刑事で、二十年勤めて退職し、古書店を営んでいる。";
const NAGISA_LATER = "ミナの叔母。三十代の女性。駅前のアトリエに一人で住んでいる。十年前に絵筆を折り、画家をやめている。";

const mina = person("c1", "ミナ", MINA_LATER, [
  { value: "十七歳の少女。瀬戸書房に通い、画集を読んでいる。渚の姪。", chapter: 1 },
  { value: MINA_LATER, chapter: 4 },
]);
const seto = person("c2", "瀬戸", SETO_LATER, [
  { value: "古書店「瀬戸書房」の店主。五十代の男。", chapter: 1 },
  { value: SETO_LATER, chapter: 5 },
]);
const nagisa = person(
  "c3",
  "渚",
  NAGISA_LATER,
  [
    { value: "ミナの叔母。三十代の女性。駅前のアトリエに一人で住んでいる。", chapter: 2 },
    { value: NAGISA_LATER, chapter: 6 },
  ],
  ["叔母さん"]
);

describe("事実の一覧（buildFutureFacts）", () => {
  it("文面は直す前と同じ書式で、一覧は文面の行と対になる", () => {
    const list = buildFutureFacts([seto, mina, seto], 2);
    expect(list.text).toBe(
      [
        `瀬戸の紹介（第5話で判明）: ${SETO_LATER}`,
        `ミナの紹介（第4話で判明）: ${MINA_LATER}`,
      ].join("\n")
    );
    expect(list.facts.map((fact) => [fact.owner, fact.label, fact.chapter])).toEqual([
      ["瀬戸", "紹介", 5],
      ["ミナ", "紹介", 4],
    ]);
  });

  it("話数の分からない本文では空", () => {
    expect(buildFutureFacts([mina], null)).toEqual({ text: "", facts: [] });
  });
});

describe("future の指摘の話数（lookupFutureKnownAt）", () => {
  const atChapter2 = buildFutureFacts([seto, mina, nagisa], 2).facts;
  const atChapter3 = buildFutureFacts([mina, nagisa, seto], 3).facts;

  it("e4b の T1：頭に「あとの話で判明する事実：」が付いても、書き写された（第4話で判明）から引く", () => {
    const says = `あとの話で判明する事実：ミナの紹介（第4話で判明）: ${MINA_LATER}`;
    expect(describeFutureKnownAt({ settingSays: says, note: "" }, atChapter3)).toBe("第4話");
  });

  it("全角の数字で書き写されても読む", () => {
    expect(
      lookupFutureKnownAt({ settingSays: "ミナの紹介（第４話で判明）: 退学", note: "" }, atChapter3)
    ).toEqual([4]);
  });

  it("settingSays に無ければ note から引く", () => {
    expect(
      lookupFutureKnownAt(
        { settingSays: "三ヶ月前に退学している", note: "第4話で判明する事実と食い違う" },
        atChapter3
      )
    ).toEqual([4]);
  });

  it("26b の S1：言い換えた「瀬戸は元刑事で、…」は、名前で1件に絞って第5話", () => {
    expect(
      describeFutureKnownAt(
        { settingSays: "瀬戸は元刑事で、二十年勤めて退職している。", note: "" },
        atChapter2,
        { chapterStart: 2, chapterEnd: 2, alsoText: "警察や役所とは一生縁がないね" }
      )
    ).toBe("第5話");
  });

  it("値をそのまま写した文は、一覧の値から引く（名前が無くても）", () => {
    expect(lookupFutureKnownAt({ settingSays: NAGISA_LATER, note: "" }, atChapter2)).toEqual([6]);
  });

  it("1字の名前（渚）と別名（叔母さん）でも絞る", () => {
    expect(
      lookupFutureKnownAt({ settingSays: "渚は絵をやめている", note: "" }, atChapter2)
    ).toEqual([6]);
    expect(
      lookupFutureKnownAt({ settingSays: "叔母さんは絵をやめている", note: "" }, atChapter2)
    ).toEqual([6]);
  });

  it("文に名前が無ければ、引用・本文の欄の名前で絞る", () => {
    expect(
      lookupFutureKnownAt({ settingSays: "元刑事で退職している", note: "" }, atChapter2, {
        chapterStart: 2,
        chapterEnd: 2,
        alsoText: "瀬戸はそう言って",
      })
    ).toEqual([5]);
  });

  it("決められなければ空（名前が無い・複数の人に当たる）", () => {
    expect(lookupFutureKnownAt({ settingSays: "毎日外出している", note: "" }, atChapter2)).toEqual([]);
    expect(
      lookupFutureKnownAt({ settingSays: "瀬戸もミナも隠しごとがある", note: "" }, atChapter2)
    ).toEqual([]);
    expect(lookupFutureKnownAt({ settingSays: "瀬戸は元刑事", note: "" }, [])).toEqual([]);
  });
});

/**
 * 控えの鍵。本命（settled）は直す前の文字列と同じ（作者のクラウドAIの確かめの控えを
 * 作り直さない）。future だけ別の版と印を付ける（文面が違う）
 */
describe("確かめの段の控えの鍵", () => {
  it("本命は 1.2 のときと同じ文字列", () => {
    expect(contradictionVerifyPromptVersion(false, "fp")).toBe("1.2:fp");
    expect(contradictionVerifyPromptVersion(true, "fp")).toBe("1.2:strict:fp");
    expect(contradictionVerifyPromptVersion(false, "fp", "settled")).toBe("1.2:fp");
    expect(contradictionVerifyPromptVersion(true, "fp", "settled")).toBe("1.2:strict:fp");
  });

  it("future は 1.3 と future: の印", () => {
    expect(contradictionVerifyPromptVersion(false, "fp", "future")).toBe("1.3:future:fp");
    expect(contradictionVerifyPromptVersion(true, "fp", "future")).toBe("1.3:strict:future:fp");
  });
});

/**
 * 指示語はそのまま答えに返ってくる（CLAUDE.md 失敗3）。future の新しい文言が却下の
 * 理由として読まれないこと、外した「まだ明かされていない」を返してきたら今の扱い
 * （決められた語として却下）のままであることを固定する
 */
describe("future の答えの読み方（parseVerifyOutcome は変えていない）", () => {
  const reply = (reason: string, explanation = "説明") =>
    JSON.stringify({ verdict: "却下", reason, explanation, confidence: "high" });

  it("外した「まだ明かされていない」を返してきたら、決められた語として却下する", () => {
    const outcome = parseVerifyOutcome(reply("まだ明かされていない"));
    expect(outcome.keep).toBe(false);
    expect(outcome.reason).toBe("まだ明かされていない");
  });

  it("future の「作中の変化」の説明を理由の欄へ写してきたら、理由と読まず通す", () => {
    const outcome = parseVerifyOutcome(
      reply("作中の変化 … 判明した事実が、対象の話の時点より後に起きた変化と読める場合だけ")
    );
    expect(outcome.keep).toBe(true);
    expect(outcome.undecided).toBe(true);
  });

  it("出どころの一文を理由の欄へ写してきたら、理由と読まず通す", () => {
    const outcome = parseVerifyOutcome(
      reply("この指摘は、あとの話で判明する事実との照合から来たものです。")
    );
    expect(outcome.keep).toBe(true);
    expect(outcome.undecided).toBe(true);
  });

  it("理由が「作中の変化」そのものなら、これまでどおり却下", () => {
    const outcome = parseVerifyOutcome(reply("作中の変化", "作中の変化には当たりません"));
    expect(outcome.keep).toBe(false);
    expect(outcome.reason).toBe("作中の変化");
  });
});
