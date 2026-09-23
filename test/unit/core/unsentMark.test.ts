import { describe, expect, test } from "vitest";
import {
  UNSENT_MARK_KEY,
  clearUnsentMark,
  describeUnsentMark,
  readUnsentMark,
  summarizeUnsent,
  writeUnsentMark,
  type UnsentMarkStorage,
} from "../../../src/core/unsentMark";
import type { GitSyncStatus } from "../../../src/core/git";

/**
 * 「送らずに閉じた」印（設計書6.15.1）。
 *
 * **閉じる前の確認は確実には動かない。** VS Code は `deactivate()` の
 * 非同期の完了を待ち切らないので、問いが出ないまま閉じることがある。
 * だから**これを唯一の守りにしない**——受け皿が次に開いたときの点検で、
 * その目印がこれである。
 *
 * **印を付けるのは同期の処理、消すのは送信が通ったときだけ。**
 */

function memory(initial: Record<string, unknown> = {}): UnsentMarkStorage & {
  raw(): Record<string, unknown>;
} {
  const store: Record<string, unknown> = { ...initial };
  return {
    get<T>(key: string): T | undefined {
      return store[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    raw: () => store,
  };
}

describe("印の付け外し", () => {
  test("付ければ読める", async () => {
    const storage = memory();
    await writeUnsentMark(storage, {
      at: "2026-09-21T20:00:00.000Z",
      ahead: 3,
      dirty: 1,
      labels: ["書庫"],
    });
    expect(readUnsentMark(storage)).toEqual({
      at: "2026-09-21T20:00:00.000Z",
      ahead: 3,
      dirty: 1,
      labels: ["書庫"],
    });
  });

  test("消せば読めない", async () => {
    const storage = memory();
    await writeUnsentMark(storage, {
      at: "2026-09-21T20:00:00.000Z",
      ahead: 3,
      dirty: 0,
      labels: [],
    });
    await clearUnsentMark(storage);
    expect(readUnsentMark(storage)).toBeUndefined();
    expect(UNSENT_MARK_KEY in storage.raw()).toBe(false);
  });

  test("何も無ければ印も無い", () => {
    expect(readUnsentMark(memory())).toBeUndefined();
  });
});

describe("壊れた印は、印が無いのと同じに扱う", () => {
  // **読めなければ知らせが1回出ないだけで、原稿には何も起きない。**
  // 直そうとして書き換えるほうが危ない
  test("形が違うもの", () => {
    expect(readUnsentMark(memory({ [UNSENT_MARK_KEY]: "こわれた" }))).toBeUndefined();
    expect(readUnsentMark(memory({ [UNSENT_MARK_KEY]: null }))).toBeUndefined();
    expect(readUnsentMark(memory({ [UNSENT_MARK_KEY]: { ahead: 3 } }))).toBeUndefined();
  });

  test("数が両方0なら、送り残しは無い", () => {
    expect(
      readUnsentMark(
        memory({
          [UNSENT_MARK_KEY]: { at: "2026-09-21T20:00:00.000Z", ahead: 0, dirty: 0 },
        })
      )
    ).toBeUndefined();
  });

  test("置き場の名前が欠けていても、件数は読める", () => {
    expect(
      readUnsentMark(
        memory({
          [UNSENT_MARK_KEY]: { at: "2026-09-21T20:00:00.000Z", ahead: 2 },
        })
      )
    ).toEqual({ at: "2026-09-21T20:00:00.000Z", ahead: 2, dirty: 0, labels: [] });
  });
});

describe("送り残しを数える", () => {
  const NOW = new Date("2026-09-21T20:00:00.000Z");

  function tracked(
    over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
  ): GitSyncStatus {
    return {
      kind: "tracked",
      root: "C:/書庫",
      branch: "main",
      upstream: "origin/main",
      behind: 0,
      ahead: 0,
      behindHere: 0,
      aheadHere: 0,
      dirty: 0,
      dirtyHere: 0,
      unmerged: 0,
      ...over,
    };
  }

  test("書庫に11作品あっても、置き場の数は1回しか足さない", () => {
    // **`ahead`／`dirty` は置き場ぜんぶの数**なので、作品ごとに足すと11倍になる
    const entries = Array.from({ length: 11 }, (_, i) => ({
      label: `作品${i}`,
      status: tracked({ ahead: 3, dirty: 2 }),
    }));
    expect(summarizeUnsent(entries, NOW)).toMatchObject({
      ahead: 3,
      dirty: 2,
      labels: ["作品0"],
    });
  });

  test("別の置き場は、それぞれ足す", () => {
    const summary = summarizeUnsent(
      [
        { label: "書庫", status: tracked({ ahead: 3 }) },
        {
          label: "別作品",
          status: tracked({ root: "C:/別作品", ahead: 1, dirty: 4 }),
        },
      ],
      NOW
    );
    expect(summary).toMatchObject({ ahead: 4, dirty: 4 });
    expect(summary?.labels).toEqual(["書庫", "別作品"]);
  });

  test("送り残しが無ければ、印を付けない", () => {
    expect(
      summarizeUnsent([{ label: "書庫", status: tracked() }], NOW)
    ).toBeUndefined();
  });

  test("受け取り待ちだけでは、送り残しにならない", () => {
    // 取りこぼしは「送っていない」ことであって、遅れていることではない
    expect(
      summarizeUnsent([{ label: "書庫", status: tracked({ behind: 5 }) }], NOW)
    ).toBeUndefined();
  });

  test("gitを使っていない作品は数えない", () => {
    expect(
      summarizeUnsent([{ label: "手書き", status: { kind: "not_a_repo" } }], NOW)
    ).toBeUndefined();
  });

  test("まだ一度も送っていない置き場は、記録待ちを数える", () => {
    expect(
      summarizeUnsent(
        [
          {
            label: "新作",
            status: {
              kind: "no_upstream",
              root: "C:/新作",
              branch: "main",
              dirty: 6,
              dirtyHere: 6,
            },
          },
        ],
        NOW
      )
    ).toMatchObject({ ahead: 0, dirty: 6 });
  });
});

describe("知らせの文", () => {
  test("前回であることを先に言い、置き場と件数を出す", () => {
    const text = describeUnsentMark({
      at: "2026-09-21T20:00:00.000Z",
      ahead: 3,
      dirty: 1,
      labels: ["書庫"],
    });
    expect(text).toContain("前回、送らずに閉じました");
    expect(text).toContain("書庫");
    expect(text).toContain("送信待ち 3件");
    expect(text).toContain("記録待ち 1件");
  });

  test("片方しか無ければ、無いほうは書かない", () => {
    const text = describeUnsentMark({
      at: "2026-09-21T20:00:00.000Z",
      ahead: 0,
      dirty: 2,
      labels: [],
    });
    expect(text).not.toContain("送信待ち");
    expect(text).toContain("記録待ち 2件");
  });
});
