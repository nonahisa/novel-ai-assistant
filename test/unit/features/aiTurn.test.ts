import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 実行の札の取り口（設計書6.76）。
 *
 * 進捗と中止ボタンは VS Code の窓口なので、`views/progress` を差し替えて
 * 「何という題で出したか」「どんな文言を report したか」「中止したら
 * どうなるか」を見る。
 */

/** 差し替えた進捗が受け取ったもの。テストごとに空にする */
const shown: Array<{ title: string; messages: string[] }> = [];

/** いま出ている進捗を、テスト側から中止するための取っ手 */
let cancelCurrent: (() => void) | undefined;

vi.mock("../../src/views/progress", () => ({
  withCancellableProgress: async (
    title: string,
    task: (
      progress: { report: (value: { message?: string }) => void },
      token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (listener: () => void) => { dispose(): void };
      }
    ) => Promise<unknown>
  ) => {
    const record = { title, messages: [] as string[] };
    shown.push(record);
    const listeners: Array<() => void> = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    };
    cancelCurrent = () => {
      token.isCancellationRequested = true;
      for (const listener of listeners) listener();
    };
    return task(
      {
        report: (value) => {
          if (value.message !== undefined) record.messages.push(value.message);
        },
      },
      token
    );
  },
}));

const { withAiTurn, withAiTurnProgress } = await import(
  "../../src/features/aiTurn"
);
const { acquireRun, currentRunLabel, resetAiSequence } = await import(
  "../../src/core/aiSequence"
);

/** 次のマイクロタスクまで待つ */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  shown.length = 0;
  cancelCurrent = undefined;
  resetAiSequence();
});

describe("進捗の中から札を取る（withAiTurnProgress）", () => {
  test("空いていれば、待ちの文言を出さずにそのまま実行する", async () => {
    let ran = false;

    await withAiTurnProgress(
      "誤字脱字を検知しています",
      { label: "誤字脱字検知" },
      async () => {
        ran = true;
        // 実行中は自分が札を持っている
        expect(currentRunLabel()).toBe("誤字脱字検知");
      }
    );

    expect(ran).toBe(true);
    expect(shown[0].title).toBe("誤字脱字を検知しています");
    expect(shown[0].messages).toEqual([]);
    // 終わったら返している
    expect(currentRunLabel()).toBeUndefined();
  });

  test("先客がいると、その機能名を出して待つ", async () => {
    const held = await acquireRun("誤字脱字検知");

    let ran = false;
    const running = withAiTurnProgress(
      "矛盾を検知しています",
      { label: "矛盾検知" },
      async () => {
        ran = true;
      }
    );

    await settle();
    expect(ran).toBe(false);
    expect(shown[0].messages).toEqual(["「誤字脱字検知」の完了を待っています…"]);

    held();
    await running;
    expect(ran).toBe(true);
  });

  test("順番待ちの最中に中止したら、処理そのものを行わない", async () => {
    const held = await acquireRun("誤字脱字検知");

    let ran = false;
    let cancelled = false;
    const running = withAiTurnProgress(
      "矛盾を検知しています",
      { label: "矛盾検知", onCancelled: () => (cancelled = true) },
      async () => {
        ran = true;
      }
    );

    await settle();
    cancelCurrent?.();
    await running;

    expect(ran).toBe(false);
    // **中止されたことを機能側へ伝える。** 伝えないと、機能側は
    // 「0件で正常に終わった」と読んで完了の知らせを出してしまう
    expect(cancelled).toBe(true);

    held();
  });

  test("処理が例外で終わっても、札は次の人へ渡る", async () => {
    await expect(
      withAiTurnProgress(
        "誤字脱字を検知しています",
        { label: "誤字脱字検知" },
        async () => {
          throw new Error("途中で落ちました");
        }
      )
    ).rejects.toThrow("途中で落ちました");

    expect(currentRunLabel()).toBeUndefined();

    // 次の一括処理が始められる
    let ran = false;
    await withAiTurnProgress("矛盾を検知しています", { label: "矛盾検知" }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("進捗をまたいで札を持つ（withAiTurn）", () => {
  test("空いていれば、待ちの進捗を出さずに実行する", async () => {
    const result = await withAiTurn({ label: "矛盾検知" }, async () => {
      expect(currentRunLabel()).toBe("矛盾検知");
      return "終わった";
    });

    expect(result).toBe("終わった");
    // 待たなかったので、待ち用の進捗は出していない
    expect(shown).toHaveLength(0);
  });

  test("先客がいるときだけ、中止できる待ちの進捗を出す", async () => {
    const held = await acquireRun("誤字脱字検知");

    let ran = false;
    const running = withAiTurn({ label: "矛盾検知" }, async () => {
      ran = true;
    });

    await settle();
    expect(ran).toBe(false);
    expect(shown[0].title).toBe("「誤字脱字検知」の完了を待っています");

    held();
    await running;
    expect(ran).toBe(true);
  });

  test("待っている間に中止したら、処理を行わず undefined を返す", async () => {
    const held = await acquireRun("誤字脱字検知");

    let ran = false;
    let cancelled = false;
    const running = withAiTurn(
      { label: "矛盾検知", onCancelled: () => (cancelled = true) },
      async () => {
        ran = true;
        return "終わった";
      }
    );

    await settle();
    cancelCurrent?.();

    expect(await running).toBeUndefined();
    expect(ran).toBe(false);
    expect(cancelled).toBe(true);

    held();
  });

  test("処理が例外で終わっても、札は次の人へ渡る", async () => {
    await expect(
      withAiTurn({ label: "矛盾検知" }, async () => {
        throw new Error("途中で落ちました");
      })
    ).rejects.toThrow("途中で落ちました");

    expect(currentRunLabel()).toBeUndefined();
  });
});
