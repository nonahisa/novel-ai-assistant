import { describe, expect, test } from "vitest";
import {
  buildTargetSheetHistoryEntry,
  isSameAsLastHistory,
  parseTargetSheetHistoryEntry,
  sortTargetSheetHistory,
  targetSheetHistoryNameCandidates,
  TARGET_SHEET_HISTORY_ROWS,
  type TargetSheetHistoryEntry,
} from "../../../src/core/targetSheetHistory";
import { targetSheetFor } from "../../../src/core/targetSheet";
import { buildTargetSheetDoc } from "../../../src/core/targetSheetDoc";
import type { ReaderScores } from "../../../src/models/readerProfile";

/**
 * ターゲットシートの控えと推移（設計書6.108.5）。
 *
 * 作者の言葉（2026-09-21）：「ターゲットシートは見直しできる、過去からの
 * 推移を見れるよう、複数保存できるようにしてください」。
 *
 * **押した回数が推移になってはいけない。** 同じ点数・同じ狙いで押し直した
 * だけの行が並ぶと、見直しの記録として読めなくなる。
 */

const SCORES: ReaderScores = { familiarity: 6, posture: 3, craving: 0 };

function entryOf(input: {
  scores?: ReaderScores;
  aim?: string[];
  at: string;
}): TargetSheetHistoryEntry {
  const sheet = targetSheetFor({
    aim: (input.aim ?? []) as never,
    scores: input.scores ?? SCORES,
  });
  const entry = buildTargetSheetHistoryEntry({
    sheet,
    source: "actual",
    at: new Date(input.at),
  });
  if (!entry) throw new Error("控えを組めなかった");
  return entry;
}

describe("控えを取るかどうか", () => {
  test("点数が無ければ控えを取らない（残す値が無い）", () => {
    const sheet = targetSheetFor({ aim: ["lore_deep"] });
    expect(
      buildTargetSheetHistoryEntry({
        sheet,
        source: "declared",
        at: new Date(),
      })
    ).toBeUndefined();
  });

  test("前回と同じ点数・同じ狙いなら、増やさない", () => {
    const first = entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:00:00" });
    const again = entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:40:00" });
    expect(isSameAsLastHistory(again, first)).toBe(true);
  });

  test("狙いを書き換えたら増える（＝見直しの記録）", () => {
    const first = entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:00:00" });
    const changed = entryOf({
      aim: ["lore_deep", "deep_pure"],
      at: "2026-09-21T23:40:00",
    });
    expect(isSameAsLastHistory(changed, first)).toBe(false);
  });

  test("点数が動いたら増える", () => {
    const first = entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:00:00" });
    const moved = entryOf({
      aim: ["lore_deep"],
      scores: { familiarity: 6, posture: 5, craving: 0 },
      at: "2026-09-22T10:00:00",
    });
    expect(isSameAsLastHistory(moved, first)).toBe(false);
  });

  test("1件目は、比べる相手がいないので必ず取る", () => {
    const first = entryOf({ at: "2026-09-21T23:00:00" });
    expect(isSameAsLastHistory(first, undefined)).toBe(false);
  });

  test("控えには、そのときの一致度といちばん高い層が入る", () => {
    const entry = entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:00:00" });
    expect(entry.top).toBe("lore_deep");
    expect(entry.affinities.lore_deep).toBe(100);
    expect(Object.keys(entry.affinities).length).toBe(11);
    expect(entry.scores).toEqual(SCORES);
  });
});

describe("控えの並びと読み取り", () => {
  test("新しい順に並ぶ", () => {
    const sorted = sortTargetSheetHistory([
      entryOf({ at: "2026-09-01T10:00:00" }),
      entryOf({ at: "2026-09-21T23:00:00" }),
      entryOf({ at: "2026-09-10T08:00:00" }),
    ]);
    // 控えの時刻はUTCで持つので、日付の文字列では比べない（時差で1日ずれる）
    expect(sorted.map((entry) => entry.recordedAt)).toEqual(
      ["2026-09-21T23:00:00", "2026-09-10T08:00:00", "2026-09-01T10:00:00"].map(
        (at) => new Date(at).toISOString()
      )
    );
  });

  test("書いたものを読み直せる", () => {
    const entry = entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:00:00" });
    const read = parseTargetSheetHistoryEntry(JSON.parse(JSON.stringify(entry)));
    expect(read).toEqual(entry);
  });

  test("形の合わない控えは読まない（直さない）", () => {
    expect(parseTargetSheetHistoryEntry(null)).toBeUndefined();
    expect(parseTargetSheetHistoryEntry({})).toBeUndefined();
    // 点数が欠けている
    expect(
      parseTargetSheetHistoryEntry({
        recordedAt: "2026-09-21T23:00:00.000Z",
        top: "lore_deep",
        scores: { familiarity: 6, posture: 3 },
      })
    ).toBeUndefined();
    // 知らない層の名前
    expect(
      parseTargetSheetHistoryEntry({
        recordedAt: "2026-09-21T23:00:00.000Z",
        top: "知らない層",
        scores: SCORES,
      })
    ).toBeUndefined();
  });

  test("狙いに知らない名前が混ざっていても、読めたぶんだけ採る", () => {
    const read = parseTargetSheetHistoryEntry({
      recordedAt: "2026-09-21T23:00:00.000Z",
      top: "lore_deep",
      scores: SCORES,
      aim: ["lore_deep", "存在しない層"],
    });
    expect(read?.aim).toEqual(["lore_deep"]);
  });

  test("同じ分に2回押しても、名前がぶつからない", () => {
    const names = targetSheetHistoryNameCandidates(
      new Date("2026-09-21T23:40:00")
    );
    expect(names[0]).toBe("2026-09-21-2340.json");
    expect(names[1]).toBe("2026-09-21-2340-2.json");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("推移の表", () => {
  function docWith(history: TargetSheetHistoryEntry[]): string {
    return buildTargetSheetDoc({
      workTitle: "テスト作品",
      sheet: targetSheetFor({ aim: ["lore_deep"], scores: SCORES }),
      authorBlock: "狙い：考察層",
      source: "actual",
      history,
      generatedAt: new Date("2026-09-21T23:40:00"),
    });
  }

  test("控えが無ければ、そう書く（表を空で出さない）", () => {
    expect(docWith([])).toContain("控えはまだありません");
  });

  test("日時・狙いの一致度・いちばん高い層・上位3つが並ぶ", () => {
    const doc = docWith([
      entryOf({ aim: ["lore_deep"], at: "2026-09-21T23:00:00" }),
    ]);
    expect(doc).toContain("| 日時 | 狙いの一致度 | いちばん高い層 | 上位3つ |");
    expect(doc).toContain("| 2026-09-21 23:00 | 考察層 100 | 考察層 |");
  });

  test("狙いを書いていなかった日も分かる", () => {
    const doc = docWith([entryOf({ at: "2026-09-21T23:00:00" })]);
    expect(doc).toContain("（狙い未記入）");
  });

  test("新しいものから20件だけ出し、控えは消さない", () => {
    const history = Array.from({ length: 25 }, (_, index) =>
      entryOf({
        aim: ["lore_deep"],
        at: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00`,
      })
    ).reverse();
    const doc = docWith(history);
    const rows = doc
      .split("\n")
      .filter((line) => /^\| 2026-09-\d\d \d\d:\d\d \|/.test(line));
    expect(rows.length).toBe(TARGET_SHEET_HISTORY_ROWS);
    expect(doc).toContain("控えは25件あります。消してはいません");
  });
});
