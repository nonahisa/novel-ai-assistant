import { describe, expect, test, vi } from "vitest";
import {
  collectEditorInboxQuietly,
  returnDecisionsIfFinished,
  type InboxDeps,
  type ReturnDeps,
} from "../../../src/features/editingAutomation";
import type { WorkEntry } from "../../../src/models/types";

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
    expect(deps.notifyDone).toHaveBeenCalledWith("採否を編集部へ送り返しました。");
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

function inboxDeps(over: Partial<InboxDeps> = {}): InboxDeps {
  return {
    isEditorMode: () => false,
    importProposals: vi.fn(async () => ({
      status: "done" as const,
      pullFailed: false,
      hadIncoming: true,
      added: 0,
    })),
    notify: vi.fn(),
    openPanel: vi.fn(async () => undefined),
    ...over,
  };
}

describe("同期のあとの、編集部の提案の取り込み", () => {
  test("0件なら黙る（知らせも、パネルも出さない）", async () => {
    const deps = inboxDeps();
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(0);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.openPanel).not.toHaveBeenCalled();
  });

  test("届いていれば件数を知らせ、提案パネルを開く", async () => {
    const deps = inboxDeps({
      importProposals: vi.fn(async () => ({
        status: "done" as const,
        pullFailed: false,
        hadIncoming: true,
        added: 3,
      })),
    });
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(3);
    expect(deps.notify).toHaveBeenCalledWith("編集部から提案が 3 件届きました。");
    expect(deps.openPanel).toHaveBeenCalledOnce();
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
          added: 1,
        };
      }),
    });
    expect(await collectEditorInboxQuietly([work("bad"), work("good")], deps)).toBe(1);
    expect(deps.openPanel).toHaveBeenCalledOnce();
  });

  test("編集者モードでは取り込みに行かない", async () => {
    const deps = inboxDeps({ isEditorMode: () => true });
    expect(await collectEditorInboxQuietly([work("a")], deps)).toBe(0);
    expect(deps.importProposals).not.toHaveBeenCalled();
  });
});
