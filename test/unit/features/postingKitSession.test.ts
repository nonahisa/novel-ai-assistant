import { describe, expect, test } from "vitest";
import {
  applyQueuedPostingUpdates,
  beginPostingKitSession,
  endPostingKitSession,
  findIssuedPostRef,
  isPostingKitActive,
  queuedPostingUpdatesOf,
  queuePostingUpdate,
  rememberIssuedPostRef,
  type QueuedPostingUpdate,
} from "../../../src/features/postingKitSession";
import { emptyPostingLedger, withPost } from "../../../src/models/posting";

/**
 * 投稿キットの案内が開いている間の預かり（設計書6.68.8）。
 * 当てる操作は何度当てても同じ結果になること・案内を終えると消えることを確かめる。
 */

const episode = (episodeId: string, allowReplace = false): QueuedPostingUpdate => ({
  kind: "episode",
  site: "kakuyomu",
  target: "本文/013.txt",
  episodeId,
  allowReplace,
  label: "第13話",
});

describe("預かり", () => {
  test("案内が開いていなければ預からない。開いていれば預かり、終えると返して消える", () => {
    expect(queuePostingUpdate("w1", episode("1"))).toBe(false);
    beginPostingKitSession("w1");
    expect(isPostingKitActive("w1")).toBe(true);
    expect(queuePostingUpdate("w1", episode("1"))).toBe(true);
    // 同じ話・同じサイトは新しいもので置き換える（2度受けても積まない）
    queuePostingUpdate("w1", episode("2"));
    expect(queuedPostingUpdatesOf("w1")).toEqual([episode("2")]);
    expect(endPostingKitSession("w1")).toEqual([episode("2")]);
    expect(isPostingKitActive("w1")).toBe(false);
    expect(queuedPostingUpdatesOf("w1")).toEqual([]);
  });

  test("入れ子の内側で終えても、外側の預かりは残る", () => {
    beginPostingKitSession("w2");
    beginPostingKitSession("w2");
    queuePostingUpdate("w2", episode("1"));
    expect(endPostingKitSession("w2")).toEqual([]);
    expect(isPostingKitActive("w2")).toBe(true);
    expect(endPostingKitSession("w2")).toHaveLength(1);
  });

  test("渡した札は、開いている案内の中でだけ引ける", () => {
    beginPostingKitSession("w3");
    rememberIssuedPostRef("w3", "ref1", { site: "kakuyomu", target: "本文/013.txt", title: "邂逅" });
    expect(findIssuedPostRef("ref1")?.workId).toBe("w3");
    endPostingKitSession("w3");
    expect(findIssuedPostRef("ref1")).toBeUndefined();
  });
});

describe("預かりを台帳へ当てる", () => {
  const empty = { ...emptyPostingLedger(), sites: [] };

  test("投稿の記録がまだ無ければ待たせ、記録ができたら入る。何度当てても同じ", () => {
    const waiting = applyQueuedPostingUpdates(empty, [episode("5")]);
    expect(waiting.changed).toBe(false);
    expect(waiting.waiting[0].reason).toContain("投稿の記録がまだありません");

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
    expect(kept.waiting[0].reason).toContain("別の番号");
    expect(applyQueuedPostingUpdates(numbered, [episode("5", true)]).ledger.posts[0].siteEpisodeId).toBe("5");
  });

  test("小説番号も当てる。形が違えば待たせて言う", () => {
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
    expect(bad.waiting).toHaveLength(1);
  });
});
