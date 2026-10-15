import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAVE_APPLY_WAIT_MS,
  createAppliedTracker,
  EDIT_TAKEN_WAIT_MS,
  describeSaveResult,
  editTakenByDocument,
  runSaveRequest,
  type SaveSteps,
} from "../../../src/core/manuscriptSave";

/**
 * 原稿エディターの［保存］（作者の裁定、2026-10-01。設計書6.25.9）。
 *
 * 拡張機能ホストが起動し直して画面の受け手が居なくなると、打った字が届かない
 * まま残る（2026-10-01 ノートPCで約100字）。画面には自分でファイルを書く力が
 * 無いので、**保存できたかを確実に知らせる**。
 *
 * 拡張機能の側で守ること：**頼まれた便（seq）までを当て終わってから保存する。**
 * 先に保存すると、最後に打った字が入る前のファイルを「保存しました」と言う。
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function steps(overrides: Partial<SaveSteps> = {}): SaveSteps & { saved: number } {
  const state = { saved: 0, dirty: true };
  return {
    get saved() {
      return state.saved;
    },
    waitApplied: async () => "applied",
    isDirty: () => state.dirty,
    save: async () => {
      state.saved += 1;
      state.dirty = false;
      return true;
    },
    chars: () => 120,
    ...overrides,
  };
}

describe("便の番号までを当ててから保存する", () => {
  it("頼まれた便より前の便が当たっただけでは保存しない。頼まれた便が当たってから保存する", async () => {
    const tracker = createAppliedTracker();
    const order: string[] = [];
    let dirty = true;
    const s = steps({
      waitApplied: (seq) => tracker.waitFor(seq, SAVE_APPLY_WAIT_MS),
      save: async () => {
        order.push("save");
        dirty = false;
        return true;
      },
      isDirty: () => dirty,
    });
    const running = runSaveRequest(3, s);
    tracker.markApplied(2, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(order, "便3が当たる前に保存した").toEqual([]);
    tracker.markApplied(3, true);
    order.push("applied3");
    const result = await running;
    expect(order).toEqual(["applied3", "save"]);
    expect(result).toEqual({ type: "saveResult", seq: 3, ok: true, chars: 120 });
  });

  it("当てている間に畳まれて番号が飛んでも、それより新しい便が当たれば待ちは解ける", async () => {
    const tracker = createAppliedTracker();
    const waiting = tracker.waitFor(3, SAVE_APPLY_WAIT_MS);
    tracker.markApplied(5, true);
    await expect(waiting).resolves.toBe("applied");
  });

  it("もう当たり終えた便なら待たない", async () => {
    const tracker = createAppliedTracker();
    tracker.markApplied(4, true);
    await expect(tracker.waitFor(4, SAVE_APPLY_WAIT_MS)).resolves.toBe("applied");
  });

  it("頼まれた便が「入れられなかった」なら、保存しない", async () => {
    const tracker = createAppliedTracker();
    const waiting = tracker.waitFor(2, SAVE_APPLY_WAIT_MS);
    tracker.markApplied(2, false);
    await expect(waiting).resolves.toBe("rejected");

    const s = steps({ waitApplied: async () => "rejected" });
    const result = await runSaveRequest(2, s);
    expect(s.saved).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/入れられません/);
  });

  it("待ちが過ぎても便が当たらなければ、保存せず ok:false を返す", async () => {
    const tracker = createAppliedTracker();
    const waiting = tracker.waitFor(7, SAVE_APPLY_WAIT_MS);
    await vi.advanceTimersByTimeAsync(SAVE_APPLY_WAIT_MS);
    await expect(waiting).resolves.toBe("timeout");

    const s = steps({ waitApplied: async () => "timeout" });
    const result = await runSaveRequest(7, s);
    expect(s.saved).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("保存の成否と字数を返す", () => {
  it("保存できたら ok:true と保存後の字数", async () => {
    const s = steps();
    const result = await runSaveRequest(1, s);
    expect(s.saved).toBe(1);
    expect(result).toEqual({ type: "saveResult", seq: 1, ok: true, chars: 120 });
  });

  it("変わっていない文書は保存し直さず、保存済みとして返す（VS Code は未変更の保存に false を返す）", async () => {
    const s = steps({ isDirty: () => false, save: async () => false });
    const result = await runSaveRequest(1, s);
    expect(result.ok).toBe(true);
    expect(result.chars).toBe(120);
  });

  it("保存が false を返したら ok:false", async () => {
    const s = steps({ save: async () => false });
    const result = await runSaveRequest(1, s);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("保存が投げたら ok:false で、理由にエラーの文を残す", async () => {
    const s = steps({
      save: async () => {
        throw new Error("EACCES: 書き込めません");
      },
    });
    const result = await runSaveRequest(1, s);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EACCES/);
  });

  it("保存したと言われても、まだ未保存のままなら ok:false", async () => {
    const s = steps({ save: async () => true, isDirty: () => true });
    const result = await runSaveRequest(1, s);
    expect(result.ok).toBe(false);
  });

  it("操作ログの1行に、成否・便の番号・字数か理由が入る", () => {
    expect(describeSaveResult({ type: "saveResult", seq: 4, ok: true, chars: 88 })).toMatch(
      /保存しました.*便4.*88字/
    );
    expect(
      describeSaveResult({ type: "saveResult", seq: 5, ok: false, reason: "読み取り専用" })
    ).toMatch(/保存できませんでした.*便5.*読み取り専用/);
  });
});

/*
  読み取り専用の原稿（設定 files.readonlyInclude）。2026-10-15 の画面の自動テスト
  （test/e2e/manuscriptReadonly.test.ts の A）で、applyEdit は true を返し文書の本文も
  変わるのに未保存の印が付かず、［保存］が「保存しました」と言った。ファイルは元のまま。
*/
describe("当てた字が保存されない文書（読み取り専用）", () => {
  it("当てた時点で未保存になっていれば、待たずに「入った」", async () => {
    let asked = 0;
    const taken = editTakenByDocument(() => {
      asked += 1;
      return true;
    });
    await expect(taken).resolves.toBe(true);
    expect(asked).toBe(1);
  });

  it("未保存の印が少し遅れて付いても「入った」（入った字を入らなかったと言わない）", async () => {
    let dirty = false;
    const taken = editTakenByDocument(() => dirty, EDIT_TAKEN_WAIT_MS);
    await vi.advanceTimersByTimeAsync(50);
    dirty = true;
    await vi.advanceTimersByTimeAsync(50);
    await expect(taken).resolves.toBe(true);
  });

  it("待っても未保存にならなければ「入らなかった」", async () => {
    const taken = editTakenByDocument(() => false, EDIT_TAKEN_WAIT_MS);
    await vi.advanceTimersByTimeAsync(EDIT_TAKEN_WAIT_MS + 50);
    await expect(taken).resolves.toBe(false);
  });

  it("入ったと数えた字が一度も保存されず、未保存でもないなら「保存しました」と言わない", async () => {
    const s = steps({ isDirty: () => false, appliedButNeverSaved: () => true });
    const result = await runSaveRequest(3, s);
    expect(s.saved).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/保存されていません/);
    expect(result.reason).toMatch(/本文をコピー/);
  });

  it("未変更の文書の保存は今までどおり保存済みとして返す（打った字が保存済みなら）", async () => {
    const s = steps({ isDirty: () => false, save: async () => false, appliedButNeverSaved: () => false });
    const result = await runSaveRequest(1, s);
    expect(result.ok).toBe(true);
  });

  it("未保存の文書なら、入ったかの確かめを挟まずに保存する", async () => {
    let asked = 0;
    const s = steps({
      appliedButNeverSaved: () => {
        asked += 1;
        return true;
      },
    });
    const result = await runSaveRequest(1, s);
    expect(s.saved).toBe(1);
    expect(result.ok).toBe(true);
    expect(asked).toBe(0);
  });
});
