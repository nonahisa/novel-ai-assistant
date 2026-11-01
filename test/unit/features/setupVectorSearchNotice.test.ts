import { beforeEach, describe, expect, test } from "vitest";
import { announceVectorSearchReady } from "../../../src/features/setupVectorSearch";
import { commands, window } from "../support/vscodeStub";

/**
 * 意味検索を使えるようにしたあとの知らせ（作者の判断 2026-11-01）。
 *
 * 以前は「作品を選んで『検索用の索引を作る』を実行してください」と言うだけで、
 * その名前の操作はどのメニューにも無かった（命令の題は「検索索引作成／更新」で、
 * 詳細メニューからは外してある。設計書6.56.3）。知らせに［索引を作る］を付け、
 * 押せばそのまま作る。
 */

let shown: Array<{ message: string; items: string[] }> = [];
let ran: string[] = [];
let answer: (items: string[]) => string | undefined = () => undefined;

beforeEach(() => {
  shown = [];
  ran = [];
  answer = () => undefined;
  Object.assign(window, {
    showInformationMessage: async (message: string, ...items: string[]) => {
      shown.push({ message, items });
      return answer(items);
    },
  });
  Object.assign(commands, {
    executeCommand: async (command: string) => {
      ran.push(command);
      return undefined;
    },
  });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("意味検索の準備のあとの知らせ", () => {
  test("メニューに無い名前を言わず、命令の題と同じ［検索索引作成／更新］を出す", () => {
    announceVectorSearchReady("意味検索を使えるようにしました。");
    expect(shown).toHaveLength(1);
    expect(shown[0].message).not.toContain("検索用の索引を作る");
    // ボタンの名前は命令の題にそろえる（作者の判断 2026-11-02）。動作の言葉
    // （「索引を作る」）にしていたが、パレットで同じ操作を探すときに名前が違った
    expect(shown[0].items).toEqual(["検索索引作成／更新"]);
  });

  test("押せば、索引づくりをそのまま始める", async () => {
    answer = (items) => items[0];
    announceVectorSearchReady("意味検索を入にしました。");
    await settle();
    expect(ran).toEqual(["novelai.buildVectorIndex"]);
  });

  test("押さなければ何もしない", async () => {
    announceVectorSearchReady("意味検索を入にしました。");
    await settle();
    expect(ran).toEqual([]);
  });
});
