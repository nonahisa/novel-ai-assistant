import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { runRequest, runResult, type RunRequestDeps } from "../../../src/mcp/tools/runRequest";
import {
  handleRunRequest,
  type RunRequestHandlerDeps,
  type RunWork,
} from "../../../src/features/runRequestHandler";
import {
  RUN_REQUEST_DIRECTORY,
  formatRunState,
  parseRunState,
  parseRunTicket,
  runIdOfFileName,
  runStateFileName,
  runTicketFileName,
  type RunStateRecord,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";

/**
 * MCP（`run.request`・`run.result`）と拡張機能の受け口を、**同じ保管庫の上で**
 * つないで通す（設計書6.87.22）。
 *
 * 片側ずつの試験では、札の形・ファイルの名前・合言葉のハッシュの取り方が
 * 両側で食い違っても気づけない。ここでは MCP が書いた札を受け口がそのまま読み、
 * 受け口が書いた結果を MCP がそのまま読む。
 *
 * **結果の置き場が作品の外であること**もここで見る（作品フォルダーには1つも増えない）。
 */

const NOW = Date.parse("2026-09-25T10:00:00+09:00");
let temp: string;
let storage: string;
let workFolder: string;

function listRecursive(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = nodePath.join(dir, entry.name);
      return entry.isDirectory() ? listRecursive(full) : [full];
    });
}

function mcpDeps(): RunRequestDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    open: async (uri) => {
      opened.push(uri);
    },
    now: () => NOW,
    random: (bytes) =>
      Array.from({ length: bytes * 2 }, (_, index) => "0123456789abcdef"[(index * 7 + bytes) % 16]).join(""),
    storageRoot: () => storage,
    clientName: () => "claude-code",
  };
}

/** 受け口の手足を、本物と同じ置き場（保管庫の `run-requests/`）で作る */
function extensionDeps(overrides: Partial<RunRequestHandlerDeps> = {}): RunRequestHandlerDeps {
  const dir = (): string => nodePath.join(storage, RUN_REQUEST_DIRECTORY);
  const work: RunWork = { id: "w", title: "星の町", folderPath: workFolder };
  return {
    isWeb: () => false,
    now: () => NOW + 2000,
    hash: sha256Text,
    readTicket: async (id) => {
      try {
        return parseRunTicket(fs.readFileSync(nodePath.join(dir(), runTicketFileName(id)), "utf8"));
      } catch {
        return undefined;
      }
    },
    claim: async (state) => {
      try {
        fs.writeFileSync(nodePath.join(dir(), runStateFileName(state.id)), formatRunState(state), {
          flag: "wx",
        });
        return true;
      } catch {
        return false;
      }
    },
    writeState: async (state) => {
      fs.writeFileSync(nodePath.join(dir(), runStateFileName(state.id)), formatRunState(state));
    },
    listStates: async () =>
      fs
        .readdirSync(dir())
        .filter((name) => runIdOfFileName(name)?.kind === "state")
        .map((name) => parseRunState(fs.readFileSync(nodePath.join(dir(), name), "utf8")))
        .filter((state): state is RunStateRecord => state !== undefined),
    findWork: (folder) => (nodePath.resolve(folder) === nodePath.resolve(workFolder) ? work : undefined),
    isAllowed: async () => true,
    resolveAi: () => ({ providerId: "ollama", providerName: "Ollama", model: "gemma4:e4b", paid: false }),
    measure: async () => ({
      ok: true,
      bodyChars: 5,
      episodeCount: 1,
      filePaths: [],
      targetLabel: "作品全体（1話）",
    }),
    confirm: vi.fn(async () => true),
    run: vi.fn(async () => ({
      ok: true as const,
      promptVersion: "1.0",
      findings: [{ filePath: "本文/第1話.txt", line: 1, original: "本分", suggestion: "本文" }],
      dropped: { count: 0, notes: [] },
      failures: { count: 0, notes: [] },
      cancelled: false,
    })),
    describeFailure: (error) => ({ reason: String(error) }),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  temp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-run-trip-"));
  storage = nodePath.join(temp, "globalStorage", "nonahisa.novel-ai-assistant");
  workFolder = nodePath.join(temp, "作品", "星の町");
  fs.mkdirSync(nodePath.join(workFolder, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(workFolder, "本文", "第1話.txt"), "本分です。");
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("頼む → 作者が確かめる → 走る → 読む", () => {
  test("MCP の札を受け口が読み、受け口の結果を MCP が読む", async () => {
    const before = listRecursive(workFolder);
    const mcp = mcpDeps();
    const requested = await runRequest({ folder: workFolder, feature: "typo" }, mcp);
    const uri = mcp.opened[0] ?? "";

    expect(runResult({ folder: workFolder, requestId: requested.requestId }, mcp).status).toBe("waiting");

    const ext = extensionDeps();
    await handleRunRequest(uri.slice(uri.indexOf("?") + 1), ext);
    expect(ext.confirm).toHaveBeenCalledTimes(1);
    expect(ext.run).toHaveBeenCalledTimes(1);

    const read = runResult({ folder: workFolder, requestId: requested.requestId }, mcp);
    expect(read.status).toBe("done");
    expect(read.result?.model).toBe("gemma4:e4b");
    expect(read.result?.provider.name).toBe("Ollama");
    expect(read.result?.findings).toHaveLength(1);

    // **作品フォルダーには1つも増えない**（結果は保管庫だけ）
    expect(listRecursive(workFolder)).toEqual(before);
    expect(
      fs.existsSync(nodePath.join(storage, RUN_REQUEST_DIRECTORY, runStateFileName(requested.requestId)))
    ).toBe(true);
  });

  test("合言葉を書き換えた URI では、確認も出さず、MCP 側は待ちのまま", async () => {
    const mcp = mcpDeps();
    const requested = await runRequest({ folder: workFolder, feature: "typo" }, mcp);
    const ext = extensionDeps();
    await handleRunRequest(`id=${requested.requestId}&token=${"f".repeat(64)}`, ext);
    expect(ext.confirm).not.toHaveBeenCalled();
    expect(runResult({ folder: workFolder, requestId: requested.requestId }, mcp).status).toBe("waiting");
  });

  test("作者が断れば、MCP 側に declined が返る", async () => {
    const mcp = mcpDeps();
    const requested = await runRequest({ folder: workFolder, feature: "synopsis" }, mcp);
    const uri = mcp.opened[0] ?? "";
    const ext = extensionDeps({ confirm: vi.fn(async () => false) });
    await handleRunRequest(uri.slice(uri.indexOf("?") + 1), ext);
    expect(ext.run).not.toHaveBeenCalled();
    expect(runResult({ folder: workFolder, requestId: requested.requestId }, mcp).status).toBe("declined");
  });
});
