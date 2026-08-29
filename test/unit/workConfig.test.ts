import * as path from "path";
import * as os from "os";
import {
  mkdir,
  mkdtemp,
  readFile as readHostFile,
  rm,
  writeFile as writeHostFile,
} from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import * as workRegistry from "../../src/core/workRegistry";
import type { WorkConfig, WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

const parseWorkConfig = (
  workRegistry as unknown as {
    parseWorkConfig: (raw: unknown) => WorkConfig;
  }
).parseWorkConfig;

const work: WorkEntry = {
  id: "work_test",
  title: "テスト作品",
  folderPath: "C:\\novels\\test-work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

const validConfig = {
  schemaVersion: "0.1",
  workTitle: "テスト作品",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-08-06T00:00:00.000Z",
};

/**
 * 新規作成が書いたファイルを集めるスタブ。
 * 何を書いたかだけを見たいので、ディスクには触れない。
 */
function scaffoldStub(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  workspace.fs = {
    stat: async () => {
      throw new FileSystemError("missing", "FileNotFound");
    },
    createDirectory: async () => undefined,
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(uri.fsPath, bytes);
    },
  };
  return files;
}

describe("作品設定", () => {
  test("必須項目を持つ設定だけを受理する", () => {
    expect(parseWorkConfig(validConfig)).toEqual(validConfig);
    expect(() => parseWorkConfig({ ...validConfig, workTitle: "" })).toThrow(
      "workTitle"
    );
    expect(() => parseWorkConfig({ ...validConfig, manuscriptDir: 123 })).toThrow(
      "manuscriptDir"
    );
  });

  test("告知の設定が無ければ、欄ごと持たない", () => {
    // 既にある config.json は announce を持たない。必須にすると全部読めなくなる
    expect(parseWorkConfig(validConfig).announce).toBeUndefined();
  });

  test("ハッシュタグの形を揃える", () => {
    const config = parseWorkConfig({
      ...validConfig,
      announce: {
        // 「#」の有無、途中の空白、空文字が混ざるのが実際の書かれ方
        hashtags: ["創作", "#カクヨム", "# 小説 更新", "", "   "],
        workUrl: " https://example.com/works/1 ",
      },
    });

    expect(config.announce).toEqual({
      hashtags: ["#創作", "#カクヨム", "#小説更新"],
      workUrl: "https://example.com/works/1",
    });
  });

  test("全角の「＃」も半角ひとつに揃える", () => {
    // 日本語入力では「＃」がそのまま出る。揃えないと「#＃創作」になり、
    // 投稿サイトではタグとして扱われない
    expect(
      parseWorkConfig({
        ...validConfig,
        announce: { hashtags: ["＃創作", "##二重", "＃＃混在"], workUrl: "" },
      }).announce?.hashtags
    ).toEqual(["#創作", "#二重", "#混在"]);
  });

  test("同じタグは1つにまとめる（先に書いたほうを残す）", () => {
    // 「創作」と「#創作」は揃えたあとでは同じもの。並べると投稿が読みにくい
    expect(
      parseWorkConfig({
        ...validConfig,
        announce: {
          hashtags: ["創作", "#創作", "＃創作", "#カクヨム"],
          workUrl: "",
        },
      }).announce?.hashtags
    ).toEqual(["#創作", "#カクヨム"]);
  });

  test("URLは空でもよい", () => {
    // 未入力でも告知文は作れる（目印を残す）
    expect(
      parseWorkConfig({
        ...validConfig,
        announce: { hashtags: ["#創作"], workUrl: "" },
      }).announce
    ).toEqual({ hashtags: ["#創作"], workUrl: "" });
  });

  test.each([
    { announce: "壊れた文字列" },
    { announce: { hashtags: "創作 カクヨム", workUrl: "" } },
    { announce: { hashtags: ["#創作"], workUrl: 123 } },
  ])("告知の設定が壊れていても、他の欄は読む（%o）", (broken) => {
    // 手で書き間違えたせいで作品そのものが開けなくなるほうが困る
    const config = parseWorkConfig({ ...validConfig, ...broken });

    expect(config.announce).toBeUndefined();
    expect(config.workTitle).toBe("テスト作品");
  });

  test.each(["..\\outside", "C:\\outside", "本文\\..\\..\\outside"])(
    "作品ルート外へ出る本文パス %s を拒否する",
    (manuscriptDir) => {
      expect(() =>
        workRegistry.workPaths(work, { ...validConfig, manuscriptDir })
      ).toThrow("作品フォルダ内");
    }
  );

  test("正しい相対パスを作品ルート内の絶対パスへ解決する", () => {
    const paths = workRegistry.workPaths(work, validConfig);
    expect(paths.manuscript).toBe("C:\\novels\\test-work\\本文");
    expect(paths.settings).toBe("C:\\novels\\test-work\\設定");
  });

  test("不正な設定を持つ既存フォルダは登録状態を変更しない", async () => {
    const updates: unknown[] = [];
    const context = {
      globalState: {
        get: <T>(_key: string, defaultValue: T): T => defaultValue,
        update: async (_key: string, value: unknown) => updates.push(value),
      },
    };
    workspace.fs = {
      readFile: async () => new TextEncoder().encode('{"workTitle": 123}'),
    };
    const registry = new workRegistry.WorkRegistry(context as never);

    await expect(
      registry.addExisting("C:\\novels\\broken", "壊れた作品")
    ).rejects.toThrow("作品設定");
    expect(updates).toEqual([]);
  });

  test("新規作品のgitignoreへ管理回復ディレクトリを追加する", async () => {
    const root = "C:\\novels\\new-work";
    const files = new Map<string, Uint8Array>();
    workspace.fs = {
      stat: async () => {
        throw new FileSystemError("missing", "FileNotFound");
      },
      createDirectory: async () => undefined,
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
      },
    };

    await workRegistry.scaffoldWorkFolder(root, "新作");

    const gitignore = new TextDecoder().decode(
      files.get(Uri.file(path.join(root, ".gitignore")).fsPath)
    );
    expect(gitignore.split("\n")).toContain(".novelai-recovery/");
  });

  test("プロットから始めるなら、テンプレートを置く", async () => {
    const root = "C:\\novels\\with-plot";
    const files = scaffoldStub();

    await workRegistry.scaffoldWorkFolder(root, "新作", { withPlot: true });

    const plot = files.get(
      Uri.file(path.join(root, "設定", "plot.md")).fsPath
    );
    expect(plot).toBeDefined();
    expect(new TextDecoder().decode(plot)).toContain("## ログライン");
  });

  test("本文から始めるなら、プロットは置かない", async () => {
    // 使わないテンプレートが設定資料に混ざると、紹介文を作るときの材料にも
    // 空のプロットとして渡ってしまう。あとから「プロットを作る」で足せる
    const root = "C:\\novels\\without-plot";
    const files = scaffoldStub();

    await workRegistry.scaffoldWorkFolder(root, "新作", { withPlot: false });

    expect(
      files.has(Uri.file(path.join(root, "設定", "plot.md")).fsPath)
    ).toBe(false);
    // 作品として成立させるものは、選び方に関わらず作る
    expect(
      files.has(Uri.file(path.join(root, ".aiwriter", "config.json")).fsPath)
    ).toBe(true);
  });

  test("指定しなければ、これまでどおりプロットを置く", async () => {
    const root = "C:\\novels\\default-plot";
    const files = scaffoldStub();

    await workRegistry.scaffoldWorkFolder(root, "新作");

    expect(
      files.has(Uri.file(path.join(root, "設定", "plot.md")).fsPath)
    ).toBe(true);
  });

  test("既存作品のgitignoreへ作者記述を保ったまま回復ルールを一度だけ追加する", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novelai-existing-work-"));
    try {
      const configPath = path.join(root, ".aiwriter", "config.json");
      const gitignorePath = path.join(root, ".gitignore");
      const authorBytes = new TextEncoder().encode(
        "# 作者の設定\r\nprivate-notes/\r\n"
      );
      await mkdir(path.dirname(configPath));
      await writeHostFile(configPath, JSON.stringify(validConfig));
      await writeHostFile(gitignorePath, authorBytes);
      workspace.fs = {
        readFile: async (uri: { fsPath: string }) =>
          new Uint8Array(await readHostFile(uri.fsPath)),
      };
      const makeContext = () => ({
        globalState: {
          get: <T>(_key: string, defaultValue: T): T => defaultValue,
          update: vi.fn(async () => undefined),
        },
      });

      await new workRegistry.WorkRegistry(makeContext() as never)
        .addExisting(root, "既存作");
      await new workRegistry.WorkRegistry(makeContext() as never)
        .addExisting(root, "既存作");

      const migrated = new Uint8Array(await readHostFile(gitignorePath));
      expect(migrated.slice(0, authorBytes.length)).toEqual(authorBytes);
      const gitignore = new TextDecoder().decode(migrated);
      expect(gitignore.match(/^\.novelai-recovery\/$/gm)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("登録済み作品を再登録せず起動ごとに冪等migrationする", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novelai-registry-migration-"));
    try {
      const gitignorePath = path.join(root, ".gitignore");
      const authorBytes = new TextEncoder().encode(
        "# 作者が管理する除外\r\nprivate-draft/\r\n"
      );
      await writeHostFile(gitignorePath, authorBytes);
      workspace.fs = {
        readFile: async (uri: { fsPath: string }) =>
          new Uint8Array(await readHostFile(uri.fsPath)),
      };
      const registered = {
        id: "work_existing",
        title: "登録済み作品",
        folderPath: root,
        registeredAt: "2026-08-06T00:00:00.000Z",
      };
      const update = vi.fn(async () => undefined);
      const context = {
        globalState: {
          get: <T>(_key: string, defaultValue: T): T =>
            [registered] as T,
          update,
        },
      };

      await new workRegistry.WorkRegistry(context as never).initialize();
      await new workRegistry.WorkRegistry(context as never).initialize();

      const migrated = new Uint8Array(await readHostFile(gitignorePath));
      expect(migrated.slice(0, authorBytes.length)).toEqual(authorBytes);
      const text = new TextDecoder().decode(migrated);
      expect(text.match(/^\.novelai-recovery\/$/gm)).toHaveLength(1);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
