import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { statusBarMessages, window, workspace } from "../support/vscodeStub";
import { answerConfirms } from "../support/confirmPicker";
import { confirmRun } from "../../../src/views/notify";
import { manageConfirmSkips } from "../../../src/features/manageConfirmSkips";

/**
 * 「以降は訊かない」を覚えさせてから見直し、また訊くように戻す往復
 * （設計書6.89。実機確認リスト F-96 の「実際に覚えさせてから見直すと…」）。
 *
 * 覚える側（`confirmRun`）と見直す側（`manageConfirmSkips`）は別々の
 * ファイルにあり、**同じ設定を読み書きしていることを通しで見ていなかった。**
 * 片方の鍵や置き場がずれると、「見直しで消したのにまだ訊かれない」
 * 「覚えたはずなのに見直しの一覧に出ない」になる。ここでは設定を1つの
 * 入れ物にして、覚える → 訊かれない → 見直しに出る → 選ぶ → また訊く、を通す。
 */

const ID = "ai.run.checkTypos";
const MESSAGE = "19話をAIで確認します。";

/** `novelai.confirm.remembered` の中身。読み書きとも、ここを通る */
let remembered: unknown;
/** 見直しの一覧に何が並んだか */
let reviewItems: { label: string; detail?: string; id: string }[];
/** 見直しで何を選ぶか（id）。undefined なら閉じる */
let reviewPick: string[] | undefined;

beforeEach(() => {
  remembered = undefined;
  reviewItems = [];
  reviewPick = undefined;
  statusBarMessages.length = 0;
  workspace.getConfiguration = ((section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T =>
      (section === "novelai" && key === "confirm.remembered"
        ? remembered ?? defaultValue
        : defaultValue) as T,
    update: async (key: string, value: unknown) => {
      if (section === "novelai" && key === "confirm.remembered") {
        remembered = value;
      }
    },
  })) as unknown as typeof workspace.getConfiguration;
  window.showQuickPick = (async (items: unknown) => {
    reviewItems = items as typeof reviewItems;
    if (!reviewPick) return undefined;
    return reviewItems.filter((item) => reviewPick!.includes(item.id));
  }) as typeof window.showQuickPick;
});

afterEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
  window.showQuickPick = (async () => undefined) as typeof window.showQuickPick;
});

async function runOnce(answer: string): Promise<{ asked: number; ran: boolean }> {
  const picker = answerConfirms(answer);
  try {
    const ran = await confirmRun(MESSAGE, "実行", { remember: { id: ID } });
    return { asked: picker.shown.length, ran };
  } finally {
    picker.restore();
  }
}

describe("「以降は訊かない」を覚えさせてから見直す", () => {
  test("覚える → 訊かれない → 見直しの一覧に出る → 選ぶと、また訊く", async () => {
    // 1回目：訊かれて「以降は訊かない」を選ぶ
    expect(await runOnce("実行（以降は訊かない）")).toEqual({ asked: 1, ran: true });

    // 2回目：覚えているので訊かれずに進む
    expect(await runOnce("実行")).toEqual({ asked: 0, ran: true });

    // 見直す：一覧に作者の言葉で並ぶ
    reviewPick = [ID];
    await manageConfirmSkips();
    const row = reviewItems.find((item) => item.id === ID);
    expect(row?.label).toContain("誤字脱字の検知：処理量の確認");
    expect(statusBarMessages.map((entry) => entry.text).join("\n")).toContain(
      "1件を、また訊くようにしました。"
    );

    // 3回目：また訊かれる
    expect(await runOnce("実行")).toEqual({ asked: 1, ran: true });
  });

  test("「すべて忘れる」でも、また訊くようになる", async () => {
    await runOnce("実行（以降は訊かない）");
    reviewPick = ["__all__"];
    await manageConfirmSkips();
    expect(await runOnce("実行")).toEqual({ asked: 1, ran: true });
  });

  test("見直しを何も選ばずに閉じたら、覚えたまま（見に来ただけで消さない）", async () => {
    await runOnce("実行（以降は訊かない）");
    reviewPick = undefined;
    await manageConfirmSkips();
    expect(await runOnce("実行")).toEqual({ asked: 0, ran: true });
  });
});
