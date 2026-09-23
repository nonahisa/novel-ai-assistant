import type { StepStatus } from "../models/schedule";
import type { SchedulePatch, StepPatch } from "./scheduleEdit";

/**
 * スケジュールの画面（WebView）から届く知らせの形（設計書6.111.7）。
 *
 * **画面から来た値は信用しない。** 形の合わないものは null にして捨てる
 * （値の中身——日付の形・日数の範囲——は `scheduleEdit.ts` がもう一度確かめる）。
 *
 * VS Code API には依存しない。
 */

export type ScheduleMessage =
  | { type: "ready" }
  | { type: "setShowFinished"; value: boolean }
  | { type: "addSchedule"; workId: string | null }
  | { type: "openWork"; workId: string }
  | { type: "openFile"; workId: string }
  | { type: "updateStep"; workId: string; scheduleId: string; stepId: string; patch: StepPatch }
  | { type: "addStep"; workId: string; scheduleId: string; afterStepId: string | null; label: string; days: number }
  | { type: "removeStep"; workId: string; scheduleId: string; stepId: string }
  | { type: "moveStep"; workId: string; scheduleId: string; stepId: string; direction: -1 | 1 }
  | { type: "updateSchedule"; workId: string; scheduleId: string; patch: SchedulePatch }
  | { type: "removeSchedule"; workId: string; scheduleId: string }
  /** 大きなマイルストーンを .ics へ書き出す（6.111.15） */
  | { type: "exportIcs" }
  /** 祝日の一覧を取り込む（押したときだけ通信。6.111.12） */
  | { type: "importHolidays" }
  /** 作業量の割合の設定を開く */
  | { type: "openWorkloadSettings" };

const STATUSES: readonly StepStatus[] = ["todo", "doing", "done"];

export function parseScheduleMessage(raw: unknown): ScheduleMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string): string | null => {
    const field = value[key];
    return typeof field === "string" && field.length > 0 && field.length <= 200 ? field : null;
  };
  const workId = text("workId");
  const scheduleId = text("scheduleId");
  const stepId = text("stepId");
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "setShowFinished":
      return typeof value.value === "boolean" ? { type: "setShowFinished", value: value.value } : null;
    case "addSchedule":
      return { type: "addSchedule", workId };
    case "openWork":
    case "openFile":
      return workId ? { type: value.type, workId } : null;
    case "updateStep": {
      const patch = stepPatch(value.patch);
      return workId && scheduleId && stepId && patch ? { type: "updateStep", workId, scheduleId, stepId, patch } : null;
    }
    case "addStep": {
      const label = typeof value.label === "string" ? value.label : null;
      const days = typeof value.days === "number" ? value.days : null;
      const after = value.afterStepId === null ? null : text("afterStepId");
      if (!workId || !scheduleId || label === null || days === null) return null;
      if (value.afterStepId !== null && after === null) return null;
      return { type: "addStep", workId, scheduleId, afterStepId: after, label, days };
    }
    case "removeStep":
      return workId && scheduleId && stepId ? { type: "removeStep", workId, scheduleId, stepId } : null;
    case "moveStep":
      return workId && scheduleId && stepId && (value.direction === -1 || value.direction === 1)
        ? { type: "moveStep", workId, scheduleId, stepId, direction: value.direction }
        : null;
    case "updateSchedule": {
      const patch = schedulePatch(value.patch);
      return workId && scheduleId && patch ? { type: "updateSchedule", workId, scheduleId, patch } : null;
    }
    case "removeSchedule":
      return workId && scheduleId ? { type: "removeSchedule", workId, scheduleId } : null;
    case "exportIcs":
    case "importHolidays":
    case "openWorkloadSettings":
      return { type: value.type };
    default:
      return null;
  }
}

function stepPatch(raw: unknown): StepPatch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const patch: { -readonly [K in keyof StepPatch]: StepPatch[K] } = {};
  if (typeof value.label === "string") patch.label = value.label;
  if (typeof value.days === "number") patch.days = value.days;
  if (value.due === null || typeof value.due === "string") patch.due = value.due === "" ? null : value.due;
  if (typeof value.status === "string") {
    if (!STATUSES.includes(value.status as StepStatus)) return null;
    patch.status = value.status as StepStatus;
  }
  if (typeof value.note === "string") patch.note = value.note;
  if (value.parallelWith === null || value.parallelWith === "") {
    patch.parallelWith = null;
  } else if (typeof value.parallelWith === "string") {
    if (value.parallelWith.length > 200) return null;
    patch.parallelWith = value.parallelWith;
  }
  if (value.actor !== undefined) {
    if (value.actor !== "self" && value.actor !== "others") return null;
    patch.actor = value.actor;
  }
  return patch;
}

function schedulePatch(raw: unknown): SchedulePatch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const patch: { -readonly [K in keyof SchedulePatch]: SchedulePatch[K] } = {};
  if (typeof value.name === "string") patch.name = value.name;
  if (value.milestone === null || typeof value.milestone === "string") {
    patch.milestone = value.milestone === "" ? null : value.milestone;
  }
  if (value.targetChars === null || typeof value.targetChars === "number") patch.targetChars = value.targetChars;
  if (typeof value.note === "string") patch.note = value.note;
  if (typeof value.serial === "object" && value.serial !== null) {
    const serial = value.serial as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (Array.isArray(serial.weekdays)) out.weekdays = serial.weekdays;
    if (serial.time === null || typeof serial.time === "string") out.time = serial.time === "" ? null : serial.time;
    for (const key of ["bufferEpisodes", "firstEpisode"] as const) {
      if (typeof serial[key] === "number") out[key] = serial[key];
    }
    for (const key of ["endEpisode", "charsPerEpisode"] as const) {
      if (serial[key] === null || typeof serial[key] === "number") out[key] = serial[key];
    }
    if (serial.endDate === null || typeof serial.endDate === "string") {
      out.endDate = serial.endDate === "" ? null : serial.endDate;
    }
    if (serial.site === null || typeof serial.site === "string") out.site = serial.site === "" ? null : serial.site;
    patch.serial = out as SchedulePatch["serial"];
  }
  return patch;
}
