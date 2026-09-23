import * as vscode from "vscode";
import {
  CLAUDE_CODE_EXTENSION_ID,
  addJsonArgs,
  buildClaudeMcpEntry,
  claudeCliCandidates,
  claudeConfigFile,
  registrationState,
  removeArgs,
  type ClaudeMcpEntry,
} from "../core/claudeCodeRegistration";
import { canRunProcesses } from "../core/runtime";
import { logLine, useLogFile } from "../core/logger";
import { SERVER_NAME } from "../mcp/version";
import { SETUP_PROMPT_NAME } from "../mcp/prompts/setupGuide";
import { resolveStableBundlePath } from "./writeAiInstructions";

/**
 * 「Claude Code とつなぐ」（設計書6.87.18）。
 *
 * Claude Code の**ユーザー全体**の登録（`~/.claude.json` の `mcpServers`）に、
 * この拡張機能の MCP サーバーを足す。足すと、どのフォルダーで Claude Code を
 * 開いても道具とセットアップの手順書（`/novel-ai-assistant:setup`）が使える。
 *
 * 守ること：
 *
 * - **押す前に、何をどこへ書くかを見せて許可を取る**
 * - **既存の登録を壊さない・重ねない**。同じなら何もしない。違えば置き換えるかを訊く
 * - **`~/.claude.json` へこちらから直に書かない。** 書くのは Claude Code 自身の
 *   CLI。あのファイルは Claude Code が会話の状態を書き続けており、重なると片方が消える
 * - **壊れた設定ファイルは直さずに止める**（実装ルール2）
 *
 * 流れ（`connectClaudeCode`）は画面と外部プロセスを外から受け取る——
 * VS Code を知らずに試せるように。つなぎ込みは `connectClaudeCodeInVsCode`。
 */

export const CONNECT_BUTTON = "つなぐ";
export const REPLACE_BUTTON = "置き換えてつなぐ";
export const COPY_BUTTON = "値を写す";

export type ConnectOutcome =
  | "blocked"
  | "already"
  | "cancelled"
  | "connected"
  | "manual"
  | "failed";

export interface ConnectClaudeCodeDeps {
  /** 外部プロセスを起動できるか（ブラウザ版では偽） */
  canRunProcesses: boolean;
  /** VS Code 本体の実行ファイル（Node として走らせる） */
  execPath: string;
  /** Claude Code の設定ファイルの場所（見せるため・読むため） */
  configFile: string;
  /** 登録する束（版に依らない場所の写し）。決まらなければ undefined */
  bundlePath(): Promise<string | undefined>;
  /** 設定ファイルを読む。無ければ undefined */
  readConfig(): Promise<string | undefined>;
  /** CLI を探す。見つからなければ undefined */
  findCli(): Promise<string | undefined>;
  /** CLI を走らせる（シェルを通さない） */
  runCli(cli: string, args: readonly string[]): Promise<{ ok: boolean; output: string }>;
  /** モーダルで尋ねる。押されたボタン（閉じたら undefined） */
  ask(message: string, detail: string, buttons: readonly string[]): Promise<string | undefined>;
  /** モーダルで知らせる */
  info(message: string, detail?: string): Promise<void>;
  /** クリップボードへ写す */
  copy(text: string): Promise<void>;
  log(line: string): void;
}

/** 済んだあとの案内。**次にすること**を1つだけ言う */
function nextStep(): string {
  return (
    // モーダルは Markdown を解さないので、強調の記号を書かない
    "Claude Code のチャットで新しい会話を始め、「/」を打って" +
    `「${SERVER_NAME}:${SETUP_PROMPT_NAME}」を選ぶと、執筆環境のセットアップを会話で進められます。` +
    "（開いたままの会話には、つないだ道具が出ないことがあります）\n\n" +
    "VS Code を入れ直して場所が変わったときは、もう一度「Claude Code とつなぐ」を押してください。"
  );
}

/** 走らせるものを、作者に読める形で */
function describeEntry(entry: ClaudeMcpEntry): string[] {
  return [
    `走らせるもの：${entry.command} ${entry.args.join(" ")}`,
    `環境変数：${Object.entries(entry.env)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}（VS Code 本体を Node として動かします。Node.js を入れなくても動きます）`,
  ];
}

/** CLI の呼び出しを、作者に読める1行に */
function describeCommand(cli: string, args: readonly string[]): string {
  return [cli, ...args].map((part) => (/\s|"/u.test(part) ? `'${part}'` : part)).join(" ");
}

export async function connectClaudeCode(
  deps: ConnectClaudeCodeDeps
): Promise<ConnectOutcome> {
  if (!deps.canRunProcesses) {
    await deps.info(
      "ブラウザ版では、Claude Code とつなげません。",
      "Claude Code に MCP サーバーを登録するには、この機械でプログラムを起動する必要がありますが、" +
        "ブラウザ版のVS Codeでは外部プロセスを起動できません。手元のVS Codeからお使いください。"
    );
    return "blocked";
  }

  const bundle = await deps.bundlePath();
  if (!bundle) {
    await deps.info(
      "MCPサーバーの束が見つかりませんでした。",
      "拡張機能に同梱されている「dist/mcp-server.mjs」が見つからないため、つなげません。" +
        "拡張機能を入れ直してから、もう一度お試しください。"
    );
    return "failed";
  }
  const entry = buildClaudeMcpEntry(deps.execPath, bundle);

  let configText: string | undefined;
  try {
    configText = await deps.readConfig();
  } catch (error) {
    return stopUnreadable(deps, error instanceof Error ? error.message : String(error));
  }
  const state = registrationState(configText, SERVER_NAME, entry);
  if (state.kind === "unreadable") return stopUnreadable(deps, state.reason);
  if (state.kind === "same") {
    deps.log("Claude Code とは既につながっていました（同じ登録がありました）。");
    await deps.info("Claude Code とは、もうつながっています。", nextStep());
    return "already";
  }

  const cli = await deps.findCli();
  if (!cli) return offerManual(deps, entry);

  const replacing = state.kind === "different";
  const button = replacing ? REPLACE_BUTTON : CONNECT_BUTTON;
  const commands = [
    ...(replacing ? [describeCommand(cli, removeArgs(SERVER_NAME))] : []),
    describeCommand(cli, addJsonArgs(SERVER_NAME, entry)),
  ];
  const detail = [
    `書き先：${deps.configFile}（Claude Code のユーザー設定の mcpServers）`,
    `登録名：${SERVER_NAME}`,
    ...describeEntry(entry),
    "",
    ...(replacing
      ? [
          "同じ名前の、違う登録が既にあります（前のやり方でつないだものなど）：",
          JSON.stringify(state.current),
          "置き換えると、上の登録を外してから新しく足します。ほかの登録には触りません。",
          "",
        ]
      : []),
    "書くのは Claude Code 自身のコマンドです（設定ファイルへ直には書きません）：",
    ...commands,
  ].join("\n");

  const answer = await deps.ask(
    replacing
      ? "Claude Code の登録を置き換えてつなぎますか？"
      : "Claude Code に、この拡張機能の MCP サーバーを登録しますか？",
    detail,
    [button]
  );
  if (answer !== button) {
    deps.log("Claude Code とつなぐのを、作者が取りやめました。");
    return "cancelled";
  }

  if (replacing) {
    const removed = await deps.runCli(cli, removeArgs(SERVER_NAME));
    if (!removed.ok) return reportCliFailure(deps, "前の登録を外せませんでした。", removed.output);
  }
  const added = await deps.runCli(cli, addJsonArgs(SERVER_NAME, entry));
  if (!added.ok) return reportCliFailure(deps, "登録できませんでした。", added.output);

  // **済んだと言われても、読み直して確かめる**（CLI の出力の言い回しに頼らない）
  let after: string | undefined;
  try {
    after = await deps.readConfig();
  } catch {
    after = undefined;
  }
  if (registrationState(after, SERVER_NAME, entry).kind !== "same") {
    return reportCliFailure(
      deps,
      "登録したはずですが、Claude Code の設定に見当たりません。",
      added.output
    );
  }

  deps.log("Claude Code とつなぎました（ユーザー全体の登録）。");
  await deps.info("Claude Code とつなぎました。", nextStep());
  return "connected";
}

async function stopUnreadable(
  deps: ConnectClaudeCodeDeps,
  reason: string
): Promise<ConnectOutcome> {
  deps.log(`Claude Code の設定ファイルが読めなかったので止めました：${reason}`);
  await deps.info(
    "Claude Code の設定ファイルが読めませんでした。",
    `${deps.configFile}\n${reason}\n\n` +
      "中身を直さずに止めました（壊れたまま書き足すと、Claude Code の設定がさらに崩れるためです）。" +
      "Claude Code を一度起動してから、もう一度お試しください。"
  );
  return "failed";
}

async function reportCliFailure(
  deps: ConnectClaudeCodeDeps,
  message: string,
  output: string
): Promise<ConnectOutcome> {
  deps.log(`Claude Code とつなげませんでした：${message} ${output}`);
  await deps.info(
    message,
    `Claude Code のコマンドの出力：\n${output || "（何も出力されませんでした）"}`
  );
  return "failed";
}

/**
 * CLI が見つからないとき。**Claude Code の画面（`/mcp`）から足す値を写せるようにする。**
 * こちらから設定ファイルへ直に書く道は作らない（冒頭の理由）。
 */
async function offerManual(
  deps: ConnectClaudeCodeDeps,
  entry: ClaudeMcpEntry
): Promise<ConnectOutcome> {
  const values = [
    `名前：${SERVER_NAME}`,
    "種類：stdio",
    `コマンド：${entry.command}`,
    `引数：${entry.args.join(" ")}`,
    `環境変数：${Object.entries(entry.env)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}`,
    "範囲（scope）：user",
  ];
  const answer = await deps.ask(
    "Claude Code のコマンドが見つかりませんでした。",
    "VS Code 版の Claude Code が入っていないか、見つけられない場所にあります。\n\n" +
      "Claude Code のチャットで「/mcp」を打つと、画面から MCP サーバーを足せます。" +
      "「値を写す」を押すと、入れる値をクリップボードへ写します：\n\n" +
      values.join("\n"),
    [COPY_BUTTON]
  );
  if (answer !== COPY_BUTTON) return "cancelled";
  await deps.copy(values.join("\n"));
  deps.log("Claude Code の CLI が見つからなかったので、登録の値を写しました。");
  return "manual";
}

/**
 * VS Code につないだ形。**Node の部品は中で動的に読む**（実装ルール7。
 * このファイル自体も `extension.ts` からは動的に読まれる）。
 */
export async function connectClaudeCodeInVsCode(
  context: vscode.ExtensionContext
): Promise<ConnectOutcome> {
  useLogFile(undefined);
  if (!canRunProcesses()) {
    return connectClaudeCode(browserDeps());
  }
  const [fs, os, nodePath, childProcess] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
    import("node:child_process"),
  ]);
  const configFile = claudeConfigFile(process.env, os.homedir(), nodePath.join);

  return connectClaudeCode({
    canRunProcesses: true,
    execPath: process.execPath,
    configFile,
    bundlePath: () => resolveStableBundlePath(context),
    readConfig: async () => {
      try {
        return await fs.promises.readFile(configFile, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    findCli: async () => {
      const candidates = claudeCliCandidates({
        platform: process.platform,
        extensionPath: vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)?.extensionPath,
        pathEnv: process.env.PATH ?? process.env.Path,
        pathDelimiter: nodePath.delimiter,
        join: nodePath.join,
      });
      for (const candidate of candidates) {
        try {
          if ((await fs.promises.stat(candidate)).isFile()) return candidate;
        } catch {
          // 無いものは飛ばす
        }
      }
      return undefined;
    },
    runCli: (cli, args) =>
      new Promise((resolve) => {
        // **ELECTRON_RUN_AS_NODE を渡さない。** 拡張機能ホストは持っているが、
        // CLI の子（Claude Code が起こすもの）へ漏れると、Electron 製のものが即終了する
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        childProcess.execFile(
          cli,
          [...args],
          { env, timeout: 60_000, windowsHide: true },
          (error, stdout, stderr) => {
            const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
            resolve({ ok: !error, output: error && !output ? error.message : output });
          }
        );
      }),
    ask: (message, detail, buttons) =>
      Promise.resolve(
        vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons)
      ),
    info: async (message, detail) => {
      await vscode.window.showInformationMessage(message, { modal: true, detail });
    },
    copy: async (text) => {
      await vscode.env.clipboard.writeText(text);
    },
    log: (line) => logLine(line),
  });
}

/** ブラウザ版の形。**断って理由を出すだけ**（ほかの口は呼ばれない） */
function browserDeps(): ConnectClaudeCodeDeps {
  const unused = async (): Promise<undefined> => undefined;
  return {
    canRunProcesses: false,
    execPath: "",
    configFile: "",
    bundlePath: unused,
    readConfig: unused,
    findCli: unused,
    runCli: async () => ({ ok: false, output: "" }),
    ask: unused,
    info: async (message, detail) => {
      await vscode.window.showInformationMessage(message, { modal: true, detail });
    },
    copy: async () => undefined,
    log: (line) => logLine(line),
  };
}
