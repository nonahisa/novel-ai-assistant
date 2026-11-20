import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  buildAiInstructionDocument,
  findAiInstructionTarget,
} from "../core/aiInstructions";
import { sha256Bytes } from "../core/hash";

/**
 * 道具の使い方の手順書を、MCP のスキルとして配る（拡張 `io.modelcontextprotocol/skills`）。
 *
 * **本文は1つ**（`docs/skills/novel-assist.md`）。作品フォルダーへ書き出す
 * Claude Code 用の SKILL.md（`core/aiInstructions.ts`）と同じ組み立てを通す
 * ——ここで別の頭を付けると、置き場所によって言うことが違う指示書になる。
 *
 * SDK（1.32.1）に専用の口は無いので、`skills/list`・`skills/get` は
 * 素の要求の受け口として足し、ファイルは普通のリソースとして読ませる。
 */

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/** 配るスキルの名前。URI の最後の要素とフロントマターの name を揃える */
export const SKILL_NAME = "novel-assist";
export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
const SKILL_MIME_TYPE = "text/markdown";

/** 受け取った側が覚えてよい時間。変わったことを知らせる口が仕様に無いので、短めに区切る */
export const SKILLS_TTL_MS = 300_000;

export interface SkillFile {
  readonly uri: string;
  /** `sha256:<小文字の16進64桁>`。返す本文の UTF-8 のバイトから出す */
  readonly digest: string;
  readonly size: number;
}

export interface SkillEntry {
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly resources: readonly SkillFile[];
}

export interface BuiltSkill {
  /** resources/read が返す SKILL.md の全文 */
  readonly text: string;
  readonly skill: SkillEntry;
}

/**
 * SKILL.md の頭を読む。**`key: value` の1行ずつだけ**を受け付ける。
 *
 * 頭はこちらで書いた固定の数行（`aiInstructions.ts`）なので、YAML の全部は要らない。
 * 形が崩れたら推測で読まずに止める——読み違えた name を配ると、URI と食い違う。
 */
export function parseSkillFrontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("SKILL.md の頭（--- で囲んだ欄）が見つかりません");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*): (.*)$/.exec(line);
    if (!field) throw new Error(`SKILL.md の頭に読めない行があります: ${line}`);
    fields[field[1]] = field[2];
  }
  return fields;
}

export function buildNovelAssistSkill(body: string): BuiltSkill {
  /*
    **改行は LF に揃える。** digest は返す本文のバイトから出すので、チェックアウトの
    改行設定で本文が変わると、同じ版なのに digest が機械ごとに違ってしまう
  */
  const text = buildAiInstructionDocument(
    findAiInstructionTarget("claude-code"),
    body.replace(/\r\n/g, "\n")
  );
  const frontmatter = parseSkillFrontmatter(text);
  if (frontmatter.name !== SKILL_NAME) {
    throw new Error(`SKILL.md の name が URI と合いません: ${String(frontmatter.name)}`);
  }
  const bytes = new TextEncoder().encode(text);
  return {
    text,
    skill: {
      uri: SKILL_URI,
      frontmatter,
      resources: [{ uri: SKILL_URI, digest: `sha256:${sha256Bytes(bytes)}`, size: bytes.length }],
    },
  };
}

/*
  `_meta` などほかの欄は通す（loose）。uri の有無は受け口の中で確かめる
  ——ここで必須にすると、欠けたときに SDK が -32603（中のエラー）で返してしまい、
  仕様の -32602（引数の誤り）にならない
*/
const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.looseObject({ cursor: z.string().optional() }).optional(),
});

const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.looseObject({ uri: z.unknown().optional() }).optional(),
});

/** 受け口の中で起きた想定外の失敗を、仕様どおり -32603 にする（引数の誤りはそのまま通す） */
function asProtocolError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(ErrorCode.InternalError, `スキルを返せませんでした: ${message}`);
}

/**
 * スキルの道を足す。**`connect` の前に呼ぶ**（宣言は繋いだあとに足せない）。
 *
 * 拡張を知らない相手には、リソースが1つ増えて見えるだけで、道具の一覧も動きも変わらない。
 */
export function registerSkills(server: McpServer, body: string): void {
  const built = buildNovelAssistSkill(body);
  const { text, skill } = built;

  server.registerResource(
    skill.frontmatter.name,
    SKILL_URI,
    { description: skill.frontmatter.description, mimeType: SKILL_MIME_TYPE },
    () => ({ contents: [{ uri: SKILL_URI, mimeType: SKILL_MIME_TYPE, text }] })
  );

  /*
    仕様の本文は宣言の置き場を `server/discover` の応答としているが、SDK 1.32.1
    （プロトコル 2025-11-25）には discover が無い。initialize の応答の capabilities に載せる。
    任意機能の directoryRead は出さない（配るのは SKILL.md の1ファイルだけ）
  */
  server.server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION_ID]: {} },
  });

  server.server.setRequestHandler(SkillsListRequestSchema, (request) => {
    try {
      // 続きを出していないので、届いた cursor はどれもこちらの知らないものである
      if (request.params?.cursor !== undefined) {
        throw new McpError(ErrorCode.InvalidParams, "この cursor は出していません");
      }
      return {
        resultType: "complete",
        skills: [skill],
        ttlMs: SKILLS_TTL_MS,
        cacheScope: "public",
      };
    } catch (error) {
      throw asProtocolError(error);
    }
  });

  server.server.setRequestHandler(SkillsGetRequestSchema, (request) => {
    try {
      const uri = request.params?.uri;
      if (typeof uri !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "uri（スキルの SKILL.md の URI）が要ります");
      }
      if (uri !== SKILL_URI) {
        throw new McpError(ErrorCode.InvalidParams, `知らないスキルです: ${uri}`);
      }
      return {
        resultType: "complete",
        skill,
        ttlMs: SKILLS_TTL_MS,
        cacheScope: "public",
      };
    } catch (error) {
      throw asProtocolError(error);
    }
  });
}
