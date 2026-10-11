import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

import { runStartupHandoff } from "../../../src/features/handoffSync";
import { UNSENT_MARK_KEY } from "../../../src/core/unsentMark";
import type { GitCommandRunner } from "../../../src/core/git";
import { commands, window } from "../support/vscodeStub";

/**
 * 開いたときの点検は、知らせのボタンが押されるのを待たずに終わる
 * （2026-10-11、作者のノートPC。設計書6.15.1）。
 *
 * ## 何が起きていたか
 *
 * 点検の終わりに出す知らせ（「前回、送らずに閉じました…」［同期する］
 * ［ログを表示］）を `await` していた。ボタン付きの知らせは、作者が押すか
 * 閉じるまで答えが返らない。ベルへ畳まれたまま置かれると、点検は終わらず、
 * **「点検が走っている」旗が立ちっぱなし**になる。自動の送り直しはこの旗を
 * 見て控えるので、Wi-Fi を入れて20分たっても1度も試さず、ログにも何も
 * 残らなかった。
 *
 * 作り物の git は「リポジトリでない」と答えるだけ（点検するものは無く、
 * 前回の印だけが知らせに載る）。
 */

let answer: (picked: string | undefined) => void;
let shown: Array<{ message: string; buttons: string[] }>;
let executed: string[];
const original = {
  showWarningMessage: window.showWarningMessage,
  executeCommand: commands.executeCommand,
};

const notARepo: GitCommandRunner = async (args) =>
  args[0] === "--version"
    ? { code: 0, stdout: "git version 2.55.0", stderr: "" }
    : { code: 128, stdout: "", stderr: "fatal: not a git repository" };

function deps() {
  const works = [{ id: "w1", title: "短編", folderPath: "C:/書庫/短編" }];
  const store: Record<string, unknown> = {
    // 前回、送らずに閉じた——開いたときの知らせに載る
    [UNSENT_MARK_KEY]: {
      at: "2026-10-11T09:41:00.000Z",
      ahead: 1,
      dirty: 0,
      labels: ["書庫"],
    },
  };
  return {
    registry: { list: () => works } as never,
    monitor: {
      refreshAll: async () => undefined,
      statusFor: () => undefined,
    } as never,
    storage: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    run: notARepo,
  };
}

beforeEach(() => {
  shown = [];
  executed = [];
  Object.assign(window, {
    // **答えが返らない知らせ**（作者が押さずにベルへ畳んだまま）
    showWarningMessage: (message: string, ...rest: unknown[]) => {
      shown.push({
        message,
        buttons: rest.filter((one): one is string => typeof one === "string"),
      });
      return new Promise<string | undefined>((resolve) => {
        answer = resolve;
      });
    },
  });
  commands.executeCommand = async (command: string) => {
    executed.push(command);
    return undefined;
  };
});

afterEach(() => {
  Object.assign(window, { showWarningMessage: original.showWarningMessage });
  commands.executeCommand = original.executeCommand;
});

describe("開いたときの点検：知らせの答えを待たない", () => {
  test("知らせが置かれたままでも点検は終わる（送り直しを控えさせ続けない）", async () => {
    const finished = await Promise.race([
      runStartupHandoff(deps()).then(() => "finished" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain("前回、送らずに閉じました");
    expect(finished).toBe("finished");
  });

  test("あとから［同期する］が押されれば、そのとき同期を始める", async () => {
    await runStartupHandoff(deps());
    expect(executed).toEqual([]);
    answer("同期する");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executed).toEqual(["novelai.saveAndSync"]);
  });
});
