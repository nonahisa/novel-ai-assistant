import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, window, workspace } from "../support/vscodeStub";
import { setWorkKind } from "../../../src/features/setWorkKind";
import { invalidateWorkKind } from "../../../src/core/workKindStore";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 設定ファイルが無い作品で「作品の種類」を押したときの案内（2026-09-24）。
 *
 * ブラウザ版の実機確認で、登録簿には入っているのに `.aiwriter/config.json` が
 * 無い作品ができた（原因は test-web の置き場の性質。
 * `addCollectionConfig.test.ts` に経緯）。そのとき出た文は
 * 「作品の設定ファイル（.aiwriter/config.json）が見つかりません。」だけで、
 * **作者が次に何をすればよいかが書かれていなかった**（規則5の考え方）。
 *
 * 設定ファイルを作り直す操作は無いので、登録し直す道を示す——
 * 登録（`addExisting`）は、設定ファイルが無ければ作る。
 */

const WORK: WorkEntry = {
  id: "work_missing_config",
  title: "仮作品",
  folderPath: "C:/novelai-test/仮作品",
  registeredAt: "2026-09-24T00:00:00.000Z",
};

const originalQuickPick = window.showQuickPick;
const originalError = window.showErrorMessage;

let errors: string[];

beforeEach(() => {
  invalidateWorkKind();
  errors = [];
  // 何を読んでも「無い」——設定ファイルもプロットも無い作品
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      throw new FileSystemError(uri.fsPath, "FileNotFound");
    },
    stat: async (uri: { fsPath: string }) => {
      throw new FileSystemError(uri.fsPath, "FileNotFound");
    },
  } as unknown as typeof workspace.fs;
  // 「エッセイ・記事」を選んだ体にする
  window.showQuickPick = (async (items: unknown) =>
    (items as Array<{ workKind?: string }>).find(
      (item) => item.workKind === "essay"
    )) as typeof window.showQuickPick;
  window.showErrorMessage = (async (message: string) => {
    errors.push(message);
    return undefined;
  }) as typeof window.showErrorMessage;
});

afterEach(() => {
  workspace.fs = {} as typeof workspace.fs;
  window.showQuickPick = originalQuickPick;
  window.showErrorMessage = originalError;
  invalidateWorkKind();
});

describe("設定ファイルが無い作品の種類を変えようとしたとき", () => {
  test("変えずに止め、登録し直す道を示す", async () => {
    const changed = await setWorkKind(WORK);

    expect(changed).toBeUndefined();
    expect(errors).toHaveLength(1);
    const [message] = errors;
    // 原因（何が無いか）
    expect(message).toContain(".aiwriter/config.json");
    // 次の手（1つ）：登録を解除して、同じフォルダーを登録し直す
    expect(message).toContain("登録を解除");
    expect(message).toContain("登録し直す");
    // 解除で消えるものを怖がらせない（フォルダーとファイルは消えない）
    expect(message).toContain("本文");
  });
});
