import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  SKILLS_EXTENSION_ID,
  SKILL_URI,
  buildNovelAssistSkill,
  parseSkillFrontmatter,
  registerSkills,
} from "../../../src/mcp/skills";
import {
  AI_INSTRUCTION_TEMPLATE_PATH,
  buildAiInstructionDocument,
  findAiInstructionTarget,
} from "../../../src/core/aiInstructions";

/**
 * MCP でスキルを配る（拡張 `io.modelcontextprotocol/skills`）。
 *
 * **本物の束を読み込まずに、同じ部品（`registerSkills`）を新しいサーバーへ当てる。**
 * `server.ts` は読み込んだ瞬間に stdio へ繋ぐ作りなので、試験からは読めない。
 * 本文は docs の雛形をそのまま読んで渡す（束はこれを埋め込む。写しは持たない）。
 */

const root = path.join(__dirname, "..", "..", "..");
const body = fs.readFileSync(path.join(root, AI_INSTRUCTION_TEMPLATE_PATH), "utf8");

const openClients: Client[] = [];
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close();
});

/** 拡張を知らない相手と同じく、capabilities に何も出さずに繋ぐ */
async function connect(withSkills: boolean): Promise<Client> {
  const server = new McpServer({ name: "skl-test", version: "0.0.0" });
  // これまでの道具の代わり。引数つき・引数なしの2本
  server.registerTool(
    "novel.scan",
    { title: "走査", description: "試験用", inputSchema: { folder: z.string() } },
    ({ folder }) => ({ content: [{ type: "text", text: `scan:${folder}` }] })
  );
  server.registerTool("mcp.version", { title: "版", description: "試験用" }, () => ({
    content: [{ type: "text", text: "v" }],
  }));
  if (withSkills) registerSkills(server, body);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "skl-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientSide);
  openClients.push(client);
  return client;
}

const AnyResult = z.object({}).passthrough();

async function rawRequest(
  client: Client,
  method: string,
  params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return (await client.request(
    params === undefined ? { method } : { method, params },
    AnyResult
  )) as Record<string, unknown>;
}

async function requestError(
  client: Client,
  method: string,
  params?: Record<string, unknown>
): Promise<McpError> {
  try {
    await rawRequest(client, method, params);
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error("失敗するはずの呼び出しが通りました");
}

describe("拡張を知らない相手（これまでの道を壊さない）", () => {
  test("tools/list の中身が、スキルを足す前と変わらない", async () => {
    const before = await (await connect(false)).listTools();
    const after = await (await connect(true)).listTools();
    expect(after).toEqual(before);
  });

  test("これまでの道具はこれまでどおり呼べる", async () => {
    const client = await connect(true);
    const result = await client.callTool({ name: "novel.scan", arguments: { folder: "作品" } });
    expect(result.content).toEqual([{ type: "text", text: "scan:作品" }]);
  });

  test("initialize の応答に、拡張の宣言と resources の宣言が載る", async () => {
    const client = await connect(true);
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
    // 拡張を宣言するなら resources も宣言する（仕様の MUST）
    expect(capabilities?.resources).toBeDefined();
    // 道具の宣言はそのまま
    expect(capabilities?.tools).toBeDefined();
  });

  test("リソースの一覧には SKILL.md だけが並ぶ", async () => {
    const client = await connect(true);
    const listed = await client.listResources();
    expect(listed.resources.map((entry) => entry.uri)).toEqual([SKILL_URI]);
    const [entry] = listed.resources;
    expect(entry.name).toBe("novel-assist");
    expect(entry.mimeType).toBe("text/markdown");
    expect(entry.description).toBe(parseSkillFrontmatter(buildNovelAssistSkill(body).text).description);
  });
});

describe("skills/list・skills/get", () => {
  test("skills/list の形", async () => {
    const client = await connect(true);
    const listed = await rawRequest(client, "skills/list", {});
    expect(listed.resultType).toBe("complete");
    expect(listed.ttlMs).toBe(300000);
    expect(listed.cacheScope).toBe("public");
    expect(listed.nextCursor).toBeUndefined();
    const skills = listed.skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0].uri).toBe(SKILL_URI);
  });

  test("params を省いても skills/list は答える", async () => {
    const client = await connect(true);
    const listed = await rawRequest(client, "skills/list");
    expect((listed.skills as unknown[]).length).toBe(1);
  });

  test("こちらが出していない cursor は -32602", async () => {
    const client = await connect(true);
    const error = await requestError(client, "skills/list", { cursor: "どこか" });
    expect(error.code).toBe(-32602);
  });

  test("digest と size が resources/read の本文のバイトと一致する", async () => {
    const client = await connect(true);
    const listed = await rawRequest(client, "skills/list", {});
    const [skill] = listed.skills as Array<{
      resources: Array<{ uri: string; digest: string; size: number }>;
    }>;
    // SKILL.md を含む全ファイルを1度ずつ
    expect(skill.resources.map((file) => file.uri)).toEqual([SKILL_URI]);
    for (const file of skill.resources) {
      const read = await client.readResource({ uri: file.uri });
      expect(read.contents).toHaveLength(1);
      const content = read.contents[0];
      expect(content.mimeType).toBe("text/markdown");
      const text = "text" in content ? content.text : "";
      const bytes = Buffer.from(text, "utf8");
      expect(file.size).toBe(bytes.length);
      // 自前の SHA-256 ではなく Node の crypto で検算する（同じ部品で検算しない）
      expect(file.digest).toBe(`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`);
      expect(file.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("skills/get は skills/list と同じ1件を返す", async () => {
    const client = await connect(true);
    const listed = await rawRequest(client, "skills/list", {});
    const got = await rawRequest(client, "skills/get", { uri: SKILL_URI });
    expect(got.resultType).toBe("complete");
    expect(got.ttlMs).toBe(300000);
    expect(got.cacheScope).toBe("public");
    expect(got.skill).toEqual((listed.skills as unknown[])[0]);
  });

  test("知らない URI は -32602", async () => {
    const client = await connect(true);
    const error = await requestError(client, "skills/get", { uri: "skill://ほか/SKILL.md" });
    expect(error.code).toBe(-32602);
  });

  test("uri を渡さなければ -32602", async () => {
    const client = await connect(true);
    const error = await requestError(client, "skills/get", {});
    expect(error.code).toBe(-32602);
  });
});

describe("配る本文", () => {
  test("作品へ書き出す Claude Code 用の SKILL.md と同じ文から作る", () => {
    const { text } = buildNovelAssistSkill(body);
    expect(text).toBe(buildAiInstructionDocument(findAiInstructionTarget("claude-code"), body));
  });

  test("フロントマターを改変せずに全欄そのまま渡す", async () => {
    const client = await connect(true);
    const listed = await rawRequest(client, "skills/list", {});
    const [skill] = listed.skills as Array<{ frontmatter: Record<string, unknown> }>;
    const { text } = buildNovelAssistSkill(body);
    expect(skill.frontmatter).toEqual(parseSkillFrontmatter(text));
    expect(Object.keys(skill.frontmatter).sort()).toEqual(["description", "name"]);
    // 読み取った値を書き戻すと、元のフロントマターに戻る
    const rebuilt = `---\n${Object.entries(skill.frontmatter)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("\n")}\n---\n`;
    expect(text.startsWith(rebuilt)).toBe(true);
  });

  test("フロントマターの name が URI の最後の要素と一致し、英小文字とハイフンだけ", () => {
    const { text, skill } = buildNovelAssistSkill(body);
    const { name } = parseSkillFrontmatter(text);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const segments = skill.uri.replace(/^skill:\/\//, "").split("/");
    // URI は skill://<name>/SKILL.md。ファイル名を除いた最後の要素が name
    expect(segments[segments.length - 1]).toBe("SKILL.md");
    expect(segments[segments.length - 2]).toBe(name);
  });

  test("description が空でない", () => {
    const { description } = parseSkillFrontmatter(buildNovelAssistSkill(body).text);
    expect(description.length).toBeGreaterThan(20);
  });

  test("改行は LF に揃える（digest が機械の改行設定で変わらない）", () => {
    const { text } = buildNovelAssistSkill(body.replace(/\n/g, "\r\n"));
    expect(text).not.toContain("\r");
    expect(text).toBe(buildNovelAssistSkill(body).text);
  });

  test("フロントマターの形が崩れていたら読まずに止める", () => {
    expect(() => parseSkillFrontmatter("本文だけ")).toThrow();
    expect(() => parseSkillFrontmatter("---\nname novel-assist\n---\n本文")).toThrow();
    expect(() => parseSkillFrontmatter("---\nname: novel-assist\n")).toThrow();
  });

  test("上限（512ファイル・16MiB）に収まる", () => {
    const { skill } = buildNovelAssistSkill(body);
    expect(skill.resources.length).toBeLessThanOrEqual(512);
    const total = skill.resources.reduce((sum, file) => sum + file.size, 0);
    expect(total).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});

describe("束への配線", () => {
  const server = fs.readFileSync(path.join(root, "src", "mcp", "server.ts"), "utf8");
  const esbuild = fs.readFileSync(path.join(root, "esbuild.js"), "utf8");

  test("server.ts は docs の雛形を埋め込んで registerSkills へ渡す（写しを持たない）", () => {
    expect(server).toContain(`from "../../${AI_INSTRUCTION_TEMPLATE_PATH}"`);
    expect(server).toMatch(/registerSkills\(server, \w+\)/);
  });

  test("MCP の束だけが .md を文字列として読む", () => {
    expect(esbuild).toMatch(/loader:\s*\{\s*"\.md":\s*"text"\s*\}/);
  });
});
