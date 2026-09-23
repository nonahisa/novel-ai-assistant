import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  COMMON_GOALS_MESSAGE,
  commonGoalsDescription,
  editCommonWritingGoals,
  parseGoalInput,
} from "../../../src/features/commonWritingGoals";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";
import { ConfigurationTarget, window, workspace } from "../support/vscodeStub";

/**
 * 全作品共通の「1日の目標」「1か月の目標」を決める入口（作者の指摘、ノートPCの
 * 実機確認 2026-09-23：「それは素人にわかりにくいと思います。で、ここにメニューがありません」）。
 *
 * - 作品目標設定から押せる。執筆統計の画面（1作品・全作品）からも押せる
 * - **書き先はユーザー（全体）の設定**。作品やワークスペースの設定に書かない
 * - 0（または空）で未設定。全角数字・桁区切りも受ける
 */

const ROOT = resolve(__dirname, "..", "..", "..");

let stored: Record<string, number>;
let writes: { key: string; value: unknown; target: unknown }[];
let inputs: (string | undefined)[];
let prompts: { title?: string; prompt?: string; value?: string }[];
let informed: string[];

beforeEach(() => {
  stored = { "stats.dailyGoal": 1000, "stats.monthlyGoal": 0 };
  writes = [];
  inputs = [];
  prompts = [];
  informed = [];
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T => (key in stored ? (stored[key] as T) : defaultValue),
    update: async (key: string, value: unknown, target: unknown) => {
      writes.push({ key, value, target });
    },
    inspect: () => ({}),
  })) as unknown as typeof workspace.getConfiguration;
  Object.assign(window, {
    showInputBox: async (options: { title?: string; prompt?: string; value?: string }) => {
      prompts.push(options);
      return inputs.shift();
    },
    showInformationMessage: async (text: string) => {
      informed.push(text);
      return undefined;
    },
    showWarningMessage: async (text: string) => {
      informed.push(text);
      return undefined;
    },
  });
});

describe("数の読み方", () => {
  test("全角数字・桁区切り・「字」を受ける", () => {
    expect(parseGoalInput("１，５００")).toBe(1500);
    expect(parseGoalInput("30,000字")).toBe(30000);
    expect(parseGoalInput(" 800 ")).toBe(800);
  });

  test("0 と空は「未設定」（0）", () => {
    expect(parseGoalInput("0")).toBe(0);
    expect(parseGoalInput("")).toBe(0);
    expect(parseGoalInput("０")).toBe(0);
  });

  test("数でないものは受けない", () => {
    expect(parseGoalInput("たくさん")).toBeNull();
    expect(parseGoalInput("-5")).toBeNull();
    expect(parseGoalInput("1.5")).toBeNull();
  });
});

describe("決める画面", () => {
  test("いまの値を見せ、1日・1か月を順に訊き、ユーザー（全体）の設定に書く", async () => {
    inputs = ["１，５００", "0"];
    const changed = await editCommonWritingGoals();
    expect(changed).toBe(true);
    expect(prompts[0].value).toBe("1000");
    expect(prompts[1].value).toBe("");
    // 全作品で共通であることを画面で断る
    expect(prompts[0].title).toContain("全作品共通");
    expect(prompts[0].prompt).toContain("全作品");
    expect(writes).toEqual([
      { key: "stats.dailyGoal", value: 1500, target: ConfigurationTarget.Global },
      { key: "stats.monthlyGoal", value: 0, target: ConfigurationTarget.Global },
    ]);
    expect(informed.join("\n")).toContain("1日 1,500字");
    expect(informed.join("\n")).toContain("1か月 未設定");
  });

  test("途中でやめたら何も書かない", async () => {
    inputs = ["2000", undefined];
    expect(await editCommonWritingGoals()).toBe(false);
    expect(writes).toEqual([]);
  });

  test("いまの値の言い方（作品目標設定の説明に出す）", () => {
    expect(commonGoalsDescription(1000, 0)).toBe("1日 1,000字・1か月 未設定");
    expect(commonGoalsDescription(0, 0)).toBe("どちらも未設定");
  });
});

describe("入口", () => {
  test("作品目標設定に「1日・1か月の目標（全作品共通）」がある", () => {
    const source = readFileSync(resolve(ROOT, "src/features/setWorkGoals.ts"), "utf8");
    expect(source).toContain("1日・1か月の目標（全作品共通）");
    expect(source).toContain("editCommonWritingGoals(");
  });

  test("執筆統計の画面（1作品・全作品の同じ部品）から押せる", () => {
    const html = buildWritingStatsPanelHtml("N", "vscode-resource:");
    expect(html).toContain(`type: '${COMMON_GOALS_MESSAGE}'`);
    expect(html).toContain("目標を決める");
    for (const file of ["src/features/writingStatsPanel.ts", "src/features/allWorksWritingStatsPanel.ts"]) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      expect(source, file).toContain("COMMON_GOALS_MESSAGE");
      expect(source, file).toContain("editCommonWritingGoals(");
    }
  });
});
