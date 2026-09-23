import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { scheduleMilestones } from "../../../src/mcp/tools/scheduleMilestones";
import { exposureOf, setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { collectMilestones, workCalendarKey } from "../../../src/core/scheduleMilestones";
import { parseScheduleFile } from "../../../src/models/schedule";

/**
 * MCP の `schedule.milestones`（設計書6.111.15）。
 *
 * - 作品ごとに許可を確かめ、**許可の無い作品は名前も日付も返さない**（断ったことだけ）
 * - 拡張機能の .ics と**同じ UID・日付**を返す（同じ関数を通す）
 * - 壊れた JSON は直さず、読めなかったと返す
 * - 書庫を渡すと、直下の作品を全部見る
 */

const root = nodePath.join(__dirname, "../../..");
const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");

let library: string;

function makeWork(name: string, options: { allow?: string[]; schedule?: unknown; createdAt?: string } = {}): string {
  const folder = nodePath.join(library, name);
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.mkdirSync(nodePath.join(folder, "設定"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "config.json"),
    JSON.stringify({ schemaVersion: "1", workTitle: name, manuscriptDir: "本文", settingsDir: "設定", createdAt: options.createdAt ?? `2026-01-01T00:00:00.000Z#${name}` })
  );
  if (options.schedule !== undefined) {
    fs.writeFileSync(
      nodePath.join(folder, "設定", "スケジュール.json"),
      typeof options.schedule === "string" ? options.schedule : JSON.stringify(options.schedule)
    );
  }
  if (options.allow) {
    fs.writeFileSync(
      nodePath.join(folder, ".aiwriter", "external-access.json"),
      JSON.stringify({
        schemaVersion: "2",
        clients: [{ name: "claude-code", tools: options.allow, sampling: false, decidedAt: "" }],
      })
    );
  }
  return folder;
}

const schedule = {
  schemaVersion: "1",
  schedules: [
    {
      id: "sch_a",
      kind: "publisher",
      name: "○○社",
      followsGoals: false,
      milestone: "2027-03-01",
      targetChars: null,
      steps: [
        { id: "stp_1", key: "firstProof", label: "初校", days: 14, due: "2027-01-20", status: "todo", doneAt: null, note: "" },
        { id: "stp_2", key: "secondProof", label: "再校", days: 10, due: null, status: "todo", doneAt: null, note: "" },
      ],
      serial: null,
      note: "",
      createdAt: "",
      updatedAt: "",
    },
  ],
};

beforeEach(() => {
  library = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-schedule-mcp-"));
  setExternalClientName("claude-code");
});

afterEach(() => {
  fs.rmSync(library, { recursive: true, force: true });
  setExternalClientName("");
});

describe("schedule.milestones", () => {
  test("サーバーに登録され、記録の転送層を通る。原稿には触れない", () => {
    expect(server).toContain('registerTool(\n  "schedule.milestones"');
    expect(server).toContain('tool("schedule.milestones"');
    expect(exposureOf("schedule.milestones", { folder: "x" })).toBe("none");
  });

  test("許可のある作品だけ返し、許可の無い作品は名前も日付も返さない", () => {
    makeWork("許した作品", { allow: ["schedule.milestones"], schedule });
    const secret = makeWork("許していない作品", { allow: ["novel.scan"], schedule });
    const result = scheduleMilestones({ folders: [library] });
    expect(result.milestones.map((m) => m.title)).toEqual([
      "初校の期日：許した作品（○○社）",
      "発売日：許した作品（○○社）",
    ]);
    expect(result.denied.map((d) => d.folder)).toEqual([secret]);
    expect(JSON.stringify(result.milestones)).not.toContain("許していない作品");
    // 断ったことはその作品にノックとして残る（次に開いたときに訊かれる）
    const log = fs.readFileSync(nodePath.join(secret, ".aiwriter", "history", "external.jsonl"), "utf8");
    expect(log).toContain("schedule.milestones");
  });

  test("拡張機能の .ics と同じ UID と日付", () => {
    const folder = makeWork("作品", { allow: ["*"], schedule, createdAt: "2026-02-03T04:05:06.000Z" });
    const result = scheduleMilestones({ folders: [folder] });
    const expected = collectMilestones({
      workKey: workCalendarKey("2026-02-03T04:05:06.000Z", "作品"),
      workTitle: "作品",
      file: parseScheduleFile(schedule),
      goalsContest: null,
      now: "",
    });
    expect(result.milestones.map((m) => [m.uid, m.date])).toEqual(expected.map((m) => [m.uid, m.date]));
  });

  test("壊れた JSON は直さず、読めなかったと返す（ほかの作品は返す）", () => {
    const broken = makeWork("壊れた作品", { allow: ["*"], schedule: "{ 壊れている" });
    makeWork("正しい作品", { allow: ["*"], schedule });
    const result = scheduleMilestones({ folders: [library] });
    expect(result.unreadable.map((u) => u.folder)).toEqual([broken]);
    expect(fs.readFileSync(nodePath.join(broken, "設定", "スケジュール.json"), "utf8")).toBe("{ 壊れている");
    expect(result.milestones.length).toBe(2);
  });

  test("作品が見つからなければ、何を渡せばよいかを言う", () => {
    expect(() => scheduleMilestones({ folders: [library] })).toThrow("作品フォルダー");
  });
});
