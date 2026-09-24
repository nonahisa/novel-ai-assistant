import { describe, expect, it } from "vitest";
import {
  PLOT_DIG_ON_OPTION,
  describeContinuedFrom,
  describeFixedDone,
  describeFixedProgress,
  describePlotFrameChoice,
  describePlotSeedAsk,
  describePlotStyleChoice,
  frameOfReply,
  nextFixedPoint,
  nextGuidedPoint,
  PLOT_DIALOGUE_STYLES,
  PLOT_LENGTH_TOPIC,
  PLOT_FIELD_ORDER,
  PLOT_FRAMES,
  plotFrame,
  plotSeedOptions,
  plotStyleOptions,
  styleOfReply,
} from "../../../src/core/plotDialogueStyles";
import {
  PLOT_DIALOGUE_LIMITS,
} from "../../../src/core/plotDialogueValidation";
import {
  PLOT_END_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_WRITE_OPTION,
} from "../../../src/core/plotInterview";
import { emptyPlotSections } from "../../../src/core/plotDoc";

/**
 * 対話式プロット作成の「型」（設計書6.4.7「問答は『型の一つ』」）。
 * 作者の指示（2026-09-25）「これはプロット作成のパターンの一つ。これだけに
 * 固定しないで」。足した4つと、いまの「着想から掘る」の5つ。
 */

describe("型を選ぶ一言", () => {
  it("5つの型を1行ずつ並べ、書くのはいつかを1度だけ言う", () => {
    const text = describePlotStyleChoice("回線の街");
    expect(PLOT_DIALOGUE_STYLES.map((style) => style.label)).toEqual([
      "着想から掘る",
      "場面から広げる",
      "結末から逆算する",
      "型に当てはめる",
      "項目を順に埋める",
    ]);
    for (const style of PLOT_DIALOGUE_STYLES) {
      expect(text).toContain(`・${style.label}：${style.summary}`);
      // 説明は1行（くどくしない）
      expect(style.summary).not.toContain("\n");
      expect(style.summary.length).toBeLessThanOrEqual(40);
    }
    expect(text).toContain(PLOT_WRITE_OPTION);
    expect(plotStyleOptions()).toEqual([...PLOT_DIALOGUE_STYLES.map((s) => s.label), PLOT_END_OPTION]);
  });

  it("札の文言だけを型の選択にする（ゆるく当てない）", () => {
    expect(styleOfReply("場面から広げる")?.key).toBe("scene");
    expect(styleOfReply("「結末から逆算する」")?.key).toBe("ending");
    expect(styleOfReply("場面から広げる話です")).toBeUndefined();
    expect(frameOfReply("起承転結")?.key).toBe("kishotenketsu");
    expect(frameOfReply("起承転結で")).toBeUndefined();
  });
});

describe("最初の返事を頼む一言", () => {
  it("型ごとに何を書けばよいかを言う", () => {
    expect(describePlotSeedAsk("idea", false)).toContain("自由に書いてください");
    expect(describePlotSeedAsk("scene", false)).toContain("書きたい場面を書いてください");
    expect(describePlotSeedAsk("ending", false)).toContain("決まっている終わり方を書いてください");
    expect(describePlotSeedAsk("fields", false)).toContain("ログライン → テーマ");
  });

  it("「プロットから始める」は、着想で始める型にだけ出す（場面・結末はそれが無いと始まらない）", () => {
    expect(describePlotSeedAsk("idea", true)).toContain(PLOT_START_FROM_PLOT_OPTION);
    expect(plotSeedOptions("idea", true)).toEqual([PLOT_START_FROM_PLOT_OPTION, PLOT_END_OPTION]);
    expect(describePlotSeedAsk("scene", true)).not.toContain(PLOT_START_FROM_PLOT_OPTION);
    expect(plotSeedOptions("ending", true)).toEqual([PLOT_END_OPTION]);
    // プロットが空なら、どの型でも出さない
    expect(plotSeedOptions("idea", false)).toEqual([PLOT_END_OPTION]);
  });

  it("型に当てはめるときは、選んだ型と枠の並びを添える", () => {
    const frame = plotFrame("kishotenketsu");
    expect(describePlotSeedAsk("structure", false, frame)).toContain("起承転結（起 → 承 → 転 → 結）で進めます。");
  });
});

describe("型の枠", () => {
  it("三幕構成・起承転結・ヒーローズジャーニー・序破急から選べる", () => {
    expect(PLOT_FRAMES.map((frame) => frame.label)).toEqual([
      "三幕構成",
      "起承転結",
      "ヒーローズジャーニー",
      "序破急",
    ]);
    const text = describePlotFrameChoice();
    for (const frame of PLOT_FRAMES) expect(text).toContain(`・${frame.label}：`);
    expect(describePlotFrameChoice(true)).toContain("下の札から選んでください");
  });

  it("枠の名前は短く、「：」を含まず、重ならない（決まったことの名前に使うため）", () => {
    for (const frame of PLOT_FRAMES) {
      const names = frame.beats.map((beat) => beat.name);
      expect(new Set(names).size, frame.label).toBe(names.length);
      for (const name of names) {
        expect(name.length, name).toBeLessThanOrEqual(PLOT_DIALOGUE_LIMITS.topic);
        expect(name, name).not.toMatch(/[：:]/u);
      }
    }
  });
});

describe("コードが決める次の1点", () => {
  const frame = plotFrame("kishotenketsu");

  it("型に当てはめる：枠を前から順に。尋ねた・飛ばした枠は除く", () => {
    const first = nextFixedPoint("structure", frame, [], emptyPlotSections(), new Map());
    expect(first).toMatchObject({ topic: "起", section: "outline", index: 1, total: 4 });

    const next = nextFixedPoint(
      "structure",
      frame,
      [
        { topic: "起", question: "起では？", skipped: false },
        { topic: "承", question: "承では？", skipped: true },
      ],
      emptyPlotSections(),
      new Map()
    );
    expect(next).toMatchObject({ topic: "転", index: 3 });
    expect(describeFixedProgress("structure", frame, next!)).toBe("［起承転結 3/4］");
  });

  it("型に当てはめる：全部尋ねたら undefined", () => {
    const asked = frame!.beats.map((beat) => ({ topic: beat.name, question: "?", skipped: false }));
    expect(nextFixedPoint("structure", frame, asked, emptyPlotSections(), new Map())).toBeUndefined();
    expect(describeFixedDone("structure", frame)).toContain("起承転結の枠は、すべて尋ねました");
  });

  it("項目を順に埋める：0.86.1 までと同じ順（ログラインが先）", () => {
    expect(PLOT_FIELD_ORDER[0]).toBe("logline");
    const first = nextFixedPoint("fields", undefined, [], emptyPlotSections(), new Map());
    expect(first).toMatchObject({ topic: "ログライン", section: "logline", index: 1 });
    expect(first?.note).toContain("話を一言で");
  });

  it("項目を順に埋める：作者がもう書いた項目は尋ねない", () => {
    const sections = emptyPlotSections();
    sections.logline = "作者が書いたログライン";
    const point = nextFixedPoint("fields", undefined, [], sections, new Map());
    expect(point?.section).toBe("theme");
  });

  it("項目を順に埋める：この問答が書いた項目は作者の記述に数えない（着想を書いた「あらすじ」も尋ねる）", () => {
    const sections = emptyPlotSections();
    sections.outline = "- 着想：回線業者が最強";
    const asked = ["ログライン", "テーマ", "世界観", "舞台", "人称", "主人公の行動原理"].map((topic) => ({
      topic,
      question: "?",
      skipped: false,
    }));
    const point = nextFixedPoint(
      "fields",
      undefined,
      asked,
      sections,
      new Map([["outline", "- 着想：回線業者が最強"]])
    );
    expect(point?.section).toBe("outline");
  });

  it("AIが1点を選ぶ型では、コードは決めない", () => {
    expect(nextFixedPoint("idea", undefined, [], emptyPlotSections(), new Map())).toBeUndefined();
    expect(nextFixedPoint("scene", undefined, [], emptyPlotSections(), new Map())).toBeUndefined();
  });
});

/**
 * AIが1点を選ぶ型（着想・場面・結末）でも、**コードが割り込んで決める1点**。
 *
 * 2026-09-25 夜の実接続（gemma4:e4b・26b × 5つの型、5往復）で、
 * ①目標の文字数を5往復のうちに一度も尋ねなかった（10本とも）
 * ②26b は「場面から広げる」で場面の直前を正面から尋ねなかった。
 * どちらもプロンプトに書いてあったのに守られなかった——頼むだけでは足りない。
 */
describe("コードが割り込む1点（AIが選ぶ型）", () => {
  const ask = (topic: string, skipped = false) => ({ topic, question: `${topic}は？`, skipped });

  it("場面から広げる：直前 → 至る理由 → その後 の順に、コードが尋ねる1点を決める", () => {
    const first = nextGuidedPoint("scene", [], [], "");
    expect(first).toMatchObject({ topic: "場面の直前", section: "outline", index: 1, total: 3 });
    expect(nextGuidedPoint("scene", [ask("場面の直前")], [], "")?.topic).toBe("場面に至る理由");
    // 飛ばした点も尋ねたことに数える（飛ばしたものをすぐまた尋ねない）
    expect(
      nextGuidedPoint("scene", [ask("場面の直前"), ask("場面に至る理由", true)], [], "")?.topic
    ).toBe("場面のその後");
  });

  it("目標の文字数：3問を尋ねても決まっていなければ、4問目はコードが「目標の文字数」にする", () => {
    const three = [ask("最強の理由"), ask("主人公"), ask("敵")];
    expect(nextGuidedPoint("idea", three.slice(0, 2), [], "")).toBeUndefined();
    expect(nextGuidedPoint("idea", three, [], "")).toMatchObject({
      topic: PLOT_LENGTH_TOPIC,
      section: "outline",
    });
    expect(nextGuidedPoint("ending", three, [], "")?.topic).toBe(PLOT_LENGTH_TOPIC);
    // 場面から広げる型は、場面の3点を尋ね終えたあとに尋ねる
    const beats = [ask("場面の直前"), ask("場面に至る理由"), ask("場面のその後")];
    expect(nextGuidedPoint("scene", beats, [], "")?.topic).toBe(PLOT_LENGTH_TOPIC);
  });

  it("目標の文字数：もう決まっている・尋ねた（飛ばした）なら割り込まない", () => {
    const three = [ask("最強の理由"), ask("主人公"), ask("敵")];
    // 作者の答えに字数がある
    expect(
      nextGuidedPoint("idea", three, [{ topic: "構成", answer: "10万字くらいの長編", section: "outline" }], "")
    ).toBeUndefined();
    // 「文字」と書いた答え（手元の gemma4:26b の候補「3万〜5万文字」）
    expect(
      nextGuidedPoint("idea", three, [{ topic: "構成", answer: "3万〜5万文字の中編", section: "outline" }], "")
    ).toBeUndefined();
    // プロットにもう書いてある
    expect(nextGuidedPoint("idea", three, [], "【あらすじ】全体で8万字")).toBeUndefined();
    // AIが自分で尋ねていた（作者は飛ばした）
    expect(nextGuidedPoint("idea", [...three, ask("物語の長さ", true)], [], "")).toBeUndefined();
    // 字数の話を名前で答えた
    expect(
      nextGuidedPoint("idea", three, [{ topic: "目標の文字数", answer: "長編で", section: "outline" }], "")
    ).toBeUndefined();
  });

  it("型を埋め終えて着想から掘るへ続けた直後の1問は割り込まず、次の問いから字数を尋ねる", () => {
    const four = [ask("起"), ask("承"), ask("転"), ask("結")];
    // 切り替えた直後（尋ねた数が切り替えたときのまま）は AI が選ぶ
    expect(nextGuidedPoint("idea", four, [], "", 4)).toBeUndefined();
    // 切り替えたあと1問尋ねたら、いつもの決まり（字数が決まっていなければ尋ねる）
    expect(nextGuidedPoint("idea", [...four, ask("班長の過去")], [], "", 4)?.topic).toBe(
      PLOT_LENGTH_TOPIC
    );
  });

  it("続けたときの元の型の名前：型に当てはめるなら選んだ枠も添える", () => {
    expect(describeContinuedFrom("structure", plotFrame("kishotenketsu"))).toBe(
      "型に当てはめる（起承転結）"
    );
    expect(describeContinuedFrom("fields", undefined)).toBe("項目を順に埋める");
  });

  it("枠・項目が尽きたときの一言は、続けて掘る札を先に言う", () => {
    const text = describeFixedDone("structure", plotFrame("johakyu"));
    expect(text).toContain("序破急の枠は、すべて尋ねました");
    expect(text.indexOf(PLOT_DIG_ON_OPTION)).toBeGreaterThan(0);
    expect(text.indexOf(PLOT_DIG_ON_OPTION)).toBeLessThan(text.indexOf(PLOT_WRITE_OPTION));
  });

  it("コードが順を決める型（型に当てはめる・項目を順に埋める）では割り込まない", () => {
    const three = [ask("起"), ask("承"), ask("転")];
    expect(nextGuidedPoint("structure", three, [], "")).toBeUndefined();
    expect(nextGuidedPoint("fields", three, [], "")).toBeUndefined();
  });
});
