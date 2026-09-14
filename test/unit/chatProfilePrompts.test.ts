import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import type * as vscode from "vscode";
import {
  buildWriterStylePrompt,
  WRITER_PLAN_PROMPTS,
  WRITER_REVISE_PROMPTS,
} from "../../src/prompts/writerStyle";
import {
  parseWorkChatAnswer,
  WORK_CHAT_SCHEMA,
} from "../../src/prompts/workChat";
import {
  buildReaderTypePrompt,
  READER_TYPE_PROMPTS,
} from "../../src/prompts/readerTarget";
import { buildAdvicePolicyPrompt } from "../../src/prompts/advicePolicy";
import {
  applyWriterStyleSignals,
  describeWriterStyleChange,
  parseWriterStyleSignals,
  WRITER_PLAN_TYPES,
  WRITER_REVISE_LABELS,
  WRITER_REVISE_STREAK_NEEDED,
  writerStyleChatLogLines,
  writerStyleUpdateLogLine,
  type WriterPlanType,
  type WriterReviseTiming,
  type WriterStyle,
} from "../../src/core/writerStyle";
import {
  WriterProfileStore,
  WRITER_PROFILE_KEY,
  type WriterProfile,
} from "../../src/core/writerProfileStore";
import {
  chatReaderBasis,
  READER_TYPES,
  readerTypeChatLogLines,
  resolveReaderType,
} from "../../src/core/readerTarget";
import {
  emptyReaderProfile,
  type ReaderProfile,
  type ReaderScores,
} from "../../src/models/readerProfile";
import type { AdviceProfile } from "../../src/core/advicePolicy";

/**
 * 診断した結果を、相談の指示へ渡す道（設計書6.86・6.90.1・6.91.9）。
 *
 * 相談のシステムプロンプトへ足すのは3つで、**どれも該当する文章1つだけ**。
 *
 * | 足すもの | 見出し |
 * |---|---|
 * | 助言方針（6.86） | `【この作者への助言の方針】`＋`【タイプ】` |
 * | 執筆スタイル（6.90） | `【この作者の書き方】` |
 * | ターゲット読者（6.91） | `【この作品の読者】` |
 *
 * ここで守るのは4つ。
 *
 * 1. **1軸につき1つだけ送ること**（節約と、他の記述に引きずられないため）
 * 2. **各文章が独立していること**（ほかのタイプの名前を含まない）
 * 3. **値踏みをしないこと**（段取りにも読者層にも良し悪しは無い）
 * 4. **診断していなくても相談が止まらないこと**
 */

const DIAGNOSED_AT = "2026-09-13T02:00:00.000Z";

function writerProfile(
  plan: WriterPlanType,
  revise: WriterReviseTiming
): WriterProfile {
  const style: WriterStyle = {
    situation: "have_files",
    plan,
    revise,
    // **渡さないと決めた2軸**（S3・S4）。どの値でも送る文章は変わらない
    material: "memo",
    outlet: "serial",
  };
  return { style, updatedAt: DIAGNOSED_AT };
}

function scores(
  familiarity: number,
  posture: number,
  craving: number
): ReaderScores {
  return { familiarity, posture, craving };
}

function declaredProfile(value: ReaderScores): ReaderProfile {
  return {
    ...emptyReaderProfile(),
    declared: { scores: value, answers: [], updatedAt: DIAGNOSED_AT },
  };
}

function actualProfile(value: ReaderScores): ReaderProfile {
  return {
    ...emptyReaderProfile(),
    actual: {
      scores: value,
      evidence: [],
      basis: "第1〜3話",
      model: "gemma4:e4b",
      updatedAt: DIAGNOSED_AT,
    },
  };
}

/** 全9通り（段取り3×直す時期3） */
function allWriterProfiles(): WriterProfile[] {
  const plans: WriterPlanType[] = ["designer", "hybrid", "improviser"];
  const timings: WriterReviseTiming[] = ["inline", "per_episode", "after_all"];
  return plans.flatMap((plan) => timings.map((revise) => writerProfile(plan, revise)));
}

describe("送るのは、該当する文章だけ（執筆スタイル）", () => {
  test("段取りの文章がちょうど1つ、直す時期の文章がちょうど1つ入る", () => {
    for (const profile of allWriterProfiles()) {
      const text = buildWriterStylePrompt(profile);
      const plans = Object.values(WRITER_PLAN_PROMPTS).filter((body) =>
        text.includes(body)
      );
      const timings = Object.values(WRITER_REVISE_PROMPTS).filter((body) =>
        text.includes(body)
      );
      const label = `${profile.style.plan}/${profile.style.revise}`;
      expect(plans, label).toEqual([WRITER_PLAN_PROMPTS[profile.style.plan]]);
      expect(timings, label).toEqual([
        WRITER_REVISE_PROMPTS[profile.style.revise],
      ]);
    }
  });

  test("渡さないと決めた2軸（資料の置き場・出し先）は文章に出ない", () => {
    // 作者の裁定（2026-09-14）：S3・S4 は案内だけに使い、相談へは渡さない。
    // S4 はターゲット読者診断と中身が重なるためである
    const all = [
      ...Object.values(WRITER_PLAN_PROMPTS),
      ...Object.values(WRITER_REVISE_PROMPTS),
    ].join("\n");
    for (const word of ["メモに書いている", "資料にまとめている", "頭の中", "公募", "投稿サイト"]) {
      expect(all.includes(word), word).toBe(false);
    }
  });

  test("診断した日を書く／読めない日付でも作れる", () => {
    expect(buildWriterStylePrompt(writerProfile("hybrid", "inline"))).toContain(
      "2026-09-13"
    );
    const broken: WriterProfile = {
      ...writerProfile("hybrid", "inline"),
      updatedAt: "",
    };
    expect(buildWriterStylePrompt(broken)).toContain("診断日は不明");
  });
});

describe("送るのは、該当する文章だけ（ターゲット読者）", () => {
  test("11タイプのうち、ちょうど1つだけ入る", () => {
    // 宣言の点数がどこにあっても、入るのは1つ
    for (const value of [
      scores(6, 6, 6),
      scores(0, 0, 0),
      scores(3, 3, 3),
      scores(6, 0, 2),
      scores(1, 5, 4),
    ]) {
      const text = buildReaderTypePrompt(declaredProfile(value)) ?? "";
      const included = Object.values(READER_TYPE_PROMPTS).filter((body) =>
        text.includes(body)
      );
      expect(included, JSON.stringify(value)).toEqual([
        READER_TYPE_PROMPTS[resolveReaderType(value)],
      ]);
    }
  });

  test("**宣言を優先する**（実像しか無ければ実像を使う）", () => {
    // 助言は作者が向かおうとしている先へ添える。書けているものが
    // たまたま届いた先へ寄せると、ズレのほうを固定してしまう
    const both: ReaderProfile = {
      ...declaredProfile(scores(0, 0, 0)),
      ...actualProfile(scores(6, 6, 6)),
      declared: declaredProfile(scores(0, 0, 0)).declared,
    };
    expect(chatReaderBasis(both)?.source).toBe("declared");
    expect(buildReaderTypePrompt(both)).toContain(
      READER_TYPE_PROMPTS[resolveReaderType(scores(0, 0, 0))]
    );

    const onlyActual = actualProfile(scores(6, 6, 6));
    expect(chatReaderBasis(onlyActual)?.source).toBe("actual");
    expect(buildReaderTypePrompt(onlyActual)).toContain(
      READER_TYPE_PROMPTS[resolveReaderType(scores(6, 6, 6))]
    );
  });

  test("実像を使うときは「読み違えていることがある」と断る", () => {
    // 宣言は作者の答えだが、実像はAIの読み取りである。断らないと
    // AIが「動かせない前提」として扱う
    const text = buildReaderTypePrompt(actualProfile(scores(5, 5, 5))) ?? "";
    expect(text).toContain("読み違えていることがあります");
    expect(buildReaderTypePrompt(declaredProfile(scores(5, 5, 5)))).not.toContain(
      "読み違えていることがあります"
    );
  });
});

describe("プロンプトを共有していない", () => {
  /*
    **確かめる相手は、同じときに送られる文章どうしに絞る。**

    執筆スタイルは段取りと直す時期を一緒に送るので、2軸をまたいで見る。
    読者タイプは1つしか送らないので、11タイプのあいだだけを見る。

    **家をまたいだ照合はしない。** 読者タイプの「常連層」には
    「1話ごとの完成度より…」という一文があり、これは直す時期の呼び名とは
    別の話である。機械に見分けられないものを禁じると、書ける文章のほうが
    痩せる。
  */
  const WRITER_LABELS = [
    ...Object.values(WRITER_PLAN_TYPES).map((info) => info.label),
    ...Object.values(WRITER_REVISE_LABELS),
  ];

  test("執筆スタイルの6つの文章が、すべて違う", () => {
    const texts = [
      ...Object.values(WRITER_PLAN_PROMPTS),
      ...Object.values(WRITER_REVISE_PROMPTS),
    ];
    expect(texts).toHaveLength(6);
    expect(new Set(texts).size).toBe(6);
  });

  test("執筆スタイルの各文章に、ほかの書き方の呼び名が出てこない", () => {
    const own: Record<string, string> = {
      designer: WRITER_PLAN_TYPES.designer.label,
      hybrid: WRITER_PLAN_TYPES.hybrid.label,
      improviser: WRITER_PLAN_TYPES.improviser.label,
      inline: WRITER_REVISE_LABELS.inline,
      per_episode: WRITER_REVISE_LABELS.per_episode,
      after_all: WRITER_REVISE_LABELS.after_all,
    };
    const leaks: string[] = [];
    for (const [id, body] of Object.entries({
      ...WRITER_PLAN_PROMPTS,
      ...WRITER_REVISE_PROMPTS,
    })) {
      for (const label of WRITER_LABELS) {
        if (label === own[id]) continue;
        if (body.includes(label)) leaks.push(`${id} に ${label}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("読者タイプの各文章に、ほかのタイプの名前が出てこない", () => {
    const leaks: string[] = [];
    for (const [id, body] of Object.entries(READER_TYPE_PROMPTS)) {
      for (const [other, info] of Object.entries(READER_TYPES)) {
        if (other === id) continue;
        if (body.includes(info.label)) leaks.push(`${id} に ${info.label}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe("値踏みをしない", () => {
  /*
    設計書6.90.1「点数にしないのは、やり方に良し悪しが無いからである」。
    段取りに上下は無く、読者層にも上下は無い。`writerStyle.test.ts` が
    診断の言い返しで見張っているのと同じ言葉を、相談へ渡す文章でも見張る。
  */
  const JUDGING = ["できていません", "足りません", "べきです", "問題"];

  test("執筆スタイルの文章が、品定めに読めない", () => {
    for (const [id, body] of Object.entries({
      ...WRITER_PLAN_PROMPTS,
      ...WRITER_REVISE_PROMPTS,
    })) {
      for (const word of JUDGING) {
        expect(body.includes(word), `${id}：${word}`).toBe(false);
      }
    }
  });

  test("読者タイプの文章が、作品への値踏みに読めない", () => {
    for (const [id, body] of Object.entries(READER_TYPE_PROMPTS)) {
      for (const word of JUDGING) {
        expect(body.includes(word), `${id}：${word}`).toBe(false);
      }
    }
  });

  test("前置きで「良し悪しの話ではない」と断る", () => {
    expect(buildWriterStylePrompt(writerProfile("improviser", "after_all"))).toContain(
      "良し悪しの話ではありません"
    );
    expect(buildReaderTypePrompt(declaredProfile(scores(3, 3, 3)))).toContain(
      "良し悪しの話にしないでください"
    );
  });
});

describe("診断していなければ、何も足さない（相談は止めない）", () => {
  test("読者像の台帳が無ければ undefined", () => {
    expect(buildReaderTypePrompt(undefined)).toBeUndefined();
  });

  test("台帳はあるが、宣言も実像も入っていなければ undefined", () => {
    expect(buildReaderTypePrompt(emptyReaderProfile())).toBeUndefined();
    expect(chatReaderBasis(emptyReaderProfile())).toBeUndefined();
  });

  test("**読めなかった台帳は、相談を止めずに諦める**", () => {
    /*
      台帳が壊れていると `ReaderTargetStore.load()` は投げる（作者が手で
      直すファイルなので、こちらの解釈で直さない）。相談はそこで止まって
      はいけない——**これまでどおりの相談になるだけ**である。

      実際に投げさせるには VS Code のファイル層が要るので、ここでは
      **受け口が握って記録するだけ**になっていることを原文で確かめる。
    */
    const source = fs.readFileSync("src/features/workChatPanel.ts", "utf-8");
    const at = source.indexOf("private async readerProfileFor(");
    expect(at, "readerProfileFor が無い").toBeGreaterThanOrEqual(0);
    const body = source.slice(at, source.indexOf("\n  }", at));
    expect(body).toContain("catch (error)");
    expect(body).toContain("logFailure(");
    // 投げ直したら相談が止まる
    expect(body).not.toContain("throw");
  });

  test("執筆スタイルを診断していなければ、記録も出ない", () => {
    expect(writerStyleChatLogLines(undefined)).toEqual([]);
    expect(readerTypeChatLogLines(undefined)).toEqual([]);
    expect(readerTypeChatLogLines(emptyReaderProfile())).toEqual([]);
  });
});

describe("3つの見出しで見分けられる", () => {
  const advice: AdviceProfile = {
    scores: { reader: 6, self: 0, taste: 0 },
    answers: [],
    updatedAt: DIAGNOSED_AT,
  };

  test("助言方針・執筆スタイル・読者タイプが、別々の見出しを持つ", () => {
    const policy = buildAdvicePolicyPrompt(advice, new Date(DIAGNOSED_AT));
    const style = buildWriterStylePrompt(writerProfile("designer", "inline"));
    const reader = buildReaderTypePrompt(declaredProfile(scores(6, 6, 6))) ?? "";

    expect(policy).toContain("【タイプ】");
    expect(style).toContain("【この作者の書き方】");
    expect(reader).toContain("【この作品の読者】");

    // **取り違えない。** 3つを続けて足すので、見出しが重なると
    // AIはどこまでが誰の話か分からなくなる
    expect(style).not.toContain("【タイプ】");
    expect(style).not.toContain("【この作品の読者】");
    expect(reader).not.toContain("【タイプ】");
    expect(reader).not.toContain("【この作者の書き方】");
    expect(policy).not.toContain("【この作者の書き方】");
    expect(policy).not.toContain("【この作品の読者】");
  });
});

describe("足したことが記録に残る", () => {
  /*
    **方針が効いているかを作者が確かめる唯一の手掛かり**である
    （助言方針の `advicePolicyLogLines` と同じ理由）。
    文言を core に置いているのは、ここから見るためである。
  */
  test("執筆スタイルは、渡した2軸だけを残す", () => {
    const lines = writerStyleChatLogLines(
      writerProfile("hybrid", "per_episode").style
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("執筆スタイル");
    expect(lines[0]).toContain(WRITER_PLAN_TYPES.hybrid.label);
    expect(lines[0]).toContain(WRITER_REVISE_LABELS.per_episode);
    // 渡していない2軸（資料の置き場・出し先）は記録にも出さない
    expect(lines[0]).not.toContain("メモ");
    expect(lines[0]).not.toContain("連載");
  });

  test("読者タイプは、出どころ（宣言か実像か）まで残す", () => {
    // どちらを基準にしたかが、助言の当たり外れを見るときの分かれ目になる
    const declared = readerTypeChatLogLines(declaredProfile(scores(6, 6, 6)));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toContain("読者タイプ");
    expect(declared[0]).toContain(
      READER_TYPES[resolveReaderType(scores(6, 6, 6))].label
    );
    expect(declared[0]).toContain("宣言");
    expect(declared[0]).toContain("2026-09-13");

    const actual = readerTypeChatLogLines(actualProfile(scores(0, 0, 0)));
    expect(actual[0]).toContain("実像");
  });

  test("相談の受け口が、3つとも記録している", () => {
    // 足したのに記録しない道ができると、効いているかを確かめられない
    const source = fs.readFileSync("src/features/workChatPanel.ts", "utf-8");
    for (const call of [
      "advicePolicyLogLines(",
      "writerStyleChatLogLines(",
      "readerTypeChatLogLines(",
    ]) {
      expect(source.includes(call), call).toBe(true);
    }
  });
});

/**
 * 直す時期（S2）だけは、相談の読み取りで動く（設計書6.90.1）。
 *
 * **6.90.1 の唯一の例外である。** ほかの3軸は「答えがそのまま事実」の
 * ままで、会話からは動かない。
 *
 * **素直に作ると、1回の読み取りが作者自身の答えを上書きする。**
 * 作者は5問に答えてその値を選んでいるので、会話の一言で書き換えるなら
 * 診断そのものが意味を失う。だから歯止めが2つある——
 * **2回続けて同じに読めたときだけ動かす**（助言方針の受容度「低」の
 * `lowStreak` と同じ考え方）、**変わったら必ず作者へ見せる**。
 */
describe("直す時期（S2）の読み取り", () => {
  function profile(
    revise: WriterReviseTiming,
    streak?: { value: WriterReviseTiming; count: number }
  ): WriterProfile {
    const base = writerProfile("designer", revise);
    return streak ? { ...base, reviseStreak: streak } : base;
  }

  /** 読み取りを順に流し込む。返るのは最後の記録 */
  function feed(
    start: WriterProfile,
    reads: WriterReviseTiming[]
  ): WriterProfile {
    return reads.reduce(
      (current, revise) => applyWriterStyleSignals(current, { revise }),
      start
    );
  }

  test("**1回では動かない**", () => {
    const before = profile("per_episode");
    const after = applyWriterStyleSignals(before, { revise: "inline" });

    expect(after.style.revise).toBe("per_episode");
    // 数えだけが進む。次に同じ値が読めたときの手掛かりである
    expect(after.reviseStreak).toEqual({ value: "inline", count: 1 });
  });

  test("**2回続けて同じなら動く**", () => {
    const after = feed(profile("per_episode"), ["inline", "inline"]);

    expect(after.style.revise).toBe("inline");
    // 反映したら数えは消える（次の1回で、また動いてしまわないように）
    expect(after.reviseStreak).toBeUndefined();
    expect(WRITER_REVISE_STREAK_NEEDED).toBe(2);
  });

  test("**途中で別の値が挟まると、数え直す**", () => {
    // inline → after_all → inline は「inline が2回」ではない。
    // 2回目の inline は、数え直しの1回目である
    const after = feed(profile("per_episode"), ["inline", "after_all", "inline"]);

    expect(after.style.revise).toBe("per_episode");
    expect(after.reviseStreak).toEqual({ value: "inline", count: 1 });

    // そのうえで、もう一度 inline が読めれば動く
    expect(feed(after, ["inline"]).style.revise).toBe("inline");
  });

  test("いまの答えと同じ値を読み取ったら、数えが途切れる", () => {
    // 「1話ごと」の人が inline を1回語り、そのあと「1話ごと」の話をした。
    // inline の数えはそこで切れる
    const after = feed(profile("per_episode"), ["inline", "per_episode"]);

    expect(after.style.revise).toBe("per_episode");
    expect(after.reviseStreak).toBeUndefined();
  });

  test("読み取りが無い回では、何も変わらない", () => {
    const before = profile("per_episode", { value: "inline", count: 1 });

    // **同じものを書き戻さない**（呼び出し側は同一性で見分ける）
    expect(applyWriterStyleSignals(before, undefined)).toBe(before);
    expect(applyWriterStyleSignals(before, {})).toBe(before);
    expect(applyWriterStyleSignals(before, { revise: undefined })).toBe(before);
  });

  test("**S1・S3・S4 は動かない**", () => {
    // S1 には呼び名（設計派・折衷派・即興派）が付いており、変わると
    // 作者への呼びかけ方まで変わる。S3・S4 は相談へ渡してすらいない
    const before = profile("per_episode");
    const after = feed(before, ["after_all", "after_all"]);

    expect(after.style.revise).toBe("after_all");
    expect(after.style.plan).toBe(before.style.plan);
    expect(after.style.material).toBe(before.style.material);
    expect(after.style.outlet).toBe(before.style.outlet);
    expect(after.style.situation).toBe(before.style.situation);
  });

  test("診断した日は動かさない", () => {
    // ここは「作者が5問に答えたのはいつか」であって、最後に触った日時ではない
    const after = feed(profile("per_episode"), ["inline", "inline"]);
    expect(after.updatedAt).toBe(DIAGNOSED_AT);
  });

  test("**変わったら、何が何に変わったか・戻し方が作者へ出る**", () => {
    const before = profile("per_episode");
    const after = feed(before, ["inline", "inline"]);
    const message = describeWriterStyleChange(before, after);

    expect(message).toBeTruthy();
    // 何が
    expect(message).toContain("直す時期");
    // 何から何へ
    expect(message).toContain(WRITER_REVISE_LABELS.per_episode);
    expect(message).toContain(WRITER_REVISE_LABELS.inline);
    // なぜ変えたか
    expect(message).toContain("相談の中で");
    // 戻し方
    expect(message).toContain("作家タイプ診断");
  });

  test("変わっていなければ、作者へは出さない（記録には残す）", () => {
    const before = profile("per_episode");
    const after = applyWriterStyleSignals(before, { revise: "inline" });

    expect(describeWriterStyleChange(before, after)).toBeUndefined();
    // **1回目も記録には残す。** 残さないと、2回目で変わったときに
    // 作者には突然変わったように見える
    const line = writerStyleUpdateLogLine(before, after);
    expect(line).toContain(WRITER_REVISE_LABELS.inline);
    expect(line).toContain("1回目");
  });

  test("動いたことが、操作ログの1行に残る", () => {
    const before = profile("per_episode");
    const after = feed(before, ["inline", "inline"]);
    const line = writerStyleUpdateLogLine(before, after);

    expect(line).toContain(WRITER_REVISE_LABELS.per_episode);
    expect(line).toContain(WRITER_REVISE_LABELS.inline);
  });

  test("**知らない値は捨てる**（指示語がそのまま返ってくる前提）", () => {
    expect(parseWriterStyleSignals({ revise: "inline" })).toEqual({
      revise: "inline",
    });
    for (const broken of [
      { revise: "inline|per_episode|after_all" },
      { revise: "書きながら" },
      { revise: 1 },
      { revise: null },
      {},
      null,
      "inline",
    ]) {
      expect(parseWriterStyleSignals(broken), JSON.stringify(broken)).toBe(
        undefined
      );
    }
  });

  test("相談の応答の欄から、読み取りが届く", () => {
    const answer = parseWorkChatAnswer(
      JSON.stringify({
        reply: "はい。",
        writerStyleSignals: { revise: "after_all" },
      })
    );
    expect(answer.writerStyleSignals).toEqual({ revise: "after_all" });

    // **小さいモデルに落とさせない**（ほかの欄と同じ扱い）
    const schema = WORK_CHAT_SCHEMA as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.writerStyleSignals).toBeTruthy();
    expect(schema.required).toContain("writerStyleSignals");
  });

  test("受け口が、読み取りを執筆スタイルへ渡している", () => {
    // 欄を足したのに繋がっていない道ができると、実機でしか気づけない
    const source = fs.readFileSync("src/features/workChatPanel.ts", "utf-8");
    expect(source).toContain("answer.writerStyleSignals");
    expect(source).toContain("applyWriterStyleSignals(");
    expect(source).toContain("describeWriterStyleChange(");
  });
});

describe("P-39 の頼み方", () => {
  const PROMPT = buildWriterStylePrompt(writerProfile("hybrid", "per_episode"));

  test("**作品の内容についての質問からは判断させない**", () => {
    // 助言方針（P-36）が既に持っている歯止めと同じ。「この人物の年齢は」と
    // 聞かれただけでは、作者のやり方は分からない
    expect(PROMPT).toContain("作品の内容についての質問からは判断しないこと");
  });

  test("読み取れたときだけ報告させる（毎回ではない）", () => {
    expect(PROMPT).toContain("読み取れなければ null");
    expect(PROMPT).toContain("毎回入れる必要はありません");
  });

  test("AIに値を決めさせない", () => {
    expect(PROMPT).toContain("読み取れたことを報告するだけ");
    expect(PROMPT).toContain("拡張機能が決めます");
  });

  test("3つの値を、そのまま返せる形で示す", () => {
    for (const value of ["inline", "per_episode", "after_all"]) {
      expect(PROMPT, value).toContain(`"${value}"`);
    }
  });

  test("頼むのは直す時期だけ（段取りは頼まない）", () => {
    // S1 には呼び名が付いており、変わると作者への呼びかけ方まで変わる
    expect(PROMPT).toContain("writerStyleSignals");
    expect(PROMPT).not.toContain("profileSignals");
    for (const plan of ["designer", "hybrid", "improviser"]) {
      expect(PROMPT, plan).not.toContain(`"${plan}"`);
    }
  });
});

describe("古い形の保存も読める", () => {
  /*
    **`WriterProfile` の形を壊さない。** 読めなくなると、作者は診断を
    やり直すことになる（連続の数えは、この項目が入る前の記録には無い）。
  */
  function memento(): vscode.Memento {
    const box = new Map<string, unknown>();
    return {
      keys: () => [...box.keys()],
      get: <T>(key: string, fallback?: T) =>
        (box.has(key) ? box.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => {
        if (value === undefined) box.delete(key);
        else box.set(key, value);
      },
    } as vscode.Memento;
  }

  const OLD_STYLE: WriterStyle = {
    situation: "have_files",
    plan: "improviser",
    revise: "after_all",
    material: "in_head",
    outlet: "undecided",
  };

  test("数えの入っていない記録が、そのまま読める", async () => {
    const box = memento();
    await box.update(WRITER_PROFILE_KEY, {
      style: OLD_STYLE,
      updatedAt: DIAGNOSED_AT,
    });

    const loaded = new WriterProfileStore(box).get();
    expect(loaded?.style).toEqual(OLD_STYLE);
    expect(loaded?.updatedAt).toBe(DIAGNOSED_AT);
    expect(loaded?.reviseStreak).toBeUndefined();
  });

  test("**数えが壊れていても、答えは捨てない**", async () => {
    // 数えは途中経過にすぎない。読めなければ「数えていない」に戻せばよい
    const box = memento();
    await box.update(WRITER_PROFILE_KEY, {
      style: OLD_STYLE,
      updatedAt: DIAGNOSED_AT,
      reviseStreak: { value: "むかしの値", count: "2" },
    });

    const loaded = new WriterProfileStore(box).get();
    expect(loaded?.style).toEqual(OLD_STYLE);
    expect(loaded?.reviseStreak).toBeUndefined();
  });

  test("数えは保存され、読み直せる（相談は日をまたぐ）", async () => {
    const box = memento();
    const store = new WriterProfileStore(box);
    await box.update(WRITER_PROFILE_KEY, {
      style: OLD_STYLE,
      updatedAt: DIAGNOSED_AT,
    });

    const first = store.get();
    if (!first) throw new Error("読めない");
    await store.update(applyWriterStyleSignals(first, { revise: "inline" }));

    // VS Code を閉じても、次の相談で2回目として数えられる
    const reopened = new WriterProfileStore(box).get();
    expect(reopened?.reviseStreak).toEqual({ value: "inline", count: 1 });
    if (!reopened) throw new Error("読めない");
    expect(
      applyWriterStyleSignals(reopened, { revise: "inline" }).style.revise
    ).toBe("inline");
  });

  test("答え直すと、数えは持ち越さない", async () => {
    // 作者がいま5問に答えたのだから、その前の会話の途中経過は用済みである
    const box = memento();
    const store = new WriterProfileStore(box);
    await box.update(WRITER_PROFILE_KEY, {
      style: OLD_STYLE,
      updatedAt: DIAGNOSED_AT,
      reviseStreak: { value: "inline", count: 1 },
    });

    await store.set(OLD_STYLE);

    expect(store.get()?.reviseStreak).toBeUndefined();
  });
});
