/**
 * AI用の指示書を、作品フォルダーへ置くための形（設計書6.87.15 柱5）。
 *
 * **作者の指示（2026-09-17）**：「作者側のスキルですが、ChatGPT や Gemini、
 * ローカルLLMでも扱えるようにしてください」。
 *
 * スキル（`.claude/skills/`）の自動適用は Claude Code の機能だが、
 * **中身は文章であり、相手を選ばない**。だから**本文は1つ**
 * （`docs/skills/novel-assist.md`）にして、置き先ごとの違いは
 * **頭の数行（フロントマターの有無）だけ**にする。写しを4つ持つと、
 * 片方だけ直したときに**相手によって言うことが違う指示書**ができる。
 *
 * **MCP の登録も一緒に書き出す。** 指示書だけ置いても、MCP に届かなければ
 * 「道具を通して答えよ」と書いた紙が宙に浮くだけである。登録の形は
 * 相手ごとに違う（JSON が2つ、TOML が1つ）。
 *
 * VS Code API に依存しない（書き込みは `features/writeAiInstructions.ts`）。
 */

import type { AiInstructionUsage } from "./aiInstructionUsage";

/** 指示書を置く相手 */
export type AiInstructionTargetId =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "plain";

/** MCP の登録の書き方。相手ごとに置き先と形が違う */
export type McpRegistrationFormat = "json" | "toml";

export interface McpRegistration {
  /** 登録名。MCP サーバーが名乗る名前（`SERVER_NAME`）と揃える */
  readonly name: string;
  /** 走らせる実行ファイル。いまは `node` の一択 */
  readonly command: string;
  /** 引数。束（`dist/mcp-server.mjs`）の場所 */
  readonly args: readonly string[];
}

export interface AiInstructionTarget {
  readonly id: AiInstructionTargetId;
  /** 画面に出す名前 */
  readonly label: string;
  /** 画面に出す一言（何が起きるか） */
  readonly detail: string;
  /**
   * 指示書の置き先（作品フォルダーからの相対。区切りは `/`）。
   * 実際の連結は `core/paths.ts` の `join` が行う。
   */
  readonly instructionPath: string;
  /** 頭に付けるフロントマター（付けない相手は undefined） */
  readonly frontMatter?: string;
  /** MCP の登録の置き先。登録の口が無い相手は undefined */
  readonly registrationPath?: string;
  readonly registrationFormat?: McpRegistrationFormat;
  /**
   * その相手が MCP で名乗る名前（分かっているものだけ）。
   *
   * **許可（設計書6.87.14）は接続元ごとに分かれる**ので、
   * 「Claude Code に許した道具は Gemini CLI には効かない」ことを
   * 書き出しの報告で伝えるために持つ。
   */
  readonly clientName?: string;
}

/**
 * 置き先の表。**ここが唯一の定義**で、画面も書き込みもここを読む。
 *
 * 並びは「自動で効くものが先、貼って使うものが後」。作者が上から選ぶ。
 */
export const AI_INSTRUCTION_TARGETS: readonly AiInstructionTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: "スキルとして置きます（説明文に合ったときに自動で効きます）",
    instructionPath: ".claude/skills/novel-assist/SKILL.md",
    frontMatter:
      "---\n" +
      "name: novel-assist\n" +
      "description: この小説作品について答えるときに読む。" +
      "誤字脱字・推敲・矛盾・伏線・あらすじ・設定資料・プロット・紹介文などを" +
      "聞かれたら、自分で本文を読んで判断せず、統合小説執筆環境" +
      "（novel-ai-assistant）の MCP の道具を通す。\n" +
      "---\n",
    registrationPath: ".mcp.json",
    registrationFormat: "json",
    clientName: "claude-code",
  },
  {
    id: "codex",
    label: "ChatGPT（Codex CLI）",
    detail: "AGENTS.md に置きます（起動時に読まれます）",
    instructionPath: "AGENTS.md",
    registrationPath: ".codex/config.toml",
    registrationFormat: "toml",
    clientName: "codex",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    detail: "GEMINI.md に置きます（起動時に読まれます）",
    instructionPath: "GEMINI.md",
    registrationPath: ".gemini/settings.json",
    registrationFormat: "json",
    clientName: "gemini-cli",
  },
  {
    id: "plain",
    label: "ローカルLLM・そのほか",
    detail:
      "素のMarkdownで置きます（システム指示へ貼って使います。MCPの登録は相手ごと）",
    instructionPath: ".aiwriter/novel-assist.md",
  },
];

export function findAiInstructionTarget(
  id: AiInstructionTargetId
): AiInstructionTarget {
  const target = AI_INSTRUCTION_TARGETS.find((entry) => entry.id === id);
  // 表は定数なので、見つからないのは呼び出し側の綴り違いだけである
  if (!target) throw new Error(`知らない置き先です: ${id}`);
  return target;
}

/** 雛形の置き場（拡張機能のフォルダーからの相対） */
export const AI_INSTRUCTION_TEMPLATE_PATH = "docs/skills/novel-assist.md";

/**
 * 置き先ごとの指示書を組む。
 *
 * **違うのは頭の数行だけ。** 本文には一切触らない——ここで差し込みを
 * 始めると、相手ごとに中身が枝分かれして、写しを4つ持つのと同じになる。
 */
export function buildAiInstructionDocument(
  target: AiInstructionTarget,
  body: string
): string {
  const text = body.replace(/^\uFEFF/, "");
  if (!target.frontMatter) return text;
  // フロントマターの直後は1行あける（Markdown の見出しと続けて読ませない）
  return `${target.frontMatter}\n${text}`;
}

/**
 * 「作品を開かずに使う」ときだけ、指示書の頭に足す数行
 * （設計書6.87.14 の末尾）。
 *
 * **本文は1つのまま。** 写しを2つ持つと、使い方によって言うことが違う
 * 指示書ができる。足すのは「作品はここにある」という事実だけで、
 * 決まりは足さない。引用（`>`）で書くのは、**本文の決まりと
 * 混ざらないようにする**ため。
 */
export function buildWorkLocationPreamble(workFolderPath: string): string {
  return (
    "> **この作品の原稿は、あなたがいま開いているフォルダーにはありません。**\n" +
    ">\n" +
    `> 作品の場所：\`${workFolderPath}\`\n` +
    ">\n" +
    "> 道具（MCP）を呼ぶときは、`folder` にこの場所をそのまま渡す。\n" +
    "> このフォルダーの外を自分で探しに行かない——原稿は道具を通してだけ読む。\n"
  );
}

/**
 * 指示書の本文に、使い方に応じた頭を付ける。
 *
 * 「開いて使う」なら**何も足さない**（0.66.8 までの動きのまま）。
 * フロントマターはこのあと `buildAiInstructionDocument` が付けるので、
 * **頭の数行より前**に来る（順を入れ替えると、スキルとして読まれなくなる）。
 */
export function applyUsageToInstructionBody(
  body: string,
  usage: AiInstructionUsage,
  workFolderPath: string
): string {
  if (usage === "open-work") return body;
  return `${buildWorkLocationPreamble(workFolderPath)}\n${body}`;
}

/**
 * 読めない設定ファイルに出会ったときの断り。
 *
 * **直さずに止める**（実装ルール2）。壊れた JSON を機械が直すと、
 * 作者が手で書いた別の登録が黙って消える。
 */
export class AiInstructionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiInstructionFormatError";
  }
}

/**
 * JSON の登録（Claude Code の `.mcp.json`、Gemini CLI の
 * `.gemini/settings.json`）へ、このサーバーの項目だけを足す／直す。
 *
 * **丸ごと置き換えない。** どちらのファイルにも、作者や他の道具が置いた
 * 登録が既に入っていることがある。消すと、作者は「昨日まで動いていた
 * 別の道具が繋がらない」という形でしか気づけない。
 */
export function mergeMcpServersJson(
  existingText: string | undefined,
  registration: McpRegistration,
  fileLabel: string
): string {
  const entry = {
    command: registration.command,
    args: [...registration.args],
  };

  const source = (existingText ?? "").trim();
  if (!source) {
    return `${JSON.stringify({ mcpServers: { [registration.name]: entry } }, null, 2)}\n`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new AiInstructionFormatError(
      `「${fileLabel}」を読めませんでした（${errorText(error)}）。` +
        "中身が壊れているかもしれないので、こちらでは直さずに止めました。" +
        "ファイルを開いて直すか、いったん別名へ退避してから、もう一度お試しください。"
    );
  }

  if (!isPlainObject(parsed)) {
    throw new AiInstructionFormatError(
      `「${fileLabel}」が想定と違う形（波かっこで始まる設定）ではありません。` +
        "こちらでは直さずに止めました。"
    );
  }

  const servers = parsed.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new AiInstructionFormatError(
      `「${fileLabel}」の mcpServers が想定と違う形です。こちらでは直さずに止めました。`
    );
  }

  const next = {
    ...parsed,
    mcpServers: { ...(servers ?? {}), [registration.name]: entry },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * TOML の登録（Codex CLI の `.codex/config.toml`）。
 *
 * **TOML は読み解かずに、この節だけを差し替える。** 全体を解釈して
 * 書き戻すと、作者が書いたコメントも並び順も失われる。節の区切り
 * （行頭の `[`）だけを見て、ここの節を置き換えるか、末尾へ足す。
 */
export function mergeCodexToml(
  existingText: string | undefined,
  registration: McpRegistration
): string {
  const section = buildCodexSection(registration);
  const source = existingText ?? "";
  if (!source.trim()) return `${section}\n`;

  const lines = source.split(/\r?\n/);
  const header = sectionHeaderPattern(registration.name);
  const start = lines.findIndex((line) => header.test(line));

  if (start < 0) {
    // 末尾へ足す。**1行あけて足す**——直前の節の値として読まれないように
    const trimmed = source.replace(/\s*$/, "");
    return `${trimmed}\n\n${section}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const rebuilt = [
    ...lines.slice(0, start),
    ...section.split("\n"),
    ...lines.slice(end),
  ];
  return `${rebuilt.join("\n").replace(/\s*$/, "")}\n`;
}

function buildCodexSection(registration: McpRegistration): string {
  const args = registration.args.map((value) => tomlString(value)).join(", ");
  return (
    `[mcp_servers.${registration.name}]\n` +
    `command = ${tomlString(registration.command)}\n` +
    `args = [${args}]`
  );
}

/**
 * `[mcp_servers.novel-ai-assistant]` を見つける。
 *
 * 名前は引用符付きでも書けるので、**両方**を拾う（作者が手で書いたものを
 * 見落とすと、同じ節が2つ並んで TOML として壊れる）。
 */
function sectionHeaderPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|"${escaped}")\\s*\\]\\s*$`
  );
}

/**
 * TOML の基本文字列。**Windows の区切り（`\\`）を必ず逃がす。**
 * 逃がさないと `C:\novel\dist` の `\n` が改行になり、別の場所を指す。
 */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
