import { describe, expect, test } from "vitest";
import {
  addJsonArgs,
  buildClaudeMcpEntry,
  claudeCliCandidates,
  claudeConfigFile,
  registrationState,
  removeArgs,
} from "../../../src/core/claudeCodeRegistration";

/**
 * 「Claude Code とつなぐ」（設計書6.87.18）の判断の部分。
 *
 * **いちばん守りたいのは、作者の Claude Code の設定を壊さないこと。**
 * `~/.claude.json` は読むだけで、書くのは Claude Code 自身の CLI に任せる。
 * ここでは「いまどうなっているか」の読み取りと、CLI へ渡す引数の形を確かめる。
 */

const EXE = "C:\\Users\\作者\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
const BUNDLE = "C:\\Users\\作者\\AppData\\Roaming\\Code\\User\\globalStorage\\nonahisa.novel-ai-assistant\\mcp-server.mjs";

describe("登録する中身", () => {
  test("VS Code 本体を Node として走らせる（Node.js が無くても動く）", () => {
    expect(buildClaudeMcpEntry(EXE, BUNDLE)).toEqual({
      type: "stdio",
      command: EXE,
      args: [BUNDLE],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });
});

describe("いまの登録を読む", () => {
  const expected = buildClaudeMcpEntry(EXE, BUNDLE);

  test("設定ファイルが無ければ「無い」", () => {
    expect(registrationState(undefined, "novel-ai-assistant", expected).kind).toBe(
      "missing"
    );
  });

  test("mcpServers に無ければ「無い」", () => {
    const text = JSON.stringify({ numStartups: 3, mcpServers: { other: {} } });
    expect(registrationState(text, "novel-ai-assistant", expected).kind).toBe(
      "missing"
    );
  });

  test("同じものがあれば「同じ」（type を省いた書き方も同じと見る）", () => {
    const { type: _type, ...withoutType } = expected;
    const text = JSON.stringify({
      mcpServers: { "novel-ai-assistant": withoutType },
    });
    expect(registrationState(text, "novel-ai-assistant", expected).kind).toBe(
      "same"
    );
  });

  test("違うもの（node で登録した古い形）は「違う」", () => {
    const text = JSON.stringify({
      mcpServers: {
        "novel-ai-assistant": { type: "stdio", command: "node", args: [BUNDLE] },
      },
    });
    const state = registrationState(text, "novel-ai-assistant", expected);
    expect(state.kind).toBe("different");
  });

  test("壊れた JSON は「読めない」——直さない", () => {
    expect(registrationState("{ broken", "novel-ai-assistant", expected).kind).toBe(
      "unreadable"
    );
  });
});

describe("CLI へ渡す引数", () => {
  test("add-json はユーザー全体へ。スコープは名前より前、JSON は1つの引数", () => {
    const entry = buildClaudeMcpEntry(EXE, BUNDLE);
    const args = addJsonArgs("novel-ai-assistant", entry);
    expect(args.slice(0, 4)).toEqual(["mcp", "add-json", "--scope", "user"]);
    expect(args[4]).toBe("novel-ai-assistant");
    expect(args).toHaveLength(6);
    // シェルを通さずに渡すので、空白や日本語を含む道でも崩れない
    expect(JSON.parse(args[5])).toEqual(entry);
  });

  test("remove もユーザー全体を指す（プロジェクトの登録は消さない）", () => {
    expect(removeArgs("novel-ai-assistant")).toEqual([
      "mcp",
      "remove",
      "novel-ai-assistant",
      "--scope",
      "user",
    ]);
  });
});

describe("CLI を探す順番", () => {
  const join = (...parts: string[]) => parts.join("\\");

  test("VS Code 版の Claude Code が抱えている CLI が先、PATH が後", () => {
    const list = claudeCliCandidates({
      platform: "win32",
      extensionPath: "C:\\ext\\anthropic.claude-code-2.1.280-win32-x64",
      pathEnv: "C:\\tools;C:\\Users\\作者\\AppData\\Roaming\\npm",
      pathDelimiter: ";",
      join,
    });
    expect(list[0]).toBe(
      "C:\\ext\\anthropic.claude-code-2.1.280-win32-x64\\resources\\native-binary\\claude.exe"
    );
    expect(list).toContain("C:\\tools\\claude.exe");
  });

  test("Windows では claude.cmd を候補にしない（シェルを通すことになる）", () => {
    const list = claudeCliCandidates({
      platform: "win32",
      pathEnv: "C:\\npm",
      pathDelimiter: ";",
      join,
    });
    expect(list.some((entry) => entry.endsWith(".cmd"))).toBe(false);
  });

  test("Windows 以外は拡張子なし", () => {
    const list = claudeCliCandidates({
      platform: "darwin",
      extensionPath: "/ext/cc",
      pathEnv: "/usr/local/bin:/opt/bin",
      pathDelimiter: ":",
      join: (...parts) => parts.join("/"),
    });
    expect(list).toEqual([
      "/ext/cc/resources/native-binary/claude",
      "/usr/local/bin/claude",
      "/opt/bin/claude",
    ]);
  });
});

describe("設定ファイルの場所", () => {
  const join = (...parts: string[]) => parts.join("/");

  test("ふだんはホームの .claude.json", () => {
    expect(claudeConfigFile({}, "/home/a", join)).toBe("/home/a/.claude.json");
  });

  test("CLAUDE_CONFIG_DIR があればその下", () => {
    expect(
      claudeConfigFile({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/a", join)
    ).toBe("/cfg/.claude.json");
  });
});
