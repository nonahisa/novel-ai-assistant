import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { CharacterStore } from "../../src/core/characterStore";
import { describeSettingsLoadErrors } from "../../src/features/settingsPanel";
import { buildSettingsPanelHtml } from "../../src/views/settingsPanelHtml";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";

/**
 * 「形の違う人物ファイルは黙って消えるのか」（49 の問い、2026-09-11）。
 *
 * 外から足された人物ファイルが一覧に出ず、知らせも出なかった、という
 * 報告があった。ここで分けて確かめる。
 *
 * - `id` の形が違うもの（`char_991_外から足した人`）は **読み込みエラーに入る**
 *   ——黙って落としてはいない
 * - 余分な鍵（`appearances`）は **捨てて読む**——形が違うわけではないので弾かない
 *
 * 出なかったのは**パネルが読み直されなかったから**で、知らせの文そのものは
 * 出せていた。読み直しの経路は `extension.ts` の
 * `reloadAfterExternalChange` に1本化した。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-08-06T00:00:00.000Z",
};

const characterDir = Uri.file(
  path.join(work.folderPath, "設定", "characters")
).fsPath;

const disk = new Map<string, Uint8Array>();

function put(name: string, body: unknown): void {
  disk.set(
    Uri.file(path.join(characterDir, name)).fsPath,
    new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`)
  );
}

beforeEach(() => {
  disk.clear();
  workspace.textDocuments = [];
  workspace.fs = {
    createDirectory: async () => {},
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    readDirectory: async (uri: { fsPath: string }) => {
      if (uri.fsPath !== characterDir) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return [...disk.keys()]
        .filter((filePath) => path.dirname(filePath) === uri.fsPath)
        .map(
          (filePath) => [path.basename(filePath), FileType.File] as [string, FileType]
        );
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async () => {},
    delete: async () => {},
  };
});

describe("形の違う人物ファイル", () => {
  test("id の形が違うファイルは、黙って消えずに読み込みエラーへ入る", async () => {
    put("char_001_文佳.json", { id: "char_001", name: "文佳" });
    put("char_991_外から足した人.json", {
      id: "char_991_外から足した人",
      name: "外から足した人",
    });

    const loaded = await new CharacterStore(work).loadAll();

    expect(loaded.characters.map((entry) => entry.id)).toEqual(["char_001"]);
    expect(loaded.errors.map((error) => error.file)).toEqual([
      "char_991_外から足した人.json",
    ]);
  });

  test("読み込みエラーは、パネルの知らせに件数とファイル名で出る", () => {
    const notice = describeSettingsLoadErrors([
      { file: "char_991_外から足した人.json" },
    ]);
    expect(notice).toContain("1 件");
    expect(notice).toContain("char_991_外から足した人.json");
    // 読めなかった項目は一覧に出ないことを、そのまま書く
    expect(notice).toContain("一覧に出ていません");
  });

  test("読めないものが無ければ、知らせは出さない", () => {
    expect(describeSettingsLoadErrors([])).toBe("");
  });

  test("余分な鍵は弾かない。持ったまま読む（外のツールの書き込みを捨てない）", async () => {
    put("char_002_灯.json", {
      id: "char_002",
      name: "灯",
      // この拡張機能が知らない鍵。作者や外のツールが足すことがある
      appearances: [1, 2, 3],
    });

    const loaded = await new CharacterStore(work).loadAll();

    expect(loaded.errors).toEqual([]);
    expect(loaded.characters.map((entry) => entry.name)).toEqual(["灯"]);
    // **知らない鍵も残す**（設計書5.4）。`parseCharacter` は検証したうえで
    // 元の中身をそのまま広げるので、書き戻しても外のツールの値は消えない
    expect(
      (loaded.characters[0] as unknown as Record<string, unknown>).appearances
    ).toEqual([1, 2, 3]);
  });

  test("ファイル名と id が食い違うファイルも読み込みエラーへ入る", async () => {
    put("char_003_別名.json", { id: "char_004", name: "別名" });

    const loaded = await new CharacterStore(work).loadAll();

    expect(loaded.characters).toEqual([]);
    expect(loaded.errors).toHaveLength(1);
  });
});

/**
 * 読み直しても、作者が見ている場所は動かさない。
 *
 * `refreshFromDisk` が送るのは `init` で、画面側の `init` は一覧を
 * 入れ替えて描き直すだけである。ここで種類や選択を初期化すると、
 * 外で1文字直すたびに人物タブの先頭へ飛ばされる。
 */
describe("読み直しで見ている場所を保つ", () => {
  const initCase = (() => {
    const source = buildSettingsPanelHtml("nonce", "csp");
    const start = source.indexOf('case "init":');
    expect(start, "init の受け口が見つからない").toBeGreaterThan(0);
    const end = source.indexOf("break;", start);
    return source.slice(start, end);
  })();

  test("一覧とタブは描き直す", () => {
    expect(initCase).toContain("renderTabs()");
    expect(initCase).toContain("renderList()");
  });

  test("選んでいる種類と選択中の id には触らない", () => {
    expect(initCase).not.toContain("activeKind =");
    expect(initCase).not.toContain("selected =");
  });
});
