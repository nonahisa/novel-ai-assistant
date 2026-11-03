import { beforeEach, describe, expect, test } from "vitest";
import {
  applyQueuedPostingUpdates,
  beginPostingKitSession,
  endPostingKitSession,
  findIssuedPostRef,
  isPostingKitActive,
  PENDING_MAX_AGE_DAYS,
  PENDING_MEMORY_KEY,
  planPendingSettlement,
  prunePendingOfUnknownWorks,
  queuedPostingUpdatesOf,
  queuePostingUpdate,
  rememberIssuedPostRef,
  settlePendingUpdates,
  storedPostingUpdatesOf,
  usePostingPendingMemory,
  type PendingMemory,
  type QueuedPostingUpdate,
  type StoredPostingUpdate,
} from "../../../src/features/postingKitSession";
import { emptyPostingLedger, withPost } from "../../../src/models/posting";

/**
 * ヘルパーから届いた番号の預かり（設計書6.68.8）。
 * 保管庫に残ること（VS Code を閉じても消えない）・何度当てても同じ結果になること・
 * 入れたら消え、待っても直らないもの・古いものも消えることを確かめる。
 */

function memento(): PendingMemory & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get<T>(key: string, defaultValue: T): T {
      return values.has(key) ? (values.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown): Thenable<void> {
      // 本物の保管庫と同じく、JSON に通した形で持つ（参照の同一で通るテストにしない）
      values.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
  };
}

const episode = (
  episodeId: string,
  allowReplace = false
): Extract<QueuedPostingUpdate, { kind: "episode" }> => ({
  kind: "episode",
  site: "kakuyomu",
  target: "本文/013.txt",
  episodeId,
  allowReplace,
  label: "第13話",
});

let store = memento();
beforeEach(() => {
  store = memento();
  usePostingPendingMemory(store);
});

describe("預かり", () => {
  test("案内が開いていなければ預からない。開いていれば保管庫へ預け、案内を終えても残る", async () => {
    expect(await queuePostingUpdate("w1", episode("1"))).toBe(false);
    beginPostingKitSession("w1");
    expect(isPostingKitActive("w1")).toBe(true);
    expect(await queuePostingUpdate("w1", episode("1"))).toBe(true);
    // 同じ話・同じサイトは新しいもので置き換える（2度受けても積まない）
    await queuePostingUpdate("w1", episode("2"));
    expect(queuedPostingUpdatesOf("w1")).toEqual([episode("2")]);
    expect(endPostingKitSession("w1").map((row) => row.update)).toEqual([episode("2")]);
    expect(isPostingKitActive("w1")).toBe(false);
    // **保管庫に残る**（VS Code を閉じても消えない。作者の答え 2026-11-03 昼）
    expect(queuedPostingUpdatesOf("w1")).toEqual([episode("2")]);
    expect(store.values.has(PENDING_MEMORY_KEY)).toBe(true);
  });

  test("入れ子の内側で終えても、外側の案内は開いたまま", () => {
    beginPostingKitSession("w2");
    beginPostingKitSession("w2");
    expect(endPostingKitSession("w2")).toEqual([]);
    expect(isPostingKitActive("w2")).toBe(true);
    endPostingKitSession("w2");
    expect(isPostingKitActive("w2")).toBe(false);
  });

  test("渡した札は、開いている案内の中でだけ引ける", () => {
    beginPostingKitSession("w3");
    rememberIssuedPostRef("w3", "ref1", { site: "kakuyomu", target: "本文/013.txt", title: "邂逅" });
    expect(findIssuedPostRef("ref1")?.workId).toBe("w3");
    endPostingKitSession("w3");
    expect(findIssuedPostRef("ref1")).toBeUndefined();
  });

  test("形の崩れた保管庫の行は読まない（台帳を書き換えない）", () => {
    store.values.set(PENDING_MEMORY_KEY, {
      w4: [{ queuedAt: "x", update: { kind: "episode", site: "kakuyomu" } }, "壊れた"],
      w5: "壊れた",
    });
    expect(storedPostingUpdatesOf("w4")).toEqual([]);
    expect(storedPostingUpdatesOf("w5")).toEqual([]);
  });
});

describe("預かりを台帳へ当てる", () => {
  const empty = { ...emptyPostingLedger(), sites: [] };

  test("投稿の記録がまだ無ければ待たせ、記録ができたら入る。何度当てても同じ", () => {
    const waiting = applyQueuedPostingUpdates(empty, [episode("5")]);
    expect(waiting.changed).toBe(false);
    expect(waiting.waiting[0].kind).toBe("noPost");

    const posted = withPost(empty, "本文/013.txt", "kakuyomu", "2026-11-03T00:00:00.000Z");
    const once = applyQueuedPostingUpdates(posted, [episode("5")]);
    expect(once.changed).toBe(true);
    expect(once.ledger.posts[0].siteEpisodeId).toBe("5");
    const twice = applyQueuedPostingUpdates(once.ledger, [episode("5")]);
    expect(twice.changed).toBe(false);
    expect(twice.ledger).toBe(once.ledger);
  });

  test("別の番号がある話は、替える答えが無ければ替えない", () => {
    const posted = withPost(empty, "本文/013.txt", "kakuyomu", "x");
    const numbered = applyQueuedPostingUpdates(posted, [episode("4")]).ledger;
    const kept = applyQueuedPostingUpdates(numbered, [episode("5")]);
    expect(kept.ledger.posts[0].siteEpisodeId).toBe("4");
    expect(kept.waiting[0].kind).toBe("replace");
    expect(applyQueuedPostingUpdates(numbered, [episode("5", true)]).ledger.posts[0].siteEpisodeId).toBe("5");
  });

  test("小説番号も当てる。形が違えば待たせる", () => {
    const update: QueuedPostingUpdate = {
      kind: "workNumber",
      site: "narou",
      number: "1234567",
      recordedAt: "2026-11-03T00:00:00.000Z",
    };
    const applied = applyQueuedPostingUpdates(empty, [update]);
    expect(applied.ledger.siteFacts?.[0]).toMatchObject({ site: "narou", siteWorkNumber: "1234567" });
    const bad = applyQueuedPostingUpdates(empty, [{ ...update, number: "n12" }]);
    expect(bad.changed).toBe(false);
    expect(bad.waiting[0].kind).toBe("invalid");
  });
});

describe("片づけの決まり", () => {
  const empty = { ...emptyPostingLedger(), sites: [] };
  const now = new Date("2026-11-20T00:00:00.000Z");
  const row = (update: QueuedPostingUpdate, queuedAt: string): StoredPostingUpdate => ({ update, queuedAt });

  test("投稿の記録を待つものは日数まで残し、過ぎたら消す", () => {
    const fresh = row(episode("5"), "2026-11-19T00:00:00.000Z");
    const stale = row({ ...episode("6"), target: "本文/014.txt" }, "2026-11-01T00:00:00.000Z");
    const plan = planPendingSettlement(empty, [fresh, stale], now);
    expect(plan.keep).toEqual([fresh]);
    expect(plan.dropped.map((entry) => entry.reason)).toEqual([
      `${PENDING_MAX_AGE_DAYS}日たっても投稿の記録ができませんでした`,
    ]);
  });

  test("入ったものと、待っても直らないもの（別の番号がある）は残さない", () => {
    const posted = withPost(
      withPost(empty, "本文/013.txt", "kakuyomu", "x"),
      "本文/014.txt",
      "kakuyomu",
      "x"
    );
    const numbered = applyQueuedPostingUpdates(posted, [{ ...episode("9"), target: "本文/014.txt" }]).ledger;
    const plan = planPendingSettlement(
      numbered,
      [row(episode("5"), "2026-11-19T00:00:00.000Z"), row({ ...episode("6"), target: "本文/014.txt" }, "2026-11-19T00:00:00.000Z")],
      now
    );
    expect(plan.changed).toBe(true);
    expect(plan.keep).toEqual([]);
    expect(plan.dropped).toHaveLength(1);
  });

  test("片づけのあいだに預けられた分は消さない", async () => {
    beginPostingKitSession("w6");
    await queuePostingUpdate("w6", episode("5"), new Date("2026-11-19T00:00:00.000Z"));
    const settled = [...storedPostingUpdatesOf("w6")];
    await queuePostingUpdate("w6", { ...episode("7"), target: "本文/015.txt" }, new Date("2026-11-19T01:00:00.000Z"));
    await settlePendingUpdates("w6", settled, []);
    expect(queuedPostingUpdatesOf("w6").map((update) => update.kind === "episode" && update.episodeId)).toEqual(["7"]);
    endPostingKitSession("w6");
  });

  test("登録の無い作品の古い預かりは消し、新しいものは残す", async () => {
    store.values.set(PENDING_MEMORY_KEY, {
      gone: [row(episode("5"), "2026-11-01T00:00:00.000Z"), row({ ...episode("6"), target: "b" }, "2026-11-19T00:00:00.000Z")],
      known: [row(episode("7"), "2026-01-01T00:00:00.000Z")],
    });
    expect(await prunePendingOfUnknownWorks(["known"], now)).toBe(1);
    expect(storedPostingUpdatesOf("gone")).toHaveLength(1);
    // 登録のある作品は起動時の片づけ（台帳へ当てる）に任せる
    expect(storedPostingUpdatesOf("known")).toHaveLength(1);
  });
});
