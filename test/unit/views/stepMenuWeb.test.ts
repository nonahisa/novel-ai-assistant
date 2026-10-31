import { afterEach, describe, expect, test } from "vitest";
import { processRequiredCommands } from "../../../src/core/processAvailability";
import { menuAllowsProcesses } from "../../../src/views/actionList";
import {
  STEP_MENU,
  filterStepsForRuntime,
  type Step,
} from "../../../src/views/stepMenu";
import { UIKind, env } from "../support/vscodeStub";

/**
 * 簡単ステップメニューも、ブラウザ版で使えない操作を並べない（作者の裁定、
 * 2026-10-31「ブラウザー版も隠す」。設計書5.8.5）。
 */

function commandsOf(steps: readonly Step[]): string[] {
  return steps.flatMap((step) =>
    step.entries.flatMap((entry) =>
      entry.kind === "action"
        ? [entry.command]
        : entry.kind === "section"
          ? entry.items.map((item) => item.command)
          : []
    )
  );
}

afterEach(() => {
  env.uiKind = UIKind.Desktop;
});

describe("ブラウザ版の簡単ステップメニュー", () => {
  test("外部プロセスの要る操作は並べない", () => {
    const needs = new Set(processRequiredCommands());
    const shown = commandsOf(filterStepsForRuntime(STEP_MENU, false));
    expect(shown.filter((command) => needs.has(command))).toEqual([]);
    // 手元では今までどおり並ぶ（隠すのはブラウザ版だけ）
    const local = commandsOf(filterStepsForRuntime(STEP_MENU, true));
    expect(local.some((command) => needs.has(command))).toBe(true);
  });

  test("空になった段・小分類は畳む", () => {
    for (const step of filterStepsForRuntime(STEP_MENU, false)) {
      expect(step.entries.length, step.label).toBeGreaterThan(0);
      for (const entry of step.entries) {
        if (entry.kind === "section") {
          expect(entry.items.length, entry.label).toBeGreaterThan(0);
        }
      }
    }
  });

  test("画面がブラウザ（isWeb）なら、自前のメニューも隠す側に回る", () => {
    expect(menuAllowsProcesses()).toBe(true);
    env.uiKind = UIKind.Web;
    expect(menuAllowsProcesses()).toBe(false);
  });
});
