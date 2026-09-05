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
/** 最初に1回だけ出す確認（modal）。中身は「見出し＋詳細」 */
let confirmed: string[] = [];
/** その確認で作者が押すもの。undefined なら取りやめ */
let confirmAnswer: string | undefined = "実行";
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
    // 見積もりは本物では走査とモデル照会が要る。ここでは固定値で置き換える
    estimate: async () => ({
      totalChars: 41000,
      chunkCount: 12,
      providerNames: ["Gemini"],
      isPaid: true,
    }),
  });
}

beforeEach(() => {
  calls = [];
  running = undefined;
  outcomes = {};
  remaining = {};
  announced = [];
  confirmed = [];
  confirmAnswer = "実行";
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

  // **確認（modal）と知らせ（非modal）を分けて受ける。** 同じ関数で出す
  // ので、区別しないと「確認が何回出たか」を数えられない
  window.showInformationMessage = (async (
    message: string,
    options?: unknown
  ) => {
    if (
      options !== null &&
      typeof options === "object" &&
      "modal" in (options as Record<string, unknown>)
    ) {
      const detail = (options as { detail?: string }).detail ?? "";
      confirmed.push(`${message}\n${detail}`);
      return confirmAnswer;
    }
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

describe("有料の確認は、最初に1回だけ", () => {
  /*
    **7回聞くのは、聞いていないのと同じである**（設計書6.80）。1回目に
    「実行」を押した作者は、残りも同じ意味で押す——押し続けるうちに
    中身を読まなくなるので、確認としては働かなくなる。
  */
  test("選んだ直後に1回だけ出し、各機能へ「確認済み」を渡す", async () => {
    selection = ["notation", "typos", "proofread"];
    const passed: unknown[] = [];
    Object.assign(commands, {
      executeCommand: async (command: string, ...args: unknown[]) => {
        calls.push(command);
        passed.push(args[1]);
        return undefined;
      },
    });

    await run();

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain("試しの作品 の校正をまとめて実行します。");
    expect(confirmed[0]).toContain(
      "走らせるもの（この順）：表記ゆれ・誤字脱字・推敲"
    );
    // AIを使うのは誤字脱字と推敲の2つ（表記ゆれは機械判定）
    expect(confirmed[0]).toContain("選んだ2機能それぞれが本文を");
    expect(passed).toEqual([
      { suite: { confirmed: true } },
      { suite: { confirmed: true } },
      { suite: { confirmed: true } },
    ]);
  });

  test("確認で取りやめたら、1つも走らせない", async () => {
    selection = ["typos", "proofread"];
    confirmAnswer = undefined;

    await run();

    expect(calls).toEqual([]);
    // **控えは残す。** 選び直したこと自体は作者の意思である
    expect(saved).toEqual(["typos", "proofread"]);
    expect(announced).toEqual([]);
  });

  test("AIを使わない機能だけなら、確認を出さない", async () => {
    // 表記ゆれは機械判定。送る量も料金も発生しないので、聞く意味が無い
    selection = ["notation"];

    await run();

    expect(confirmed).toEqual([]);
    expect(calls).toEqual(["novelai.checkNotation"]);
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
    outcomes = { "novelai.checkTypos": { kind: "cancelled" } };

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

  test("失敗しても、残りは走らせる", async () => {
    /*
      **失敗は止める理由にならない**（0.33.7のレビュー）。レート上限も
      応答の解析の失敗も、次の機能では起きないことのほうが多い。
    */
    selection = ["notation", "typos", "proofread"];
    outcomes = { "novelai.checkTypos": { kind: "failed" } };

    await run();

    expect(calls).toEqual([
      "novelai.checkNotation",
      "novelai.checkTypos",
      "novelai.checkProofread",
    ]);
  });

  test("表記ゆれで0組を選んで確定しても、次へ進む", async () => {
    /*
      作者の実機報告（2026-09-05）「表記ゆれを何も選ばないと動かず終わります」。
      **0組のまま確定は「今回は揃えない」であって、止める意思ではない。**
      表記ゆれのコマンド側で完走（`CHECK_COMPLETED`）を返すようにした。
    */
    selection = ["notation", "typos", "proofread"];
    outcomes = { "novelai.checkNotation": { kind: "completed" } };
    remaining = { 表記ゆれ: 0, 誤字脱字: 2, 推敲: 1 };

    await run();

    expect(calls).toEqual([
      "novelai.checkNotation",
      "novelai.checkTypos",
      "novelai.checkProofread",
    ]);
    expect(announced).toEqual([
      "校正をまとめて実行しました。表記ゆれ0件・誤字脱字2件・推敲1件。" +
        "提案パネルで確認できます。",
    ]);
  });

  test("表記ゆれをEscで閉じたら、そこで止めて残りを伝える", async () => {
    selection = ["notation", "typos", "proofread"];
    outcomes = { "novelai.checkNotation": { kind: "cancelled" } };

    await run();

    expect(calls).toEqual(["novelai.checkNotation"]);
    expect(announced).toEqual([
      "校正をまとめて実行：1件も実行せずに止まりました" +
        "（残り：表記ゆれ・誤字脱字・推敲）。",
    ]);
  });

  test("コマンドが例外を投げても、内訳は失われない", async () => {
    /*
      **例外で通知ごと失わない**（0.33.7のレビュー）。ここで抜けると、
      それまでに走った機能の結果も作者へ伝わらないまま終わっていた。
    */
    selection = ["notation", "typos", "proofread"];
    remaining = { 表記ゆれ: 2, 推敲: 1 };
    Object.assign(commands, {
      executeCommand: async (command: string) => {
        calls.push(command);
        if (command === "novelai.checkTypos") {
          throw new Error("わざと壊した");
        }
        return undefined;
      },
    });

    await run();

    expect(calls).toEqual([
      "novelai.checkNotation",
      "novelai.checkTypos",
      "novelai.checkProofread",
    ]);
    expect(announced).toEqual([
      "校正をまとめて実行しました。表記ゆれ2件・誤字脱字は失敗しました・推敲1件。" +
        "提案パネルで確認できます。",
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

  test("前提が無くて走れなかった理由は、まとめの末尾へ出す", async () => {
    /*
      **確認を1回にした代わりに、機能ごとの警告を出す場が無くなった。**
      「設定資料がまだ無い」は作者が次に何をすればよいかを決める情報なので、
      まとめの知らせへ持ち越す（設計書6.80）。
    */
    selection = ["typos", "contradictions"];
    remaining = { 誤字脱字: 1 };
    outcomes = {
      "novelai.checkContradictions": {
        kind: "failed",
        notes: ["矛盾：突き合わせる設定資料がまだありません。"],
      },
    };

    await run();

    expect(announced).toEqual([
      "校正をまとめて実行しました。誤字脱字1件・矛盾は失敗しました。" +
        "提案パネルで確認できます。" +
        "矛盾：突き合わせる設定資料がまだありません。",
    ]);
  });

  test("中止したら、そこまでの内訳と残りを伝える", async () => {
    selection = ["notation", "proofread", "contradictions"];
    remaining = { 表記ゆれ: 2 };
    outcomes = { "novelai.checkProofread": { kind: "cancelled" } };

    await run();

    expect(announced).toEqual([
      "校正をまとめて実行：ここまで実行しました（残り：推敲・矛盾）。" +
        "表記ゆれ2件。提案パネルで確認できます。",
    ]);
  });

  test("1つ目で中止されても、黙って終わらない", async () => {
    /*
      **通知ゼロを作らない**（0.33.7のレビュー）。1件目で止まると `done` が
      空になり、作者からは「押したのに何も起きない」としか見えなかった。
    */
    selection = ["notation", "typos"];
    outcomes = { "novelai.checkNotation": { kind: "cancelled" } };

    await run();

    expect(announced).toEqual([
      "校正をまとめて実行：1件も実行せずに止まりました" +
        "（残り：表記ゆれ・誤字脱字）。",
    ]);
  });
});
