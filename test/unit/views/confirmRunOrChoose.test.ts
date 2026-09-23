import { describe, expect, test } from "vitest";
import { confirmRunOrChoose } from "../../../src/views/notify";
import { answerConfirms } from "../support/confirmPicker";

/**
 * 確認に「別の道」を並べる（A3④、2026-09-23）。
 *
 * 大きいモデルの案内は、確認と同じ窓に「〈モデル〉に切り替える」
 * 「〈モデル〉の速さを測る」として出す。確認の窓は画面上部の選択窓
 * （A4、2026-09-23）。見ること：
 * - 押された道が返る（実行と取り違えない）
 * - 別の道は覚えない（「以降は訊かない」は実行だけ）
 */

async function withAnswer<T>(
  answer: string | undefined,
  run: (shown: ReturnType<typeof answerConfirms>["shown"]) => Promise<T>
): Promise<T> {
  const picker = answerConfirms(answer);
  try {
    return await run(picker.shown);
  } finally {
    picker.restore();
  }
}

describe("confirmRunOrChoose", () => {
  test("実行が選ばれたら run", async () => {
    await withAnswer("実行", async () => {
      expect(
        await confirmRunOrChoose("矛盾を検知します。", "実行", {
          choices: ["gemma4:26b に切り替える"],
        })
      ).toEqual({ kind: "run" });
    });
  });

  test("別の道が選ばれたら、その名前を返す", async () => {
    await withAnswer("gemma4:26b に切り替える", async (shown) => {
      expect(
        await confirmRunOrChoose("矛盾を検知します。", "実行", {
          choices: ["gemma4:26b に切り替える", "gemma4:31b の速さを測る"],
        })
      ).toEqual({ kind: "choice", label: "gemma4:26b に切り替える" });
      // 実行を先に、別の道をあとに並べる
      expect(shown[0].buttons).toEqual([
        "実行",
        "gemma4:26b に切り替える",
        "gemma4:31b の速さを測る",
      ]);
    });
  });

  test("閉じられたら undefined", async () => {
    await withAnswer(undefined, async () => {
      expect(
        await confirmRunOrChoose("矛盾を検知します。", "実行", {
          choices: ["gemma4:26b に切り替える"],
        })
      ).toBeUndefined();
    });
  });

  test("実行と同じ名前の道は並べない（押したものを取り違えない）", async () => {
    await withAnswer("実行", async (shown) => {
      await confirmRunOrChoose("矛盾を検知します。", "実行", {
        choices: ["実行", "gemma4:26b に切り替える"],
      });
      expect(shown[0].buttons).toEqual(["実行", "gemma4:26b に切り替える"]);
    });
  });

  test("別の道が無ければ、これまでの確認と同じボタンだけ", async () => {
    await withAnswer("実行", async (shown) => {
      await confirmRunOrChoose("矛盾を検知します。");
      expect(shown[0].buttons).toEqual(["実行"]);
    });
  });
});
