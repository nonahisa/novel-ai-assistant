import { describe, expect, test, vi } from "vitest";
import { confirmRun, confirmRunOrChoose } from "../../../src/views/notify";
import { workspace } from "../support/vscodeStub";
import { answerConfirms } from "../support/confirmPicker";

/**
 * 実行の確認の窓で、未保存の文書を保存してから走らせる（作者の判断 2026-11-02）。
 *
 * それまでは範囲を選ぶ前に右下の知らせで「未保存の変更が N 件あります。保存して
 * から実行しますか？」と訊いていた。問いを「範囲」と「実行の確認」の2回までに
 * するため、確認の窓に「未保存の N 件を保存してから実行します」と1行書き、
 * ［実行］で保存する。取りやめたら保存しない。
 */

function presave(count: number, saved = true) {
  return { count, save: vi.fn(async () => saved) };
}

/** 覚え書き（`novelai.confirmMemory`）を差し替える（notify.test.ts と同じ形） */
function stubConfirmMemory(initial: Record<string, string>): { restore: () => void } {
  const original = workspace.getConfiguration;
  workspace.getConfiguration = ((section?: string) => {
    if (section !== "novelai") return original();
    return { get: () => initial, update: async () => undefined };
  }) as typeof workspace.getConfiguration;
  return { restore: () => (workspace.getConfiguration = original) };
}

describe("確認の窓に保存の1行を書き、［実行］で保存する", () => {
  test("未保存があれば1行を足し、［実行］で保存してから run を返す", async () => {
    const given = presave(2);
    const picker = answerConfirms("実行");
    try {
      await expect(
        confirmRun("いじめられっ子 の推敲を行います。", "実行", { presave: given })
      ).resolves.toBe(true);
      expect(picker.shown).toHaveLength(1);
      expect(picker.shown[0].flat).toContain("未保存の 2 件を保存してから実行します。");
      expect(given.save).toHaveBeenCalledOnce();
    } finally {
      picker.restore();
    }
  });

  test("取りやめたら保存しない", async () => {
    const given = presave(1);
    const picker = answerConfirms(undefined);
    try {
      await expect(confirmRun("推敲を行います。", "実行", { presave: given })).resolves.toBe(false);
      expect(given.save).not.toHaveBeenCalled();
    } finally {
      picker.restore();
    }
  });

  test("保存できなければ、［実行］を押しても走らせない", async () => {
    const given = presave(1, false);
    const picker = answerConfirms("実行");
    try {
      await expect(confirmRun("推敲を行います。", "実行", { presave: given })).resolves.toBe(false);
      expect(given.save).toHaveBeenCalledOnce();
    } finally {
      picker.restore();
    }
  });

  test("未保存が無ければ、文も動きも今までどおり", async () => {
    const given = presave(0);
    const picker = answerConfirms("実行");
    try {
      await expect(confirmRun("推敲を行います。", "実行", { presave: given })).resolves.toBe(true);
      expect(picker.shown[0].flat).not.toContain("未保存");
      expect(given.save).not.toHaveBeenCalled();
    } finally {
      picker.restore();
    }
  });

  test("「以降は訊かない」を覚えていても、未保存があれば窓を出す（黙って保存しない）", async () => {
    const memory = stubConfirmMemory({ "ai.run.checkProofread": "実行" });
    const given = presave(1);
    const picker = answerConfirms("実行");
    try {
      await expect(
        confirmRun("推敲を行います。", "実行", {
          presave: given,
          remember: { id: "ai.run.checkProofread" },
        })
      ).resolves.toBe(true);
      expect(picker.shown).toHaveLength(1);
      expect(given.save).toHaveBeenCalledOnce();
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("「以降は訊かない」を覚えていて未保存が無ければ、窓を出さずに通す（今までどおり）", async () => {
    const memory = stubConfirmMemory({ "ai.run.checkProofread": "実行" });
    const picker = answerConfirms("実行");
    try {
      await expect(
        confirmRun("推敲を行います。", "実行", {
          presave: presave(0),
          remember: { id: "ai.run.checkProofread" },
        })
      ).resolves.toBe(true);
      expect(picker.shown).toEqual([]);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("別の道（実行の代わり）を選んだら保存しない", async () => {
    const given = presave(1);
    const picker = answerConfirms("gemma4:26b に切り替える");
    try {
      await expect(
        confirmRunOrChoose("誤字脱字を検知します。", "実行", {
          presave: given,
          choices: ["gemma4:26b に切り替える"],
        })
      ).resolves.toEqual({ kind: "choice", label: "gemma4:26b に切り替える" });
      expect(given.save).not.toHaveBeenCalled();
    } finally {
      picker.restore();
    }
  });
});
