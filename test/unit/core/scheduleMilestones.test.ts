import { describe, expect, test } from "vitest";
import type { Schedule, ScheduleFile, ScheduleStep } from "../../../src/models/schedule";
import {
  buildIcs,
  collectMilestones,
  escapeText,
  foldLine,
  milestoneUid,
  workCalendarKey,
} from "../../../src/core/scheduleMilestones";

/**
 * カレンダーへ出すマイルストーン（設計書6.111.15）。大きな予定だけを出すこと、
 * 日付を変えても UID が変わらないこと、RFC 5545 の形（CRLF・折り返し・逃がし・終日）。
 */

function step(id: string, extra: Partial<ScheduleStep> = {}): ScheduleStep {
  return { id, key: "custom", label: id, days: 3, due: null, status: "todo", doneAt: null, note: "", ...extra };
}

function schedule(patch: Partial<Schedule>): Schedule {
  return {
    id: "sch_a",
    kind: "publisher",
    name: "○○社",
    followsGoals: false,
    milestone: "2027-03-01",
    targetChars: null,
    steps: [],
    serial: null,
    note: "",
    createdAt: "",
    updatedAt: "",
    ...patch,
  };
}

const file = (schedules: Schedule[]): ScheduleFile => ({ schemaVersion: "1", schedules });

describe("出すもの", () => {
  test("マイルストーンと手で入れた期日だけ。逆算の段の日付は出さない", () => {
    const list = collectMilestones({
      workKey: "wkey",
      workTitle: "星の話",
      file: file([
        schedule({ steps: [step("stp_1", { label: "改稿" }), step("stp_2", { label: "初校", due: "2027-01-20" })] }),
      ]),
      goalsContest: null,
      now: "",
    });
    expect(list.map((m) => [m.date, m.title])).toEqual([
      ["2027-01-20", "初校の期日：星の話（○○社）"],
      ["2027-03-01", "発売日：星の話（○○社）"],
    ]);
  });

  test("種類ごとの呼び名（締切・発売日・連載開始）", () => {
    const list = collectMilestones({
      workKey: "k",
      workTitle: "作品",
      file: file([
        schedule({ id: "s1", kind: "contest", name: "○○賞", milestone: "2026-12-01" }),
        schedule({ id: "s2", kind: "selfPublish", name: "Kindle版", milestone: "2027-02-01" }),
        schedule({ id: "s3", kind: "webSerial", name: "カクヨム連載", milestone: "2026-10-01", serial: null }),
      ]),
      goalsContest: null,
      now: "",
    });
    expect(list.map((m) => m.title)).toEqual([
      "連載開始：作品（カクヨム連載）",
      "締切：作品（○○賞）",
      "発売日：作品（Kindle版）",
    ]);
  });

  test("作品目標設定の応募先に従う公募は、応募先の名前と締切で出す。外れていれば出さない", () => {
    const follows = schedule({ id: "sch_goals", kind: "contest", name: "", followsGoals: true, milestone: null });
    const withGoals = collectMilestones({
      workKey: "k",
      workTitle: "作品",
      file: file([follows]),
      goalsContest: { name: "□□大賞", deadline: "2027-01-10", targetChars: null },
      now: "",
    });
    expect(withGoals.map((m) => m.title)).toEqual(["締切：作品（□□大賞）"]);
    const detached = collectMilestones({ workKey: "k", workTitle: "作品", file: file([follows]), goalsContest: null, now: "" });
    expect(detached).toEqual([]);
  });

  test("ファイルにまだ公募が無くても、応募先があれば画面と同じく締切を出す", () => {
    const list = collectMilestones({
      workKey: "k",
      workTitle: "作品",
      file: file([]),
      goalsContest: { name: "□□大賞", deadline: "2027-01-10", targetChars: null },
      now: "",
    });
    expect(list.map((m) => m.date)).toEqual(["2027-01-10"]);
  });
});

describe("UID", () => {
  test("日付を変えても同じ UID（取り込み直すと上書きされる）", () => {
    const at = (date: string) =>
      collectMilestones({ workKey: "k", workTitle: "作品", file: file([schedule({ milestone: date })]), goalsContest: null, now: "" })[0].uid;
    expect(at("2027-03-01")).toBe(at("2027-04-15"));
    expect(at("2027-03-01")).toBe("k-sch_a-release@novel-ai-assistant");
  });

  test("作品が違えば、同じスケジュールID（sch_goals）でも別の UID", () => {
    const a = workCalendarKey("2026-01-01T00:00:00.000Z", "星の話");
    const b = workCalendarKey("2026-02-01T00:00:00.000Z", "星の話");
    expect(milestoneUid(a, "sch_goals", "deadline")).not.toBe(milestoneUid(b, "sch_goals", "deadline"));
  });

  test("作品の鍵は作成日時から決まる（機器が違っても同じ）。無ければフォルダーの名前", () => {
    expect(workCalendarKey("2026-01-01T00:00:00.000Z", "A")).toBe(workCalendarKey("2026-01-01T00:00:00.000Z", "B"));
    expect(workCalendarKey(null, "A")).not.toBe(workCalendarKey(null, "B"));
    expect(workCalendarKey("", "A")).toMatch(/^w[0-9a-f]{12}$/);
  });

  test("UID に使えない文字は置き換える", () => {
    expect(milestoneUid("k", "sch 1/2", "due-stp_1")).toBe("k-sch_1_2-due-stp_1@novel-ai-assistant");
  });
});

describe("iCalendar の形（RFC 5545）", () => {
  const milestones = collectMilestones({
    workKey: "k",
    workTitle: "星の話, 第2部; 完結編",
    file: file([schedule({ steps: [step("stp_1", { label: "初校", due: "2026-12-31" })] })]),
    goalsContest: null,
    now: "",
  });
  const ics = buildIcs(milestones, new Date("2026-09-24T01:02:03.456Z"));

  test("行の終わりは CRLF で、終日の予定（終わりは翌日。年またぎ）", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101");
    expect(ics).toContain("DTSTAMP:20260924T010203Z");
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
  });

  test("文字の , ; は逃がす", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("SUMMARY:初校の期日：星の話\\, 第2部\\; 完結編（○○社）");
  });

  test("75オクテットを超える行は折り返し、日本語の文字の途中で切らない", () => {
    const long = "SUMMARY:" + "あ".repeat(60);
    const folded = foldLine(long);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    for (const line of lines) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
    expect(lines.map((line, index) => (index === 0 ? line : line.slice(1))).join("")).toBe(long);
    for (const line of ics.split("\r\n")) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
  });
});
