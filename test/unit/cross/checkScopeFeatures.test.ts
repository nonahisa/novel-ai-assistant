import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import { disposeLog } from "../../src/core/logger";
import type { WorkEntry } from "../../src/models/types";
import {
  chooseScope,
  resolveCheckScope,
  scopeFeatureSpec,
  describeChosenScope,
  type ScopeFeature,
} from "../../src/features/typoCheckScope";
// 差し替える相手（`views/notify`）の項目の型だけ借りる。
// 型は消えるので、`vi.mock` の差し替えとはぶつからない
import type { MemorablePick } from "../../src/views/notify";

/**
 * `chooseScope` が並べる項目をのぞくための差し替え。
 *
 * `pickWithMemory`（`views/notify.ts`）を直に動かすと選択画面
 * （`createQuickPick`）まで組み立てる必要が出るので、ここでは
 * **渡された項目だけを覗いて `undefined`（取りやめ）を返す**形にする。
 * 選択画面そのものの動きは `notify.test.ts` で見ている。
 */
const notifyMocks = vi.hoisted(() => ({
  // **本物の `pickWithMemory` と同じ引数の形で型を付ける。**
  // 引数なしの関数として書くと mock.calls の中身が空の組になり、
  // 「どんな項目が並んだか」を覗くというこのテストの目的が型で引けない
  pickWithMemory: vi.fn<
    (params: {
      items: readonly MemorablePick<string>[];
      title: string;
      placeHolder?: string;
      remember?: { id: string };
    }) => Promise<string | undefined>
  >(async () => undefined),
  confirmRun: vi.fn(async () => true),
}));
vi.mock("../../src/views/notify", () => ({
  pickWithMemory: notifyMocks.pickWithMemory,
  confirmRun: notifyMocks.confirmRun,
}));

/** `chooseScope` が走査する話の一覧。中身は `scanWork` の結果を差し替える */
const scannerMocks = vi.hoisted(() => ({ scanWork: vi.fn() }));
vi.mock("../../src/core/scanner", () => ({
  scanWork: scannerMocks.scanWork,
}));

/**
 * 範囲の選択は、**機能ごとに分かれていなければならない**
 * （作者の指摘、2026-09-20）。
 *
 * 「誤字脱字の前回」と「矛盾検知の前回」は別物である。時刻を1つのファイルへ
 * まとめると、**誤字脱字を走らせた時刻で矛盾検知が絞られ、まだ一度も矛盾を
 * 見ていない話が黙って対象から外れる。** 覚え（「以降はこの選択で進む」）も
 * 同じ理由で分ける——誤字脱字は差分で足りても、矛盾は全体で見たいことがある。
 */

const FEATURES: ScopeFeature[] = [
  "typo",
  "contradiction",
  "proofread",
  "foreshadow",
  "deviation",
];

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

/** ログへ出た行。飛ばした中身を捨てていないことを、ここで確かめる */
let logged: string[] = [];

const stub = window as unknown as Record<string, unknown>;
const originalCreateOutputChannel = stub.createOutputChannel;

beforeEach(() => {
  logged = [];
  stub.createOutputChannel = () => ({
    appendLine: (line: string) => logged.push(line),
    show: () => undefined,
    dispose: () => undefined,
  });
});

afterEach(() => {
  // ログの出力先は module 側に覚えられているので、捨ててから戻す
  disposeLog();
  stub.createOutputChannel = originalCreateOutputChannel;
});

describe("時刻と覚えは、機能ごとに分ける", () => {
  test("時刻を控えるファイル名が、5つとも違う", () => {
    const names = FEATURES.map((feature) => scopeFeatureSpec(feature).fileName);

    expect(new Set(names).size).toBe(FEATURES.length);
  });

  test("「以降はこの選択で進む」の覚えも、5つとも違う", () => {
    const ids = FEATURES.map((feature) => scopeFeatureSpec(feature).rememberId);

    expect(new Set(ids).size).toBe(FEATURES.length);
  });

  test("誤字脱字のファイル名は変えない（手元の記録を無かったことにしない）", () => {
    expect(scopeFeatureSpec("typo").fileName).toBe("typo_last_check.json");
  });

  test("呼び名も5つとも違う（ログでどの検知か読める）", () => {
    const labels = FEATURES.map((feature) => scopeFeatureSpec(feature).label);

    expect(new Set(labels).size).toBe(FEATURES.length);
  });
});

/**
 * **まとめ実行では聞かない**（設計書6.80）。量と料金の確認を1枚へまとめた
 * のに、そのあと個々の検知が選択画面を出すと、作者はボタン1回で放置できない。
 */
describe("まとめ実行では聞かない", () => {
  for (const feature of FEATURES) {
    test(`${feature}：聞かずに全体を選んだことにする`, async () => {
      expect(await resolveCheckScope(work, feature, { suiteConfirmed: true }))
        .toEqual({ kind: "all" });
    });
  }

  test("飛ばしたことを、どの検知かが分かる形でログへ残す", async () => {
    // **黙って全体にしない。** あとから「なぜ全話ぶん走ったのか」を
    // 追えないと、料金や待ち時間の問い合わせに答えられない
    await resolveCheckScope(work, "contradiction", { suiteConfirmed: true });

    const text = logged.join("\n");
    expect(text).toContain("矛盾検知");
    expect(text).toContain("まとめ実行のため対象は全体");
  });
});

describe("絞ったことを、完了の知らせでも黙らない", () => {
  test("全体のときは何も添えない", () => {
    expect(describeChosenScope("all")).toBe("");
  });

  test("差分のときは、そう書く", () => {
    expect(describeChosenScope("changed")).toContain("前回から書いた分");
  });

  test("試したときは、話数まで書く", () => {
    // 「10話しか見ていない」ことが知らせに出ていないと、
    // 少ない指摘を「作品全体で問題なし」と読んでしまう
    expect(describeChosenScope("first")).toContain("10話");
  });
});

/**
 * 「はじめの10話だけ（試す）」は覚えない印が付く（`noRemember`、設計書6.8.7）。
 *
 * 印そのものの効き目（覚え書きへ書かない・古い記録を素通りさせない）は
 * `pickWithMemory` の試験（`notify.test.ts`）で見ている。ここで見るのは、
 * `chooseScope`（`scopePick`、247〜257行）が**「試す」の項目にだけ**
 * その印を付けていること——付け忘れると、実機確認リストの前提が崩れる。
 */
describe("「はじめの10話だけ（試す）」には noRemember が付く", () => {
  beforeEach(() => {
    notifyMocks.pickWithMemory.mockClear();
    notifyMocks.pickWithMemory.mockResolvedValue(undefined);
  });

  test("試す・全体・前回から書いた分が並ぶとき、試すの項目にだけ付く", async () => {
    // 20話中、末尾5話だけ「前回の検知のあとに書いた」ことにする。
    // これで「差分」「試す」「全体」の3つがそろって並ぶ
    const total = 20;
    const changedFrom = 15; // 0始まりの添字。15〜19番目（5話）が対象
    const episodes = Array.from({ length: total }, (_, i) => ({
      filePath: `C:/works/試しの作品/原稿/${String(i + 1).padStart(3, "0")}.txt`,
    }));
    scannerMocks.scanWork.mockResolvedValue({ episodes });

    const originalFs = workspace.fs;
    workspace.fs = {
      readFile: async () =>
        new TextEncoder().encode(JSON.stringify({ checkedAt: 1000 })),
      stat: async (uri: { fsPath: string }) => {
        const index = episodes.findIndex((e) =>
          uri.fsPath.endsWith(e.filePath.split("/").pop() as string)
        );
        return { mtime: index >= changedFrom ? 2000 : 500 };
      },
    };
    try {
      await chooseScope(work, "typo");
    } finally {
      workspace.fs = originalFs;
    }

    expect(notifyMocks.pickWithMemory).toHaveBeenCalledTimes(1);
    const passedItems = notifyMocks.pickWithMemory.mock.calls[0][0].items;

    // 並びには「取りやめる」（`value` を持たない）も混ざる（設計書6.17.2）。
    // ここで見たいのは選べる3つだけなので、それは除く
    const byValue = new Map(
      passedItems
        .filter((item): item is typeof item & { value: string } => item.value !== undefined)
        .map((item) => [item.value, item])
    );
    expect([...byValue.keys()].sort()).toEqual(["all", "changed", "first"]);

    expect(byValue.get("first")?.noRemember).toBe(true);
    expect(byValue.get("all")?.noRemember).toBeUndefined();
    expect(byValue.get("changed")?.noRemember).toBeUndefined();
  });
});
