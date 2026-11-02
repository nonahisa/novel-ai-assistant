import { describe, expect, test } from "vitest";
import {
  isRankCelebrationId,
  markRankCelebrationsShown,
  notifyRankEvents,
  pendingRankCelebration,
} from "../../../src/features/rankCelebrations";
import { emptyPostingLedger, type PostingLedger } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";

/** 順位のお祝いを二度出さない（知らせも、執筆統計の風船も。作者の指示 2026-11-02） */

class FakeMemento {
  values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}

const work = { id: "w1", title: "苦手の流転", folderPath: "C:/works/a" } as unknown as WorkEntry;
const now = new Date("2026-11-02T10:00:00+09:00");

function ledger(ranks: Array<[string, number]>): PostingLedger {
  return {
    ...emptyPostingLedger(),
    rankings: ranks.map(([day, rank]) => ({
      site: "narou",
      recordedAt: `${day}T00:00:00+09:00`,
      board: "日間",
      rank,
      source: "narou-api",
    })),
  };
}

describe("知らせ", () => {
  test("新しく入った順位を1回だけ知らせる（同じ台帳を何度保存しても二度出さない）", async () => {
    const memento = new FakeMemento();
    const shown: string[] = [];
    const show = (message: string) => shown.push(message);
    const first = await notifyRankEvents(memento, work, ledger([["2026-11-01", 45]]), { now, enabled: true, show });
    const again = await notifyRankEvents(memento, work, ledger([["2026-11-01", 45]]), { now, enabled: true, show });
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);
    expect(shown).toEqual(["「苦手の流転」が小説家になろうの日間で45位に入りました！"]);
  });

  test("上がったらまた知らせ、下がったら何も出さない", async () => {
    const memento = new FakeMemento();
    const shown: string[] = [];
    const show = (message: string) => shown.push(message);
    await notifyRankEvents(memento, work, ledger([["2026-10-31", 45]]), { now, enabled: true, show });
    await notifyRankEvents(memento, work, ledger([["2026-10-31", 45], ["2026-11-01", 30]]), { now, enabled: true, show });
    await notifyRankEvents(memento, work, ledger([["2026-10-31", 45], ["2026-11-01", 30], ["2026-11-02", 60]]), { now, enabled: true, show });
    expect(shown).toEqual([
      "「苦手の流転」が小説家になろうの日間で45位に入りました！",
      "「苦手の流転」が小説家になろうの日間で自己最高の45位を抜いて30位になりました！",
    ]);
  });

  test("祝いを切っている（novelai.celebrations.enabled）ときは出さない", async () => {
    const shown: string[] = [];
    await notifyRankEvents(new FakeMemento(), work, ledger([["2026-11-01", 1]]), {
      now,
      enabled: false,
      show: (message) => shown.push(message),
    });
    expect(shown).toEqual([]);
  });
});

describe("執筆統計の風船", () => {
  test("見せ終えたら二度は上げない。知らせを出したかとは別に覚える", async () => {
    const memento = new FakeMemento();
    await notifyRankEvents(memento, work, ledger([["2026-11-01", 1]]), { now, enabled: true, show: () => undefined });
    const payload = pendingRankCelebration(memento, work, ledger([["2026-11-01", 1]]), { now, enabled: true });
    expect(payload).toMatchObject({ size: "grand", lines: ["小説家になろうの日間で1位に入りました"] });
    expect(payload?.ids.every(isRankCelebrationId)).toBe(true);
    await markRankCelebrationsShown(memento, payload?.ids ?? []);
    expect(pendingRankCelebration(memento, work, ledger([["2026-11-01", 1]]), { now, enabled: true })).toBeUndefined();
  });

  test("執筆の目標の祝いの鍵は、順位の帳面に入れない", async () => {
    const memento = new FakeMemento();
    await markRankCelebrationsShown(memento, ["daily:2026-11-02:1000"]);
    expect(memento.values.size).toBe(0);
    expect(isRankCelebrationId("daily:2026-11-02:1000")).toBe(false);
  });
});
