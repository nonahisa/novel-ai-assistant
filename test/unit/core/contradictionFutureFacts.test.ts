import { describe, expect, it } from "vitest";
import { emptyCharacter, type Character } from "../../../src/models/character";
import {
  buildFutureFacts,
  describeFutureKnownAt,
  futureFactLinesForIssue,
  lookupFutureKnownAt,
  selectFutureFactsForIssue,
} from "../../../src/core/contradictionFutureFacts";
import {
  buildContradictionVerifyUserPrompt,
  contradictionVerifyPromptVersion,
} from "../../../src/core/contradictionAssembly";
import type { Chunk } from "../../../src/core/chunker";
import type { AcceptedContradiction } from "../../../src/core/contradictionValidation";
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

  it("future は 1.4 と future: の印（1.4 で事実の文を渡すようにした）", () => {
    expect(contradictionVerifyPromptVersion(false, "fp", "future")).toBe("1.4:future:fp");
    expect(contradictionVerifyPromptVersion(true, "fp", "future")).toBe("1.4:strict:future:fp");
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

/**
 * **確かめの段へ、照らしたあとの話の事実の文そのものを渡す**（作者の裁定「事実の文を
 * 渡す」、2026-10-23。P-12b 1.4）。
 *
 * 作り物の台Bで、26b は検出の段で「宗一はこの町で生まれ、七十八年間、一度も町の外で
 * 暮らしたことがない。」と第5話の事実「四十歳まで東京で中学の教師をしていた」の
 * 食い違いを拾ったのに、settingSays には「宗一は七十八歳である。」と書いた。
 * 確かめの段には事実の文が渡らず、「78年間外で暮らしていないと78歳は両立する」で
 * 消えた。**AI の書いた文に頼らず、コードが特定した事実の文を渡す。**
 */
describe("確かめの段へ渡す、照らした事実の文（selectFutureFactsForIssue）", () => {
  const SOICHI_LATER = "七十八歳の老人。四十歳まで東京で中学の教師をしていた。";
  const soichi = person("c4", "宗一", SOICHI_LATER, [
    { value: "七十八歳の老人。町の古い家に一人で住んでいる。", chapter: 1 },
    { value: SOICHI_LATER, chapter: 5 },
  ]);
  const facts = buildFutureFacts([soichi, seto], 2).facts;
  const issue = {
    excerpt: "宗一はこの町で生まれ、七十八年間、一度も町の外で暮らしたことがない。",
    settingSays: "宗一は七十八歳である。",
    textSays: "七十八年間、一度も町の外で暮らしたことがない",
    note: "第5話で判明する、四十歳まで東京で教師をしていたことと食い違う",
  };
  const scope = { chapterStart: 2, chapterEnd: 2, alsoText: `${issue.excerpt}\n${issue.textSays}` };

  it("台Bの宗一：settingSays が事実と違う文でも、名前と話数から第5話の事実の文を選ぶ", () => {
    expect(futureFactLinesForIssue(issue, facts, scope)).toEqual([
      `宗一の紹介（第5話で判明）: ${SOICHI_LATER}`,
    ]);
  });

  it("文の書式は検出の段へ送った一覧の行と同じ", () => {
    const list = buildFutureFacts([soichi, seto], 2);
    for (const line of futureFactLinesForIssue(issue, facts, scope)) {
      expect(list.text.split("\n")).toContain(line);
    }
  });

  it("名前が文に無くても、引用・本文の欄の名前で絞る", () => {
    expect(
      selectFutureFactsForIssue({ ...issue, settingSays: "七十八歳である", note: "" }, facts, scope).map(
        (fact) => fact.owner
      )
    ).toEqual(["宗一"]);
  });

  it("どこにも名前が無く話数も決められなければ、検出の段へ渡した一覧をそのまま渡す（空にしない）", () => {
    const none = selectFutureFactsForIssue(
      { excerpt: "", settingSays: "毎日外出している", textSays: "", note: "" },
      facts
    );
    expect(none).toEqual(facts);
  });

  it("一覧が空なら空", () => {
    expect(selectFutureFactsForIssue(issue, [], scope)).toEqual([]);
  });
});

describe("確かめの頼み（buildContradictionVerifyUserPrompt）へ、事実の文と補足が渡る", () => {
  const SOICHI_LATER = "七十八歳の老人。四十歳まで東京で中学の教師をしていた。";
  const soichi = person("c4", "宗一", SOICHI_LATER, [
    { value: "七十八歳の老人。町の古い家に一人で住んでいる。", chapter: 1 },
    { value: SOICHI_LATER, chapter: 5 },
  ]);
  const text = "宗一はこの町で生まれ、七十八年間、一度も町の外で暮らしたことがない。";
  const chunk = {
    filePath: "第2話.txt",
    hash: "h",
    text,
    index: 0,
    startLine: 0,
    chapterStart: 2,
    chapterEnd: 2,
  } as unknown as Chunk;
  const issue = {
    line: 1,
    excerpt: text,
    settingSays: "宗一は七十八歳である。",
    textSays: "七十八年間、一度も町の外で暮らしたことがない",
    category: "人物",
    note: "第5話で判明する、四十歳まで東京で教師をしていたことと食い違う",
    confidence: "high",
  } as unknown as AcceptedContradiction;

  it("future で事実の一覧を渡すと、照らした事実の欄と補足の欄が入る", () => {
    const prompt = buildContradictionVerifyUserPrompt({
      chapterLabel: "第2話",
      chunk,
      issue,
      settingKnownAt: "第5話",
      source: "future",
      futureFacts: buildFutureFacts([soichi], 2).facts,
    });
    expect(prompt).toContain("【照らした事実（あとの話で判明）】");
    expect(prompt).toContain(`- 宗一の紹介（第5話で判明）: ${SOICHI_LATER}`);
    expect(prompt).toContain("【検出の段の補足（AIが書いた文。参考）】");
    expect(prompt).toContain(issue.note);
    // 事実の文が補足より上にある
    expect(prompt.indexOf("【照らした事実")).toBeLessThan(prompt.indexOf("【検出の段の補足"));
  });

  it("本命（settled）では、事実の一覧を渡しても欄を足さない", () => {
    const prompt = buildContradictionVerifyUserPrompt({
      chapterLabel: "第2話",
      chunk,
      issue,
      settingKnownAt: "",
      futureFacts: buildFutureFacts([soichi], 2).facts,
    });
    expect(prompt).not.toContain("【照らした事実");
    expect(prompt).not.toContain("【検出の段の補足");
  });
});
