import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DONE_MESSAGE_TIMEOUT_MS,
  confirmRun,
  errorWithLog,
  notifyDone,
  warnWithLog,
} from "../../src/views/notify";
import { statusBarMessages, window } from "./support/vscodeStub";
import * as logger from "../../src/core/logger";

/**
 * 知らせの行き先（作者の裁定 2026-09-06、`src/views/notify.ts`）。
 *
 * **確認はモーダル、その場限りの完了はステータスバー。**
 * 通知センターに読み捨ての報告が積み上がると、返事を待っている
 * 確認カードが下へ押し出されて見えなくなる。
 */
describe("その場限りの完了", () => {
  beforeEach(() => {
    statusBarMessages.length = 0;
  });

  test("ステータスバーへ出す。印を頭に付け、数秒で消す", () => {
    notifyDone("Ollamaを起動しました。");
    expect(statusBarMessages).toEqual([
      { text: "$(check) Ollamaを起動しました。", timeout: DONE_MESSAGE_TIMEOUT_MS },
    ]);
  });

  test("同じ文言を操作ログにも残す（ステータスバーは消えるため）", () => {
    const logStep = vi.spyOn(logger, "logStep").mockImplementation(() => {});
    try {
      notifyDone("索引を削除しました。");
      expect(logStep).toHaveBeenCalledWith("索引を削除しました。");
    } finally {
      logStep.mockRestore();
    }
  });

  test("通知センターへは出さない", async () => {
    const shown = vi.fn(async () => undefined);
    const original = window.showInformationMessage;
    window.showInformationMessage = shown;
    try {
      notifyDone("切り替えました。");
      expect(shown).not.toHaveBeenCalled();
    } finally {
      window.showInformationMessage = original;
    }
  });
});

describe("実行前の確認", () => {
  test("モーダルで出し、押されたら true", async () => {
    const calls: unknown[][] = [];
    const original = window.showInformationMessage;
    window.showInformationMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "実行";
    };
    try {
      expect(await confirmRun("19話をAIで確認します。")).toBe(true);
      expect(calls).toEqual([
        ["19話をAIで確認します。", { modal: true }, "実行"],
      ]);
    } finally {
      window.showInformationMessage = original;
    }
  });

  test("Escで閉じられたら false（「中止」ボタンは置かない）", async () => {
    const original = window.showInformationMessage;
    window.showInformationMessage = async () => undefined;
    try {
      expect(await confirmRun("19話をAIで確認します。")).toBe(false);
    } finally {
      window.showInformationMessage = original;
    }
  });

  test("押すボタンの名前は呼び出し側が決められる", async () => {
    const calls: unknown[][] = [];
    const original = window.showInformationMessage;
    window.showInformationMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "まとめる";
    };
    try {
      expect(await confirmRun("2人をまとめます。", "まとめる")).toBe(true);
      expect(calls[0]?.[2]).toBe("まとめる");
    } finally {
      window.showInformationMessage = original;
    }
  });
});

describe("ログへの入口つきの警告", () => {
  test("押されたときだけログを開く", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const original = window.showWarningMessage;
    window.showWarningMessage = async () => "ログを見る";
    try {
      await warnWithLog("応答を読み取れませんでした。");
      expect(showLog).toHaveBeenCalledTimes(1);
    } finally {
      window.showWarningMessage = original;
      showLog.mockRestore();
    }
  });

  test("押されなければ開かない", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const original = window.showWarningMessage;
    window.showWarningMessage = async () => undefined;
    try {
      await warnWithLog("応答を読み取れませんでした。");
      expect(showLog).not.toHaveBeenCalled();
    } finally {
      window.showWarningMessage = original;
      showLog.mockRestore();
    }
  });

  test("ボタンの名前は呼び出し側が渡す（既存の文言を変えないため）", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const calls: unknown[][] = [];
    const original = window.showWarningMessage;
    window.showWarningMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "ログを表示";
    };
    try {
      await warnWithLog("送れませんでした。", "ログを表示");
      expect(calls).toEqual([["送れませんでした。", "ログを表示"]]);
      expect(showLog).toHaveBeenCalledTimes(1);
    } finally {
      window.showWarningMessage = original;
      showLog.mockRestore();
    }
  });

  test("エラー版は、出す先だけが違う", async () => {
    const showLog = vi.spyOn(logger, "showLog").mockImplementation(() => {});
    const calls: unknown[][] = [];
    const original = window.showErrorMessage;
    window.showErrorMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "ログを見る";
    };
    try {
      await errorWithLog("取り込めませんでした。");
      expect(calls).toEqual([["取り込めませんでした。", "ログを見る"]]);
      expect(showLog).toHaveBeenCalledTimes(1);
    } finally {
      window.showErrorMessage = original;
      showLog.mockRestore();
    }
  });
});
