import { beforeEach, describe, expect, test } from "vitest";
import {
  AiQueueAbortError,
  acquireCall,
  acquireRun,
  currentRunLabel,
  pendingCallCount,
  pendingRunCount,
  resetAiSequence,
} from "../../../src/core/aiSequence";

/**
 * AI呼び出しの全体キュー（設計書6.76）。
 *
 * ここで固定するのは**振る舞いだけ**である。実際にAIを呼ばないので、
 * 「同時に1件」「先に頼んだものが先」「解放したら次へ進む」を、
 * 順番を書き留めながら確かめる。
 */

/** 実行の順番を書き留める入れ物 */
function recorder() {
  const order: string[] = [];
  return { order, note: (what: string) => order.push(what) };
}

/** 次のマイクロタスクまで待つ（「まだ進んでいない」ことを見るのに要る） */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  resetAiSequence();
});

describe("リクエストの関所（同時1件・FIFO）", () => {
  test("先客がいる間、2件目は待たされる", async () => {
    const { order, note } = recorder();

    const first = await acquireCall();
    note("1件目が入った");

    let secondEntered = false;
    const second = acquireCall().then((release) => {
      secondEntered = true;
      note("2件目が入った");
      return release;
    });

    await settle();
    expect(secondEntered).toBe(false);
    expect(pendingCallCount()).toBe(1);

    first();
    const release = await second;
    expect(secondEntered).toBe(true);
    expect(order).toEqual(["1件目が入った", "2件目が入った"]);
    release();
  });

  test("先に頼んだものから順に通す（FIFO）", async () => {
    const { order, note } = recorder();
    const held = await acquireCall();

    const waiters = ["あ", "い", "う"].map((name) =>
      acquireCall().then((release) => {
        note(name);
        release();
      })
    );

    await settle();
    held();
    await Promise.all(waiters);

    expect(order).toEqual(["あ", "い", "う"]);
  });

  test("解放関数を二度呼んでも、余分に1件通らない", async () => {
    const held = await acquireCall();

    let entered = 0;
    const first = acquireCall().then((release) => {
      entered++;
      return release;
    });
    const second = acquireCall().then((release) => {
      entered++;
      return release;
    });

    held();
    // 二重に呼んでも、通るのは1件だけ
    held();
    await settle();

    expect(entered).toBe(1);

    (await first)();
    await settle();
    expect(entered).toBe(2);
    (await second)();
  });

  test("持ち主が例外で終わっても、解放されていれば次へ回る", async () => {
    const { order, note } = recorder();

    const failing = (async () => {
      const release = await acquireCall();
      try {
        throw new Error("送信に失敗しました");
      } finally {
        note("1件目を解放");
        release();
      }
    })();

    await expect(failing).rejects.toThrow("送信に失敗しました");

    const release = await acquireCall();
    note("2件目が入った");
    release();

    expect(order).toEqual(["1件目を解放", "2件目が入った"]);
  });

  test("待っている間に中止されたら、列から抜ける", async () => {
    const held = await acquireCall();
    const controller = new AbortController();

    const waiting = acquireCall(controller.signal);
    await settle();
    expect(pendingCallCount()).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AiQueueAbortError);
    expect(pendingCallCount()).toBe(0);

    // **抜けたぶんが詰まりにならない。** 解放したら次の人がすぐ入れる
    let nextEntered = false;
    const next = acquireCall().then((release) => {
      nextEntered = true;
      return release;
    });
    held();
    (await next)();
    expect(nextEntered).toBe(true);
  });

  test("はじめから中止されている合図では、並ばずに断る", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(acquireCall(controller.signal)).rejects.toBeInstanceOf(
      AiQueueAbortError
    );
    expect(pendingCallCount()).toBe(0);

    // 空いたままであることを確かめる（断ったせいで詰まらせない）
    const release = await acquireCall();
    release();
  });
});

describe("実行の札（まとまった一括処理を丸ごと1つずつ）", () => {
  test("先客の機能名を名乗る。解放したら誰もいなくなる", async () => {
    expect(currentRunLabel()).toBeUndefined();

    const release = await acquireRun("誤字脱字検知");
    expect(currentRunLabel()).toBe("誤字脱字検知");

    release();
    expect(currentRunLabel()).toBeUndefined();
  });

  test("2つ目の一括処理は、先客が終わるまで始まらない", async () => {
    const { order, note } = recorder();

    const first = await acquireRun("誤字脱字検知");
    note("誤字脱字：開始");

    const second = acquireRun("矛盾検知").then((release) => {
      note("矛盾：開始");
      return release;
    });

    await settle();
    expect(order).toEqual(["誤字脱字：開始"]);
    expect(pendingRunCount()).toBe(1);
    // 待っている間も、名乗るのは先客である（待ち表示に使う）
    expect(currentRunLabel()).toBe("誤字脱字検知");

    note("誤字脱字：終了");
    first();
    (await second)();

    expect(order).toEqual([
      "誤字脱字：開始",
      "誤字脱字：終了",
      "矛盾：開始",
    ]);
  });

  test("待っている間に中止されたら、札の列からも抜ける", async () => {
    const held = await acquireRun("誤字脱字検知");
    const controller = new AbortController();

    const waiting = acquireRun("矛盾検知", controller.signal);
    await settle();
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(AiQueueAbortError);
    expect(pendingRunCount()).toBe(0);
    held();
  });
});

describe("札と関所の関係（デッドロックの禁止則）", () => {
  test("札を持ったまま関所を取れる", async () => {
    // **この向きだけを許す**（設計書6.76）。逆向き——関所を持ったまま
    // 札を待つ——を作ると、先客の札が関所待ちで止まって永久に進まない
    const turn = await acquireRun("誤字脱字検知");

    const call = await acquireCall();
    call();

    const call2 = await acquireCall();
    call2();

    turn();
  });

  test("札を待っている間も、単発の呼び出しは関所を通れる", async () => {
    // 相談や独り言は札を取らないので、一括処理のチャンクの合間に入れる
    const turn = await acquireRun("誤字脱字検知");
    const waitingTurn = acquireRun("矛盾検知");

    const call = await acquireCall();
    call();

    turn();
    (await waitingTurn)();
  });
});

describe("関所の幅（クラウドは3件まで。設計書6.76.3）", () => {
  test("幅3なら3件まで同時に通り、4件目は待つ", async () => {
    const releases = await Promise.all([
      acquireCall(undefined, 3),
      acquireCall(undefined, 3),
      acquireCall(undefined, 3),
    ]);
    let fourth = false;
    const waiting = acquireCall(undefined, 3).then((release) => {
      fourth = true;
      return release;
    });
    await settle();
    expect(fourth).toBe(false);
    expect(pendingCallCount()).toBe(1);
    releases[0]();
    (await waiting)();
    expect(fourth).toBe(true);
    releases[1]();
    releases[2]();
  });

  test("幅1（手元のAI）は先客がいれば待ち、通っているあいだはほかを入れない", async () => {
    const cloud = await acquireCall(undefined, 3);
    const r = recorder();
    const local = acquireCall(undefined, 1).then((release) => {
      r.note("手元");
      return release;
    });
    await settle();
    expect(r.order).toEqual([]);
    cloud();
    const localRelease = await local;
    // 手元が通っているあいだは、幅3の頼みも入れない
    const later = acquireCall(undefined, 3).then((release) => {
      r.note("クラウド");
      return release;
    });
    await settle();
    expect(r.order).toEqual(["手元"]);
    localRelease();
    (await later)();
    expect(r.order).toEqual(["手元", "クラウド"]);
  });

  test("幅を名乗らない呼び出しは幅1（従来の同時1件）", async () => {
    const first = await acquireCall();
    let second = false;
    const waiting = acquireCall(undefined, 3).then((release) => {
      second = true;
      return release;
    });
    await settle();
    expect(second).toBe(false);
    first();
    (await waiting)();
    expect(second).toBe(true);
  });
});
