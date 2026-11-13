import iconv from "iconv-lite";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { decodeBytes } from "../../../src/core/textDecode";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 原稿 UTF-8 変換の流れ（設計書5.4.2、0.149.0）。
 *
 * 確かめること：窓で見せた話だけを変える・窓を断れば1バイトも変えない・読めない話は飛ばす・
 * 1話が失敗しても残りは変え、届いていない話を先に知らせる・1話ずつ編集履歴に残す。
 * 開いている文書の読み直し（VS Code が UTF-8 で読み直すか）は単体では写せない（実機確認リスト）。
 */
const EPISODES: string[] = [];

vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({ episodes: EPISODES.map((filePath) => ({ filePath })) }),
}));

const edits: Array<{ action: string; file?: string; detail?: string }> = [];
vi.mock("../../../src/core/actorContext", () => ({
  manualActor: () => "author",
  recordEdit: async (_work: unknown, entry: { action: string; file?: string; detail?: string }) => {
    edits.push(entry);
  },
}));

const { convertToUtf8 } = await import("../../../src/features/convertToUtf8");

const WORK_FOLDER = Uri.file("C:\\novels\\作品").fsPath;
const work = { id: "w", title: "作品", folderPath: WORK_FOLDER } as unknown as WorkEntry;
const at = (name: string): string => Uri.file(`C:\\novels\\作品\\${name}`).fsPath;
const sjis = (text: string): Uint8Array => iconv.encode(text, "shift_jis");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const disk = new Map<string, Uint8Array>();
let confirms: Array<{ message: string; detail: string }>;
let notices: string[];
let picks: string[];
let answer: string | undefined;
let pickLabel: string | undefined;
let beforeAnswer: (() => void) | undefined;

beforeEach(() => {
  disk.clear();
  EPISODES.length = 0;
  edits.length = 0;
  confirms = [];
  notices = [];
  picks = [];
  answer = "UTF-8 に変換する";
  pickLabel = undefined;
  beforeAnswer = undefined;
  workspace.textDocuments = [];
  workspace.fs = memoryFs(disk, { readDirectory: "nested" });
  window.showWarningMessage = (async (message: string, ...rest: unknown[]) => {
    const [options] = rest as [{ modal?: boolean; detail?: string } | undefined];
    if (options && typeof options === "object" && options.modal) {
      confirms.push({ message, detail: options.detail ?? "" });
      beforeAnswer?.();
      return answer;
    }
    notices.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
  window.showInformationMessage = (async (message: string) => {
    notices.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showQuickPick = async (items: unknown) => {
    const list = items as Array<{ label: string }>;
    picks.push(...list.map((item) => item.label));
    return list.find((item) => item.label === pickLabel);
  };
});

function episode(name: string, bytes: Uint8Array): string {
  const filePath = at(name);
  EPISODES.push(filePath);
  disk.set(filePath, bytes);
  return filePath;
}

describe("原稿 UTF-8 変換", () => {
  test("作品の Shift_JIS の話を、窓で確かめてから UTF-8 にする（BOM はほかの UTF-8 の話に合わせる）", async () => {
    const one = episode("第1話.txt", sjis("灯\r\n"));
    const two = episode("第2話.txt", sjis("澪\n"));
    const three = episode("第3話.txt", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("翠\n")]));

    await convertToUtf8({ work });

    // 「この話」が無いので、範囲は訊かない
    expect(picks).toEqual([]);
    expect(confirms).toHaveLength(1);
    expect(confirms[0].message).toBe("2話を Shift_JIS から UTF-8 に変換します。");
    expect(confirms[0].detail).toContain("・第1話.txt\n・第2話.txt");
    expect(decodeBytes(disk.get(one) ?? new Uint8Array())).toMatchObject({ encoding: "utf8-bom", text: "灯\n", eol: "\r\n" });
    expect(decodeBytes(disk.get(two) ?? new Uint8Array())).toMatchObject({ encoding: "utf8-bom", text: "澪\n" });
    expect(disk.get(three)?.slice(3)).toEqual(utf8("翠\n"));
    expect(edits.map((entry) => [entry.action, entry.file, entry.detail])).toEqual([
      ["文字コードを変えた", "第1話.txt", "Shift_JIS → UTF-8（BOM 付き）"],
      ["文字コードを変えた", "第2話.txt", "Shift_JIS → UTF-8（BOM 付き）"],
    ]);
    expect(notices).toEqual(["2話を UTF-8 に変換しました。"]);
  });

  test("窓を断ったら1バイトも変えない", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    answer = undefined;
    await convertToUtf8({ work });
    expect(disk.get(one)).toEqual(sjis("灯\n"));
    expect(edits).toEqual([]);
  });

  test("「この話だけ」を選べば、その話だけを変える", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    const two = episode("第2話.txt", sjis("澪\n"));
    pickLabel = "この話だけ";
    await convertToUtf8({ work, focusPath: one });
    expect(picks.slice(0, 2)).toEqual(["この話だけ", "作品の Shift_JIS の話すべて"]);
    expect(confirms[0].message).toBe("1話を Shift_JIS から UTF-8 に変換します。");
    expect(decodeBytes(disk.get(one) ?? new Uint8Array()).encoding).toBe("utf8");
    expect(disk.get(two)).toEqual(sjis("澪\n"));
  });

  test("読めないバイトがある話は飛ばし、窓と終わりの知らせに書く", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    const broken = new Uint8Array([...sjis("澪"), 0xa0, 0x0a]);
    const two = episode("第2話.txt", broken);
    await convertToUtf8({ work });
    expect(confirms[0].detail).toContain("Shift_JIS として読めないバイトがある1話（第2話.txt）");
    expect(disk.get(two)).toEqual(broken);
    expect(decodeBytes(disk.get(one) ?? new Uint8Array()).encoding).toBe("utf8");
    expect(notices[0]).toContain("変えずに飛ばしました：Shift_JIS として読めないバイトがある1話（第2話.txt）");
  });

  test("窓を見ているあいだに変わった話は書かず、残りは変える。届いていない話を先に知らせる", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    const two = episode("第2話.txt", sjis("澪\n"));
    beforeAnswer = () => disk.set(one, sjis("灯と\n"));
    await convertToUtf8({ work });
    expect(disk.get(one)).toEqual(sjis("灯と\n"));
    expect(decodeBytes(disk.get(two) ?? new Uint8Array()).encoding).toBe("utf8");
    expect(notices[0]).toMatch(/^1話は変換できず、Shift_JIS のままです：第1話.txt（/);
    expect(notices[0]).toContain("1話を UTF-8 に変換しました。");
  });

  test("右クリックした話がもう UTF-8 なら、窓でそう言ってから残りの Shift_JIS の話を候補にする", async () => {
    const one = episode("第1話.txt", utf8("灯\n"));
    const two = episode("第2話.txt", sjis("澪\n"));
    await convertToUtf8({ work, focusPath: one });
    expect(picks).toEqual([]);
    expect(confirms[0].detail.startsWith("「第1話.txt」はすでに UTF-8 です。")).toBe(true);
    expect(decodeBytes(disk.get(two) ?? new Uint8Array()).encoding).toBe("utf8");
  });

  test("開いている話が化けたまま（Shift_JIS で読んだまま）なら、待ってから知らせる", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    // VS Code 1.90 の形（文字コードの欄が無い）。読み直しで化けた本文を返し続ける
    workspace.textDocuments = [{ uri: { fsPath: one }, isDirty: false, getText: () => "轟ｯ\n" }];
    await convertToUtf8({ work });
    expect(notices.some((notice) => notice.startsWith("開いている1話が、まだ Shift_JIS のまま表示されています"))).toBe(true);
    // 開き直しても化けたままのときは、VS Code ごと開き直す案内（作者の答え 2026-11-13「知らせで案内」）
    expect(notices.some((notice) => notice.includes("開き直しても字が化けて見えるときは、VS Code を一度閉じて開き直してください。"))).toBe(true);
  });

  test("読み直す前の文書（本文が同じ）を、すぐ「済んだ」としない：文字コードの欄が UTF-8 になるまで待つ", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    // 新しい VS Code の形。開き直しの口を呼ぶまでは shiftjis のまま
    const document = { uri: Uri.file(one), isDirty: false, getText: () => "灯\n", encoding: "shiftjis" };
    workspace.textDocuments = [document as unknown as (typeof workspace.textDocuments)[number]];
    const opened: unknown[] = [];
    (workspace as unknown as { openTextDocument: (uri: unknown, options: unknown) => Promise<unknown> }).openTextDocument =
      async (_uri, options) => {
        opened.push(options);
        document.encoding = "utf8";
        return document;
      };
    await convertToUtf8({ work });
    expect(opened).toEqual([{ encoding: "utf8" }]);
    expect(notices.some((notice) => notice.includes("まだ Shift_JIS のまま"))).toBe(false);
  });

  test("本文が同じでも、文書がまだ shiftjis のままなら知らせる（読み直す前の本文で「済んだ」としない）", async () => {
    const one = episode("第1話.txt", sjis("灯\n"));
    const document = { uri: Uri.file(one), isDirty: false, getText: () => "灯\n", encoding: "shiftjis" };
    workspace.textDocuments = [document as unknown as (typeof workspace.textDocuments)[number]];
    // 開き直しの口が効かなかった（文字コードが変わらない）
    (workspace as unknown as { openTextDocument: () => Promise<unknown> }).openTextDocument = async () => document;
    await convertToUtf8({ work });
    expect(notices.some((notice) => notice.startsWith("開いている1話が、まだ Shift_JIS のまま表示されています"))).toBe(true);
  });

  test("Shift_JIS の話が無ければ、そう知らせて何もしない", async () => {
    const one = episode("第1話.txt", utf8("灯\n"));
    await convertToUtf8({ work, focusPath: one });
    expect(confirms).toEqual([]);
    expect(notices).toEqual(["「第1話.txt」はすでに UTF-8 です。この作品に Shift_JIS の話はありません。"]);
  });
});
