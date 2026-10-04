import { describe, expect, test } from "vitest";
import {
  appliedByOf,
  locateAppliedFinding,
  recentAppliedFindings,
} from "../../../src/core/appliedFindings";
import {
  OUTBOX_DECISION_NOTES,
  findingId,
  type FindingStatus,
  type FindingView,
} from "../../../src/models/finding";

/**
 * 提案パネルの「当てたもの」——どれを並べ、いまの本文のどの行か（作者の裁定 2026-10-04。
 * 設計書6.96.5・6.115）。
 *
 * 戻す処理そのものは既存の［戻す］（`undoIssue`）なので、ここでは
 * 「並ぶ・期限で外れる・並べてはいけないものを並べない・行を探し直す」を見る。
 */

const NOW = new Date("2026-10-04T12:00:00.000Z");
const FILE = "本文/001_駅.txt";

function view(
  overrides: Partial<FindingView> = {},
  decision: { status?: FindingStatus; note?: string; time?: string } | null = {}
): FindingView {
  const base = {
    id: findingId(FILE, "男は以外にも若かった。", "以外", "意外", "typo", "誤字脱字"),
    time: "2026-10-01T00:00:00.000Z",
    file: FILE,
    hintLine: 2,
    original: "男は以外にも若かった。",
    target: "以外",
    suggestion: "意外",
    before: "　終電を逃した駅のホームに、雨の音だけが残っていた。",
    after: "　ホームの時計が、零時を指していた。",
    message: "「思いのほか」なら「意外」",
    category: "typo" as const,
    label: "誤字脱字",
    ...overrides,
  };
  if (decision === null) return { ...base, status: "pending" };
  const status = decision.status ?? "accepted";
  return {
    ...base,
    status,
    decision: {
      findingId: base.id,
      time: decision.time ?? "2026-10-04T10:00:00.000Z",
      status,
      note: decision.note ?? "",
    },
  };
}

describe("覚え書きから、誰がどこで当てたかを読む", () => {
  test("空はパソコン、［直す］は出先、［自分で直す］の行は出先で自分で直した", () => {
    expect(appliedByOf("")).toBe("here");
    expect(appliedByOf(OUTBOX_DECISION_NOTES.fix)).toBe("remote");
    expect(appliedByOf(OUTBOX_DECISION_NOTES.authorEdit)).toBe("remoteOwnWords");
  });

  test("本文に修正案が入っていない判断は読まない（［済み］・［自分で直す］の元のAIの指摘・知らない覚え書き）", () => {
    expect(appliedByOf(OUTBOX_DECISION_NOTES.done)).toBeUndefined();
    expect(appliedByOf(OUTBOX_DECISION_NOTES.editOriginal)).toBeUndefined();
    expect(appliedByOf("適用を戻した")).toBeUndefined();
    expect(appliedByOf("何か別の記録")).toBeUndefined();
  });
});

describe("並べる候補", () => {
  test("採った指摘が並ぶ（誰がどこで・戻す分類つき）", () => {
    const [only, ...rest] = recentAppliedFindings(
      [view({}, { note: OUTBOX_DECISION_NOTES.fix })],
      3,
      NOW
    );
    expect(rest).toHaveLength(0);
    expect(only.appliedBy).toBe("remote");
    expect(only.panelCategory).toBe("誤字脱字");
    expect(only.appliedTime).toBe("2026-10-04T10:00:00.000Z");
  });

  test("期限の起点は当てた時刻——検知が古くても、きのう当てたものは並び、4日前に当てたものは外れる", () => {
    const oldDetection = view({ time: "2026-09-01T00:00:00.000Z" }, { time: "2026-10-03T12:00:00.000Z" });
    const oldApply = view(
      { id: "f-old", original: "古い文。", target: "古い", suggestion: "旧い" },
      { time: "2026-09-30T11:59:00.000Z" }
    );
    const shown = recentAppliedFindings([oldDetection, oldApply], 3, NOW);
    expect(shown.map((entry) => entry.finding.id)).toEqual([oldDetection.id]);
  });

  test("日数が0なら無期限", () => {
    const old = view({}, { time: "2025-01-01T00:00:00.000Z" });
    expect(recentAppliedFindings([old], 0, NOW)).toHaveLength(1);
  });

  test("未処理・退けた・戻したものは並べない", () => {
    expect(
      recentAppliedFindings(
        [
          view({}, null),
          view({ id: "f-d" }, { status: "dismissed" }),
          view({ id: "f-p" }, { status: "pending", note: "適用を戻した" }),
        ],
        3,
        NOW
      )
    ).toHaveLength(0);
  });

  test("修正案の無い指摘（矛盾・修正案の無い推敲）は並べない（戻す道が無い）", () => {
    const contradiction = view(
      { id: "f-c", category: "contradiction", label: "矛盾", target: "", suggestion: "" },
      {}
    );
    const proofreadNoFix = view(
      { id: "f-p", category: "proofread", label: "推敲", suggestion: "" },
      {}
    );
    expect(recentAppliedFindings([contradiction, proofreadNoFix], 3, NOW)).toHaveLength(0);
  });

  test("新しく当てたものが上", () => {
    const earlier = view({ id: "f-1" }, { time: "2026-10-03T00:00:00.000Z" });
    const later = view({ id: "f-2" }, { time: "2026-10-04T00:00:00.000Z" });
    expect(
      recentAppliedFindings([earlier, later], 3, NOW).map((entry) => entry.finding.id)
    ).toEqual(["f-2", "f-1"]);
  });
});

describe("いまの本文のどの行か", () => {
  const FIXED = [
    "　終電を逃した駅のホームに、雨の音だけが残っていた。",
    "　近づいてみると、男は意外にも若かった。",
    "　ホームの時計が、零時を指していた。",
    "",
  ].join("\n");

  test("当てたあとの文脈（原文の直す語を当てた字にした文）で探す", () => {
    expect(locateAppliedFinding(view(), FIXED)).toBe(2);
  });

  test("上に行が足されても、当てたあとの文脈で探し直す", () => {
    expect(locateAppliedFinding(view(), "　足した一行。\n" + FIXED)).toBe(3);
  });

  test("当てたあとで作者が書き換えた行は見つからない（戻す先が無い）", () => {
    const rewritten = FIXED.replace("男は意外にも若かった。", "男は思いのほか若かった。");
    expect(locateAppliedFinding(view(), rewritten)).toBeUndefined();
  });

  test("まだ当てていない本文（原文のまま）では見つからない", () => {
    const untouched = FIXED.replace("意外", "以外");
    expect(locateAppliedFinding(view(), untouched)).toBeUndefined();
  });

  test("［自分で直す］の行（原文の全体を作者の文へ）は、作者の文で探す", () => {
    const own = view({
      original: "男は以外にも若かった。",
      target: "男は以外にも若かった。",
      suggestion: "男は、思っていたより若かった。",
    });
    const text = FIXED.replace("男は意外にも若かった。", "男は、思っていたより若かった。");
    expect(locateAppliedFinding(own, text)).toBe(2);
  });

  test("［自分で直す］の元のAIの指摘は、本文にAIの修正案が無いので見つからない", () => {
    const text = FIXED.replace("男は意外にも若かった。", "男は、思っていたより若かった。");
    expect(locateAppliedFinding(view(), text)).toBeUndefined();
  });
});
