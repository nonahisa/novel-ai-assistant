import { afterEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「未記録の変更が残っているため…」の問い（［記録してから取り込む］［閉じる］）を
 * 待つあいだ、取り込みの旗を立てたままにしない（2026-10-11、0.103.5）。
 *
 * 0.103.2 で直した「開いたときの点検」と同じ形の不具合だった。作者が知らせを
 * 押さずにベルへ畳むと、答えが来ないまま `isOperating()` が立ち続け、
 * 自動の送り直しが「取り込み・送信が走っている」で見送り続ける。
 *
 * **`pull()` も答えを待たずに戻ることを見る。** 取り込みのコマンド
 * （`novelai.gitPull`）は `pull()` が戻るまで「同期の操作が走っている」札を
 * 持つので、`pull()` が答えを待つと、旗の代わりに札が立ちっぱなしになる。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

// 取り込みの結果だけを差し替える（未記録が残っている、を作る）。
// ほかの git の読み書きは、渡した `run` の作り物が受ける
const pullResults: Array<
  { ok: true } | { ok: false; failure: { kind: "dirty" } }
> = [];
vi.mock("../../../src/core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/git")>();
  return {
    ...actual,
    pullFastForward: vi.fn(async () => pullResults.shift() ?? { ok: true }),
  };
});

const { GitSyncMonitor, RECORD_THEN_PULL } = await import(
  "../../../src/features/gitSync"
);

const target: WorkEntry = {
  id: "w1",
  title: "作品",
  folderPath: "C:\\novels\\w1",
  registeredAt: "2026-10-01T00:00:00.000Z",
};

const registry = {
  list: () => [],
  get: () => undefined,
  onDidChange: () => ({ dispose: () => undefined }),
};

/** 少し先まで進めて、待ちの途中の様子を見る */
const settle = () => new Promise((done) => setTimeout(done, 10));

type Answer = string | undefined;
const originalWarning = vscode.window.showWarningMessage;

afterEach(() => {
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage =
    originalWarning;
  pullResults.length = 0;
});

/** 問いを出したまま、作者がまだ答えていない形にする。答えは後から渡せる */
function holdWarning(): { answer: (value: Answer) => void; shown: string[] } {
  const shown: string[] = [];
  let answer: (value: Answer) => void = () => undefined;
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (
    message: string
  ) => {
    shown.push(message);
    // 問いの知らせだけを止める（ほかの知らせはすぐ閉じた体にする）
    if (!message.includes("未記録")) return Promise.resolve(undefined);
    return new Promise<Answer>((resolve) => {
      answer = resolve;
    });
  };
  return { answer: (value) => answer(value), shown };
}

function monitorWithRecord(recordOk = true) {
  const run: GitCommandRunner = async () => ({ code: 1, stdout: "", stderr: "" });
  const monitor = new GitSyncMonitor(registry as never, { run });
  const recorded: string[] = [];
  // 記録そのもの（早送り・名前の確認・commit）は別のテストが見ている。
  // ここで見たいのは「答えのあとに記録 → 取り込みへ進む」流れだけ
  (monitor as unknown as {
    recordBeforePull: (work: WorkEntry) => Promise<boolean>;
  }).recordBeforePull = async (work) => {
    recorded.push(work.id);
    // 記録しているあいだは旗が立っている（送り直しと git を重ねない）
    expect(monitor.isOperating()).toBe(true);
    return recordOk;
  };
  return { monitor, recorded };
}

describe("未記録が残っているときの問いは、旗を立てたまま待たない", () => {
  test("答えを待つあいだ isOperating() は立たず、pull() も戻る", async () => {
    const held = holdWarning();
    pullResults.push({ ok: false, failure: { kind: "dirty" } });
    const { monitor } = monitorWithRecord();
    try {
      let returned: boolean | undefined;
      const running = monitor.pull(target).then((value) => {
        returned = value;
      });
      await settle();
      expect(held.shown.some((text) => text.includes("未記録"))).toBe(true);
      // 作者はまだ押していない
      expect(monitor.isOperating()).toBe(false);
      // コマンドの札も下ろせるよう、取り込みは「取り込めなかった」で戻っている
      expect(returned).toBe(false);
      await running;
    } finally {
      monitor.dispose();
    }
  });

  test("［記録してから取り込む］を押すと、記録してからもう一度取り込む", async () => {
    const held = holdWarning();
    pullResults.push({ ok: false, failure: { kind: "dirty" } }, { ok: true });
    const { monitor, recorded } = monitorWithRecord();
    try {
      await monitor.pull(target);
      await settle();
      expect(recorded).toEqual([]);

      held.answer(RECORD_THEN_PULL);
      await settle();
      expect(recorded).toEqual(["w1"]);
      // 2回目の取り込みまで済んでいる（差し替えた結果を使い切った）
      expect(pullResults).toEqual([]);
      expect(monitor.isOperating()).toBe(false);
    } finally {
      monitor.dispose();
    }
  });

  test("記録できなければ、2回目の取り込みへは進まない", async () => {
    const held = holdWarning();
    pullResults.push({ ok: false, failure: { kind: "dirty" } }, { ok: true });
    const { monitor, recorded } = monitorWithRecord(false);
    try {
      await monitor.pull(target);
      held.answer(RECORD_THEN_PULL);
      await settle();
      expect(recorded).toEqual(["w1"]);
      expect(pullResults).toHaveLength(1);
      expect(monitor.isOperating()).toBe(false);
    } finally {
      monitor.dispose();
    }
  });

  test("［閉じる］なら何もしない", async () => {
    const held = holdWarning();
    pullResults.push({ ok: false, failure: { kind: "dirty" } }, { ok: true });
    const { monitor, recorded } = monitorWithRecord();
    try {
      await monitor.pull(target);
      held.answer("閉じる");
      await settle();
      expect(recorded).toEqual([]);
      expect(pullResults).toHaveLength(1);
      expect(monitor.isOperating()).toBe(false);
    } finally {
      monitor.dispose();
    }
  });
});
