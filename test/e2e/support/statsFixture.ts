/**
 * 執筆統計の画面（`.aiwriter/stats/<環境名>.json` が元）の見本を、製品が読む形で置く・
 * 画面の面を探す・描かれたグラフを読む（設計書6.3・6.113）。**AI は呼ばない。**
 *
 * - 見本は `models/writingStats.ts` の形（`schemaVersion: "1"`・`deviceId`・`days[]`）。
 *   **起こす前に置く**（`LaunchOptions.prepareWork`）
 * - 日付は `dayKey`（`scheduleFixture.ts`）と同じく、製品の「今日」（1日の境4時）に合わせる
 * - 画面の読み取りは `writingStatsPanelHtml.ts` の DOM（`#chart` の SVG・`.goal-label`・`.bar`・
 *   `.tick`・`#episode-table`）に頼る。そこを直したらここも直す
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { dayKey } from "./scheduleFixture";

/** 1日の記録（見本）。`net`＝その日に増えた純字数 */
export interface SampleDay {
  /** 今日からの日数（0＝今日、-1＝昨日） */
  offset: number;
  net: number;
}

/** 起こす前に、統計の見本を置く。環境名は製品の規則（英数字と `-` `_`）に合わせる */
export async function writeStatsFile(
  workFolder: string,
  days: readonly SampleDay[],
  deviceId = "e2e-device"
): Promise<void> {
  const folder = path.join(workFolder, ".aiwriter", "stats");
  await mkdir(folder, { recursive: true });
  const body = {
    schemaVersion: "1",
    deviceId,
    days: days.map((day) => ({ date: dayKey(day.offset), net: day.net, gross: day.net, saves: 1 })),
  };
  await writeFile(path.join(folder, `${deviceId}.json`), JSON.stringify(body, null, 2), "utf8");
}

/** 執筆統計の画面の面（日ごとのグラフ `#chart` を持つ） */
export async function statsFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.querySelector("#chart") !== null && document.querySelector("#cards") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 日ごとのグラフの横送りの状態（グラフを包む箱） */
export async function chartScroll(
  frame: Frame
): Promise<{ left: number; client: number; scrollWidth: number; atRight: boolean }> {
  return frame.evaluate(() => {
    const wrap = (document.getElementById("chart") as Element).parentElement as HTMLElement;
    return {
      left: wrap.scrollLeft,
      client: wrap.clientWidth,
      scrollWidth: wrap.scrollWidth,
      atRight: wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 4,
    };
  });
}

/** 描かれた矩形（画面の中の座標） */
export interface DrawnBox {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** グラフの中の要素の矩形を全部返す（`selector` は `#chart` の下で探す） */
export async function chartBoxes(frame: Frame, selector: string): Promise<DrawnBox[]> {
  return frame.evaluate((query) => {
    return Array.from(document.querySelectorAll(`#chart ${query}`)).map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent ?? "",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
  }, selector);
}
