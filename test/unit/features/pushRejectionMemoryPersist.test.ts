import { describe, expect, it } from "vitest";
import { PushRejectionMemory } from "../../../src/features/pushRejectionMemory";
import { describeTooLargeToSend } from "../../../src/core/gitLargeFiles";

/**
 * 送信を断られた覚えを、起動し直しても残す（作者の答え 2026-11-16「残す」。設計書5.5.21、1.0.16）。
 * 同じ記録なら、起動し直しても自動では送らず、窓も出さない。
 */

/** VS Code の globalState の代わり（読みと書きだけ） */
function fakeStore(): { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Promise<void>; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T>(key: string, fallback: T): T {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : fallback;
    },
    async update(key: string, value: unknown): Promise<void> {
      data.set(key, structuredClone(value));
    },
  };
}

describe("送信を断られた覚えは、起動し直しても残る", () => {
  it("覚えた置き場と記録は、新しく作った覚え（起動し直した形）でも断られたものとして返る", async () => {
    const store = fakeStore();
    const before = new PushRejectionMemory();
    before.attach(store);
    before.remember("C:\\小説\\書庫", "abc123", "断られた理由");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = new PushRejectionMemory();
    after.attach(store);
    expect(after.rejectedReason("C:\\小説\\書庫", "abc123")).toBe("断られた理由");
    // 記録が変われば（記録し直した・取り込んだ）また試す
    expect(after.rejectedReason("C:\\小説\\書庫", "def456")).toBeUndefined();
  });

  it("通って忘れたものは、起動し直しても戻ってこない", async () => {
    const store = fakeStore();
    const before = new PushRejectionMemory();
    before.attach(store);
    before.remember("C:\\小説\\書庫", "abc123", "断られた理由");
    before.forget("C:\\小説\\書庫");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = new PushRejectionMemory();
    after.attach(store);
    expect(after.rejectedReason("C:\\小説\\書庫", "abc123")).toBeUndefined();
  });

  it("保管庫の中身が壊れていても、覚えを空として動く（投げない）", () => {
    const store = fakeStore();
    store.data.set(PushRejectionMemory.STORAGE_KEY, { "c:/小説/書庫": { head: 1 }, other: "文字" });
    const memory = new PushRejectionMemory();
    memory.attach(store);
    expect(memory.rejectedReason("C:\\小説\\書庫", "1")).toBeUndefined();
  });
});

describe("送る前に大きさで止めたときの知らせに、戻し方の手順が入る（作者の答え 2026-11-16「案内だけ出す」）", () => {
  const text = describeTooLargeToSend([{ path: "素材/big.zip", size: 200 * 1024 * 1024, untracked: false }]);

  it("VS Code の日本語の画面の名前で、取り消し・ステージング解除・もう一度同期を順に書く", () => {
    const undo = text.indexOf("前回のコミットを元に戻す");
    const unstage = text.indexOf("変更のステージング解除");
    const again = text.indexOf("もう一度同期");
    expect(text).toContain("ソース管理");
    expect(undo).toBeGreaterThan(0);
    expect(unstage).toBeGreaterThan(undo);
    expect(again).toBeGreaterThan(unstage);
  });

  it("取り消しても原稿は消えないことを書く", () => {
    expect(text).toContain("原稿は消えません");
  });
});
