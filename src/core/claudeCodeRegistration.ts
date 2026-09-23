/**
 * 「Claude Code とつなぐ」の判断の部分（設計書6.87.18）。
 *
 * **作者の Claude Code の設定（`~/.claude.json`）は読むだけ。** 書くのは
 * Claude Code 自身の CLI（`claude mcp add-json` / `remove`）に任せる。
 * あのファイルは Claude Code が会話の状態を書き続けており、こちらの
 * 書き込みと重なると片方が消える。
 *
 * VS Code API にも Node にも依存しない（道の連結は呼び出し側が渡す）。
 */

/** VS Code 版の Claude Code の拡張機能ID */
export const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";

/**
 * Claude Code の登録の中身（`mcpServers` の1項目）。
 *
 * **VS Code 本体を Node として走らせる。** 依頼の前提は「VS Code と拡張機能を
 * 入れただけ」で、Node.js は入っていないことがある。`ELECTRON_RUN_AS_NODE=1`
 * を付けると Electron（VS Code 本体）が Node として動く——VS Code 自身の
 * `code` コマンドも同じやり方をしている。
 */
export interface ClaudeMcpEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildClaudeMcpEntry(
  execPath: string,
  bundlePath: string
): ClaudeMcpEntry {
  return {
    type: "stdio",
    command: execPath,
    args: [bundlePath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export type RegistrationState =
  | { kind: "missing" }
  | { kind: "same" }
  | { kind: "different"; current: unknown }
  | { kind: "unreadable"; reason: string };

/**
 * いまの登録を読む。
 *
 * - ファイルが無い・`mcpServers` に無い → `missing`
 * - 同じ（`type` を省いた書き方は `stdio` と読む。Claude Code の既定）→ `same`
 * - 違う（`node` で登録した古い形・別の場所）→ `different`
 * - 読めない（壊れた JSON）→ `unreadable`。**直さない**（実装ルール2）
 */
export function registrationState(
  configText: string | undefined,
  name: string,
  expected: ClaudeMcpEntry
): RegistrationState {
  if (configText === undefined) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isRecord(parsed)) {
    return { kind: "unreadable", reason: "中身が JSON のオブジェクトではありません" };
  }
  const servers = parsed.mcpServers;
  if (!isRecord(servers) || !(name in servers)) return { kind: "missing" };
  const current = servers[name];
  return sameEntry(current, expected) ? { kind: "same" } : { kind: "different", current };
}

function sameEntry(current: unknown, expected: ClaudeMcpEntry): boolean {
  if (!isRecord(current)) return false;
  const type = current.type ?? "stdio";
  if (type !== expected.type) return false;
  if (current.command !== expected.command) return false;
  if (!sameStrings(current.args, expected.args)) return false;
  const env = isRecord(current.env) ? current.env : {};
  const keys = new Set([...Object.keys(env), ...Object.keys(expected.env)]);
  for (const key of keys) {
    if (env[key] !== expected.env[key]) return false;
  }
  return true;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `claude mcp add-json --scope user <名前> <JSON>` の引数。
 *
 * **シェルを通さずに1つの引数として渡す**ので、空白や日本語を含む道でも
 * JSON の引用符が崩れない。スコープは名前より前（Claude Code の文書の形）。
 */
export function addJsonArgs(name: string, entry: ClaudeMcpEntry): string[] {
  return ["mcp", "add-json", "--scope", "user", name, JSON.stringify(entry)];
}

/**
 * 置き換えるときの `remove`。**ユーザー全体の登録だけを指す**——同じ名前で
 * プロジェクトの `.mcp.json` にある登録（このリポジトリの開発用など）は消さない。
 */
export function removeArgs(name: string): string[] {
  return ["mcp", "remove", name, "--scope", "user"];
}

/**
 * CLI を探す順番。
 *
 * 1. **VS Code 版の Claude Code が抱えている CLI**（`resources/native-binary/`）。
 *    拡張機能は PATH に足さないので、ここを見ないと「入れたのに見つからない」
 * 2. PATH の `claude`。**Windows では `claude.exe` だけ**——`claude.cmd`
 *    （npm で入れた形）はシェルを通すことになり、空白を含む道と JSON を
 *    安全に渡せない
 */
export function claudeCliCandidates(options: {
  platform: string;
  extensionPath?: string;
  pathEnv?: string;
  pathDelimiter: string;
  join: (...parts: string[]) => string;
}): string[] {
  const exe = options.platform === "win32" ? "claude.exe" : "claude";
  const list: string[] = [];
  if (options.extensionPath) {
    list.push(options.join(options.extensionPath, "resources", "native-binary", exe));
  }
  for (const dir of (options.pathEnv ?? "").split(options.pathDelimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/u, "$1");
    if (trimmed) list.push(options.join(trimmed, exe));
  }
  return list;
}

/**
 * Claude Code の設定ファイルの場所。`CLAUDE_CONFIG_DIR` があればその下
 * （Claude Code の文書の決まり）、無ければホームの `.claude.json`。
 */
export function claudeConfigFile(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  join: (...parts: string[]) => string
): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir ? dir : home, ".claude.json");
}
