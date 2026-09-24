import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { importHolidays } from "../../../src/features/holidayImport";
import { HOLIDAYS_URL } from "../../../src/core/holidays";
import { answerConfirms, type ConfirmPicker } from "../support/confirmPicker";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 「祝日を取り込む」（設計書6.111.12。実機確認リスト 0.83.6）。
 *
 * 作者の裁定（2026-09-23）は「押すこともできるけど、基本は VSIX に同梱」。
 * 押したときだけ取りに行き、**押す前に、どこへつなぐかを見せる**（公募の RSS と同じ）。
 *
 * ここで見るのは次の2つ。
 *
 * 1. 取りに行く前に確認の窓が出て、そこにつなぐ先の URL が出る
 * 2. 断ったら通信しない（保管庫にも何も書かない）
 *
 * 取りに行く口（`fetcher`）は差し替える——本物の通信はしない。
 */

const disk = new Map<string, Uint8Array>();
const STORAGE = Uri.file("C:/保管庫/nonahisa.novel-ai-assistant");
const context = { globalStorageUri: STORAGE } as never;

let picker: ConfirmPicker | undefined;
const informed: string[] = [];
const originals = {
  fs: workspace.fs,
  showInformationMessage: window.showInformationMessage,
  showWarningMessage: window.showWarningMessage,
};

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    createDirectory: async () => undefined,
    rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;
  window.showInformationMessage = (async (message: string) => {
    informed.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = (async () => undefined) as typeof window.showWarningMessage;
});

afterEach(() => {
  picker?.restore();
  picker = undefined;
  workspace.fs = originals.fs;
  window.showInformationMessage = originals.showInformationMessage;
  window.showWarningMessage = originals.showWarningMessage;
});

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("祝日を取り込む", () => {
  test("取りに行く前に確認の窓を出し、つなぐ先の URL を見せる。断ったら通信しない", async () => {
    picker = answerConfirms(undefined); // 何も選ばずに閉じる
    const fetcher = vi.fn();

    expect(await importHolidays(context, fetcher)).toBe(false);

    expect(picker.shown).toHaveLength(1);
    expect(picker.shown[0].flat).toContain(HOLIDAYS_URL);
    // 送るものが無いことも、押す前に言う
    expect(picker.shown[0].flat).toContain("こちらから送るものはありません");
    expect(fetcher).not.toHaveBeenCalled();
    // 保管庫にも何も書かない
    expect([...disk.keys()]).toEqual([]);
  });

  test("「取りに行く」を選んだときだけ、確認のあとで取りに行く", async () => {
    const order: string[] = [];
    picker = answerConfirms((shown) => {
      order.push("確認");
      return shown.buttons.includes("取りに行く") ? "取りに行く" : undefined;
    });
    const fetcher = vi.fn(async (url: string) => {
      order.push(`取得:${url}`);
      return response(200, JSON.stringify({ "2027-01-01": "元日", "2027-01-11": "成人の日" }));
    });

    expect(await importHolidays(context, fetcher)).toBe(true);

    expect(order).toEqual(["確認", `取得:${HOLIDAYS_URL}`]);
    expect(informed.join("\n")).toContain("祝日の一覧を取り込みました（2件");
  });
});
