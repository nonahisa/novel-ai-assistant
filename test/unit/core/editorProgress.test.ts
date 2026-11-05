import { describe, expect, test } from "vitest";
import {
  describeEditorStatus,
  formatWhen,
  judgeEditorProgress,
  lastReceivedFromReflog,
  type EditorProgressFacts,
} from "../../../src/core/editorProgress";
import type { FileLock } from "../../../src/models/fileLock";
import {
  decisionKey,
  HAND_EDIT_CATEGORY,
  HAND_MEMO_CATEGORY,
  type ProposalView,
} from "../../../src/models/proposal";

/**
 * 編集者メニューの進み具合（作者の指示 2026-11-05 夜。設計書5.6.6 の表）。
 *
 * 表の行ごとに1つずつ確かめる。**分からないものは「済み」にしない**（作者の指示）ことと、
 * **前の回の提案で、次の回の手順が済みに見えない**ことを特に見る。
 */

function lock(file: string, since: string): FileLock {
  return { file, holder: "kmizu", holderKind: "editor", since, note: "校閲中" };
}

let counter = 0;
function proposal(
  time: string,
  category: string,
  status: ProposalView["status"] = "pending",
  decidedAt?: string
): ProposalView {
  counter += 1;
  const id = `p${counter}`;
  return {
    id,
    time,
    proposer: "kmizu",
    file: "本文/001.txt",
    line: 3,
    original: "雨が降っていた。",
    target: "雨",
    suggestion: category === HAND_MEMO_CATEGORY ? "" : "雪",
    reason: "季節",
    category,
    status,
    ...(status === "pending"
      ? {}
      : {
          decision: {
            proposalId: id,
            time: decidedAt ?? "2026-11-05T12:00:00.000Z",
            decidedBy: "作者",
            status,
            note: "",
          },
        }),
  };
}

function facts(overrides: Partial<EditorProgressFacts> = {}): EditorProgressFacts {
  return {
    sync: { behind: 0, ahead: 0, dirty: 0 },
    myLocks: [],
    myProposals: [],
    seenDecisions: new Set(),
    ...overrides,
  };
}

describe("1. 受け取る", () => {
  test("GitHub の状態が読めて、未取得が0なら済み", () => {
    expect(judgeEditorProgress(facts()).marks.receive).toBe("done");
  });

  test("作者の新しい原稿があれば、まだ。ほかが進んでいても「次はここ」は1", () => {
    const progress = judgeEditorProgress(
      facts({
        sync: { behind: 2, ahead: 0, dirty: 1 },
        myLocks: [lock("本文/001.txt", "2026-11-05T10:00:00.000Z")],
      })
    );
    expect(progress.marks.receive).toBe("next");
    expect(progress.next).toBe("receive");
    expect(progress.notes.receive).toContain("未取得 2");
  });

  test("GitHub の状態が読めないときは、済みにしない", () => {
    const progress = judgeEditorProgress(facts({ sync: undefined }));
    expect(progress.marks.receive).not.toBe("done");
    expect(progress.notes.receive).toContain("読めていません");
  });
});

describe("2. 話を選ぶ", () => {
  test("自分の校閲の鍵が1つ以上あれば済み", () => {
    const progress = judgeEditorProgress(
      facts({ myLocks: [lock("本文/001.txt", "2026-11-05T10:00:00.000Z")] })
    );
    expect(progress.marks.range).toBe("done");
    expect(progress.next).toBe("detect");
  });

  test("参加したばかり（鍵も提案も無い）なら、次は2", () => {
    const progress = judgeEditorProgress(facts());
    expect(progress.marks.range).toBe("next");
    expect(progress.next).toBe("range");
    expect(progress.phase).toBe("reviewing");
  });
});

describe("3・4. この回に置いた提案", () => {
  const since = "2026-11-05T10:00:00.000Z";

  test("この回に検知から置いた提案があれば3が済み、手で書いた提案があれば4が済み", () => {
    const progress = judgeEditorProgress(
      facts({
        sync: { behind: 0, ahead: 0, dirty: 1 },
        myLocks: [lock("本文/001.txt", since)],
        myProposals: [
          proposal("2026-11-05T10:05:00.000Z", "誤字脱字"),
          proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY),
        ],
      })
    );
    expect(progress.marks.detect).toBe("done");
    expect(progress.marks.propose).toBe("done");
    expect(progress.roundProposals).toBe(2);
    expect(progress.next).toBe("review");
  });

  test("機械に探させずに手で書いただけなら、3は「まだ」のまま、次は5（飛ばした手順で止めない）", () => {
    const progress = judgeEditorProgress(
      facts({
        sync: { behind: 0, ahead: 0, dirty: 1 },
        myLocks: [lock("本文/001.txt", since)],
        myProposals: [proposal("2026-11-05T10:06:00.000Z", HAND_MEMO_CATEGORY)],
      })
    );
    expect(progress.marks.detect).toBe("todo");
    expect(progress.marks.propose).toBe("done");
    expect(progress.next).toBe("review");
  });

  test("鍵より前に置いた提案（前の回の、作者がまだ決めていないもの）は、この回に数えない", () => {
    const progress = judgeEditorProgress(
      facts({
        myLocks: [lock("本文/001.txt", since)],
        myProposals: [
          proposal("2026-11-01T09:00:00.000Z", "誤字脱字"),
          proposal("2026-11-01T09:01:00.000Z", HAND_EDIT_CATEGORY),
        ],
      })
    );
    expect(progress.marks.detect).toBe("next");
    expect(progress.marks.propose).toBe("todo");
    expect(progress.roundProposals).toBe(0);
  });

  test("鍵が無く、GitHub の状態も読めないときは、提案があっても3・4を済みにしない", () => {
    const progress = judgeEditorProgress(
      facts({
        sync: undefined,
        myProposals: [proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY)],
      })
    );
    expect(progress.marks.detect).not.toBe("done");
    expect(progress.marks.propose).not.toBe("done");
    expect(progress.marks.return).not.toBe("done");
  });
});

describe("5・6. 返し終えた", () => {
  test("鍵が0・送っていない変更が0・置いた提案が1つ以上なら、2〜6が済み", () => {
    const progress = judgeEditorProgress(
      facts({ myProposals: [proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY)] })
    );
    expect(progress.phase).toBe("returned");
    for (const key of ["receive", "range", "detect", "propose", "review", "return"] as const) {
      expect(progress.marks[key], key).toBe("done");
    }
    // 作者の返事待ち：押しても進まない手順を「次はここ」と言わない
    expect(progress.marks.decisions).toBe("todo");
    expect(progress.next).toBeUndefined();
    expect(progress.notes.decisions).toContain("返事待ち 1");
  });

  test("送っていない変更が残っていれば、返し終えていない", () => {
    const progress = judgeEditorProgress(
      facts({
        sync: { behind: 0, ahead: 1, dirty: 0 },
        myProposals: [proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY)],
      })
    );
    expect(progress.phase).toBe("reviewing");
    expect(progress.marks.return).not.toBe("done");
    expect(progress.notes.return).toContain("まだ返していません");
  });

  test("まだ鍵を押さえていれば、返し終えていない", () => {
    const progress = judgeEditorProgress(
      facts({
        myLocks: [lock("本文/001.txt", "2026-11-05T10:00:00.000Z")],
        myProposals: [proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY)],
      })
    );
    expect(progress.marks.return).not.toBe("done");
  });

  test("一度も提案を置いていなければ、返し終えたとは言わない（参加したばかりと見分けられない）", () => {
    const progress = judgeEditorProgress(facts());
    expect(progress.marks.return).toBe("todo");
  });
});

describe("7. 作者の採否", () => {
  test("作者の採否が届いていて、まだ知らせていなければ「次はここ」", () => {
    const decided = proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY, "accepted");
    const progress = judgeEditorProgress(facts({ myProposals: [decided] }));
    expect(progress.marks.decisions).toBe("next");
    expect(progress.next).toBe("decisions");
    expect(progress.unseenDecisions).toBe(1);
  });

  test("作者が全部決め、届いた採否をすべて知らせた・見たなら済み", () => {
    const decided = proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY, "rejected");
    const key = decisionKey(decided);
    const progress = judgeEditorProgress(
      facts({ myProposals: [decided], seenDecisions: new Set(key ? [key] : []) })
    );
    expect(progress.marks.decisions).toBe("done");
    expect(progress.next).toBeUndefined();
  });

  test("一部だけ決まっていれば、済みにしない（返事待ちが残る）", () => {
    const decided = proposal("2026-11-05T10:06:00.000Z", HAND_EDIT_CATEGORY, "accepted");
    const key = decisionKey(decided);
    const progress = judgeEditorProgress(
      facts({
        myProposals: [decided, proposal("2026-11-05T10:07:00.000Z", "誤字脱字")],
        seenDecisions: new Set(key ? [key] : []),
      })
    );
    expect(progress.marks.decisions).toBe("todo");
    expect(progress.awaitingAuthor).toBe(1);
  });

  test("次の回を始めたら（鍵を押さえたら）、7は「まだ」に戻り、2から先の印で進む", () => {
    const decided = proposal("2026-11-01T10:06:00.000Z", HAND_EDIT_CATEGORY, "accepted");
    const key = decisionKey(decided);
    const progress = judgeEditorProgress(
      facts({
        myLocks: [lock("本文/002.txt", "2026-11-05T10:00:00.000Z")],
        myProposals: [decided],
        seenDecisions: new Set(key ? [key] : []),
      })
    );
    expect(progress.phase).toBe("reviewing");
    expect(progress.marks.decisions).toBe("todo");
    expect(progress.marks.review).toBe("todo");
    expect(progress.next).toBe("detect");
  });
});

describe("状態の行", () => {
  test("校閲中の話・置いた提案・作者の採否・受け取りを、作品の下に並べる", () => {
    const decided = proposal("2026-11-01T10:06:00.000Z", HAND_EDIT_CATEGORY, "accepted");
    const f = facts({
      sync: { behind: 1, ahead: 0, dirty: 1 },
      myLocks: [lock("本文/003.txt", "2026-11-05T10:00:00.000Z")],
      myProposals: [decided, proposal("2026-11-05T10:06:00.000Z", "誤字脱字")],
      lastReceivedAt: "2026-11-05T09:00:00.000Z",
    });
    const lines = describeEditorStatus(f, judgeEditorProgress(f), "第3話", new Date("2026-11-05T12:00:00.000Z"));
    expect(lines.map((line) => line.label)).toEqual(["校閲中の話", "置いた提案", "作者の採否", "受け取り"]);
    expect(lines[0].value).toBe("第3話");
    expect(lines[1].value).toBe("この回 1件（まだ返していません）");
    expect(lines[2].value).toContain("採用 1・見送り 0・読まれた 0");
    expect(lines[3].value).toContain("最後に受け取ったのは 今日");
    expect(lines[3].value).toContain("未取得 1");
  });

  test("分からないものは「分かりません」「読めていません」と書く", () => {
    const f = facts({ sync: undefined });
    const lines = describeEditorStatus(f, judgeEditorProgress(f), undefined);
    expect(lines[3].value).toContain("分かりません");
    expect(lines[3].value).toContain("読めていません");
    expect(lines[0].value).toBe("まだ選んでいません");
    expect(lines[2].value).toBe("まだ届いていません");
  });
});

describe("最後に受け取った時刻（git の HEAD の記録から）", () => {
  test("pull・clone・reset・merge の行のうち最後の時刻を読み、自分の commit は数えない", () => {
    const text = [
      "0000 aaaa kmizu <k@example.com> 1762300000 +0900\tclone: from https://github.com/author/tayutau.git",
      "aaaa bbbb kmizu <k@example.com> 1762310000 +0900\tpull --ff-only: Fast-forward",
      "bbbb cccc kmizu <k@example.com> 1762320000 +0900\tcommit: 校閲を終えて返す",
      "",
    ].join("\n");
    expect(lastReceivedFromReflog(text)).toBe(new Date(1762310000 * 1000).toISOString());
  });

  test("受け取りの行が無ければ分からない", () => {
    expect(lastReceivedFromReflog("aaaa bbbb x <x> 1762320000 +0900\tcommit: x\n")).toBeUndefined();
    expect(lastReceivedFromReflog("")).toBeUndefined();
  });

  test("今日なら「今日 時:分」、別の日なら「月日 時:分」", () => {
    const now = new Date(2026, 10, 5, 21, 0);
    expect(formatWhen(new Date(2026, 10, 5, 9, 5).toISOString(), now)).toBe("今日 9:05");
    expect(formatWhen(new Date(2026, 10, 3, 21, 40).toISOString(), now)).toBe("11月3日 21:40");
    expect(formatWhen("壊れた時刻", now)).toBeUndefined();
  });
});
