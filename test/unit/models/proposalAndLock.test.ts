import { describe, expect, test } from "vitest";
import {
  proposalId,
  resolveProposals,
  type ProposalLine,
} from "../../src/models/proposal";
import { parseProposalLines } from "../../src/core/proposalStore";
import {
  describeLock,
  lockOf,
  normalizeFile,
  resolveLocks,
  type LockEvent,
} from "../../src/models/fileLock";
import { parseLockEvents } from "../../src/core/fileLockStore";

/**
 * 編集部からの提案と、校閲ロック（設計書5.6）。
 *
 * **編集部は本文を書き換えない。提案として置く**（2026-08-19、作者の判断）。
 * はじめは「編集部も直せる」前提で作っていたが、作者の意向に反して
 * 勝手に書き換えられる恐れがあった。
 *
 * 提案にすると、**競合そのものが起きない。** 編集部が触るのは提案の
 * ファイルだけで、本文には一切書き込まないためである。
 */
function proposal(overrides: Record<string, unknown> = {}): ProposalLine {
  return {
    kind: "proposal",
    id: "p1",
    time: "2026-08-19T10:00:00.000Z",
    proposer: "kmizu",
    file: "episode_0001.md",
    line: 12,
    original: "手足の冷たさがｈっきりとわかる。",
    target: "ｈっきりと",
    suggestion: "はっきりと",
    reason: "誤変換",
    category: "誤字脱字",
    ...overrides,
  } as ProposalLine;
}

function decision(overrides: Record<string, unknown> = {}): ProposalLine {
  return {
    kind: "decision",
    proposalId: "p1",
    time: "2026-08-19T11:00:00.000Z",
    decidedBy: "nonahisa",
    status: "accepted",
    note: "",
    ...overrides,
  } as ProposalLine;
}

describe("提案の番号", () => {
  test("同じ場所の同じ直しなら、同じ番号になる", () => {
    // **編集部が2回検知しても、提案は1件で済む**
    expect(proposalId("a.md", 1, "あ", "い")).toBe(
      proposalId("a.md", 1, "あ", "い")
    );
  });

  test("直す中身が違えば別の番号", () => {
    expect(proposalId("a.md", 1, "あ", "い")).not.toBe(
      proposalId("a.md", 1, "あ", "う")
    );
  });

  test("場所が違えば別の番号", () => {
    expect(proposalId("a.md", 1, "あ", "い")).not.toBe(
      proposalId("a.md", 2, "あ", "い")
    );
  });
});

describe("提案と決定を突き合わせる", () => {
  test("決定が無ければ未決", () => {
    const [view] = resolveProposals([proposal()]);

    expect(view.status).toBe("pending");
  });

  test("承認されていればそう出る", () => {
    const [view] = resolveProposals([proposal(), decision()]);

    expect(view.status).toBe("accepted");
    expect(view.decision?.decidedBy).toBe("nonahisa");
  });

  test("あとから来た決定が勝つ", () => {
    // **却下してから考え直して承認することがある。**
    // 追記だけの作りなので、時刻の新しいほうを見る
    const [view] = resolveProposals([
      proposal(),
      decision({ status: "rejected", time: "2026-08-19T11:00:00.000Z" }),
      decision({ status: "accepted", time: "2026-08-19T12:00:00.000Z" }),
    ]);

    expect(view.status).toBe("accepted");
  });

  test("同じ提案が二重に来ても1件にする", () => {
    // **競合を「両方残す」で解決すると、同じ行が2つになる**
    expect(resolveProposals([proposal(), proposal()])).toHaveLength(1);
  });

  test("未決が先に並ぶ", () => {
    const views = resolveProposals([
      proposal({ id: "p1" }),
      decision({ proposalId: "p1" }),
      proposal({ id: "p2", time: "2026-08-18T10:00:00.000Z" }),
    ]);

    expect(views.map((view) => view.status)).toEqual(["pending", "accepted"]);
  });
});

describe("提案の読み取り", () => {
  test("読めない行は捨てて、読める行は残す", () => {
    const text = [
      JSON.stringify(proposal()),
      "{壊れている",
      JSON.stringify(proposal({ id: "p2" })),
    ].join("\n");

    expect(parseProposalLines(text)).toHaveLength(2);
  });

  test("競合マーカーの行を落とす", () => {
    const text = [
      "<<<<<<< HEAD",
      JSON.stringify(proposal()),
      "=======",
      JSON.stringify(proposal({ id: "p2" })),
      ">>>>>>> origin/main",
    ].join("\n");

    expect(parseProposalLines(text)).toHaveLength(2);
  });

  test("どこを直すか分からない提案は取らない", () => {
    // **作者が判断できない**
    const text = JSON.stringify({ kind: "proposal", id: "x", file: "a.md" });

    expect(parseProposalLines(text)).toEqual([]);
  });

  test("知らない種類の行は取らない", () => {
    expect(parseProposalLines(JSON.stringify({ kind: "何か" }))).toEqual([]);
  });
});

/**
 * **ロックはファイル単位**（作者の判断）。作品全体を止めると、
 * 編集部が第3話を見ている間、作者は第20話も書けなくなる。
 */
function lockEvent(overrides: Partial<LockEvent> = {}): LockEvent {
  return {
    kind: "acquire",
    file: "episode_0003.md",
    holder: "kmizu",
    holderKind: "editor",
    time: "2026-08-19T10:00:00.000Z",
    note: "校閲中",
    ...overrides,
  };
}

describe("校閲ロック", () => {
  test("取ればかかる", () => {
    const locks = resolveLocks([lockEvent()]);

    expect(lockOf(locks, "episode_0003.md")?.holder).toBe("kmizu");
  });

  test("他のファイルはかからない", () => {
    // **ここが要。** 第3話を押さえても第20話は書ける
    const locks = resolveLocks([lockEvent()]);

    expect(lockOf(locks, "episode_0020.md")).toBeUndefined();
  });

  test("外せば外れる", () => {
    const locks = resolveLocks([
      lockEvent(),
      lockEvent({ kind: "release", time: "2026-08-19T12:00:00.000Z" }),
    ]);

    expect(lockOf(locks, "episode_0003.md")).toBeUndefined();
  });

  test("外してから取り直せば、またかかる", () => {
    const locks = resolveLocks([
      lockEvent(),
      lockEvent({ kind: "release", time: "2026-08-19T12:00:00.000Z" }),
      lockEvent({ time: "2026-08-19T13:00:00.000Z" }),
    ]);

    expect(lockOf(locks, "episode_0003.md")).toBeDefined();
  });

  test("作者が外したものも外れる", () => {
    // **作者が自分の原稿を触れなくなることだけは起きてはならない**
    const locks = resolveLocks([
      lockEvent(),
      lockEvent({
        kind: "release",
        holder: "nonahisa",
        holderKind: "author",
        time: "2026-08-19T12:00:00.000Z",
      }),
    ]);

    expect(lockOf(locks, "episode_0003.md")).toBeUndefined();
  });

  test("パスの書き方が違っても同じファイルと見なす", () => {
    const locks = resolveLocks([lockEvent({ file: "話\\episode_0003.md" })]);

    expect(lockOf(locks, "話/Episode_0003.md")).toBeDefined();
    expect(normalizeFile(".\\a\\B.md")).toBe("a/b.md");
  });
});

describe("ロックの説明", () => {
  test("誰が・何をしているかを言う", () => {
    const message = describeLock({
      file: "episode_0003.md",
      holder: "kmizu",
      holderKind: "editor",
      since: new Date().toISOString(),
      note: "第3話の校閲",
    });

    expect(message).toContain("kmizu");
    expect(message).toContain("第3話の校閲");
  });

  test("長く続いているなら、外し忘れを疑わせる", () => {
    // **「ロックされています」だけでは、待つのか連絡するのか判断できない**
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const message = describeLock({
      file: "a.md",
      holder: "kmizu",
      holderKind: "editor",
      since: twoDaysAgo,
      note: "",
    });

    expect(message).toContain("外し忘れ");
  });
});

describe("ロックの読み取り", () => {
  test("壊れた行を飛ばして読む", () => {
    const text = [
      JSON.stringify(lockEvent()),
      "こわれている",
      JSON.stringify(lockEvent({ file: "b.md" })),
    ].join("\n");

    expect(parseLockEvents(text)).toHaveLength(2);
  });

  test("ファイルが分からない記録は取らない", () => {
    expect(
      parseLockEvents(JSON.stringify({ kind: "acquire", holder: "x" }))
    ).toEqual([]);
  });
});
