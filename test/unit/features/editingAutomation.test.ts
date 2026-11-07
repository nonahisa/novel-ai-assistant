import { describe, expect, test, vi } from "vitest";
import {
  collectEditorInboxQuietly,
  DECISIONS_BUTTON,
  returnDecisionsIfFinished,
  type InboxDeps,
  type ReturnDeps,
} from "../../../src/features/editingAutomation";
import type { WorkEntry } from "../../../src/models/types";
import type { ProposalView } from "../../../src/models/proposal";
import type { DecisionMemory } from "../../../src/features/decisionMemory";

/**
 * 編集部連携の自動化（作者の裁定、2026-10-28）。
 * 条件の分かれ目と、「失敗しても呼び元を止めない」を測る。
 */

function work(id: string): WorkEntry {
  return {
    id,
    title: `作品${id}`,
    folderPath: `C:\\Novels\\${id}`,
    registeredAt: "2026-10-28T00:00:00.000Z",
  };
}

function returnDeps(over: Partial<ReturnDeps> = {}): ReturnDeps {
  return {
    hasPointer: async () => true,
    pendingCount: async () => 0,
    isEditorMode: () => false,
    resend: vi.fn(async () => ({ ok: true, detail: "" })),
    notifyDone: vi.fn(),
    notifyFailure: vi.fn(),
    ...over,
  };
}

describe("採否を決め終えたときの自動の送り返し", () => {
  test("未決が0件で pointer があれば、静かに送り返して知らせる", async () => {
    const deps = returnDeps();
    expect(await returnDecisionsIfFinished(work("a"), deps)).toBe("sent");
    expect(deps.resend).toHaveBeenCalledOnce();
    expect(deps.notifyDone).toHaveBeenCalledWith("採否を編集者へ送り返しました。");
  });

  test("送り返した知らせに、採用・見送り・読まれたの内訳を添える（意見は採用に数えない）", async () => {
    const deps = returnDeps({
      decisionCounts: async () => ({ accepted: 2, rejected: 1, read: 3, pending: 0 }),
    });
    expect(await returnDecisionsIfFinished(work("counts"), deps)).toBe("sent");
    expect(deps.notifyDone).toHaveBeenCalledWith(
      "採否を編集者へ送り返しました（採用 2・見送り 1・読まれた 3）。"
    );
  });

  test("未決が残っていれば送り返さない", async () => {
    const deps = returnDeps({ pendingCount: async () => 2 });
    expect(await returnDecisionsIfFinished(work("a"), deps)).toBe("skipped");
    expect(deps.resend).not.toHaveBeenCalled();
  });

  test("pointer が無い作品では何もしない", async () => {
    const deps = returnDeps({ hasPointer: async () => false });
    expect(await returnDecisionsIfFinished(work("a"), deps)).toBe("skipped");
    expect(deps.resend).not.toHaveBeenCalled();
  });

  test("編集者モードでは何もしない", async () => {
    const deps = returnDeps({ isEditorMode: () => true });
    expect(await returnDecisionsIfFinished(work("a"), deps)).toBe("skipped");
    expect(deps.resend).not.toHaveBeenCalled();
  });

  test("送り返しに失敗しても例外にせず、知らせて失敗を返す（採否は成功のまま）", async () => {
    const deps = returnDeps({
      resend: vi.fn(async () => ({ ok: false, detail: "回線がありません" })),
    });
    expect(await returnDecisionsIfFinished(work("a"), deps)).toBe("failed");
    expect(deps.notifyFailure).toHaveBeenCalledWith(expect.anything(), "回線がありません");
    expect(deps.notifyDone).not.toHaveBeenCalled();
  });

  test("途中で例外が出ても、外へは投げない", async () => {
    const deps = returnDeps({
      resend: vi.fn(async () => {
        throw new Error("壊れた");
      }),
    });
    expect(await returnDecisionsIfFinished(work("a"), deps)).toBe("failed");
  });

  test("同じ作品で続けて呼ばれたら、飛ばさず前の走りの後ろへ繋ぐ（重ならない）", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const deps = returnDeps({
      resend: vi.fn(async () => {
        const mine = first ? "1回目" : "2回目";
        order.push(`${mine}:始まり`);
        if (first) {
          first = false;
          await gate;
        }
        order.push(`${mine}:終わり`);
        return { ok: true, detail: "" };
      }),
    });

    const a = returnDecisionsIfFinished(work("same"), deps);
    const b = returnDecisionsIfFinished(work("same"), deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([a, b]);

    expect(order).toEqual(["1回目:始まり", "1回目:終わり", "2回目:始まり", "2回目:終わり"]);
  });
});

describe("採否をまとめて決めたとき", () => {
  test("決めた回数だけ走らず、待っているのは1本に畳まれる（走行中は1回、あと1回で足りる）", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const deps = returnDeps({
      resend: vi.fn(async () => {
        calls += 1;
        if (calls === 1) await gate;
        return { ok: true, detail: "" };
      }),
    });

    // 1件目で走り出し、走っている間に9件が決まる
    const runs = Array.from({ length: 10 }, () =>
      returnDecisionsIfFinished(work("batch"), deps)
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all(runs);

    // 走り出した1回と、取りこぼしを拾う1回だけ（10回ではない）
    expect(deps.resend).toHaveBeenCalledTimes(2);
  });

  test("走り終えたあとの呼び出しは、新しく1回走る", async () => {
    const deps = returnDeps();
    await returnDecisionsIfFinished(work("again"), deps);
    await returnDecisionsIfFinished(work("again"), deps);
    expect(deps.resend).toHaveBeenCalledTimes(2);
  });
});

function inboxDeps(over: Partial<InboxDeps> = {}): InboxDeps {
  return {
    isEditorMode: () => false,
    importProposals: vi.fn(async () => ({
      status: "done" as const,
      pullFailed: false,
      hadIncoming: true,
      locksAcquired: [] as string[],
      locksReleased: [] as string[],
      added: 0,
    })),
    notify: vi.fn(),
    offer: vi.fn(),
    offerDecisions: vi.fn(),
    viewDecisions: vi.fn(async () => undefined),
    primePanel: vi.fn(async () => undefined),
    viewProposals: vi.fn(async () => undefined),
    loadProposals: vi.fn(async () => []),
    decisionMemory: memoryOf(),
    ...over,
  };
}

describe("同期のあとの、編集者の提案の取り込み", () => {
  test("0件なら黙る（知らせも、パネルも出さない）", async () => {
    const deps = inboxDeps();
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(0);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.offer).not.toHaveBeenCalled();
    expect(deps.primePanel).not.toHaveBeenCalled();
  });

  test("届いていれば［提案を見る］付きで件数を知らせ、パネルは開かずに選び欄へ足す", async () => {
    const deps = inboxDeps({
      importProposals: vi.fn(async () => ({
        status: "done" as const,
        pullFailed: false,
        hadIncoming: true,
        locksAcquired: [] as string[],
        locksReleased: [] as string[],
        added: 3,
      })),
    });
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(3);
    expect(deps.offer).toHaveBeenCalledOnce();
    const [offeredWork, text, onView] = vi.mocked(deps.offer).mock.calls[0];
    expect(offeredWork.id).toBe("a");
    expect(text).toBe("編集者から提案が 3 件届きました。");
    // 勝手に開かず、選び欄へ静かに足す（作者の判断 2026-11-01 のボタンを受けた実装の判断）
    expect(deps.primePanel).toHaveBeenCalledOnce();
    expect(deps.viewProposals).not.toHaveBeenCalled();
    // ［提案を見る］を押すと、「編集部の提案を見る」をその作品で走らせる
    await onView();
    expect(deps.viewProposals).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  test("pointer の無い作品は飛ばす", async () => {
    const deps = inboxDeps({
      importProposals: vi.fn(async () => ({ status: "noPointer" as const })),
    });
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(0);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test("1作品が失敗しても例外を外へ出さず、残りの作品は取り込む", async () => {
    const deps = inboxDeps({
      importProposals: vi.fn(async (target: WorkEntry) => {
        if (target.id === "bad") throw new Error("取り寄せで落ちた");
        return {
          status: "done" as const,
          pullFailed: false,
          hadIncoming: true,
          locksAcquired: [] as string[],
          locksReleased: [] as string[],
          added: 1,
        };
      }),
    });
    expect(await collectEditorInboxQuietly([work("bad"), work("good")], deps)).toBe(1);
    expect(deps.offer).toHaveBeenCalledOnce();
  });

  test("編集者モードでは取り込みに行かない", async () => {
    const deps = inboxDeps({ isEditorMode: () => true });
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(0);
    expect(deps.importProposals).not.toHaveBeenCalled();
  });
});

/** 覚えの代役（Map 1つ） */
function memoryOf(): DecisionMemory {
  const store = new Map<string, Set<string>>();
  return {
    seen: (id) => store.get(id) ?? new Set(),
    add: async (id, keys) => {
      const set = store.get(id) ?? new Set<string>();
      for (const key of keys) set.add(key);
      store.set(id, set);
    },
  };
}

/** 提案1件の今の状態。`status` を渡すと、作者の採否の行が付く */
function view(
  id: string,
  status: "pending" | "accepted" | "rejected" | "read",
  time = "2026-11-01T12:30:00.000Z",
  suggestion = "直し"
): ProposalView {
  return {
    id,
    time: "2026-11-01T12:00:00.000Z",
    proposer: "kmizu",
    file: "本文/001.txt",
    line: 1,
    original: "原文",
    target: "原",
    suggestion,
    reason: "表記ゆれ",
    category: "表記ゆれ",
    status,
    decision:
      status === "pending"
        ? undefined
        : { proposalId: id, time, decidedBy: "nonahisa", status, note: "" },
  };
}

describe("編集者モード：同期で届いた作者の採否を知らせる（作者の判断 2026-11-01）", () => {
  test("届いた採否を「作者が提案を決めました（採用 N・見送り N・読まれた N）。」で知らせる", async () => {
    const deps = inboxDeps({
      isEditorMode: () => true,
      loadProposals: vi.fn(async () => [
        view("p1", "accepted"),
        view("p2", "rejected"),
        view("p3", "read"),
        // 意見だけ（直した案が空）を採ったものは、読まれたに数える（0.119.0 の数え方）
        view("p4", "accepted", undefined, ""),
        view("p5", "pending"),
      ]),
    });

    await collectEditorInboxQuietly([work("a")], deps);

    expect(deps.offerDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "作者が提案を決めました（採用 1・見送り 1・読まれた 2）。",
      expect.any(Function)
    );
  });

  test("同じ採否を二度知らせない。新しく届いた分だけを数える", async () => {
    let views = [view("p1", "accepted"), view("p2", "pending")];
    const deps = inboxDeps({
      isEditorMode: () => true,
      loadProposals: vi.fn(async () => views),
    });

    await collectEditorInboxQuietly([work("a")], deps);
    await collectEditorInboxQuietly([work("a")], deps);
    expect(deps.offerDecisions).toHaveBeenCalledTimes(1);

    // 2件目が届いた
    views = [view("p1", "accepted"), view("p2", "rejected", "2026-11-01T13:00:00.000Z")];
    await collectEditorInboxQuietly([work("a")], deps);
    expect(deps.offerDecisions).toHaveBeenCalledTimes(2);
    expect(deps.offerDecisions).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "a" }),
      "作者が提案を決めました（採用 0・見送り 1・読まれた 0）。",
      expect.any(Function)
    );
  });

  test("決め直し（見送り → 採用）は新しく届いたものとして知らせる", async () => {
    let views = [view("p1", "rejected")];
    const deps = inboxDeps({
      isEditorMode: () => true,
      loadProposals: vi.fn(async () => views),
    });
    await collectEditorInboxQuietly([work("a")], deps);

    views = [view("p1", "accepted", "2026-11-01T14:00:00.000Z")];
    await collectEditorInboxQuietly([work("a")], deps);

    expect(deps.offerDecisions).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "a" }),
      "作者が提案を決めました（採用 1・見送り 0・読まれた 0）。",
      expect.any(Function)
    );
  });

  test("知らせの［採否を見る］を押すと、その作品の作者の採否の一覧を開く（作者の頼み 2026-11-07）", async () => {
    const opened: string[] = [];
    const deps = inboxDeps({
      isEditorMode: () => true,
      loadProposals: vi.fn(async () => [view("p1", "accepted")]),
      offerDecisions: vi.fn((target: WorkEntry, _text: string, onView: () => Promise<void>) => {
        opened.push(target.id);
        void onView();
      }),
      viewDecisions: vi.fn(async (target: WorkEntry) => {
        opened.push(`一覧:${target.id}`);
      }),
    });
    await collectEditorInboxQuietly([work("a")], deps);
    expect(opened).toEqual(["a", "一覧:a"]);
    expect(DECISIONS_BUTTON).toBe("採否を見る");
  });

  test("採否が無ければ黙る。読めなくても例外を外へ出さない", async () => {
    const quiet = inboxDeps({
      isEditorMode: () => true,
      loadProposals: vi.fn(async () => [view("p1", "pending")]),
    });
    await collectEditorInboxQuietly([work("a")], quiet);
    expect(quiet.notify).not.toHaveBeenCalled();

    const broken = inboxDeps({
      isEditorMode: () => true,
      loadProposals: vi.fn(async () => {
        throw new Error("読めない");
      }),
    });
    await expect(collectEditorInboxQuietly([work("a")], broken)).resolves.toBe(0);
  });
});
