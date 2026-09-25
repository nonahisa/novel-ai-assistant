import { describe, expect, test } from "vitest";
import {
  settleNarrativePerson,
  validatePlotSummary,
} from "../../../src/core/plotDialogueValidation";
import {
  composeSectionContents,
  type PlotDecision,
  type PlotDialogueSection,
} from "../../../src/core/plotInterview";

/**
 * 対話式プロット作成で、小さいモデル（gemma4:e4b）が「誰の目で語るか」の答えを
 * 「人称」の項目へ書く（0.86.12 の担当の報告。実機確認リスト、2026-09-25 朝の
 * 実接続の台：e4b 起承転結【物語の視点と語り手】）。
 *
 * 人称は一人称・三人称などの**書き方の形だけ**。語り手が誰かは人物の話なので、
 * 人称の項目には形だけを残し、誰かの部分は別の項目へ回す（作者へもそう示す）。
 *
 * 見逃しと誤検出の両方を測る（CLAUDE.md の繰り返し起きた失敗2）——形だけの
 * 答え（「一人称（僕）」「三人称一元視点で淡々と描く」）は動かさない。
 */

function decide(answer: string, topic = "物語の視点と語り手"): PlotDecision {
  return { topic, answer, section: "narrativePerson" };
}

function settle(decisions: PlotDecision[]) {
  return settleNarrativePerson(composeSectionContents(decisions));
}

describe("人称の項目に、誰の目かが入った答えを直す", () => {
  test("再現：e4b の答え（誰かと形が1つの文）は、人称へ形だけ、誰かはあらすじへ", () => {
    // 直す前は、この答えが丸ごと【人称】に入っていた
    const before = composeSectionContents([
      decide("主人公である新人ケースワーカー・ユキの一人称"),
    ]);
    expect(before.get("narrativePerson")).toContain("ユキ");

    const settled = settle([decide("主人公である新人ケースワーカー・ユキの一人称")]);
    expect(settled.contents.get("narrativePerson")).toBe("一人称");
    expect(settled.contents.get("outline")).toBe(
      "- 視点の人物：主人公である新人ケースワーカー・ユキの一人称"
    );
    expect(settled.moved).toEqual([
      { form: "一人称", answer: "主人公である新人ケースワーカー・ユキの一人称" },
    ]);
  });

  const mixed: Array<[string, string]> = [
    ["三人称一元（ユキに寄り添う）", "三人称一元"],
    ["ユキ視点の三人称", "三人称"],
    ["主人公（ユキ）の一人称視点で、内面を深く描く", "一人称視点"],
    ["一人称（主人公・ユキ）", "一人称"],
    ["班長ケンプの視点で語る三人称一元", "三人称一元"],
    ["新人の少年の目で見る三人称限定", "三人称限定"],
  ];
  for (const [answer, form] of mixed) {
    test(`誰かを含む：${answer} → 人称「${form}」`, () => {
      const settled = settle([decide(answer)]);
      expect(settled.contents.get("narrativePerson")).toBe(form);
      expect(settled.contents.get("outline")).toContain(answer);
      expect(settled.moved).toHaveLength(1);
    });
  }

  test("形の無い答え（誰の目かだけ）は、人称の項目を空にして丸ごと回す", () => {
    const settled = settle([decide("主人公の新人ケースワーカーの目で見る")]);
    expect(settled.contents.has("narrativePerson")).toBe(false);
    expect(settled.contents.get("outline")).toBe(
      "- 視点の人物：主人公の新人ケースワーカーの目で見る"
    );
    expect(settled.moved).toEqual([{ form: "", answer: "主人公の新人ケースワーカーの目で見る" }]);
  });

  test("あらすじに先の行があれば、その後ろへ足す（先の行は消さない）", () => {
    const settled = settle([
      { topic: "着想", answer: "配信業者が最強", section: "outline" },
      decide("ユキの一人称"),
    ]);
    expect(settled.contents.get("outline")).toBe(
      "- 着想：配信業者が最強\n- 視点の人物：ユキの一人称"
    );
  });

  test("名前だけの項目（見出しと同じ名前の答え）も同じく直す", () => {
    const settled = settle([decide("ユキの一人称", "人称")]);
    expect(settled.contents.get("narrativePerson")).toBe("一人称");
  });
});

describe("形だけの答えは動かさない（誤検出の側）", () => {
  const formOnly = [
    "一人称",
    "三人称一元",
    "三人称多元",
    "一人称（僕）",
    "僕の一人称",
    "三人称一元視点で淡々と描く",
    "三人称多元（複数の人物の視点を切り替える）",
    "神視点",
    "三人称一元（淡々とした語り口）",
    // 手元の gemma4:e4b が【人称】の問いに出した候補（2026-09-25 の実接続）。
    // 誰とも決めていない言い足し（主人公・神・一人の人物）なので形の話である
    "一人称（主人公の視点）",
    "三人称限定（一人の人物に焦点を当てる）",
    "三人称全知（神の視点）",
    "三人称複数（複数の視点を切り替える）",
    "彼女の視点で語る三人称一元",
    "主人公の視点",
  ];
  for (const answer of formOnly) {
    test(`そのまま：${answer}`, () => {
      const decisions = [decide(answer)];
      const settled = settle(decisions);
      expect(settled.moved).toEqual([]);
      expect(settled.contents.get("narrativePerson")).toBe(
        composeSectionContents(decisions).get("narrativePerson")
      );
      expect(settled.contents.has("outline")).toBe(false);
    });
  }

  test("人称以外の項目は見ない", () => {
    const contents = new Map<PlotDialogueSection, string>([
      ["mainCharacters", "- ユキ：新人ケースワーカー。一人称の語り手"],
    ]);
    const settled = settleNarrativePerson(contents);
    expect(settled.moved).toEqual([]);
    expect(settled.contents).toEqual(contents);
  });

  test("直したあとにもう一度通しても変わらない（書く前にもう一度通すため）", () => {
    const once = settle([decide("ユキの一人称")]);
    const twice = settleNarrativePerson(once.contents);
    expect(twice.moved).toEqual([]);
    expect(twice.contents).toEqual(once.contents);
  });
});

describe("まとめ（P-44）の人称にも同じ直しが効く", () => {
  test("まとめの人称に誰かが入っていても、形だけを残して回せる", () => {
    const decisions = [decide("ユキの一人称")];
    const check = validatePlotSummary(
      JSON.stringify({ narrativePerson: "ユキの一人称", outline: "- 着想：配信業者が最強" }),
      decisions,
      ["配信業者が最強"]
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const settled = settleNarrativePerson(check.contents);
    expect(settled.contents.get("narrativePerson")).toBe("一人称");
    expect(settled.contents.get("outline")).toContain("視点の人物：ユキの一人称");
  });
});
