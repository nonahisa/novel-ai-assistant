import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DONE_MESSAGE_TIMEOUT_MS,
  confirmRun,
  errorWithLog,
  notifyDone,
  pickWithMemory,
  warnWithLog,
} from "../../src/views/notify";
import {
  lastQuickPick,
  resetLastQuickPick,
  statusBarMessages,
  window,
  workspace,
} from "./support/vscodeStub";
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

/**
 * 取り消しにくい操作は、警告の顔で確かめる（0.35.4）。
 *
 * 0.35.3 で `confirmRun` へ移したとき、人物をまとめる・GitHubへ送信する
 * ような**取り消しにくい操作まで情報アイコン**になった。もとは
 * `showWarningMessage` で出しており、見た目で身構えられていた。
 *
 * モーダルには VS Code が「キャンセル」を必ず付けるので、
 * 出口が無くなる心配は無い。
 */
describe("確認の顔つき", () => {
  test("既定は情報の顔（showInformationMessage）", async () => {
    const calls: unknown[][] = [];
    const original = window.showInformationMessage;
    window.showInformationMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "実行";
    };
    try {
      expect(await confirmRun("19話をAIで確認します。")).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      window.showInformationMessage = original;
    }
  });

  test("kind: \"warning\" なら警告の顔（showWarningMessage）で出す", async () => {
    const warnCalls: unknown[][] = [];
    const infoCalls: unknown[][] = [];
    const originalWarn = window.showWarningMessage;
    const originalInfo = window.showInformationMessage;
    window.showWarningMessage = async (message, ...items) => {
      warnCalls.push([message, ...items]);
      return "まとめる";
    };
    window.showInformationMessage = async (message, ...items) => {
      infoCalls.push([message, ...items]);
      return undefined;
    };
    try {
      expect(
        await confirmRun("2人をまとめます。", "まとめる", { kind: "warning" })
      ).toBe(true);
      expect(warnCalls).toEqual([
        ["2人をまとめます。", { modal: true }, "まとめる"],
      ]);
      // 情報の顔では出さない（二重に出さない）
      expect(infoCalls).toEqual([]);
    } finally {
      window.showWarningMessage = originalWarn;
      window.showInformationMessage = originalInfo;
    }
  });

  test("警告の顔でも、押さなければ false", async () => {
    const original = window.showWarningMessage;
    window.showWarningMessage = async () => undefined;
    try {
      expect(
        await confirmRun("送信します。", "送信する", { kind: "warning" })
      ).toBe(false);
    } finally {
      window.showWarningMessage = original;
    }
  });

  test("kind: \"info\" を明示しても、情報の顔のまま", async () => {
    const calls: unknown[][] = [];
    const original = window.showInformationMessage;
    window.showInformationMessage = async (message, ...items) => {
      calls.push([message, ...items]);
      return "実行";
    };
    try {
      expect(await confirmRun("確かめます。", "実行", { kind: "info" })).toBe(
        true
      );
      expect(calls).toHaveLength(1);
    } finally {
      window.showInformationMessage = original;
    }
  });
});

/**
 * 「以降は訊かない」の覚え書きを差し替える。
 *
 * 本物は `vscode.workspace.getConfiguration("novelai").get("confirm.remembered")`
 * で読み、`.update(...)` で書く（`core/confirmMemoryStore.ts`）。テストは
 * それぞれを差し替えて、初期状態と書き込まれた中身を覗く。
 */
function stubConfirmMemory(initial: Record<string, string>): {
  updates: Array<Record<string, string>>;
  restore: () => void;
} {
  const SECTION = "novelai";
  const updates: Array<Record<string, string>> = [];
  const original = workspace.getConfiguration;
  workspace.getConfiguration = ((section?: string) => {
    if (section !== SECTION) return original();
    return {
      get: (_key: string) => initial,
      update: async (_key: string, value: Record<string, string>) => {
        updates.push(value);
      },
    };
  }) as typeof workspace.getConfiguration;
  return {
    updates,
    restore: () => {
      workspace.getConfiguration = original;
    },
  };
}

/**
 * 「はじめの10話だけ試す」は覚えない（`noRemember`、設計書6.8.7）。
 *
 * 覚えると、以後すべての実行が黙って10話だけになり、見ていない話が
 * 「指摘なし」として通る——**試したつもりが本番になる。** ここは
 * `pickWithMemory`（`views/notify.ts` の272行・322行）を実際に動かして
 * 確かめる（実機確認リストの項目を、機械で確かめられる形にする）。
 */
describe("pickWithMemory：noRemember の項目は覚えない", () => {
  const items = [
    {
      label: "$(beaker) はじめの10話だけ（試す）",
      value: "first" as const,
      noRemember: true,
    },
    { label: "$(book) 作品全体", value: "all" as const },
  ];

  beforeEach(() => {
    resetLastQuickPick();
  });

  test("noRemember の項目を選ぶと、ピンが入っていても覚え書きへ書かない", async () => {
    const memory = stubConfirmMemory({});
    try {
      const promise = pickWithMemory({
        items,
        title: "どこまで見ますか",
        remember: { id: "scope.typoCheck" },
      });

      // ピンを入れてから選ぶ（「以降はこの選択で進む」を入れた体にする）
      expect(lastQuickPick).toBeDefined();
      lastQuickPick!.triggerButton();
      lastQuickPick!.accept(
        lastQuickPick!.items.find((item) => item.value === "first")!
      );

      expect(await promise).toBe("first");
      // ピンを入れて選んだのに、覚え書きへは1件も書かれない
      expect(memory.updates).toEqual([]);
    } finally {
      memory.restore();
    }
  });

  test("noRemember でない項目なら、ピンを入れて選ぶとこれまでどおり覚える", async () => {
    // 上のテストが効きすぎて、覚える道そのものを塞いでいないことの裏
    const memory = stubConfirmMemory({});
    try {
      const promise = pickWithMemory({
        items,
        title: "どこまで見ますか",
        remember: { id: "scope.typoCheck" },
      });

      lastQuickPick!.triggerButton();
      lastQuickPick!.accept(
        lastQuickPick!.items.find((item) => item.value === "all")!
      );

      expect(await promise).toBe("all");
      expect(memory.updates).toEqual([{ "scope.typoCheck": "all" }]);
    } finally {
      memory.restore();
    }
  });

  test("覚え書きに noRemember の項目の値が残っていても、素通りさせずに訊き直す", async () => {
    // 272行：古い記録（覚えられた時期があった場合）が残っていたケース
    const memory = stubConfirmMemory({ "scope.typoCheck": "first" });
    try {
      const promise = pickWithMemory({
        items,
        title: "どこまで見ますか",
        remember: { id: "scope.typoCheck" },
      });

      // 素通りしていれば選択画面は作られない。ここで作られていることが、
      // 訊き直していることの証になる
      expect(lastQuickPick).toBeDefined();
      lastQuickPick!.accept(
        lastQuickPick!.items.find((item) => item.value === "all")!
      );

      expect(await promise).toBe("all");
    } finally {
      memory.restore();
    }
  });
});
