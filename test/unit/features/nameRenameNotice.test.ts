import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  announceRenameProposals,
  confirmScope,
} from "../../../src/features/nameRename";
import { findAction } from "../../../src/views/actionList";
import type { WorkEntry } from "../../../src/models/types";
import { commands, window } from "../support/vscodeStub";

/**
 * 名前を付け替えたあとの知らせから、資料への反映へ進める（設計書6.37.3）。
 *
 * 前は「〜を実行してください」と言うだけで、作者はメニューを探し直す
 * 必要があった。**知らせにボタンを付ける。** 押さなければ何もしない。
 *
 * **ボタンを待たない**（`completionNoticeNoWait.test.ts` と同じ理由）。
 * 待つと、知らせを閉じるまで「名前を付け替える」の札を持ち続ける。
 */

const work: WorkEntry = {
  id: "work_rename",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "rename"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const APPLY = "novelai.applyRenameToRecords";

let shown: Array<{ message: string; items: string[] }> = [];
let ran: Array<{ command: string; args: unknown[] }> = [];
let answer: (items: string[]) => string | undefined = () => undefined;
/** 知らせの返事を、テストの側で好きなときに返すための栓 */
let release: () => void = () => undefined;

beforeEach(() => {
  shown = [];
  ran = [];
  answer = () => undefined;
  release = () => undefined;
  Object.assign(window, {
    showInformationMessage: (message: string, ...items: string[]) => {
      shown.push({ message, items });
      return new Promise<string | undefined>((resolve) => {
        release = () => resolve(answer(items));
      });
    },
  });
  Object.assign(commands, {
    executeCommand: async (command: string, ...args: unknown[]) => {
      ran.push({ command, args });
      return undefined;
    },
  });
});

/** 知らせの `then` の後始末まで進める */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("付け替えの知らせから資料への反映へ", () => {
  test("ボタンの名前はメニューの項目と同じ", () => {
    announceRenameProposals(work, 3);
    const label = findAction(APPLY)?.label;
    expect(label).toBeTruthy();
    expect(shown[0].items).toEqual([label]);
    expect(shown[0].message).toContain("3件");
  });

  test("押せば、この作品を指して資料への反映を呼ぶ", async () => {
    answer = (items) => items[0];
    announceRenameProposals(work, 3);
    release();
    await settle();
    expect(ran).toEqual([{ command: APPLY, args: [{ type: "work", work }] }]);
  });

  test("押さなければ何もしない", async () => {
    announceRenameProposals(work, 0);
    release();
    await settle();
    expect(ran).toEqual([]);
    // 本文に無くても、資料だけ直す道として同じボタンを出す
    expect(shown[0].items).toHaveLength(1);
  });

  test("知らせの返事を待たずに戻る", () => {
    // 返事を返さないまま（release を呼ばない）でも、関数は同期で戻る
    const returned: unknown = announceRenameProposals(work, 2);
    expect(returned).toBeUndefined();
    expect(ran).toEqual([]);
  });
});

describe("本文に当たりが無いときの知らせ（0.81.4）", () => {
  /**
   * 0.76.7 の報告：本文に当たりが0件だと、ボタンの無い「見つかりませんでした…
   * 実行してください」が先に出て、そのあとボタン付きの知らせがもう1つ出た。
   * 同じことを2回言われるうえ、先の1つはメニューを探させる古い言い方だった。
   * **知らせは1つにまとめ、資料へ進むボタンの付いたほうだけを残す。**
   */
  test("走査の確認と完了の知らせを通しても、知らせは1つだけ", async () => {
    const proceed = await confirmScope(
      { issues: [], fileCount: 0, conflicted: [] },
      "真田",
      "源"
    );
    announceRenameProposals(work, 0, "真田");
    expect(proceed).toBe(true);
    expect(shown).toHaveLength(1);
    // 残る1つは、資料への反映へ進めるボタン付き
    expect(shown[0].items).toEqual([findAction(APPLY)?.label]);
    // どの名前が無かったのかは、残る知らせで言う
    expect(shown[0].message).toContain("「真田」");
  });
});
