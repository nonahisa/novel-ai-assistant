import { describe, expect, test } from "vitest";
import {
  processCommandsUsableHere,
  processRequiredCommands,
} from "../../../src/core/processAvailability";
import { canRunProcesses } from "../../../src/core/runtime";
import {
  STEP_MENU,
  filterStepsForRuntime,
  type Step,
} from "../../../src/views/stepMenu";

/**
 * 簡単ステップメニューも、ブラウザ版で使えない操作を並べない（作者の裁定、
 * 2026-10-31「ブラウザー版も隠す」。設計書5.8.16）。
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

  /*
    **画面がブラウザかでは分けない**（作者の裁定、2026-10-31「動くものは出す」）。
    Codespaces など、拡張機能が Node で動く所では出す
  */
  test("出す・隠すは、外部プロセスを起こせるかだけで決まる", () => {
    expect(processCommandsUsableHere()).toBe(canRunProcesses());
  });
});
