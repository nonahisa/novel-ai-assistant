import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";
import {
  AI_INSTRUCTION_TARGETS,
  AI_INSTRUCTION_TEMPLATE_PATH,
  AiInstructionFormatError,
  applyUsageToInstructionBody,
  buildAiInstructionDocument,
  buildToolLocationPreamble,
  findAiInstructionTarget,
  mergeCodexToml,
  mergeMcpServersJson,
} from "../../src/core/aiInstructions";
import { RECOVERY_DIRECTORY_NAME } from "../../src/core/atomicWrite";
import {
  AI_INSTRUCTION_USAGE_FILE,
  DIRECT_READ_CAVEAT,
  VIA_TOOLS_ONLY_NOTE,
  describeAiInstructionUsage,
} from "../../src/core/aiInstructionUsage";
import { AiInstructionUsageStore } from "../../src/core/aiInstructionUsageStore";
import { IGNORED_PATHS } from "../../src/core/workRegistry";
import { SERVER_NAME } from "../../src/mcp/version";

/**
 * AI用の指示書を作品へ置く（設計書6.87.15 柱5）。
 *
 * **ここで守りたいのは4つ。**
 *
 * 1. **本文は1つ**——4つの置き先で、頭の数行以外が一致すること
 *    （写しを4つ持つと、相手によって言うことが違う指示書ができる）
 * 2. MCP の登録が、相手ごとの正しい形で書かれること
 *    （指示書だけ置いても、道具に届かなければ意味が無い）
 * 3. **既にあるファイルを黙って壊さないこと**（`AGENTS.md`・`GEMINI.md` は
 *    作者や別の道具が既に置いている可能性が高い）
 * 4. `.mcp.json` に別の登録があっても消えないこと
 *
 * **本物のファイルシステムで走らせる**——確かめたいのは「何がファイルに
 * 書かれたか」なので、作り物の円盤では確かめたことにならない。
 */

const { writeAiInstructions, REGISTRATION_IS_LOCAL_NOTE } = await import(
  "../../src/features/writeAiInstructions"
);

const REGISTRATION = {
  name: SERVER_NAME,
  command: "node",
  args: ["C:\\repo\\dist\\mcp-server.mjs"],
};

describe("指示書の中身（VS Code に触らない部分）", () => {
  const body = "# 見出し\n\n本文です。\n";

  test("**本文は1つで、違うのは頭の数行だけ**", () => {
    const documents = AI_INSTRUCTION_TARGETS.map((target) =>
      buildAiInstructionDocument(target, body)
    );
    // どれも本文で終わる（本文へ差し込みを始めたら、ここで落ちる）
    for (const document of documents) expect(document.endsWith(body)).toBe(true);
    // フロントマターを持つのは Claude Code だけ
    const withFrontMatter = documents.filter((text) => text.startsWith("---\n"));
    expect(withFrontMatter).toHaveLength(1);
  });

  /*
    **登録ファイルの無い置き先には、束の場所を書き添える**（0.70.2）。

    作者の指摘（2026-09-19）：「各ユーザー環境に応じたMCPサーバの位置は
    指示されているでしょうか？」——**されていなかった。** Claude Code・
    Codex・Gemini CLI は登録ファイルに絶対パスが入るが、「ローカルLLM・
    そのほか」は登録ファイルを持たないので、**束の場所がどこにも
    書かれていなかった**——作者が自分で拡張機能のフォルダーを探すことになる。
  */
  describe("道具の在り処を、登録ファイルの無い置き先へ書き添える", () => {
    /** 空白を含む道。**囲っていなければ Program Files で切れる** */
    const registration = {
      name: "novel-ai-assistant",
      command: "node",
      args: ["C:\\Program Files\\ext\\dist\\mcp-server.mjs"],
    };

    test("ローカルLLM向けの指示書の頭に、登録名と走らせるものが出る", () => {
      const text = buildAiInstructionDocument(
        findAiInstructionTarget("plain"),
        body,
        registration
      );

      expect(text.startsWith("> **道具（MCPサーバー）の場所**")).toBe(true);
      expect(text).toContain("novel-ai-assistant");
      expect(text).toContain("mcp-server.mjs");
      // **本文は1文字も変わらない**（頭に足すだけ）
      expect(text.endsWith(body)).toBe(true);
    });

    test("空白を含む道は、引用符で囲って出す", () => {
      const line = buildToolLocationPreamble(registration);

      expect(line).toContain('"C:\\Program Files\\ext\\dist\\mcp-server.mjs"');
    });

    /*
      **登録ファイルを書く置き先には足さない。** あちらは `.mcp.json` などに
      絶対パスが入るので、同じことを2か所で言うことになる。
    */
    test("登録ファイルを書く置き先には、足さない", () => {
      for (const id of ["claude-code", "codex", "gemini-cli"] as const) {
        const text = buildAiInstructionDocument(
          findAiInstructionTarget(id),
          body,
          registration
        );
        expect(text, id).not.toContain("道具（MCPサーバー）の場所");
      }
    });

    /*
      **場所が分からなければ、書かない。** 当てずっぽうの道を書くと、
      作者はそれを登録して「繋がらない」で行き止まる。
    */
    test("場所が分からなければ、何も足さない", () => {
      const text = buildAiInstructionDocument(
        findAiInstructionTarget("plain"),
        body
      );

      expect(text).toBe(body);
    });
  });

  test("Claude Code のフロントマターは name と description を持つ", () => {
    const text = buildAiInstructionDocument(
      findAiInstructionTarget("claude-code"),
      body
    );
    expect(text).toMatch(/^---\nname: novel-assist\n/);
    expect(text).toContain("description: ");
    // フロントマターの終わりと本文のあいだは1行あける
    expect(text).toContain("---\n\n# 見出し");
  });

  test("JSON の登録は、ほかの登録を消さずに足す", () => {
    const existing = JSON.stringify(
      {
        mcpServers: { "別の道具": { command: "node", args: ["other.mjs"] } },
        そのほかの設定: { 保つ: true },
      },
      null,
      2
    );
    const merged = JSON.parse(
      mergeMcpServersJson(existing, REGISTRATION, ".mcp.json")
    );
    expect(merged.mcpServers["別の道具"]).toEqual({
      command: "node",
      args: ["other.mjs"],
    });
    expect(merged.mcpServers[SERVER_NAME]).toEqual({
      command: "node",
      args: REGISTRATION.args,
    });
    expect(merged["そのほかの設定"]).toEqual({ 保つ: true });
  });

  test("**読めない JSON は直さずに止める**", () => {
    expect(() =>
      mergeMcpServersJson("{ これは JSON ではない", REGISTRATION, ".mcp.json")
    ).toThrow(AiInstructionFormatError);
    // 波かっこで始まらない形も、勝手に包み直さない
    expect(() =>
      mergeMcpServersJson("[1, 2, 3]", REGISTRATION, ".mcp.json")
    ).toThrow(AiInstructionFormatError);
  });

  test("TOML は、この節だけを差し替える", () => {
    const existing =
      "# 作者の覚え書き\n" +
      "model = \"gpt-5\"\n" +
      "\n" +
      "[mcp_servers.別の道具]\n" +
      "command = \"node\"\n" +
      "args = [\"other.mjs\"]\n" +
      "\n" +
      `[mcp_servers.${SERVER_NAME}]\n` +
      "command = \"node\"\n" +
      "args = [\"古い場所.mjs\"]\n";
    const merged = mergeCodexToml(existing, REGISTRATION);
    expect(merged).toContain("# 作者の覚え書き");
    expect(merged).toContain("[mcp_servers.別の道具]");
    expect(merged).toContain("other.mjs");
    expect(merged).not.toContain("古い場所.mjs");
    // **Windows の区切りを逃がす**（逃がさないと別の場所を指す）
    expect(merged).toContain('args = ["C:\\\\repo\\\\dist\\\\mcp-server.mjs"]');
    // 節が2つ並ばない
    expect(
      merged.split("\n").filter((line) =>
        line.startsWith(`[mcp_servers.${SERVER_NAME}]`)
      )
    ).toHaveLength(1);
  });

  test("**使い方の頭は、本文を1文字も変えない**", () => {
    const opened = applyUsageToInstructionBody(body, "open-work", "C:\\作品");
    const closed = applyUsageToInstructionBody(body, "keep-closed", "C:\\作品");
    // 開いて使うなら、0.66.8 までと同じ（何も足さない）
    expect(opened).toBe(body);
    // 開かずに使うときだけ、頭に作品の場所が付く
    expect(closed.endsWith(body)).toBe(true);
    expect(closed).toContain("C:\\作品");
    // フロントマターは、そのさらに前（順が入れ替わると読まれない）
    const skill = buildAiInstructionDocument(
      findAiInstructionTarget("claude-code"),
      closed
    );
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill.endsWith(body)).toBe(true);
  });

  test("節が無ければ末尾へ足す（前の節の値として読まれない）", () => {
    const merged = mergeCodexToml("model = \"gpt-5\"\n", REGISTRATION);
    expect(merged).toContain("model = \"gpt-5\"\n\n[mcp_servers.");
  });
});

describe("作品へ書き出す", () => {
  let base = "";
  let root = "";
  let extensionRoot = "";
  /** 拡張機能の保管庫（`globalStorageUri`）。版に依らない束の置き場 */
  let storageRoot = "";
  const globalStore = new Map<string, unknown>();

  const work = (): WorkEntry => ({
    id: "work_test",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-09-18T00:00:00.000Z",
  });

  /**
   * 拡張機能の文脈の作り物（使うのは extensionUri・globalStorageUri・
   * globalState だけ）。
   */
  const context = () =>
    ({
      extensionUri: Uri.file(extensionRoot),
      globalStorageUri: Uri.file(storageRoot),
      globalState: {
        get: <T>(key: string): T | undefined => globalStore.get(key) as T,
        update: async (key: string, value: unknown) => {
          globalStore.set(key, value);
        },
      },
    }) as never;

  const read = (relative: string): Promise<string> =>
    fsp.readFile(nodePath.join(root, relative), "utf8");

  const put = async (relative: string, text: string) => {
    const target = nodePath.join(root, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };

  const exists = async (relative: string): Promise<boolean> => {
    try {
      await fsp.stat(nodePath.join(root, relative));
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    globalStore.clear();
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-skill-"));
    root = nodePath.join(base, "氷の街");
    // **版が入ったフォルダー名**。ここへの道を登録すると、更新で切れる
    extensionRoot = nodePath.join(base, "nonahisa.novel-ai-assistant-0.70.11");
    storageRoot = nodePath.join(base, "globalStorage", "nonahisa.novel-ai-assistant");
    await fsp.mkdir(root, { recursive: true });

    // 同梱の雛形と、同梱の束（どちらも配布物に入る。2026-09-18 に束も同梱へ）
    const template = nodePath.join(extensionRoot, AI_INSTRUCTION_TEMPLATE_PATH);
    await fsp.mkdir(nodePath.dirname(template), { recursive: true });
    await fsp.writeFile(template, TEMPLATE, "utf8");
    await fsp.mkdir(nodePath.join(extensionRoot, "dist"), { recursive: true });
    await fsp.writeFile(
      nodePath.join(extensionRoot, "dist", "mcp-server.mjs"),
      "// 束",
      "utf8"
    );

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      },
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(await fsp.readFile(uri.fsPath));
        } catch {
          // **本物と同じ形で断る**（素の ENOENT では見分けが効かない）
          throw new FileSystemError(uri.fsPath, "FileNotFound");
        }
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
      readDirectory: async (uri: { fsPath: string }) => {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? FileType.Directory : FileType.File,
        ]);
      },
      delete: async (
        uri: { fsPath: string },
        options?: { recursive?: boolean }
      ) => {
        await fsp.rm(uri.fsPath, {
          recursive: options?.recursive ?? false,
          force: true,
        });
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (!options?.overwrite) {
          try {
            await fsp.stat(to.fsPath);
            throw new FileSystemError(to.fsPath, "FileExists");
          } catch (error) {
            if (error instanceof FileSystemError) throw error;
          }
        }
        await fsp.rename(from.fsPath, to.fsPath);
      },
    } as unknown as typeof workspace.fs;

    Object.assign(window, {
      // **相手選び（複数可）と使い方選び（1つ）の両方を通す。**
      // 使い方は先頭＝「作品フォルダーを開いて使う」＝0.66.8 までの動き
      showQuickPick: vi.fn(
        async (items: unknown, options?: { canPickMany?: boolean }) =>
          options?.canPickMany ? items : (items as unknown[])[0]
      ),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showOpenDialog: vi.fn(async () => undefined),
      setStatusBarMessage: vi.fn(() => undefined),
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
    });
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    try {
      await fsp.rm(base, { recursive: true, force: true });
    } catch {
      // 一時フォルダーなので、消せなくても結果に関わらない
    }
  });

  test("**4つの相手ぶんを置くと、本文は同じで頭の数行だけが違う**", async () => {
    await writeAiInstructions(context(), work());

    const documents = await Promise.all(
      AI_INSTRUCTION_TARGETS.map((target) => read(target.instructionPath))
    );
    for (const document of documents) {
      expect(document.endsWith(TEMPLATE)).toBe(true);
    }
    /*
      **雛形そのままなのは2つだけ**（0.70.2）。Claude Code はフロントマター、
      「ローカルLLM・そのほか」は**道具の在り処**が頭に付く——あちらだけは
      登録ファイルを書かないので、束の場所をここでしか渡せない。
    */
    expect(documents.filter((text) => text === TEMPLATE)).toHaveLength(2);
    expect(documents.filter((text) => text.startsWith("---\n"))).toHaveLength(1);
    const plain = await read(findAiInstructionTarget("plain").instructionPath);
    expect(plain).toContain("道具（MCPサーバー）の場所");
    expect(plain).toContain("mcp-server.mjs");
  });

  test("MCP の登録が、相手ごとの形で書かれる", async () => {
    await writeAiInstructions(context(), work());

    // ドライブ名の大小はスタブの都合で変わるので、そこは見ない。
    // **登録に書かれるのは保管庫の写し**（版に依らない場所。0.70.12 以降）
    const bundle = nodePath
      .join(storageRoot, "mcp-server.mjs")
      .toLowerCase();

    const claude = JSON.parse(await read(".mcp.json"));
    expect(claude.mcpServers[SERVER_NAME].command).toBe("node");
    expect(claude.mcpServers[SERVER_NAME].args[0].toLowerCase()).toBe(bundle);

    const gemini = JSON.parse(await read(".gemini/settings.json"));
    expect(gemini.mcpServers[SERVER_NAME].command).toBe("node");
    expect(gemini.mcpServers[SERVER_NAME].args[0].toLowerCase()).toBe(bundle);

    const codex = await read(".codex/config.toml");
    expect(codex).toContain(`[mcp_servers.${SERVER_NAME}]`);
    expect(codex).toContain('command = "node"');

    // ローカルLLM向けには登録の口が無いので、勝手なファイルを作らない
    expect(await exists(".aiwriter/novel-assist.md")).toBe(true);
  });

  test("**既にある AGENTS.md は、訊かずに壊さない**（やめると1文字も変わらない）", async () => {
    await put("AGENTS.md", "作者が書いた決まり\n");
    // 「取りやめる」＝どちらのボタンも押さない
    (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async () => undefined
    );

    await writeAiInstructions(context(), work());

    expect(await read("AGENTS.md")).toBe("作者が書いた決まり\n");
    // ほかの置き先にも手を付けない（全部まとめて取りやめる）
    expect(await exists("GEMINI.md")).toBe(false);
    expect(await exists(".mcp.json")).toBe(false);
  });

  test("退避を選ぶと、元の中身が .novelai-recovery に残る", async () => {
    await put("GEMINI.md", "前からある中身\n");
    (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async () => "退避してから置く"
    );

    await writeAiInstructions(context(), work());

    expect(await read("GEMINI.md")).toBe(TEMPLATE);
    const backups = await fsp.readdir(
      nodePath.join(root, RECOVERY_DIRECTORY_NAME)
    );
    expect(backups.length).toBeGreaterThan(0);
    const saved = await Promise.all(
      backups.map((name) =>
        fsp.readFile(nodePath.join(root, RECOVERY_DIRECTORY_NAME, name), "utf8")
      )
    );
    expect(saved).toContain("前からある中身\n");
  });

  test("**`.mcp.json` に別の登録があっても消えない**", async () => {
    await put(
      ".mcp.json",
      JSON.stringify(
        { mcpServers: { "別の道具": { command: "node", args: ["other.mjs"] } } },
        null,
        2
      )
    );
    (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async () => "退避してから置く"
    );

    await writeAiInstructions(context(), work());

    const merged = JSON.parse(await read(".mcp.json"));
    expect(merged.mcpServers["別の道具"]).toEqual({
      command: "node",
      args: ["other.mjs"],
    });
    expect(merged.mcpServers[SERVER_NAME]).toBeDefined();
  });

  test("読めない `.mcp.json` は直さずに止め、ほかの相手は置き終える", async () => {
    await put(".mcp.json", "{ 壊れている");
    (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async () => "退避してから置く"
    );

    await writeAiInstructions(context(), work());

    // 壊れたファイルには触っていない
    expect(await read(".mcp.json")).toBe("{ 壊れている");
    // Claude Code の指示書は、登録に失敗した時点で止まる
    expect(await exists(".claude/skills/novel-assist/SKILL.md")).toBe(true);
    // ほかの相手は最後まで進む
    expect(await read("GEMINI.md")).toBe(TEMPLATE);
    expect(await exists(".gemini/settings.json")).toBe(true);
  });

  test("同じ中身が置いてあれば、二度目は触らない", async () => {
    await writeAiInstructions(context(), work());
    const before = await fsp.stat(nodePath.join(root, "GEMINI.md"));

    (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async () => "退避してから置く"
    );
    await writeAiInstructions(context(), work());

    const after = await fsp.stat(nodePath.join(root, "GEMINI.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // 同じなので退避も作らない
    expect(await exists(RECOVERY_DIRECTORY_NAME)).toBe(false);
  });

  /*
    **登録に書く束の道は、版に依らない場所を指す**（設計書6.87.15）。

    拡張機能のフォルダー名には版が入る
    （`…\extensions\nonahisa.novel-ai-assistant-0.70.11\dist\mcp-server.mjs`）。
    その道をそのまま登録すると、**VS Code が拡張機能を更新した瞬間に、
    存在しない場所を指す**——作者には「先週は動いていたのに、Claude Code が
    道具を見つけられなくなった」としか見えない。
  */
  describe("束を、版に依らない場所へ写してから登録する", () => {
    const storageBundle = (): string =>
      nodePath.join(storageRoot, "mcp-server.mjs");

    const registeredPath = async (): Promise<string> => {
      const parsed = JSON.parse(await read(".mcp.json"));
      return parsed.mcpServers[SERVER_NAME].args[0] as string;
    };

    test("**登録に書かれるのは保管庫の写しで、版の入ったフォルダーではない**", async () => {
      await writeAiInstructions(context(), work());

      const written = (await registeredPath()).toLowerCase();
      expect(written).toBe(storageBundle().toLowerCase());
      // 版が入った道が1文字も残っていないこと（更新で切れる道）
      expect(written).not.toContain("0.70.11");
      // 写しが実際に置かれ、中身も同じ
      expect(await fsp.readFile(storageBundle(), "utf8")).toBe("// 束");
    });

    test("登録ファイルの無い置き先の頭にも、保管庫の写しの道が出る", async () => {
      await writeAiInstructions(context(), work());

      const plain = await read(findAiInstructionTarget("plain").instructionPath);
      // 引用符で囲った道がそのまま出る（空白を含んでも貼って使える形）
      expect(plain.toLowerCase()).toContain(storageBundle().toLowerCase());
      expect(plain).not.toContain("0.70.11");
    });

    /*
      **毎回は写さない。** 写し直すと束の更新時刻が変わり、走っている MCP
      サーバーが「起動後に束が作り直された＝古い」と言い続ける
      （`mcp/staleness.ts` の判定2）。
    */
    test("同じ束なら、二度目は1バイトも触らない（更新時刻が変わらない）", async () => {
      await writeAiInstructions(context(), work());
      const before = await fsp.stat(storageBundle());

      await writeAiInstructions(context(), work());

      const after = await fsp.stat(storageBundle());
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    test("束が入れ替われば、写し直す", async () => {
      await writeAiInstructions(context(), work());
      await fsp.writeFile(
        nodePath.join(extensionRoot, "dist", "mcp-server.mjs"),
        "// 新しい束",
        "utf8"
      );

      await writeAiInstructions(context(), work());

      expect(await fsp.readFile(storageBundle(), "utf8")).toBe("// 新しい束");
    });

    /*
      **写せなかったときは、黙って諦めない**（実装ルール5）。これまでどおり
      拡張機能の中の道を書く——更新で切れる道だが、何も登録されないよりはよい。
    */
    test("保管庫へ写せなくても、拡張機能の中の道で登録する", async () => {
      const real = workspace.fs.createDirectory;
      workspace.fs.createDirectory = (async (uri: { fsPath: string }) => {
        if (uri.fsPath.includes("globalStorage")) {
          throw new Error("保管庫を作れません");
        }
        await fsp.mkdir(uri.fsPath, { recursive: true });
      }) as typeof workspace.fs.createDirectory;

      try {
        await writeAiInstructions(context(), work());
      } finally {
        workspace.fs.createDirectory = real;
      }

      const written = (await registeredPath()).toLowerCase();
      expect(written).toBe(
        nodePath.join(extensionRoot, "dist", "mcp-server.mjs").toLowerCase()
      );
    });
  });

  /*
    **登録ファイルを置けない置き先の指示書は、同期しない**（0.70.12）。
    あれだけは本文に束の絶対パスが入るので、機械に依存する。
  */
  test("`.aiwriter/novel-assist.md` は同期から外れている", () => {
    expect(IGNORED_PATHS).toContain(
      findAiInstructionTarget("plain").instructionPath
    );
    // **ほかの指示書は同期してよい**（文章だけで、機械に依存しない）
    for (const id of ["claude-code", "codex", "gemini-cli"] as const) {
      expect(IGNORED_PATHS, id).not.toContain(
        findAiInstructionTarget(id).instructionPath
      );
    }
  });

  /*
    **登録は機械をまたげない**（設計書5.5.7・6.87.15、0.70.11）。
    登録には束への絶対パスが入るので同期から外してあるが、**外して
    あること自体を言わないと**、作者は「デスクトップで置いたから
    ノートPCでも使えるはず」と読む（2026-09-20 に実際そうなった）。
  */
  describe("登録がこの機械だけのものだと断る", () => {
    /** 完了の知らせ（`showInformationMessage`）に渡された詳細文 */
    const reportDetail = (): string => {
      const calls = (window.showInformationMessage as unknown as ReturnType<
        typeof vi.fn
      >).mock.calls;
      const last = calls[calls.length - 1] as [string, { detail?: string }];
      return last[1].detail ?? "";
    };

    test("登録を書いた回は、同期されないことを言う", async () => {
      await writeAiInstructions(context(), work());

      expect(reportDetail()).toContain(REGISTRATION_IS_LOCAL_NOTE);
    });

    test("登録を書かない回は言わない（「ローカルLLM・そのほか」だけ）", async () => {
      // この置き先は登録ファイルを持たない。無い話をしても通じない
      (window.showQuickPick as unknown as ReturnType<typeof vi.fn>) = vi.fn(
        async (items: unknown, options?: { canPickMany?: boolean }) =>
          options?.canPickMany
            ? (items as Array<{ target?: { id?: string } }>).filter(
                (item) => item.target?.id === "plain"
              )
            : (items as unknown[])[0]
      );

      await writeAiInstructions(context(), work());

      expect(await exists(".mcp.json")).toBe(false);
      expect(reportDetail()).not.toContain(REGISTRATION_IS_LOCAL_NOTE);
      /*
        **登録ファイルが無くても、場所そのものは本文に書かれる**（0.70.2）。
        既存のこの試験は「登録ファイルを作らない」「同期の注記を出さない」
        しか見ておらず、肝心の「場所が本文に書かれる」ことを確かめていなかった。
        束（`dist/mcp-server.mjs`）は同梱されているので、登録ファイルを
        書く置き先が無くても `resolveRegistration` は静かに見つけている
        （`writeAiInstructions.ts` の `resolveRegistration`）。
      */
      const plain = await read(findAiInstructionTarget("plain").instructionPath);
      expect(plain).toContain("道具（MCPサーバー）の場所");
    });

    /*
      **許可は接続元ごとに分かれる**（設計書6.87.14）。相手を1つしか
      選ばなかった回に、複数選んだときの言い回し
      （「許可は接続元ごとに分かれます（claude-code・…）」）を出すと、
      1つしか繋いでいない作者には無い相手の名前が並んで見える。
    */
    test("相手を1つしか選ばなければ、名前を並べずに言う", async () => {
      // 相手選び（複数可）を claude-code だけに絞る
      (window.showQuickPick as unknown as ReturnType<typeof vi.fn>) = vi.fn(
        async (items: unknown, options?: { canPickMany?: boolean }) =>
          options?.canPickMany
            ? (items as Array<{ target?: { id?: string } }>).filter(
                (item) => item.target?.id === "claude-code"
              )
            : (items as unknown[])[0]
      );

      await writeAiInstructions(context(), work());

      expect(reportDetail()).toContain(
        "許可は接続元ごとに分かれます。別のAIから繋ぐと、あらためてお尋ねします。"
      );
      // 複数選んだときだけの言い回し（相手の名前を並べる）は出さない
      expect(reportDetail()).not.toContain("同じ作品でも、Claude Code に許した機能は");
    });
  });

  /*
    **作品フォルダーを開いて使うか、開かずに使うか**（設計書6.87.14 の末尾、
    作者の指示 2026-09-18）。ここで確かめたいのは4つ。

    1. 置き先が選択で変わる
    2. 「開かずに使う」のときだけ、頭に作品の絶対パスが付く
    3. 本文は1つで、違いは頭だけ（写しを2つ持たない）
    4. 選んだことが覚えられ、読み戻せる（編集履歴の断りに要る）
  */
  describe("使い方を選ぶ", () => {
    /** 「作品を開かずに使う」を選び、置き先として `destination` を返す */
    const chooseKeepClosed = (destination: string): void => {
      (window.showQuickPick as unknown as ReturnType<typeof vi.fn>) = vi.fn(
        async (items: unknown, options?: { canPickMany?: boolean }) =>
          options?.canPickMany
            ? items
            : (items as Array<{ usage?: string }>).find(
                (item) => item.usage === "keep-closed"
              )
      );
      (window.showOpenDialog as unknown as ReturnType<typeof vi.fn>) = vi.fn(
        async () => [Uri.file(destination)]
      );
    };

    let outside = "";

    beforeEach(async () => {
      outside = nodePath.join(base, "AI作業場");
      await fsp.mkdir(outside, { recursive: true });
    });

    const readOutside = (relative: string): Promise<string> =>
      fsp.readFile(nodePath.join(outside, relative), "utf8");

    test("**「開かずに使う」と、作品の外へ置き、頭に作品の場所が付く**", async () => {
      chooseKeepClosed(outside);

      await writeAiInstructions(context(), work());

      // 作品フォルダーには指示書も登録も置かれない
      expect(await exists("GEMINI.md")).toBe(false);
      expect(await exists(".mcp.json")).toBe(false);
      expect(await exists(".claude/skills/novel-assist/SKILL.md")).toBe(false);

      const placed = await readOutside("GEMINI.md");
      // **作品の絶対パスが頭にある**（道具へ渡す場所）
      expect(placed).toContain(root);
      // **本文は1つのまま**——違うのは頭だけ
      expect(placed.endsWith(TEMPLATE)).toBe(true);
      expect(placed).not.toBe(TEMPLATE);

      // Claude Code のフロントマターは先頭のまま（崩れると読まれない）
      const skill = await readOutside(".claude/skills/novel-assist/SKILL.md");
      expect(skill.startsWith("---\nname: novel-assist\n")).toBe(true);
      expect(skill).toContain(root);
      expect(skill.endsWith(TEMPLATE)).toBe(true);

      // MCP の登録も、AIが開くほうのフォルダーへ置く
      const registration = JSON.parse(await readOutside(".mcp.json"));
      expect(registration.mcpServers[SERVER_NAME]).toBeDefined();
    });

    test("「開いて使う」の本文は、頭が付かない（違いは頭だけ）", async () => {
      await writeAiInstructions(context(), work());
      const opened = await read("GEMINI.md");

      chooseKeepClosed(outside);
      await writeAiInstructions(context(), work());
      const closed = await readOutside("GEMINI.md");

      expect(opened).toBe(TEMPLATE);
      expect(closed.slice(closed.length - opened.length)).toBe(opened);
    });

    test("**作品フォルダーそのものを選んだら、選び直してもらう**", async () => {
      chooseKeepClosed(outside);
      const dialog = vi
        .fn()
        .mockResolvedValueOnce([Uri.file(root)])
        .mockResolvedValueOnce([Uri.file(outside)]);
      (window.showOpenDialog as unknown as ReturnType<typeof vi.fn>) = dialog;
      (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) =
        vi.fn(async () => "選び直す");

      await writeAiInstructions(context(), work());

      expect(dialog).toHaveBeenCalledTimes(2);
      expect(await exists("GEMINI.md")).toBe(false);
      expect(await readOutside("GEMINI.md")).toContain(root);
    });

    test("選び直さずにやめれば、1文字も置かれない", async () => {
      chooseKeepClosed(outside);
      (window.showOpenDialog as unknown as ReturnType<typeof vi.fn>) = vi.fn(
        async () => [Uri.file(root)]
      );
      (window.showWarningMessage as unknown as ReturnType<typeof vi.fn>) =
        vi.fn(async () => undefined);

      await writeAiInstructions(context(), work());

      expect(await exists("GEMINI.md")).toBe(false);
      expect(await exists(`.aiwriter/${AI_INSTRUCTION_USAGE_FILE}`)).toBe(false);
    });

    test("**選んだ使い方を覚えていて、読み戻せる**", async () => {
      await writeAiInstructions(context(), work());
      const opened = await new AiInstructionUsageStore(work()).load();
      expect(opened?.usage).toBe("open-work");
      expect(opened?.decidedAt).not.toBe("");
      // 編集履歴に出す1行（記録が実態より少なく見えることを断る）
      expect(describeAiInstructionUsage(opened)).toEqual({
        text: DIRECT_READ_CAVEAT,
        warn: true,
      });

      chooseKeepClosed(outside);
      await writeAiInstructions(context(), work());
      const closed = await new AiInstructionUsageStore(work()).load();
      expect(closed?.usage).toBe("keep-closed");
      expect(describeAiInstructionUsage(closed)).toEqual({
        text: VIA_TOOLS_ONLY_NOTE,
        warn: false,
      });
    });

    test("覚え書きは同期しない（許可の印と同じ）", () => {
      expect(IGNORED_PATHS).toContain(`.aiwriter/${AI_INSTRUCTION_USAGE_FILE}`);
    });

    test("選んでいない作品では、何も言わない", () => {
      // どちらとも言い切れないので、断りも出さない
      expect(describeAiInstructionUsage(undefined)).toBeUndefined();
    });
  });
});

/** 雛形の代わり（本物の中身はここでは問わない。**そのまま置かれるか**を見る） */
const TEMPLATE = "# この作品を扱うAIへの指示書\n\n決まりを書く。\n";
