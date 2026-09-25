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

vi.mock("../../../src/views/progress", () => ({
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
  "../../../src/features/aiTurn"
);
const {
  acquireRun,
  currentRunLabel,
  currentRunScope,
  resetAiSequence,
  setRunScopeCarrier,
} = await import("../../../src/core/aiSequence");
const { createRunScopeCarrier } = await import("../../../src/core/localAiLeaseNode");

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

describe("一括処理の本体に「一括処理の中」の印を持たせる（6.76.1 の追記）", () => {
  test("札を取った処理の中だけが印を持つ。外から並んで来た呼び出しは持たない", async () => {
    setRunScopeCarrier(createRunScopeCarrier());
    try {
      let inside: string | undefined;
      let outsideDuringRun: string | undefined = "未確認";
      let resume: () => void = () => undefined;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const running = withAiTurnProgress(
        "誤字脱字を検知しています",
        { label: "誤字脱字の検知" },
        async () => {
          await paused;
          // await をまたいでも印が残る（チャンクの送信は await の先で起きる）
          inside = currentRunScope();
        }
      );
      await settle();
      // 一括処理の最中に、画面から押された相談（札を取らない呼び出し）
      outsideDuringRun = currentRunScope();
      resume();
      await running;
      expect(inside).toBe("誤字脱字の検知");
      expect(outsideDuringRun).toBeUndefined();
      expect(currentRunScope()).toBeUndefined();
    } finally {
      setRunScopeCarrier(undefined);
    }
  });

  test("まとめ実行の中の機能（alreadyHeld）は、札の持ち主の名前で印を持つ", async () => {
    setRunScopeCarrier(createRunScopeCarrier());
    try {
      let inner: string | undefined;
      await withAiTurn({ label: "校正をまとめて実行" }, async () => {
        await withAiTurnProgress("推敲しています", { label: "推敲", alreadyHeld: true }, async () => {
          inner = currentRunScope();
        });
      });
      expect(inner).toBe("校正をまとめて実行");
    } finally {
      setRunScopeCarrier(undefined);
    }
  });

  test("運ぶ仕組みが入っていなければ、印は無い（呼ぶ側は従来の見分け方へ戻る）", async () => {
    let inside: string | undefined = "未確認";
    await withAiTurn({ label: "推敲" }, async () => {
      inside = currentRunScope();
    });
    expect(inside).toBeUndefined();
  });
});
