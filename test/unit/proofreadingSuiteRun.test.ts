import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, window } from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";
import {
  runProofreadingSuite,
  type SelectionMemento,
} from "../../src/features/proofreadingSuite";
import { PROOFREADING_SUITE_SELECTION_KEY } from "../../src/core/proofreadingSuite";

/**
 * 校正のまとめ実行（設計書6.80）の走らせ方。
 *
 * **1つずつ順に走らせる。** 並べて走らせると、AIの札（設計書6.76）を
 * 取り合って自分の順番待ちになるうえ、作者は「いま何を見ているのか」を
 * 見失う。**中止したら残りは走らせない**——止めたのに次が始まるのは、
 * 押した意味が無いのと同じである。
 */

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

/** QuickPickへ並んだ項目（idと初期選択だけ覚える） */
interface OfferedItem {
  label: string;
  id: string;
  picked?: boolean;
}

/** 走った順。`|` の後ろは、その時点で他のコマンドが動いていたか */
let calls: string[] = [];
/** いま走っているコマンド（直列であることを確かめる） */
let running: string | undefined;
/** コマンドごとの戻り値。無ければ undefined を返す（＝完走） */
let outcomes: Record<string, unknown> = {};
/** 分類ごとの、提案パネルに残っている件数 */
let remaining: Record<string, number> = {};
/** 画面に出た知らせ */
let announced: string[] = [];
/** QuickPickへ並んだもの */
let offered: OfferedItem[] = [];
/** 何を選ぶか。undefined なら Esc（取りやめ） */
let selection: string[] | undefined;
/** 控えに書かれた値 */
let saved: unknown;

const stub = window as unknown as Record<string, unknown>;
const originalWithProgress = stub.withProgress;
const originalShowQuickPick = stub.showQuickPick;

function memento(initial?: unknown): SelectionMemento {
  return {
    get: <T,>(_key: string, defaultValue: T): T =>
      (initial === undefined ? defaultValue : (initial as T)),
    update: async (_key: string, value: unknown) => {
      saved = value;
    },
  };
}

async function run(initial?: unknown): Promise<void> {
  await runProofreadingSuite(work, {
    memento: memento(initial),
    remainingIn: (category) => remaining[category] ?? 0,
  });
}

beforeEach(() => {
  calls = [];
  running = undefined;
  outcomes = {};
  remaining = {};
  announced = [];
  offered = [];
  selection = undefined;
  saved = undefined;

  // 本物と同じく、渡された処理をそのまま走らせる
  stub.withProgress = async (
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ) => task({ report: () => undefined }, undefined);

  stub.showQuickPick = async (items: OfferedItem[]) => {
    offered = items;
    if (selection === undefined) return undefined;
    return items.filter((item) => selection?.includes(item.id));
  };

  Object.assign(commands, {
    executeCommand: async (command: string, ...args: unknown[]) => {
      // **直列で呼ばれていること**を、呼ばれた側から確かめる
      calls.push(running ? `${command}（${running}と同時）` : command);
      running = command;
      await Promise.resolve();
      running = undefined;
      void args;
      return outcomes[command];
    },
  });

  window.showInformationMessage = (async (message: string) => {
    announced.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
});

afterEach(() => {
  stub.withProgress = originalWithProgress;
  stub.showQuickPick = originalShowQuickPick;
});

describe("選び方", () => {
  test("前回の選択が、はじめから選ばれた状態で並ぶ", async () => {
    selection = [];

    await run(["typos", "contradictions"]);

    const picked = offered
      .filter((item) => item.picked)
      .map((item) => item.id);
    expect(picked).toEqual(["typos", "contradictions"]);
  });

  test("控えが無ければ、既定の4つが選ばれている", async () => {
    selection = [];

    await run(undefined);

    const picked = offered
      .filter((item) => item.picked)
      .map((item) => item.id);
    expect(picked).toEqual([
      "notation",
      "typos",
      "proofread",
      "contradictions",
    ]);
  });

  test("取りやめたら、何も走らせず控えも書き換えない", async () => {
    selection = undefined;

    await run(["typos"]);

    expect(calls).toEqual([]);
    expect(saved).toBeUndefined();
    expect(announced).toEqual([]);
  });

  test("1つも選ばなければ、走らせずにその旨だけ伝える", async () => {
    selection = [];

    await run(["typos"]);

    expect(calls).toEqual([]);
    expect(saved).toBeUndefined();
    expect(announced).toEqual([
      "走らせるものが1つも選ばれていないので、何もしませんでした。",
    ]);
  });
});

describe("走らせ方", () => {
  test("選んだ順ではなく、決めた順に1つずつ走らせる", async () => {
    selection = ["contradictions", "typos", "notation"];

    await run();

    expect(calls).toEqual([
      "novelai.checkNotation",
      "novelai.checkTypos",
      "novelai.checkContradictions",
    ]);
  });

  test("作品を指定して呼ぶ（もう一度作品を選ばせない）", async () => {
    selection = ["typos"];
    const given: unknown[] = [];
    Object.assign(commands, {
      executeCommand: async (command: string, arg: unknown) => {
        calls.push(command);
        given.push(arg);
        return undefined;
      },
    });

    await run();

    expect(given).toEqual([{ type: "work", work }]);
  });

  test("走らせたものを控えへ残す", async () => {
    selection = ["proofread", "notation"];

    await run(["typos"]);

    expect(saved).toEqual(["notation", "proofread"]);
  });

  test("中止したら、残りは走らせない", async () => {
    selection = ["notation", "typos", "proofread"];
    outcomes = { "novelai.checkTypos": { cancelled: true } };

    await run();

    expect(calls).toEqual(["novelai.checkNotation", "novelai.checkTypos"]);
  });

  test("何も返さないコマンドでも、次へ進む", async () => {
    // 冒頭診断のように戻り値を持たない入口があっても止まらない
    selection = ["opening", "contradictions"];

    await run();

    expect(calls).toEqual([
      "novelai.checkOpening",
      "novelai.checkContradictions",
    ]);
  });
});

describe("終わったときの知らせ", () => {
  test("機能ごとの残り件数を、1通知にまとめる", async () => {
    selection = ["typos", "proofread", "contradictions"];
    remaining = { 誤字脱字: 3, 推敲: 12, 矛盾: 0 };

    await run();

    expect(announced).toEqual([
      "校正をまとめて実行しました。誤字脱字3件・推敲12件・矛盾0件。" +
        "提案パネルで確認できます。",
    ]);
  });

  test("中止したら、そこまでの内訳と残りを伝える", async () => {
    selection = ["notation", "proofread", "contradictions"];
    remaining = { 表記ゆれ: 2 };
    outcomes = { "novelai.checkProofread": { cancelled: true } };

    await run();

    expect(announced).toEqual([
      "校正をまとめて実行：ここまで実行しました（残り：推敲・矛盾）。" +
        "表記ゆれ2件。提案パネルで確認できます。",
    ]);
  });

  test("1つ目で中止されたら、何も知らせない", async () => {
    selection = ["notation", "typos"];
    outcomes = { "novelai.checkNotation": { cancelled: true } };

    await run();

    expect(announced).toEqual([]);
  });
});
