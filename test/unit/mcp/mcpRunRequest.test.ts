import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  RUN_REQUEST_INPUT,
  runRequest,
  runResult,
  type RunRequestDeps,
} from "../../../src/mcp/tools/runRequest";
import { exposureOf, setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { McpToolError } from "../../../src/mcp/tools/shared";
import {
  RUN_ARRIVAL_MS,
  RUN_REQUEST_DIRECTORY,
  formatRunState,
  parseRunQuery,
  parseRunTicket,
  runStateFileName,
  runTicketFileName,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";

/**
 * MCP の `run.request`・`run.result`（設計書6.87.22）。
 *
 * - 札は**保管庫**に置き、作品フォルダーには何も書かない
 * - 札には合言葉のハッシュだけ。合言葉は URI にだけ載る
 * - `run.result` は依頼番号で状態か結果を返す。**別の作品・別の接続元には返さない**
 */

const root = nodePath.join(__dirname, "../../..");
const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");
const NOW = Date.parse("2026-09-25T10:00:00+09:00");

let temp: string;
let storage: string;
let work: string;

function listRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRecursive(full));
    else out.push(full);
  }
  return out;
}

function deps(overrides: Partial<RunRequestDeps> = {}): RunRequestDeps & { opened: string[] } {
  const opened: string[] = [];
  let counter = 0;
  return {
    opened,
    open: async (uri) => {
      opened.push(uri);
    },
    now: () => NOW,
    random: (bytes) => {
      counter += 1;
      return String(counter).repeat(bytes * 2).slice(0, bytes * 2).replace(/[^0-9a-f]/gu, "0");
    },
    storageRoot: () => storage,
    clientName: () => "claude-code",
    ...overrides,
  };
}

beforeEach(() => {
  temp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-run-"));
  storage = nodePath.join(temp, "globalStorage");
  work = nodePath.join(temp, "作品", "星の町");
  fs.mkdirSync(nodePath.join(work, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(work, "本文", "第1話.txt"), "本文です。");
  setExternalClientName("claude-code");
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("run.request", () => {
  test("札を保管庫に置き、作品フォルダーには何も書かない", async () => {
    const before = listRecursive(work);
    const d = deps();
    const result = await runRequest({ folder: work, feature: "typo" }, d);
    expect(listRecursive(work)).toEqual(before);
    const ticketPath = nodePath.join(storage, RUN_REQUEST_DIRECTORY, runTicketFileName(result.requestId));
    expect(fs.existsSync(ticketPath)).toBe(true);
    expect(result.status).toBe("waiting");
    expect(result.opened).toBe(true);
  });

  test("URI の合言葉は札のハッシュと合い、札には合言葉そのものが無い", async () => {
    const d = deps();
    const result = await runRequest({ folder: work, feature: "proofread", file: "本文\\第1話.txt" }, d);
    const uri = d.opened[0] ?? "";
    expect(uri.startsWith("vscode://nonahisa.novel-ai-assistant/run?")).toBe(true);
    const query = parseRunQuery(uri.slice(uri.indexOf("?") + 1));
    expect(query.ok).toBe(true);
    const text = fs.readFileSync(
      nodePath.join(storage, RUN_REQUEST_DIRECTORY, runTicketFileName(result.requestId)),
      "utf8"
    );
    const ticket = parseRunTicket(text);
    expect(query.ok && ticket?.tokenHash).toBe(query.ok ? sha256Text(query.token) : "");
    expect(query.ok && text.includes(query.token)).toBe(false);
    expect(ticket?.feature).toBe("proofread");
    expect(ticket?.file).toBe("本文\\第1話.txt");
    expect(ticket?.client).toBe("claude-code");
  });

  test("白名簿の外は、開く前に断る", async () => {
    const d = deps();
    await expect(runRequest({ folder: work, feature: "settings" }, d)).rejects.toBeInstanceOf(McpToolError);
    expect(d.opened).toHaveLength(0);
  });

  test("作品フォルダーの外を指す file は断る", async () => {
    const d = deps();
    await expect(
      runRequest({ folder: work, feature: "typo", file: "..\\..\\秘密.txt" }, d)
    ).rejects.toBeInstanceOf(McpToolError);
    expect(d.opened).toHaveLength(0);
  });

  test("返事の無い依頼を重ねさせない", async () => {
    const d = deps();
    await runRequest({ folder: work, feature: "typo" }, d);
    await runRequest({ folder: work, feature: "typo" }, d);
    await expect(runRequest({ folder: work, feature: "typo" }, d)).rejects.toThrow(/返事を待っている/u);
  });

  test("開けなくても行き止まりにしない（URI を返す）", async () => {
    const d = deps({
      open: async () => {
        throw new Error("開けません");
      },
    });
    const result = await runRequest({ folder: work, feature: "typo" }, d);
    expect(result.opened).toBe(false);
    expect(result.uri).toContain("/run?");
  });

  test("7日より古い札と結果は片付ける", async () => {
    const d = deps({ now: () => NOW - 8 * 86_400_000 });
    const old = await runRequest({ folder: work, feature: "typo" }, d);
    const dir = nodePath.join(storage, RUN_REQUEST_DIRECTORY);
    fs.writeFileSync(
      nodePath.join(dir, runStateFileName(old.requestId)),
      formatRunState({ version: 1, id: old.requestId, state: "done", at: new Date(NOW - 8 * 86_400_000).toISOString() })
    );
    await runRequest({ folder: work, feature: "typo" }, deps({ random: (bytes) => "e".repeat(bytes * 2) }));
    expect(fs.existsSync(nodePath.join(dir, runTicketFileName(old.requestId)))).toBe(false);
    expect(fs.existsSync(nodePath.join(dir, runStateFileName(old.requestId)))).toBe(false);
  });
});

describe("run.result", () => {
  async function requested(): Promise<string> {
    return (await runRequest({ folder: work, feature: "typo" }, deps())).requestId;
  }
  function writeState(id: string, state: Record<string, unknown>): void {
    fs.writeFileSync(
      nodePath.join(storage, RUN_REQUEST_DIRECTORY, runStateFileName(id)),
      JSON.stringify({ version: 1, id, at: new Date(NOW).toISOString(), ...state })
    );
  }

  test("まだ受け取られていない → waiting、期限を過ぎたら expired", async () => {
    const id = await requested();
    expect(runResult({ folder: work, requestId: id }, deps()).status).toBe("waiting");
    expect(
      runResult({ folder: work, requestId: id }, deps({ now: () => NOW + RUN_ARRIVAL_MS + 1 })).status
    ).toBe("expired");
  });

  test("作者の確認待ち・実行中・断られた", async () => {
    const id = await requested();
    writeState(id, { state: "confirming" });
    expect(runResult({ folder: work, requestId: id }, deps()).status).toBe("confirming");
    writeState(id, { state: "running" });
    expect(runResult({ folder: work, requestId: id }, deps()).status).toBe("running");
    writeState(id, { state: "declined" });
    expect(runResult({ folder: work, requestId: id }, deps()).status).toBe("declined");
    writeState(id, { state: "refused", reason: "許可がありません。", nextAction: "許可する" });
    const refused = runResult({ folder: work, requestId: id }, deps());
    expect(refused.status).toBe("refused");
    expect(refused.nextAction).toBe("許可する");
    expect(refused.result).toBeUndefined();
  });

  test("走り終えたら結果を返す", async () => {
    const id = await requested();
    const result = { feature: "typo", model: "gemma", promptVersion: "1.0", findings: [{ line: 1 }] };
    writeState(id, { state: "done", result });
    const read = runResult({ folder: work, requestId: id }, deps());
    expect(read.status).toBe("done");
    expect(read.result).toEqual(result);
  });

  test("失敗は種別と次の操作を返す", async () => {
    const id = await requested();
    writeState(id, { state: "failed", reason: "残高", errorKind: "insufficient_credit", nextAction: "購入" });
    const read = runResult({ folder: work, requestId: id }, deps());
    expect(read).toMatchObject({ status: "failed", errorKind: "insufficient_credit", nextAction: "購入" });
  });

  test("別の作品・別の接続元には返さない", async () => {
    const id = await requested();
    const other = nodePath.join(temp, "作品", "別");
    fs.mkdirSync(other, { recursive: true });
    expect(() => runResult({ folder: other, requestId: id }, deps())).toThrow(McpToolError);
    expect(() =>
      runResult({ folder: work, requestId: id }, deps({ clientName: () => "someone-else" }))
    ).toThrow(McpToolError);
  });

  test("知らない依頼番号・形の合わない番号", () => {
    expect(() => runResult({ folder: work, requestId: "0000000000000000" }, deps())).toThrow(/見つかりません/u);
    expect(() => runResult({ folder: work, requestId: "../x" }, deps())).toThrow(McpToolError);
  });
});

describe("門番と記録", () => {
  test("許可の印が無い作品では、どちらの道具も門番で断られる", () => {
    expect(() => assertExternalAccessAllowed({ folder: work, feature: "typo" }, "run.request")).toThrow();
    expect(() => assertExternalAccessAllowed({ folder: work, requestId: "x" }, "run.result")).toThrow();
  });

  test("run.request を許せば、run.result も同じ鍵で通る", () => {
    fs.mkdirSync(nodePath.join(work, ".aiwriter"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(work, ".aiwriter", "external-access.json"),
      JSON.stringify({
        schemaVersion: "2",
        clients: [{ name: "claude-code", tools: ["run.request"], sampling: false, decidedAt: "" }],
      })
    );
    expect(() => assertExternalAccessAllowed({ folder: work, feature: "typo" }, "run.request")).not.toThrow();
    expect(() => assertExternalAccessAllowed({ folder: work, requestId: "x" }, "run.result")).not.toThrow();
    // 機能（typo）の許可とは別——novel.run の typo は通らない
    expect(() =>
      assertExternalAccessAllowed({ folder: work, feature: "typo", runner: "ollama" }, "novel.run")
    ).toThrow();
  });

  test("原稿の出方：頼むだけなら出ない、結果は抜粋", () => {
    expect(exposureOf("run.request", { feature: "typo" })).toBe("none");
    expect(exposureOf("run.result", { requestId: "x" })).toBe("excerpt");
  });

  test("サーバーに2本とも登録されている", () => {
    expect(server).toContain('registerTool(\n  "run.request"');
    expect(server).toContain('tool("run.request"');
    expect(server).toContain('registerTool(\n  "run.result"');
    expect(server).toContain('tool("run.result"');
  });

  test("合言葉は引数で受けない（呼び出し元に選ばせない）", () => {
    // 呼び出し元に合言葉を選ばせると、ウェブページも同じ値で URI を作れる
    expect(Object.keys(RUN_REQUEST_INPUT).sort()).toEqual(["feature", "file", "folder"]);
  });
});
