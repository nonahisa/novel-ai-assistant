import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  listenForFocusWithoutPointer,
  reclaimPickerFocus,
  resetPickerFocusForTest,
  showQuickPickKeepingFocus,
  whilePickerOpen,
} from "../../../src/views/pickerFocus";
import { commands, window } from "../support/vscodeStub";
import fs from "node:fs";
import nodePath from "node:path";
import { askText } from "../../../src/views/dialogs";
import { findBlockAfter } from "../support/sourceBlock";

/**
 * 確認の窓が出ている間に WebView が焦点を取り返したら、窓へ戻す（2026-11-13）。
 *
 * 画面での再現は `test/e2e/confirmFocusReclaim.test.ts`。ここでは決まりだけを見る：
 * - 窓が出ていなければ何もしない（ふだんの焦点の移りに手を出さない）
 * - 窓が出ていれば、本体のコマンドで窓へ戻す
 * - 1つの窓につき1回だけ（キーで原稿へ移した作者を、何度も窓へ引き戻さない）
 */

const originalExecute = commands.executeCommand;
let called: string[] = [];
beforeEach(() => {
  resetPickerFocusForTest();
  called = [];
  commands.executeCommand = async (command: string) => {
    called.push(command);
    return undefined;
  };
});
afterEach(() => {
  commands.executeCommand = originalExecute;
  resetPickerFocusForTest();
});

/** 開いたままの窓。`close` で閉じる */
function openPicker(): { shown: Promise<string | undefined>; close: () => void } {
  let close: () => void = () => undefined;
  const shown = whilePickerOpen(
    () =>
      new Promise<string | undefined>((resolve) => {
        close = () => resolve(undefined);
      })
  );
  return { shown, close: () => close() };
}

describe("確認の窓の焦点を取り返す", () => {
  test("窓が出ていなければ、何もしない", () => {
    reclaimPickerFocus("原稿エディター");
    expect(called).toEqual([]);
  });

  test("窓が出ていれば、窓へ焦点を戻す。1つの窓につき1回だけ", async () => {
    const picker = openPicker();
    reclaimPickerFocus("原稿エディター");
    reclaimPickerFocus("原稿エディター");
    expect(called).toEqual(["workbench.action.focusQuickOpen"]);
    picker.close();
    await picker.shown;
  });

  test("窓を閉じたあとは戻さない。次の窓ではまた1回戻す", async () => {
    const first = openPicker();
    reclaimPickerFocus("原稿エディター");
    first.close();
    await first.shown;
    reclaimPickerFocus("原稿エディター");
    expect(called).toHaveLength(1);

    const second = openPicker();
    reclaimPickerFocus("原稿エディター");
    expect(called).toHaveLength(2);
    second.close();
    await second.shown;
  });

  test("showQuickPickKeepingFocus で出した窓も、出ている間は焦点を戻す。閉じたら戻さない", async () => {
    let close: (value: string | undefined) => void = () => undefined;
    const original = window.showQuickPick;
    window.showQuickPick = (() =>
      new Promise<string | undefined>((resolve) => {
        close = resolve;
      })) as unknown as typeof window.showQuickPick;
    try {
      const shown = showQuickPickKeepingFocus(["はい", "いいえ"], { ignoreFocusOut: true });
      reclaimPickerFocus("設定資料");
      expect(called).toEqual(["workbench.action.focusQuickOpen"]);
      close("はい");
      expect(await shown).toBe("はい");
      reclaimPickerFocus("設定資料");
      expect(called).toHaveLength(1);
    } finally {
      window.showQuickPick = original;
    }
  });

  test("パネルの受け口は、focusWithoutPointer の便だけで焦点を戻す", async () => {
    let receive: (message: unknown) => void = () => undefined;
    const webview = {
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receive = listener;
        return { dispose: () => undefined };
      },
    };
    listenForFocusWithoutPointer(webview, "提案パネル");
    const picker = openPicker();
    receive({ type: "ready" });
    receive(null);
    expect(called).toEqual([]);
    receive({ type: "focusWithoutPointer" });
    expect(called).toEqual(["workbench.action.focusQuickOpen"]);
    picker.close();
    await picker.shown;
  });

  test("入力の窓（askText）も、出ている間は焦点を戻す。閉じたら戻さない（実装の残り 117行）", async () => {
    let close: (value: string | undefined) => void = () => undefined;
    const original = window.showInputBox;
    window.showInputBox = (() =>
      new Promise<string | undefined>((resolve) => {
        close = resolve;
      })) as unknown as typeof window.showInputBox;
    try {
      const shown = askText({ prompt: "新しい名前" });
      reclaimPickerFocus("原稿エディター");
      expect(called).toEqual(["workbench.action.focusQuickOpen"]);
      close("第二章");
      expect(await shown).toBe("第二章");
      reclaimPickerFocus("原稿エディター");
      expect(called).toHaveLength(1);
    } finally {
      window.showInputBox = original;
    }
  });

  test("はじめの案内の段の一覧（createQuickPick）も、出している間を whilePickerOpen で包む", () => {
    // 行にボタンを付けるため createQuickPick で組んでおり、showQuickPickKeepingFocus を通らない
    const source = fs.readFileSync(nodePath.join(__dirname, "../../../src/features/writerDiagnosis.ts"), "utf8");
    const body = findBlockAfter(source, "function askStep(");
    expect(body).toBeDefined();
    expect(body).toContain("whilePickerOpen(");
    expect(body).toContain("createQuickPick");
  });

  test("覚えられる選択の一覧（pickWithMemory の createQuickPick）も、出している間を whilePickerOpen で包む", () => {
    // 右上のピンを付けるため createQuickPick で組んでおり、showQuickPickKeepingFocus を通らない
    const source = fs.readFileSync(nodePath.join(__dirname, "../../../src/views/notify.ts"), "utf8");
    const body = findBlockAfter(source, "export async function pickWithMemory<");
    expect(body).toBeDefined();
    expect(body).toContain("whilePickerOpen(");
    expect(body).toContain("createQuickPick");
  });

  test("コマンドが断られても投げない（窓はクリックで選べる）", async () => {
    commands.executeCommand = async () => {
      throw new Error("無いコマンド");
    };
    const picker = openPicker();
    expect(() => reclaimPickerFocus("原稿エディター")).not.toThrow();
    picker.close();
    await picker.shown;
  });
});
