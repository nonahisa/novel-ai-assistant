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
