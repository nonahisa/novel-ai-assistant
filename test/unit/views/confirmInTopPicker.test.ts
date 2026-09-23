import { afterEach, describe, expect, test } from "vitest";
import { confirmRun, confirmRunOrChoose } from "../../../src/views/notify";
import { window } from "../support/vscodeStub";

/**
 * 確認の窓を、画面上部の選択窓にそろえる（作者の裁定 A4、2026-09-23）。
 *
 * 作者の要望は「メニューから選んだら、その横あたりに窓を」。VS Code は
 * 拡張機能に窓の位置を決めさせないので、**作品を選ぶ窓と同じ、画面上部の
 * 選択窓で続けて訊く**形にした（視線は左のメニューと上の窓の2か所）。
 * それまでは画面中央のモーダルで、視線が3か所へ飛んでいた。
 *
 * 見ること：
 * - 確認はモーダル（`showInformationMessage` / `showWarningMessage`）で出さない
 * - 選択窓の先頭は実行（Enter でそのまま進む——モーダルの既定ボタンと同じ）
 * - 取りやめの項目が見えている
 * - 補足（処理量の見積もり）は、実行の下に行として並ぶ
 * - 補足の行を選んでも走らない（読んでいるだけの行）
 */

const originalInfo = window.showInformationMessage;
const originalWarn = window.showWarningMessage;
const originalPick = window.showQuickPick;
afterEach(() => {
  window.showInformationMessage = originalInfo;
  window.showWarningMessage = originalWarn;
  window.showQuickPick = originalPick;
});

interface Shown {
  items: Array<{ label: string; kind?: number; [key: string]: unknown }>;
  options: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean };
}

/** 選択窓を差し替え、`choose` が返した項目を選んだことにする */
function picking(
  choose: (shown: Shown) => unknown
): Shown[] {
  const calls: Shown[] = [];
  window.showQuickPick = async (items, options) => {
    const shown = { items, options } as Shown;
    calls.push(shown);
    return choose(shown);
  };
  return calls;
}

function labelled(shown: Shown, text: string): unknown {
  return shown.items.find((item) => item.label.includes(text));
}

describe("確認は画面上部の選択窓で訊く（A4）", () => {
  test("モーダルを出さない", async () => {
    let modal = 0;
    window.showInformationMessage = async () => {
      modal++;
      return undefined;
    };
    window.showWarningMessage = async () => {
      modal++;
      return undefined;
    };
    picking(() => undefined);
    await confirmRun("19話をAIで確認します。");
    await confirmRun("送信します。", "送信する", { kind: "warning" });
    expect(modal).toBe(0);
  });

  test("実行を選べば true。先頭の項目が実行", async () => {
    const calls = picking((shown) => shown.items[0]);
    expect(await confirmRun("19話をAIで確認します。")).toBe(true);
    expect(calls[0].items[0].label).toContain("実行");
    expect(calls[0].options.ignoreFocusOut).toBe(true);
  });

  test("文は窓の題に出る", async () => {
    const calls = picking(() => undefined);
    await confirmRun("19話をAIで確認します。");
    expect(calls[0].options.title).toBe("19話をAIで確認します。");
  });

  test("作品名を渡すと、題の頭に作品名が出る", async () => {
    const calls = picking(() => undefined);
    await confirmRun("15チャンク中 15件を処理します。", "実行", {
      work: { title: "こちら冒険者ギルド生活保護課!!" },
    });
    expect(calls[0].options.title).toContain("こちら冒険者ギルド生活保護課!!");
  });

  test("取りやめの項目が見えている。選べば false", async () => {
    const calls = picking((shown) => labelled(shown, "取りやめる"));
    expect(await confirmRun("19話をAIで確認します。")).toBe(false);
    expect(labelled(calls[0], "取りやめる")).toBeDefined();
  });

  test("閉じられたら false", async () => {
    picking(() => undefined);
    expect(await confirmRun("19話をAIで確認します。")).toBe(false);
  });

  test("補足は、実行の下に行として並ぶ", async () => {
    const calls = picking(() => undefined);
    await confirmRun("矛盾を検知します。", "実行", {
      detail: "12チャンク中 12件を処理します。\n\n材料: 人物3人",
    });
    const labels = calls[0].items.map((item) => item.label);
    const run = labels.findIndex((label) => label.includes("実行"));
    const volume = labels.indexOf("12チャンク中 12件を処理します。");
    expect(volume).toBeGreaterThan(run);
    expect(labels).toContain("材料: 人物3人");
  });

  test("補足の行を選んでも走らない（もう一度訊く）", async () => {
    let round = 0;
    const calls = picking((shown) => {
      round++;
      // 1回目は補足の行、2回目は取りやめ
      return round === 1
        ? labelled(shown, "材料: 人物3人")
        : labelled(shown, "取りやめる");
    });
    expect(
      await confirmRun("矛盾を検知します。", "実行", { detail: "材料: 人物3人" })
    ).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("別の道を選べば、その名前が返る", async () => {
    picking((shown) => labelled(shown, "gemma4:26b に切り替える"));
    expect(
      await confirmRunOrChoose("矛盾を検知します。", "実行", {
        choices: ["gemma4:26b に切り替える"],
      })
    ).toEqual({ kind: "choice", label: "gemma4:26b に切り替える" });
  });
});
