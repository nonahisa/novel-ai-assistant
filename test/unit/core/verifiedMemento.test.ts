import { describe, expect, test } from "vitest";
import {
  MAX_VERIFIED_WRITES,
  MementoWriteLostError,
  updateVerified,
  watchForLateLoss,
  type MementoLike,
} from "../../../src/core/verifiedMemento";

/**
 * globalState へ書いて読み返す部品（2026-10-03。0.97.3）。
 * 登録簿の側の試験は `workRegistryEcho.test.ts`（VS Code の送り返しを写した作り物）。
 */

/** 書くたびに `afterWrite` で手元を変えられる作り物 */
function memento(
  initial: Record<string, unknown>,
  afterWrite: (store: Record<string, unknown>, writes: number) => void = () => undefined
): MementoLike & { writes: () => number; store: Record<string, unknown> } {
  const store = { ...initial };
  let writes = 0;
  return {
    store,
    writes: () => writes,
    get<T>(key: string, defaultValue: T): T {
      return (store[key] as T | undefined) ?? defaultValue;
    },
    async update(key: string, value: unknown) {
      store[key] = value;
      writes++;
      afterWrite(store, writes);
    },
  };
}

const add = (item: string) => (list: string[]) =>
  list.includes(item) ? list : [...list, item];

describe("updateVerified", () => {
  test("消えていなければ1回で済む", async () => {
    const m = memento({});
    expect(await updateVerified(m, "k", [] as string[], add("a"))).toEqual(["a"]);
    expect(m.writes()).toBe(1);
  });

  test("1回目が古い塊で消されたら、読み直して当て直す", async () => {
    const m = memento({ k: ["old"] }, (store, writes) => {
      if (writes === 1) store.k = ["old"];
    });
    expect(await updateVerified(m, "k", [] as string[], add("a"))).toEqual(["old", "a"]);
    expect(m.writes()).toBe(2);
  });

  test("別の窓が同じ鍵に足したものは、違いと見て書き直さない", async () => {
    // 書いた直後に、別の窓の追加（"b"）が届いた。変えたいこと（"a"）は入っている
    const m = memento({}, (store) => {
      store.k = [...(store.k as string[]), "b"];
    });
    expect(await updateVerified(m, "k", [] as string[], add("a"))).toEqual(["a", "b"]);
    expect(m.writes()).toBe(1);
  });

  test("何度書いても残らなければ投げる（黙って消さない）", async () => {
    const m = memento({}, (store) => {
      delete store.k;
    });
    await expect(updateVerified(m, "k", [] as string[], add("a"))).rejects.toBeInstanceOf(
      MementoWriteLostError
    );
    expect(m.writes()).toBe(MAX_VERIFIED_WRITES);
  });
});

describe("watchForLateLoss", () => {
  test("見に行ったときに消えていれば当て直し、知らせる", async () => {
    const m = memento({ k: ["a"] });
    let repaired = 0;
    const done = watchForLateLoss(m, "k", [] as string[], add("a"), {
      delays: [10, 20],
      wait: async () => {
        // 見に行く直前に、古い塊が届いて消えた
        m.store.k = [];
      },
      onRepaired: () => repaired++,
    });
    await done;
    expect(m.store.k).toEqual(["a"]);
    expect(repaired).toBe(2);
  });

  test("消えていなければ何も書かない", async () => {
    const m = memento({ k: ["a"] });
    await watchForLateLoss(m, "k", [] as string[], add("a"), {
      delays: [10, 20, 30],
      wait: async () => undefined,
    });
    expect(m.writes()).toBe(0);
  });
});
