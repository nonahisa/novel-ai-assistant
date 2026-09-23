import { describe, expect, test } from "vitest";
import { parseScheduleMessage } from "../../../src/core/scheduleMessages";
import { buildEpisodeFacts } from "../../../src/core/scheduleEpisodes";

/**
 * スケジュールの画面から届く知らせの形と、連載の「話ごとの事実」の組み立て（設計書6.111）。
 */

describe("画面から届く知らせ", () => {
  test("形の合わないものは捨てる", () => {
    expect(parseScheduleMessage(null)).toBeNull();
    expect(parseScheduleMessage({ type: "unknown" })).toBeNull();
    expect(parseScheduleMessage({ type: "updateStep", workId: "w", scheduleId: "s" })).toBeNull();
    expect(
      parseScheduleMessage({ type: "updateStep", workId: "w", scheduleId: "s", stepId: "t", patch: { status: "finished" } })
    ).toBeNull();
    expect(parseScheduleMessage({ type: "moveStep", workId: "w", scheduleId: "s", stepId: "t", direction: 2 })).toBeNull();
  });

  test("段の直しは、空の期日を「外す」として読む", () => {
    expect(
      parseScheduleMessage({
        type: "updateStep",
        workId: "w",
        scheduleId: "s",
        stepId: "t",
        patch: { status: "done", due: "", label: "推敲", note: "", days: 7 },
      })
    ).toEqual({
      type: "updateStep",
      workId: "w",
      scheduleId: "s",
      stepId: "t",
      patch: { status: "done", due: null, label: "推敲", note: "", days: 7 },
    });
  });

  test("段を足す：先頭（null）か、指定の段の後ろ", () => {
    expect(
      parseScheduleMessage({ type: "addStep", workId: "w", scheduleId: "s", afterStepId: null, label: "装画", days: 3 })
    ).toMatchObject({ afterStepId: null });
    expect(
      parseScheduleMessage({ type: "addStep", workId: "w", scheduleId: "s", afterStepId: "t", label: "装画", days: 3 })
    ).toMatchObject({ afterStepId: "t" });
  });

  test("連載の決まりの空欄は null として読む", () => {
    const parsed = parseScheduleMessage({
      type: "updateSchedule",
      workId: "w",
      scheduleId: "s",
      patch: { milestone: "", serial: { weekdays: [1, 4], time: "", endDate: "", site: "", endEpisode: null } },
    });
    expect(parsed).toMatchObject({
      patch: { milestone: null, serial: { weekdays: [1, 4], time: null, endDate: null, site: null, endEpisode: null } },
    });
  });
});

describe("連載の話ごとの事実", () => {
  test("合本は話ごとに投稿を訊き、字数は話の数で均す。予定の話は書いていないとして題を並べる", () => {
    const facts = buildEpisodeFacts(
      [
        { chapterStart: 1, chapterEnd: 1, net: 3000, title: "始まり", isPosted: (chapter) => chapter === null },
        { chapterStart: 2, chapterEnd: 3, net: 5000, title: "合本", isPosted: (chapter) => chapter === 2 },
        { chapterStart: null, chapterEnd: null, net: 800, title: "あとがき", isPosted: () => false },
      ],
      new Map([
        [5, "決戦"],
        [2, "重なる予定"],
      ])
    );
    expect(facts).toEqual([
      { chapter: 1, written: true, posted: true, chars: 3000, title: "始まり" },
      { chapter: 2, written: true, posted: true, chars: 2500, title: null },
      { chapter: 3, written: true, posted: false, chars: 2500, title: null },
      { chapter: 5, written: false, posted: false, chars: 0, title: "決戦" },
    ]);
  });
});
