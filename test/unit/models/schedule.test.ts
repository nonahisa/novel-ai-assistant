import { describe, expect, test } from "vitest";
import { parseScheduleFile } from "../../../src/models/schedule";
import { createSchedule, type IdMaker } from "../../../src/core/scheduleTemplates";

/**
 * `設定/スケジュール.json` の検証（設計書6.111.2）。
 *
 * **壊れていれば例外を投げる**（直して上書きしない。規則2）。
 * 知らない種類・段・状態を既定に寄せると、新しい版が書いた値を古い版が
 * 別の意味で読み、保存で書き換えてしまう。
 */

const ids: IdMaker = (() => {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
})();

function sample() {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: "1",
      schedules: [
        createSchedule({ kind: "selfPublish", name: "Kindle版", milestone: "2027-03-01", now: "t" }, ids),
        createSchedule({ kind: "webSerial", name: "カクヨム連載", milestone: null, now: "t" }, ids),
      ],
    })
  );
}

describe("スケジュールのファイルを読む", () => {
  test("書いた形をそのまま読み直せる", () => {
    const raw = sample();
    expect(parseScheduleFile(raw)).toEqual(raw);
  });

  test("知らない種類は壊れているとして止める", () => {
    const raw = sample();
    raw.schedules[0].kind = "magazine";
    expect(() => parseScheduleFile(raw)).toThrow("知らない種類");
  });

  test("日付の形が違えば止める（存在しない日付も）", () => {
    const raw = sample();
    raw.schedules[0].milestone = "2027-02-30";
    expect(() => parseScheduleFile(raw)).toThrow("YYYY-MM-DD");
  });

  test("知らない状態・段の日数が範囲外なら止める", () => {
    const status = sample();
    status.schedules[0].steps[0].status = "finished";
    expect(() => parseScheduleFile(status)).toThrow("知らない状態");
    const days = sample();
    days.schedules[0].steps[0].days = 0;
    expect(() => parseScheduleFile(days)).toThrow("1〜3650");
  });

  test("IDが重なれば止める", () => {
    const raw = sample();
    raw.schedules[1].id = raw.schedules[0].id;
    expect(() => parseScheduleFile(raw)).toThrow("重なっています");
  });

  test("応募先に従えるのは公募だけ", () => {
    const raw = sample();
    raw.schedules[0].followsGoals = true;
    expect(() => parseScheduleFile(raw)).toThrow("公募だけ");
  });

  test("連載の曜日が空なら止める", () => {
    const raw = sample();
    raw.schedules[1].serial.weekdays = [];
    expect(() => parseScheduleFile(raw)).toThrow("曜日");
  });

  test("連載の曜日は重なりを除いて並べ直す", () => {
    const raw = sample();
    raw.schedules[1].serial.weekdays = [4, 1, 4];
    expect(parseScheduleFile(raw).schedules[1].serial?.weekdays).toEqual([1, 4]);
  });
});

describe("0.83.0 までのファイル（並行・担い手の欄が無い）を読む", () => {
  // 0.83.0 が書いた形そのもの。欄が増えても、古い形はそのまま読める（無い欄は既定）
  const old = {
    schemaVersion: "1",
    schedules: [
      {
        id: "sch_old",
        kind: "selfPublish",
        name: "Kindle版",
        followsGoals: false,
        milestone: "2027-03-01",
        targetChars: null,
        steps: [
          { id: "stp_a", key: "revise", label: "推敲", days: 10, due: null, status: "todo", doneAt: null, note: "" },
          { id: "stp_b", key: "cover", label: "表紙の用意", days: 14, due: null, status: "doing", doneAt: null, note: "" },
          { id: "stp_c", key: "custom", label: "告知", days: 2, due: null, status: "todo", doneAt: null, note: "" },
        ],
        serial: null,
        note: "",
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  };

  test("並行は「前の段が終わってから」、担い手は段の印ごとの既定で読む（並びを変えない）", () => {
    const steps = parseScheduleFile(JSON.parse(JSON.stringify(old))).schedules[0].steps;
    expect(steps.map((s) => [s.id, s.parallelWith, s.actor])).toEqual([
      ["stp_a", null, "self"],
      ["stp_b", null, "others"],
      ["stp_c", null, "self"],
    ]);
  });

  test("知らない担い手は壊れているとして止める", () => {
    const raw = JSON.parse(JSON.stringify(old));
    raw.schedules[0].steps[0].actor = "robot";
    expect(() => parseScheduleFile(raw)).toThrow("知らない値");
  });

  test("並行の相手は文字で。数などは止める", () => {
    const raw = JSON.parse(JSON.stringify(old));
    raw.schedules[0].steps[1].parallelWith = 3;
    expect(() => parseScheduleFile(raw)).toThrow("段のID");
  });
});
