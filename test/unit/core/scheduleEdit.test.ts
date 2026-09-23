import { describe, expect, test } from "vitest";
import type { ScheduleFile } from "../../../src/models/schedule";
import {
  addSchedule,
  addStep,
  materializeGoalsSchedule,
  moveStep,
  removeSchedule,
  removeStep,
  updateSchedule,
  updateStep,
} from "../../../src/core/scheduleEdit";
import { planSchedule } from "../../../src/core/schedulePlan";
import { createSchedule, GOALS_CONTEST_SCHEDULE_ID, type IdMaker } from "../../../src/core/scheduleTemplates";

/**
 * スケジュールの書き換え（設計書6.111.2）。元のファイルを書き換えず新しいものを返すこと、
 * 段の追加・削除・並べ替え、済みの記録、手で入れた期日が逆算で消えないことを押さえる。
 */

function idMaker(): IdMaker {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
}

function fileWith(kind: "publisher" | "webSerial" = "publisher"): ScheduleFile {
  return {
    schemaVersion: "1",
    schedules: [createSchedule({ kind, name: "新刊", milestone: "2027-03-01", now: "t0" }, idMaker())],
  };
}

describe("段の書き換え", () => {
  test("元のファイルは書き換えない", () => {
    const file = fileWith();
    const before = JSON.stringify(file);
    updateStep(file, "sch_1", "stp_2", { days: 5 }, "2026-09-23", "t1");
    expect(JSON.stringify(file)).toBe(before);
  });

  test("済みにすると済んだ日を残し、外すと消す", () => {
    const done = updateStep(fileWith(), "sch_1", "stp_2", { status: "done" }, "2026-09-23", "t1");
    expect(done.schedules[0].steps[0]).toMatchObject({ status: "done", doneAt: "2026-09-23" });
    const undone = updateStep(done, "sch_1", "stp_2", { status: "doing" }, "2026-09-24", "t2");
    expect(undone.schedules[0].steps[0]).toMatchObject({ status: "doing", doneAt: null });
  });

  test("手で入れた期日は、逆算しても消えない", () => {
    const file = updateStep(fileWith(), "sch_1", "stp_3", { due: "2026-12-10" }, "2026-09-23", "t1");
    const plan = planSchedule(file.schedules[0], {
      today: "2026-09-23",
      written: 0,
      perDay: 0,
      goalsContest: null,
      perEpisodeGoal: null,
      episodes: [],
    });
    const rewrite = plan.steps.find((step) => step.step.id === "stp_3")!;
    expect(rewrite.end).toBe("2026-12-10");
    expect(file.schedules[0].steps[1].due).toBe("2026-12-10");
    // 外すと逆算に戻る
    const cleared = updateStep(file, "sch_1", "stp_3", { due: null }, "2026-09-23", "t2");
    expect(cleared.schedules[0].steps[1].due).toBeNull();
  });

  test("日数・期日の形が違えば止める", () => {
    expect(() => updateStep(fileWith(), "sch_1", "stp_2", { days: 0 }, "2026-09-23", "t")).toThrow("日数");
    expect(() => updateStep(fileWith(), "sch_1", "stp_2", { days: 1.5 }, "2026-09-23", "t")).toThrow("日数");
    expect(() => updateStep(fileWith(), "sch_1", "stp_2", { due: "2026/12/01" }, "2026-09-23", "t")).toThrow(
      "YYYY-MM-DD"
    );
  });

  test("段を足す（指定の段の後ろ・先頭）・消す・動かす", () => {
    const ids = idMaker();
    let file = addStep(fileWith(), "sch_1", { label: "装画の確認", days: 3, afterStepId: "stp_3" }, () => "stp_new", "t");
    expect(file.schedules[0].steps.map((step) => step.id)).toEqual([
      "stp_2",
      "stp_3",
      "stp_new",
      "stp_4",
      "stp_5",
      "stp_6",
    ]);
    file = addStep(file, "sch_1", { label: "資料集め", days: 2, afterStepId: null }, () => ids("stp"), "t");
    expect(file.schedules[0].steps[0]).toMatchObject({ label: "資料集め", key: "custom" });
    file = moveStep(file, "sch_1", "stp_new", -1, "t");
    expect(file.schedules[0].steps.map((step) => step.id).slice(1, 4)).toEqual(["stp_2", "stp_new", "stp_3"]);
    // 端では何もしない
    expect(moveStep(file, "sch_1", "stp_1", -1, "t").schedules[0].steps[0].id).toBe("stp_1");
    file = removeStep(file, "sch_1", "stp_new", "t");
    expect(file.schedules[0].steps.some((step) => step.id === "stp_new")).toBe(false);
  });

  test("無い段・無いスケジュールは止める", () => {
    expect(() => removeStep(fileWith(), "sch_1", "nothing", "t")).toThrow("見つかりません");
    expect(() => removeSchedule(fileWith(), "nothing")).toThrow("見つかりません");
  });
});

describe("スケジュールの書き換え", () => {
  test("名前・マイルストーン・予定の字数を直せる", () => {
    const file = updateSchedule(fileWith(), "sch_1", { name: "第2巻", milestone: null, targetChars: 120000 }, "t1");
    expect(file.schedules[0]).toMatchObject({ name: "第2巻", milestone: null, targetChars: 120000, updatedAt: "t1" });
  });

  test("応募先に従う公募の名前と締切は、ここでは直させない（二重に持たない）", () => {
    const file = materializeGoalsSchedule({ schemaVersion: "1", schedules: [] }, GOALS_CONTEST_SCHEDULE_ID, "t");
    expect(file.schedules[0].followsGoals).toBe(true);
    expect(() => updateSchedule(file, GOALS_CONTEST_SCHEDULE_ID, { milestone: "2027-01-01" }, "t")).toThrow(
      "作品目標設定"
    );
  });

  test("画面の上だけの公募は、書き換えの前に1度だけファイルへ下ろす", () => {
    const once = materializeGoalsSchedule({ schemaVersion: "1", schedules: [] }, GOALS_CONTEST_SCHEDULE_ID, "t");
    const twice = materializeGoalsSchedule(once, GOALS_CONTEST_SCHEDULE_ID, "t");
    expect(twice.schedules).toHaveLength(1);
    expect(materializeGoalsSchedule(fileWith(), "sch_1", "t").schedules).toHaveLength(1);
  });

  test("応募先に従う公募は2つ置けない", () => {
    const file = materializeGoalsSchedule({ schemaVersion: "1", schedules: [] }, GOALS_CONTEST_SCHEDULE_ID, "t");
    const another = createSchedule({ kind: "contest", name: "", milestone: null, followsGoals: true, now: "t" }, idMaker());
    expect(() => addSchedule(file, { ...another, id: "sch_other" })).toThrow("もうあります");
  });

  test("連載の決まりを直せる。曜日が空・話数が逆なら止める", () => {
    const file = updateSchedule(fileWith("webSerial"), "sch_1", { serial: { weekdays: [5, 2], bufferEpisodes: 10 } }, "t");
    expect(file.schedules[0].serial).toMatchObject({ weekdays: [2, 5], bufferEpisodes: 10 });
    expect(() => updateSchedule(fileWith("webSerial"), "sch_1", { serial: { weekdays: [] } }, "t")).toThrow("曜日");
    expect(() =>
      updateSchedule(fileWith("webSerial"), "sch_1", { serial: { firstEpisode: 5, endEpisode: 3 } }, "t")
    ).toThrow("完結予定");
    expect(() => updateSchedule(fileWith(), "sch_1", { serial: { bufferEpisodes: 1 } }, "t")).toThrow("WEB連載");
  });
});

describe("並行と担い手（6.111.13・6.111.14）", () => {
  test("同時に進める段を選べる。自分自身・無い段は止める。null で前の段の後ろへ戻す", () => {
    // 出版社の雛形：stp_2 打ち合わせ・stp_3 改稿・stp_4 初校…
    const paired = updateStep(fileWith(), "sch_1", "stp_4", { parallelWith: "stp_3" }, "2026-09-23", "t1");
    expect(paired.schedules[0].steps[2].parallelWith).toBe("stp_3");
    expect(() => updateStep(fileWith(), "sch_1", "stp_4", { parallelWith: "stp_4" }, "2026-09-23", "t1")).toThrow("自分自身");
    expect(() => updateStep(fileWith(), "sch_1", "stp_4", { parallelWith: "stp_99" }, "2026-09-23", "t1")).toThrow("見つかりません");
    const back = updateStep(paired, "sch_1", "stp_4", { parallelWith: null }, "2026-09-23", "t2");
    expect(back.schedules[0].steps[2].parallelWith).toBeNull();
  });

  test("段を消すと、その段と並行にしていた段は前の段の後ろへ戻る", () => {
    const paired = updateStep(fileWith(), "sch_1", "stp_4", { parallelWith: "stp_3" }, "2026-09-23", "t1");
    const removed = removeStep(paired, "sch_1", "stp_3", "t2");
    expect(removed.schedules[0].steps.find((s) => s.id === "stp_4")?.parallelWith).toBeNull();
  });

  test("自分で進めるか人に頼むかを切り替えられる。足した段は自分で進める", () => {
    const changed = updateStep(fileWith(), "sch_1", "stp_3", { actor: "others" }, "2026-09-23", "t1");
    expect(changed.schedules[0].steps[1].actor).toBe("others");
    const added = addStep(fileWith(), "sch_1", { label: "告知", days: 2, afterStepId: null }, () => "stp_new", "t");
    expect(added.schedules[0].steps[0]).toMatchObject({ id: "stp_new", actor: "self", parallelWith: null });
  });
});
