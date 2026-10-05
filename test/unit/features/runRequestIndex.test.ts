import { describe, expect, test, vi } from "vitest";
import {
  handleRunRequest,
  type RunIndexDeps,
  type RunRequestHandlerDeps,
  type RunWork,
} from "../../../src/features/runRequestHandler";
import {
  buildRunUri,
  parseRunTicket,
  formatRunTicket,
  runStatusOf,
  type RunIndexRow,
  type RunStateRecord,
  type RunTicket,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";

/**
 * 外部AIから頼まれた索引づくり（設計書6.87.23。0.99.19）。
 *
 * - 合言葉・1回限り・許可・回数の上限は、ほかの機能と同じ道を通る
 * - **全作品でも作品ごとに許可を確かめ**、無い作品は回さずに理由を並べる
 * - 1作品の失敗・途中の中止でも、結果（作品ごとの行）は返る
 */

const ID = "0123456789abcdef";
const TOKEN = "c".repeat(64);
const NOW = Date.parse("2026-10-05T10:00:00+09:00");
const A: RunWork = { id: "a", title: "星の町", folderPath: "C:\\作品\\星の町" };
const B: RunWork = { id: "b", title: "海の駅", folderPath: "C:\\作品\\海の駅" };
const C: RunWork = { id: "c", title: "森の家", folderPath: "C:\\作品\\森の家" };

function ticket(overrides: Partial<RunTicket> = {}): RunTicket {
  return {
    version: 1,
    id: ID,
    tokenHash: sha256Text(TOKEN),
    feature: "vectorIndex",
    folder: A.folderPath,
    client: "claude-code",
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function queryOf(): string {
  const uri = buildRunUri(ID, TOKEN);
  return uri.slice(uri.indexOf("?") + 1);
}

function rowOf(work: RunWork, status: RunIndexRow["status"], reason?: string): RunIndexRow {
  return {
    workTitle: work.title,
    folder: work.folderPath,
    status,
    ...(status === "done" ? { built: 3, reused: 10, removed: 0, total: 13, failedScenes: 0, bytes: 100 } : {}),
    seconds: 1.5,
    ...(reason ? { reason } : {}),
  };
}

function setup(
  t: RunTicket,
  options: {
    allowed?: (work: RunWork) => boolean;
    index?: Partial<RunIndexDeps>;
  } = {}
) {
  const store = new Map<string, RunStateRecord>();
  const index: RunIndexDeps = {
    enabled: () => true,
    model: () => "bge-m3",
    listWorks: () => [A, B, C],
    check: vi.fn(async () => ({ ok: true as const })),
    build: vi.fn(async (works: RunWork[]) => works.map((work) => rowOf(work, "done"))),
    ...options.index,
  };
  const d: RunRequestHandlerDeps = {
    isWeb: () => false,
    now: () => NOW + 1000,
    hash: sha256Text,
    readTicket: async (id) => (id === t.id ? t : undefined),
    claim: async (state) => {
      if (store.has(state.id)) return false;
      store.set(state.id, state);
      return true;
    },
    writeState: async (state) => {
      store.set(state.id, state);
    },
    listStates: async () => [],
    findWork: (folder) => [A, B, C].find((work) => work.folderPath === folder),
    isAllowed: vi.fn(async (work: RunWork) => (options.allowed ? options.allowed(work) : true)),
    resolveAi: () => undefined,
    measure: vi.fn(async () => ({ ok: false as const, reason: "呼ばれないはず" })),
    confirm: vi.fn(async () => true),
    run: vi.fn(),
    describeFailure: (error) => ({ reason: error instanceof Error ? error.message : String(error) }),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    index,
  };
  return { d, store, index };
}

describe("索引づくりの依頼", () => {
  test("1作品：確認を出し、作品ごとの行を結果へ書く（AIの割当も送る量の上限も見ない）", async () => {
    const { d, store, index } = setup(ticket());
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.confirm).mock.calls[0][1].split("\n")[0]).toBe("作品：星の町");
    expect(d.measure).not.toHaveBeenCalled();
    expect(index.build).toHaveBeenCalledWith([A]);
    const state = store.get(ID);
    expect(state?.state).toBe("done");
    expect(state?.result?.feature).toBe("vectorIndex");
    expect(state?.result?.provider.paid).toBe(false);
    expect(state?.result?.model).toBe("bge-m3");
    expect(state?.result?.findings).toHaveLength(1);
  });

  test("全作品：許可の無い作品は回さず、理由つきで並べる", async () => {
    const { d, store, index } = setup(ticket({ scope: "all" }), {
      allowed: (work) => work.id !== "b",
    });
    await handleRunRequest(queryOf(), d);
    expect(index.build).toHaveBeenCalledWith([A, C]);
    const findings = store.get(ID)?.result?.findings as RunIndexRow[];
    expect(findings.map((row) => [row.workTitle, row.status])).toEqual([
      ["星の町", "done"],
      ["森の家", "done"],
      ["海の駅", "skipped"],
    ]);
    expect(findings[2].reason).toContain("許可");
    expect(vi.mocked(d.confirm).mock.calls[0][1]).toContain("回さない作品：海の駅");
  });

  test("1作品の失敗と途中の中止は、行に残して結果は done で返す", async () => {
    const { d, store } = setup(ticket({ scope: "all" }), {
      index: {
        build: vi.fn(async () => [
          rowOf(A, "done"),
          rowOf(B, "failed", "Ollamaに接続できません"),
          rowOf(C, "cancelled", "中止したため回していません"),
        ]),
      },
    });
    await handleRunRequest(queryOf(), d);
    const result = store.get(ID)?.result;
    expect(store.get(ID)?.state).toBe("done");
    expect(result?.failures.count).toBe(1);
    expect(result?.failures.notes.join("\n")).toContain("海の駅：Ollamaに接続できません");
    expect(result?.failures.notes.join("\n")).toContain("途中で止めました");
  });

  test("意味検索が切なら、確認を出さずに断る（次の操作つき）", async () => {
    const { d, store } = setup(ticket(), { index: { enabled: () => false } });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
    expect(store.get(ID)?.nextAction).toContain("ベクトル検索準備");
  });

  test("Ollama で埋め込めなければ、確認を出さずに断る", async () => {
    const { d, store } = setup(ticket(), {
      index: { check: async () => ({ ok: false, reason: "Ollamaに接続できません。", nextAction: "Ollamaを起動してください。" }) },
    });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.nextAction).toBe("Ollamaを起動してください。");
  });

  test("依頼の持ち主の作品に許可が無ければ、全作品でも断る", async () => {
    const { d, store, index } = setup(ticket({ scope: "all" }), { allowed: (work) => work.id !== "a" });
    await handleRunRequest(queryOf(), d);
    expect(store.get(ID)?.state).toBe("refused");
    expect(index.build).not.toHaveBeenCalled();
  });

  test("作者が断れば declined", async () => {
    const { d, store, index } = setup(ticket());
    vi.mocked(d.confirm).mockResolvedValue(false);
    await handleRunRequest(queryOf(), d);
    expect(store.get(ID)?.state).toBe("declined");
    expect(index.build).not.toHaveBeenCalled();
  });
});

describe("札の範囲（scope）", () => {
  test("索引づくりの all は読める。ほかの機能に付いた範囲は読まない", () => {
    expect(parseRunTicket(formatRunTicket(ticket({ scope: "all" })))?.scope).toBe("all");
    expect(parseRunTicket(formatRunTicket(ticket({ feature: "typo", scope: "all" })))).toBeUndefined();
    const bad = { ...ticket(), scope: "everything" };
    expect(parseRunTicket(JSON.stringify(bad))).toBeUndefined();
  });

  test("done の一言は索引づくり向け", () => {
    const view = runStatusOf(ticket(), { version: 1, id: ID, state: "done", at: new Date(NOW).toISOString() }, NOW);
    expect(view.message).toContain("novel.search");
  });
});
