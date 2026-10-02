import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import { saveDirtyDocumentsBeforeExtraction } from "../../../src/features/extractCharacters";
import { answerConfirms, type ConfirmPicker } from "../support/confirmPicker";

/**
 * 原稿エディターのキー（Ctrl+Alt+T など。設計書6.25.10）から検知を呼んだときの
 * 「未保存の変更があります」（作者の要望、2026-10-02「ポップアップが出る
 * ショートカットキー → Enter で操作が終了するのが理想」）。
 *
 * **右下の知らせ（トースト）では Enter が届かない。** 焦点は原稿に残ったままで、
 * Enter を押すと本文に改行が入る。原稿を打っている最中に押すキーなので、
 * 未保存は毎回のように起きる。ほかの確認と同じ**画面上部の選択窓**で訊き、
 * 先頭（＝Enter）を「保存して実行」にする。
 */

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const originalWarning = window.showWarningMessage;
let picker: ConfirmPicker | undefined;

function dirtyDocument() {
  const document = {
    uri: { fsPath: "C:/works/試しの作品/原稿/001.txt" },
    isDirty: true,
    getText: () => "打ちかけ",
    save: vi.fn(async () => {
      document.isDirty = false;
      return true;
    }),
  };
  return document;
}

beforeEach(() => {
  workspace.textDocuments = [];
});

afterEach(() => {
  picker?.restore();
  picker = undefined;
  window.showWarningMessage = originalWarning;
});

describe("キーから呼んだときの保存の確認", () => {
  test("選択窓で訊き、先頭（Enter）は「保存して実行」", async () => {
    const document = dirtyDocument();
    workspace.textDocuments = [document];
    const warning = vi.fn(async () => undefined);
    window.showWarningMessage = warning as typeof window.showWarningMessage;
    picker = answerConfirms((shown) => shown.buttons[0]);

    await expect(
      saveDirtyDocumentsBeforeExtraction(work, "推敲", { askInPicker: true })
    ).resolves.toBe(true);

    expect(picker.shown).toHaveLength(1);
    expect(picker.shown[0].buttons[0]).toBe("保存して実行");
    expect(picker.shown[0].flat).toContain("未保存の変更が 1 件あります");
    expect(document.save).toHaveBeenCalledOnce();
    // 右下の知らせは出さない（Enter が届かない）
    expect(warning).not.toHaveBeenCalled();
  });

  test("Esc で閉じたら保存もせずに取りやめる", async () => {
    const document = dirtyDocument();
    workspace.textDocuments = [document];
    picker = answerConfirms(undefined);

    await expect(
      saveDirtyDocumentsBeforeExtraction(work, "推敲", { askInPicker: true })
    ).resolves.toBe(false);
    expect(document.save).not.toHaveBeenCalled();
  });

  test("印が無ければ今までどおり右下の知らせで訊く（メニューからの道は変えない）", async () => {
    const document = dirtyDocument();
    workspace.textDocuments = [document];
    const warning = vi.fn(async () => "保存して実行");
    window.showWarningMessage = warning as unknown as typeof window.showWarningMessage;

    await expect(saveDirtyDocumentsBeforeExtraction(work, "推敲")).resolves.toBe(
      true
    );
    expect(warning).toHaveBeenCalledOnce();
  });
});
