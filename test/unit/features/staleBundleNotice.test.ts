import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";

const logged = vi.hoisted(() => ({ failures: [] as string[] }));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn((label: string) => logged.failures.push(label)),
  useLogFile: vi.fn(),
}));

import { handleStaleBundleFailure } from "../../../src/features/staleBundleNotice";

/**
 * 「拡張機能が更新されています」の案内は、**拡張機能の入れ替わりのときだけ**
 * 出す（設計書6.106。実機確認リストの「作品ファイルの ENOENT では出ない」）。
 *
 * 見分け方そのもの（`isStaleBundleError`）は `staleBundle.test.ts` が真偽の
 * 両側で見ている。ここはその先——**作品ファイルの ENOENT のとき、案内も
 * ログの行も出さず、呼び出し側が元の失敗をそのまま投げ直す**こと。
 * 投げ直すのは受け取ったのと同じ失敗なので、作者の画面に出る文言は
 * この包みが入る前と1文字も変わらない。
 */

const EXTENSION_PATH =
  "C:\\Users\\nonah\\.vscode\\extensions\\nonahisa.novel-ai-assistant-0.69.10";

/** 作品ファイルが消えていたときに Node が投げる形 */
function workFileMissing(): Error {
  const error = new Error(
    "ENOENT: no such file or directory, open 'C:\\Users\\nonah\\Documents\\確認用コピー\\たゆたう鉛_確認用\\本文\\episode_0003.txt'"
  );
  (error as Error & { code: string }).code = "ENOENT";
  return error;
}

/** 拡張機能のフォルダーが消えていたとき（作者の本番で実際に出た形） */
function bundleMissing(): Error {
  const error = new Error(
    "ENOENT: no such file or directory, open 'c:\\Users\\nonah\\.vscode\\extensions\\nonahisa.novel-ai-assistant-0.69.10\\dist\\extension.js'"
  );
  (error as Error & { code: string }).code = "ENOENT";
  return error;
}

let shownErrors: string[] = [];

beforeEach(() => {
  shownErrors = [];
  logged.failures.length = 0;
  window.showErrorMessage = (async (message: string) => {
    shownErrors.push(message);
    return undefined;
  }) as typeof window.showErrorMessage;
});

/** `extension.ts` のコマンドの包みと同じ使い方で呼ぶ */
async function runWrapped(error: unknown): Promise<unknown> {
  try {
    throw error;
  } catch (caught) {
    if (!handleStaleBundleFailure(caught, EXTENSION_PATH, "novelai.openVertical")) {
      throw caught;
    }
    return undefined;
  }
}

describe("作品ファイルの ENOENT では、更新の案内を出さない", () => {
  test("元の失敗がそのまま（同じもの・同じ文言で）投げ直される", async () => {
    const original = workFileMissing();
    const rethrown = await runWrapped(original).then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(rethrown).toBe(original);
    expect((rethrown as Error).message).toBe(original.message);
  });

  test("案内も「拡張機能の更新」のログの行も出ない", async () => {
    await runWrapped(workFileMissing()).catch(() => undefined);
    expect(shownErrors).toEqual([]);
    expect(logged.failures).toEqual([]);
  });

  test("ほかの失敗（ENOENT でないもの）も、そのまま投げ直す", async () => {
    const original = new Error("本文ファイルに競合マーカーがあります");
    await expect(runWrapped(original)).rejects.toBe(original);
    expect(shownErrors).toEqual([]);
  });
});

describe("拡張機能のフォルダーが消えていたときだけ、案内する", () => {
  test("［再読み込み］付きで案内し、ログに「拡張機能の更新」を残す", async () => {
    let buttons: unknown[] = [];
    window.showErrorMessage = (async (message: string, ...items: unknown[]) => {
      shownErrors.push(message);
      buttons = items;
      return undefined;
    }) as typeof window.showErrorMessage;

    await expect(runWrapped(bundleMissing())).resolves.toBeUndefined();
    expect(shownErrors).toEqual([
      "拡張機能が更新されています。ウィンドウを再読み込みしてください。",
    ]);
    expect(buttons).toEqual(["再読み込み"]);
    expect(logged.failures).toEqual(["拡張機能の更新"]);
  });
});
