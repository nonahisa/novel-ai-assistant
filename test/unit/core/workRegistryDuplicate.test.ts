import { afterEach, describe, expect, test } from "vitest";
import { window } from "vscode";
import { WorkRegistry } from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 同じ場所を表記の違いで二重に登録しない（作者の報告、2026-09-24）。
 *
 * ノートPCで Claude Code のセットアップ（`/novel-ai-assistant:setup`）を試し、
 * **すでに登録してある** `C:\Users\nonah\Documents\novels` を、エクスプローラーの
 * アドレス欄から貼って渡そうとしていた。登録簿の重複の見方は
 * `path.normalize` の完全一致だったので、次がすべて「別の場所」になっていた。
 *
 * - ドライブ文字の大小（VS Code のフォルダー選び・`Uri.fsPath` は `c:`、
 *   アドレス欄から貼ると `C:`）
 * - 末尾の区切り（`novels\`）
 * - フォルダー名の大小（Windows では同じフォルダー）
 * - 前後の空白（貼るときに紛れ込む）
 *
 * 大小を同一視するのは Windows のときだけ（`pathText.ts` の
 * `normalizeForComparison`）。ドライブ文字の道は Windows でしか意味を
 * 持たないので、その部分は Windows の上でだけ走らせる（CI も Windows）。
 */

/** 登録簿の中身を持つだけの `globalState`。書いた値をそのまま覗く */
function fakeContext(works: WorkEntry[]): {
  context: { globalState: unknown };
  saved: () => WorkEntry[];
} {
  let stored = works;
  return {
    context: {
      globalState: {
        get: <T>(_key: string, _defaultValue: T): T => stored as unknown as T,
        update: async (_key: string, value: unknown) => {
          stored = value as WorkEntry[];
        },
      },
    },
    saved: () => stored,
  };
}

function entry(id: string, title: string, folderPath: string): WorkEntry {
  return { id, title, folderPath, registeredAt: "2026-09-24T00:00:00.000Z" };
}

const originalWarn = window.showWarningMessage;
afterEach(() => {
  window.showWarningMessage = originalWarn;
});

/** 出た警告を拾う */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
  return warnings;
}

/** フォルダー選びの形（`Uri.fsPath` はドライブ文字を小文字にする） */
const REGISTERED = "c:\\Users\\nonah\\Documents\\novels";

describe.runIf(process.platform === "win32")("Windows の書き方の違い", () => {
  const variants = [
    ["ドライブ文字が大文字（アドレス欄から貼った形）", "C:\\Users\\nonah\\Documents\\novels"],
    ["末尾に区切り", "C:\\Users\\nonah\\Documents\\novels\\"],
    ["フォルダー名の大小が違う", "C:\\USERS\\Nonah\\documents\\NOVELS"],
    ["前後に空白", "  C:\\Users\\nonah\\Documents\\novels  "],
    ["空白と末尾の区切りの両方", " C:\\Users\\nonah\\Documents\\novels\\ "],
    ["斜線の区切り", "C:/Users/nonah/Documents/novels/"],
  ] as const;

  for (const [label, given] of variants) {
    test(`add は断る：${label}`, async () => {
      const { context, saved } = fakeContext([entry("w1", "書庫の作品", REGISTERED)]);
      const warnings = captureWarnings();
      const registry = new WorkRegistry(context as never);

      expect(await registry.add(given)).toBeUndefined();
      expect(saved()).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    });

    test(`addExisting は断る：${label}`, async () => {
      const { context, saved } = fakeContext([entry("w1", "書庫の作品", REGISTERED)]);
      const warnings = captureWarnings();
      const registry = new WorkRegistry(context as never);

      expect(await registry.addExisting(given)).toBeUndefined();
      expect(saved()).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    });
  }

  test("断るときは、どの作品として登録済みかを添える", async () => {
    // 作品名が無いと、作者はどの登録と重なったのか一覧を探すことになる
    const { context } = fakeContext([entry("w1", "たゆたう鉛", REGISTERED)]);
    const warnings = captureWarnings();
    const registry = new WorkRegistry(context as never);

    await registry.add("C:\\Users\\nonah\\Documents\\novels\\");

    expect(warnings[0]).toContain("「たゆたう鉛」");
  });

  test("登録するときは前後の空白と末尾の区切りだけを落とす（大小はそのまま）", async () => {
    // 大小まで畳むと、作者が見るフォルダー名と一覧の表記が食い違う
    const { context, saved } = fakeContext([]);
    const registry = new WorkRegistry(context as never);

    const added = await registry.add("  C:\\Users\\nonah\\Documents\\新作\\  ");

    expect(added?.folderPath).toBe("C:\\Users\\nonah\\Documents\\新作");
    expect(added?.title).toBe("新作");
    expect(saved()[0].folderPath).toBe("C:\\Users\\nonah\\Documents\\新作");
  });

  test("ドライブの根は区切りを残す（`C:` にすると「その時の場所」の意味に変わる）", async () => {
    const { context } = fakeContext([]);
    const registry = new WorkRegistry(context as never);

    const added = await registry.add("D:\\");

    expect(added?.folderPath).toBe("D:\\");
  });

  test("既存の登録の表記は書き換えない", async () => {
    // 登録簿は作者の globalState。新しく足すだけで、前の行はそのまま残す
    const { context, saved } = fakeContext([entry("w1", "書庫の作品", REGISTERED)]);
    const registry = new WorkRegistry(context as never);

    await registry.add("C:\\Users\\nonah\\Documents\\別の作品");

    expect(saved()[0].folderPath).toBe(REGISTERED);
    expect(saved()).toHaveLength(2);
  });

  test("findByFolder は表記が違っても同じ作品を返す", () => {
    const { context } = fakeContext([entry("w1", "書庫の作品", REGISTERED)]);
    const registry = new WorkRegistry(context as never);

    expect(registry.findByFolder(" C:\\Users\\nonah\\Documents\\NOVELS\\ ")?.id).toBe("w1");
    expect(registry.findByFolder("C:\\Users\\nonah\\Documents\\novels2")).toBeUndefined();
  });

  test("名前の続きが違う別のフォルダーは別物（前方一致で重ねない）", async () => {
    const { context, saved } = fakeContext([entry("w1", "書庫の作品", REGISTERED)]);
    const registry = new WorkRegistry(context as never);

    expect(await registry.add("C:\\Users\\nonah\\Documents\\novels2")).toBeDefined();
    expect(saved()).toHaveLength(2);
  });
});

describe("ブラウザ版の作品（URI）", () => {
  const REMOTE = "vscode-vfs://github/nonahisa/novels/作品";

  test("末尾の斜線だけが違えば、同じ作品として断る", async () => {
    const { context, saved } = fakeContext([entry("w1", "作品", REMOTE)]);
    const warnings = captureWarnings();
    const registry = new WorkRegistry(context as never);

    expect(await registry.add(`${REMOTE}/`)).toBeUndefined();
    expect(await registry.add(` ${REMOTE} `)).toBeUndefined();
    expect(saved()).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  });

  test("登録するときは末尾の斜線を落とし、仕組みと場所の `//` は残す", async () => {
    const { context } = fakeContext([]);
    const registry = new WorkRegistry(context as never);

    const added = await registry.add(`${REMOTE}/`);

    expect(added?.folderPath).toBe(REMOTE);
  });
});
