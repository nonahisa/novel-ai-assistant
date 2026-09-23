import { afterEach, describe, expect, test } from "vitest";
import { confirmRunOrChoose } from "../../../src/views/notify";
import { window } from "../support/vscodeStub";

/**
 * 確認に「別の道」を並べる（A3④、2026-09-23）。
 *
 * 大きいモデルの案内は、確認と同じ窓に「〈モデル〉に切り替える」
 * 「〈モデル〉の速さを測る」として出す。見ること：
 * - 押された道が返る（実行と取り違えない）
 * - 別の道は覚えない（「以降は訊かない」は実行だけ）
 */

const original = window.showInformationMessage;
afterEach(() => {
  window.showInformationMessage = original;
});

function answering(answer: string | undefined): unknown[][] {
  const calls: unknown[][] = [];
  window.showInformationMessage = async (message, ...items) => {
    calls.push([message, ...items]);
    return answer as never;
  };
  return calls;
}

describe("confirmRunOrChoose", () => {
  test("実行が押されたら run", async () => {
    answering("実行");
    expect(
      await confirmRunOrChoose("矛盾を検知します。", "実行", {
        choices: ["gemma4:26b に切り替える"],
      })
    ).toEqual({ kind: "run" });
  });

  test("別の道が押されたら、その名前を返す", async () => {
    const calls = answering("gemma4:26b に切り替える");
    expect(
      await confirmRunOrChoose("矛盾を検知します。", "実行", {
        choices: ["gemma4:26b に切り替える", "gemma4:31b の速さを測る"],
      })
    ).toEqual({ kind: "choice", label: "gemma4:26b に切り替える" });
    // 実行を先に、別の道をあとに並べる
    expect(calls[0]?.slice(2)).toEqual([
      "実行",
      "gemma4:26b に切り替える",
      "gemma4:31b の速さを測る",
    ]);
  });

  test("閉じられたら undefined", async () => {
    answering(undefined);
    expect(
      await confirmRunOrChoose("矛盾を検知します。", "実行", {
        choices: ["gemma4:26b に切り替える"],
      })
    ).toBeUndefined();
  });

  test("実行と同じ名前の道は並べない（押したものを取り違えない）", async () => {
    const calls = answering("実行");
    await confirmRunOrChoose("矛盾を検知します。", "実行", {
      choices: ["実行", "gemma4:26b に切り替える"],
    });
    expect(calls[0]?.slice(2)).toEqual(["実行", "gemma4:26b に切り替える"]);
  });

  test("別の道が無ければ、これまでの確認と同じボタンだけ", async () => {
    const calls = answering("実行");
    await confirmRunOrChoose("矛盾を検知します。");
    expect(calls[0]?.slice(2)).toEqual(["実行"]);
  });
});
