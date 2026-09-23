import { afterEach, describe, expect, test } from "vitest";
import {
  CONTRADICTION_ROUTE_CHOICES,
  pickContradictionRoute,
} from "../../../src/features/checkContradictions";
import { prerequisiteOf } from "../../../src/core/prerequisites";
import { findAction, isItemShownInActionList } from "../../../src/views/actionList";
import { window } from "../support/vscodeStub";

/**
 * 矛盾検知の入口を1つにした（作者の裁定 A7・計画 C1、2026-09-23）。
 *
 * 以前は「矛盾を検知」（設定との照合）と「矛盾検知（事実の照合）」（話どうし）
 * が詳細メニューに並んでいた。押した入口で「両方／設定との照合だけ／話どうし
 * だけ」を選ぶ。設定資料が無ければ、押した時点で前提の関門が知らせる。
 */
const original = window.showQuickPick;
afterEach(() => {
  Object.assign(window, { showQuickPick: original });
});

describe("矛盾検知の入口", () => {
  test("詳細メニューに出るのは「矛盾検知」1つ（事実の照合は画面から外す）", () => {
    const unified = findAction("novelai.checkContradictions");
    const facts = findAction("novelai.checkFactContradictions");

    expect(unified?.label).toBe("矛盾検知");
    expect(isItemShownInActionList(unified!, true)).toBe(true);
    // コマンドは残す（パレットと、関門の代わりの道が使う）
    expect(facts).toBeDefined();
    expect(isItemShownInActionList(facts!, true)).toBe(false);
  });

  test("押すと、両方・設定との照合だけ・話どうしだけ の順に並ぶ", () => {
    expect(CONTRADICTION_ROUTE_CHOICES.map((choice) => choice.route)).toEqual([
      "both",
      "settings",
      "facts",
    ]);
    // 両方は、AIを2回呼ぶことと、確認が2回出ることを先に言う
    const both = CONTRADICTION_ROUTE_CHOICES[0];
    expect(both.detail).toContain("2回");
    expect(both.detail).toContain("足し算");
    expect(both.detail).toContain("確認");
  });

  test("選んだ道を返し、閉じたら何も返さない", async () => {
    let seen: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => {
        seen = items;
        return items[2];
      },
    });
    expect(await pickContradictionRoute()).toBe("facts");
    // 出口を見える形で置く
    expect(String(seen[seen.length - 1].label)).toContain("取りやめる");

    Object.assign(window, { showQuickPick: async () => undefined });
    expect(await pickContradictionRoute()).toBeUndefined();
  });

  /**
   * **設定資料が無ければ、押す前に知らせる**（作者の裁定 A7）。関門が
   * 「代わりに『矛盾検知（事実の照合）』を使う」の説明としてこの一文を出す。
   */
  test("設定資料が無いときの一文は、作者の言葉どおり", () => {
    const { needs, insteadOf } = prerequisiteOf("novelai.checkContradictions");

    expect(needs).toEqual(["settings"]);
    expect(insteadOf?.command).toBe("novelai.checkFactContradictions");
    expect(insteadOf?.why).toContain("設定との食い違いは見られません");
    expect(insteadOf?.why).toContain("話どうしの照合だけ走ります");
  });
});
