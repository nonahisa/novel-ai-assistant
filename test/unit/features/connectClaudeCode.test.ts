import { describe, expect, test, vi } from "vitest";
import {
  CONNECT_BUTTON,
  REPLACE_BUTTON,
  connectClaudeCode,
  type ConnectClaudeCodeDeps,
} from "../../../src/features/connectClaudeCode";
import { buildClaudeMcpEntry } from "../../../src/core/claudeCodeRegistration";

/**
 * 「Claude Code とつなぐ」（設計書6.87.18）の流れ。
 *
 * - **押す前に、何をどこへ書くかを見せて許可を取る**
 * - 既存の登録を壊さない・重ねない（同じなら何もしない、違えば置き換えるかを訊く）
 * - `~/.claude.json` へこちらから直に書かない（書くのは Claude Code の CLI）
 * - 壊れた設定ファイルは直さずに止める
 */

const EXE = "C:\\VS Code\\Code.exe";
const BUNDLE = "C:\\store\\mcp-server.mjs";
const CLI = "C:\\ext\\claude.exe";
const CONFIG = "C:\\Users\\作者\\.claude.json";

function configWith(entry: unknown): string {
  return JSON.stringify({ numStartups: 5, mcpServers: { "novel-ai-assistant": entry } });
}

function deps(overrides: Partial<ConnectClaudeCodeDeps> = {}): ConnectClaudeCodeDeps {
  let registered = false;
  return {
    canRunProcesses: true,
    execPath: EXE,
    configFile: CONFIG,
    bundlePath: async () => BUNDLE,
    readConfig: async () =>
      registered ? configWith(buildClaudeMcpEntry(EXE, BUNDLE)) : JSON.stringify({}),
    findCli: async () => CLI,
    runCli: vi.fn(async (_cli: string, args: readonly string[]) => {
      if (args[1] === "add-json") registered = true;
      return { ok: true, output: "Added" };
    }),
    ask: vi.fn(async () => CONNECT_BUTTON),
    info: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
}

describe("ブラウザ版", () => {
  test("理由を出して、何もしない", async () => {
    const d = deps({ canRunProcesses: false });
    expect(await connectClaudeCode(d)).toBe("blocked");
    expect(d.runCli).not.toHaveBeenCalled();
    expect((d.info as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain("ブラウザ版");
  });
});

describe("まだつないでいない", () => {
  test("押す前に、書き先と実行するコマンドを見せる", async () => {
    const ask = vi.fn<ConnectClaudeCodeDeps["ask"]>(async () => CONNECT_BUTTON);
    await connectClaudeCode(deps({ ask }));
    const [, detail, buttons] = ask.mock.calls[0] ?? ["", "", []];
    expect(detail).toContain(CONFIG);
    expect(detail).toContain(CLI);
    expect(detail).toContain("add-json");
    expect(detail).toContain(BUNDLE);
    expect(buttons).toContain(CONNECT_BUTTON);
  });

  test("許しを得たら CLI で足し、読み直して確かめる", async () => {
    const d = deps();
    expect(await connectClaudeCode(d)).toBe("connected");
    const calls = (d.runCli as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1].slice(0, 4)).toEqual(["mcp", "add-json", "--scope", "user"]);
    // 済んだら、次にすること（新しい会話で / から選ぶ）を言う
    const said = (d.info as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(said).toContain("novel-ai-assistant:setup");
  });

  test("断られたら、何も書かない", async () => {
    const d = deps({ ask: vi.fn(async () => undefined) });
    expect(await connectClaudeCode(d)).toBe("cancelled");
    expect(d.runCli).not.toHaveBeenCalled();
  });

  test("CLI が足したと言っても、読み直して無ければ失敗と言う", async () => {
    const d = deps({ readConfig: async () => JSON.stringify({}) });
    expect(await connectClaudeCode(d)).toBe("failed");
  });

  test("CLI が失敗したら、その出力を見せる", async () => {
    const d = deps({
      runCli: vi.fn(async () => ({ ok: false, output: "MCP server already exists" })),
    });
    expect(await connectClaudeCode(d)).toBe("failed");
    const said = (d.info as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(said).toContain("already exists");
  });
});

describe("既に登録がある", () => {
  test("同じものなら、何もせずそう言う", async () => {
    const d = deps({
      readConfig: async () => configWith(buildClaudeMcpEntry(EXE, BUNDLE)),
    });
    expect(await connectClaudeCode(d)).toBe("already");
    expect(d.runCli).not.toHaveBeenCalled();
    expect(d.ask).not.toHaveBeenCalled();
  });

  test("違うものなら、置き換えるかを訊き、remove → add-json の順に呼ぶ", async () => {
    let registered: unknown = { command: "node", args: ["old.mjs"] };
    const runCli = vi.fn(async (_cli: string, args: readonly string[]) => {
      if (args[1] === "remove") registered = undefined;
      if (args[1] === "add-json") registered = JSON.parse(args[5]);
      return { ok: true, output: "" };
    });
    const ask = vi.fn<ConnectClaudeCodeDeps["ask"]>(async () => REPLACE_BUTTON);
    const d = deps({
      readConfig: async () =>
        registered ? configWith(registered) : JSON.stringify({ mcpServers: {} }),
      runCli,
      ask,
    });
    expect(await connectClaudeCode(d)).toBe("connected");
    expect(ask.mock.calls[0]?.[2]).toContain(REPLACE_BUTTON);
    expect(runCli.mock.calls.map((call) => call[1][1])).toEqual(["remove", "add-json"]);
  });

  test("違うものを置き換えないなら、何も書かない", async () => {
    const d = deps({
      readConfig: async () => configWith({ command: "node", args: ["old.mjs"] }),
      ask: vi.fn(async () => undefined),
    });
    expect(await connectClaudeCode(d)).toBe("cancelled");
    expect(d.runCli).not.toHaveBeenCalled();
  });
});

describe("触らずに止める", () => {
  test("設定ファイルが壊れていたら、直さずに止める", async () => {
    const d = deps({ readConfig: async () => "{ broken" });
    expect(await connectClaudeCode(d)).toBe("failed");
    expect(d.runCli).not.toHaveBeenCalled();
  });

  test("束の場所が決まらなければ止める", async () => {
    const d = deps({ bundlePath: async () => undefined });
    expect(await connectClaudeCode(d)).toBe("failed");
    expect(d.runCli).not.toHaveBeenCalled();
  });

  test("CLI が見つからなければ、画面の /mcp から足す値を写せるようにする", async () => {
    const copy = vi.fn<ConnectClaudeCodeDeps["copy"]>(async () => undefined);
    const d = deps({
      findCli: async () => undefined,
      ask: vi.fn(async () => "値を写す"),
      copy,
    });
    expect(await connectClaudeCode(d)).toBe("manual");
    expect(d.runCli).not.toHaveBeenCalled();
    const copied = String(copy.mock.calls[0]?.[0]);
    expect(copied).toContain(BUNDLE);
    expect(copied).toContain("ELECTRON_RUN_AS_NODE");
  });
});
