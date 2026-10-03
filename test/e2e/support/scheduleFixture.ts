/**
 * スケジュール画面（`設定/スケジュール.json`）の見本を、製品が読む形で置く・画面の面を探す・
 * 画面に描かれた段や点を読む（設計書6.111・6.113）。**AI は呼ばない。**
 *
 * - 見本は `models/schedule.ts` の形（`parseScheduleFile` が検査する）で、**起こす前に置く**
 *   （`LaunchOptions.prepareWork`。起きてから書くと「外で変更されました」の知らせが揺れて出る）
 * - 日付は**今日からの日数**で組む。画面の「今日」は拡張機能の側の時計で決まり、テストからは
 *   動かせないため、固定の日付を置くと日がたつと意味が変わる
 * - 画面の読み取りは `schedulePanelHtml.ts` の DOM（`.bar`・`.dot`・`.milestone`・`#detail`）に頼る。
 *   そこを直したらここも直す
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { DEFAULT_SETTINGS_DIR } from "../../../src/models/types";
import type { Schedule, ScheduleFile, ScheduleStep, SerialRule, StepKey, StepStatus } from "../../../src/models/schedule";
import { SCHEDULE_FILE } from "../../../src/models/schedule";
import { POSTING_FILE } from "../../../src/models/posting";
/**
 * 1日の境の既定（時）。製品の `stats.dayBoundaryHour`（`features/writingProgress.ts`、
 * `core/writingStats.ts` の `DEFAULT_DAY_BOUNDARY_HOUR`）と同じ値。
 * **そちらを読み込まない**——`writingStats` は `vscode` の型を持つ部品を読み、画面の自動テストの
 * 型検査（`vscode` の型を入れない）が通らなくなる。境の既定を変えたらここも直す
 */
const DAY_BOUNDARY_HOUR = 4;

/**
 * 今日からの日数ぶん進めた日付（`YYYY-MM-DD`）。
 *
 * **製品の「今日」と同じ決め方にする**（`features/scheduleData.ts` の `scheduleToday`＝
 * 1日の境の設定〔既定4時〕で区切った日。**午前0〜4時は前の日が今日**）。端末の暦の日付で組むと、
 * 夜中に走らせたときに1日ずれる（2026-10-04 午前0時台に踏んだ）
 */
export function dayKey(offsetDays: number): string {
  // 製品の `statsDayKey` と同じ：境の時間ぶん戻した時刻の（端末の暦の）日付
  const shifted = new Date(Date.now() - DAY_BOUNDARY_HOUR * 3_600_000);
  const date = new Date(Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() + offsetDays));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 段の見本（印・名前・日数。状態は未着手が既定） */
export function step(
  id: string,
  key: StepKey,
  label: string,
  days: number,
  extra: Partial<ScheduleStep> = {}
): ScheduleStep {
  return {
    id,
    key,
    label,
    days,
    due: null,
    status: "todo" as StepStatus,
    doneAt: null,
    note: "",
    parallelWith: null,
    ...extra,
  };
}

const STAMP = "2026-10-01T00:00:00.000Z";

/** スケジュール1件の見本。足りない欄は空にする */
export function schedule(
  input: Pick<Schedule, "id" | "kind" | "name" | "steps"> & Partial<Schedule>
): Schedule {
  return {
    followsGoals: false,
    milestone: null,
    targetChars: null,
    serial: null,
    note: "",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...input,
  };
}

/** 自費出版の段（雛形と同じ印・日数。表紙は推敲と同時に進める） */
export function selfPublishSteps(): ScheduleStep[] {
  return [
    step("sp-write", "write", "執筆（初稿まで）", 30),
    step("sp-revise", "revise", "推敲", 10),
    step("sp-cover", "cover", "表紙の用意", 14, { parallelWith: "sp-revise" }),
    step("sp-proof", "proof", "最終校正", 7),
    step("sp-submit", "submitFiles", "入稿（EPUB・PDF）", 3),
    step("sp-review", "storeReview", "配信の申請（ストアの審査）", 7),
  ];
}

/** 作品フォルダーの `スケジュール.json`（登録の前なので、設定の置き場は既定の名前） */
export function scheduleFilePath(workFolder: string): string {
  return path.join(workFolder, DEFAULT_SETTINGS_DIR, SCHEDULE_FILE);
}

/** 起こす前に、スケジュールの見本を置く（`LaunchOptions.prepareWork` から呼ぶ） */
export async function writeScheduleFile(workFolder: string, schedules: readonly Schedule[]): Promise<void> {
  const file = scheduleFilePath(workFolder);
  await mkdir(path.dirname(file), { recursive: true });
  const body: ScheduleFile = { schemaVersion: "1", schedules: [...schedules] };
  await writeFile(file, JSON.stringify(body, null, 2), "utf8");
}

/** 製品が書いた `スケジュール.json` を読む（登録のあとなので、置き場は作品の設定の置き場） */
export async function readScheduleFile(workFolder: string): Promise<ScheduleFile> {
  return JSON.parse(await readFile(scheduleFilePath(workFolder), "utf8")) as ScheduleFile;
}

/** スケジュール画面の面（日付の目盛りの親 `#grid` を持つ） */
export async function scheduleFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.querySelector("#grid") !== null && document.querySelector("#showFinished") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 画面に描かれた段（`.bar`）。名前は吹き出しの1行目（描かれた字は細い帯だと省かれるため） */
export interface DrawnBar {
  /** 吹き出し（title）の1行目から「　」より前 */
  label: string;
  /** 帯の上端（画面の中の px。時間は下へ進む） */
  top: number;
  height: number;
  left: number;
  width: number;
  classes: string[];
}

export async function drawnBars(frame: Frame): Promise<DrawnBar[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll(".lane .bar")).map((bar) => {
      const node = bar as HTMLElement;
      const title = (node.getAttribute("title") ?? "").split("\n")[0] ?? "";
      const rect = node.getBoundingClientRect();
      return {
        label: title.split("　")[0] ?? "",
        top: rect.top,
        height: rect.height,
        left: rect.left,
        width: rect.width,
        classes: Array.from(node.classList),
      };
    })
  );
}

/** WEB連載の決まり（毎日更新。書き溜め2話・第1話から。カクヨムの記録で投稿済みを見る） */
export function serialRule(extra: Partial<SerialRule> = {}): SerialRule {
  return {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    time: null,
    bufferEpisodes: 2,
    firstEpisode: 1,
    endEpisode: 8,
    endDate: null,
    charsPerEpisode: 2000,
    site: "kakuyomu",
    ...extra,
  };
}

/**
 * 投稿状態の台帳（`設定/投稿状態.json`）へ、「投稿した」記録を置く（起こす前に）。
 * `episodePath` は作品フォルダーからの相対パス（区切りは `/`）。**サイトは kakuyomu**
 */
export async function writePostingLedger(workFolder: string, postedEpisodePaths: readonly string[]): Promise<void> {
  const file = path.join(workFolder, DEFAULT_SETTINGS_DIR, POSTING_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const body = {
    schemaVersion: "1",
    sites: [],
    posts: postedEpisodePaths.map((episodePath) => ({
      episodePath,
      site: "kakuyomu",
      postedAt: new Date().toISOString(),
    })),
  };
  await writeFile(file, JSON.stringify(body, null, 2), "utf8");
}
