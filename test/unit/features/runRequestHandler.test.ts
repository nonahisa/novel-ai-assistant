import { describe, expect, test, vi } from "vitest";
import {
  handleRunRequest,
  type RunOutcome,
  type RunRequestHandlerDeps,
  type RunWork,
} from "../../../src/features/runRequestHandler";
import {
  RUN_CONFIRM_MS,
  RUN_MAX_BODY_CHARS,
  RUN_MAX_PER_HOUR,
  buildRunUri,
  type RunStateRecord,
  type RunTicket,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";
import { ReaderStatsHelperLink } from "../../../src/features/readerStatsHelperLink";
import { readerStatsUriAction } from "../../../src/core/readerStatsHelperLink";

/**
 * 外部AIから頼まれた実行を受ける側（設計書6.87.22）。
 *
 * - 合言葉が合わない・使い回し・期限切れ・白名簿の外・許可が無い作品は、
 *   **確認も出さずに断る**
 * - 通った依頼は**毎回作者に確かめてから**走らせ、結果を保管庫へ書く
 */

const ID = "0123456789abcdef";
const TOKEN = "c".repeat(64);
const NOW = Date.parse("2026-09-25T10:00:00+09:00");
const WORK: RunWork = { id: "w1", title: "星の町", folderPath: "C:\\作品\\星の町" };

function ticket(overrides: Partial<RunTicket> = {}): RunTicket {
  return {
    version: 1,
    id: ID,
    tokenHash: sha256Text(TOKEN),
    feature: "typo",
    folder: WORK.folderPath,
    client: "claude-code",
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function queryOf(id = ID, token = TOKEN): string {
  const uri = buildRunUri(id, token);
  return uri.slice(uri.indexOf("?") + 1);
}

const DONE: RunOutcome = {
  ok: true,
  promptVersion: "9.9",
  findings: [{ filePath: "本文/第1話.txt", line: 3, original: "誤時", suggestion: "誤字" }],
  dropped: { count: 2, notes: ["本文と合わない指摘 2件"] },
  failures: { count: 0, notes: [] },
  cancelled: false,
};

/** 状態のファイルを記憶の中に持つ作り物。**作ったか・書いたか**を後から見る */
function deps(
  overrides: Partial<RunRequestHandlerDeps> = {},
  options: { ticket?: RunTicket | undefined; states?: RunStateRecord[] } = {}
) {
  const store = new Map<string, RunStateRecord>();
  const history: RunStateRecord[] = [];
  const t = "ticket" in options ? options.ticket : ticket();
  const d: RunRequestHandlerDeps = {
    isWeb: () => false,
    now: () => NOW + 1000,
    hash: sha256Text,
    readTicket: vi.fn(async (id: string) => (t && t.id === id ? t : undefined)),
    claim: vi.fn(async (state: RunStateRecord) => {
      if (store.has(state.id)) return false;
      store.set(state.id, state);
      history.push(state);
      return true;
    }),
    writeState: vi.fn(async (state: RunStateRecord) => {
      store.set(state.id, state);
      history.push(state);
    }),
    listStates: vi.fn(async () => options.states ?? []),
    findWork: (folder: string) => (folder === WORK.folderPath ? WORK : undefined),
    isAllowed: vi.fn(async () => true),
    resolveAi: () => ({ providerId: "ollama", providerName: "Ollama", model: "gemma", paid: false }),
    measure: vi.fn(async () => ({
      ok: true as const,
      bodyChars: 4000,
      episodeCount: 1,
      filePaths: ["C:\\作品\\星の町\\本文\\第1話.txt"],
      targetLabel: "第1話.txt",
    })),
    confirm: vi.fn(async () => true),
    run: vi.fn(async () => DONE),
    describeFailure: (error: unknown) => ({
      reason: error instanceof Error ? error.message : String(error),
      errorKind: "insufficient_credit",
      nextAction: "請求画面でクレジットを購入してください。",
    }),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
  return { d, store, history };
}

describe("確認も出さずに断る", () => {
  test("合言葉が合わない（ウェブのリンクから開かされた）", async () => {
    const { d, store } = deps();
    await handleRunRequest(queryOf(ID, "d".repeat(64)), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    // **札の状態に触れない**——依頼番号だけ当てた誰かに、正しい依頼を潰させない
    expect(store.size).toBe(0);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  test("札の無い依頼番号", async () => {
    const { d, store } = deps({}, { ticket: undefined });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  test("合言葉の使い回し（同じ URI を2度開かれた）", async () => {
    const { d } = deps();
    await handleRunRequest(queryOf(), d);
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.warn).mock.calls.at(-1)?.[0]).toContain("1回しか使えません");
  });

  test("期限を過ぎて届いた合言葉は、期限切れとして返す", async () => {
    const { d, store } = deps({ now: () => NOW + 11 * 60_000 });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("expired");
  });

  test("白名簿の外の機能", async () => {
    const { d, store } = deps({}, { ticket: ticket({ feature: "apply" as never }) });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("外部AIの許可の印が無い作品", async () => {
    const { d, store } = deps({ isAllowed: vi.fn(async () => false) });
    await handleRunRequest(queryOf(), d);
    expect(d.isAllowed).toHaveBeenCalledWith(WORK, "claude-code");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
    expect(store.get(ID)?.nextAction).toContain("外部AI許可");
  });

  test("登録されていない作品", async () => {
    const { d, store } = deps({}, { ticket: ticket({ folder: "C:\\ほかの場所" }) });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("1時間に走らせた回数が上限に届いている", async () => {
    const started = new Date(NOW - 60_000).toISOString();
    const states = Array.from({ length: RUN_MAX_PER_HOUR }, (_, index) => ({
      version: 1 as const,
      id: `${index}`.padStart(16, "0"),
      state: "done" as const,
      at: started,
      startedAt: started,
    }));
    const { d, store } = deps({}, { states });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("使うAIが設定されていない", async () => {
    const { d, store } = deps({ resolveAi: () => undefined });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.nextAction).toContain("AI設定");
  });

  test("1回の依頼の字数の上限を超える", async () => {
    const { d, store } = deps({
      measure: vi.fn(async () => ({
        ok: true as const,
        bodyChars: RUN_MAX_BODY_CHARS + 1,
        episodeCount: 300,
        filePaths: [],
        targetLabel: "作品全体（300話）",
      })),
    });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("ブラウザ版では理由を出して断る", async () => {
    const { d, store } = deps({ isWeb: () => true });
    await handleRunRequest(queryOf(), d);
    expect(d.readTicket).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(vi.mocked(d.warn).mock.calls[0]?.[0]).toContain("ブラウザ版");
  });
});

describe("毎回作者に確かめてから走らせる", () => {
  test("確認に依頼の中身を全部並べる", async () => {
    const { d } = deps({
      resolveAi: () => ({
        providerId: "cloud",
        providerName: "作り物のクラウドAI",
        model: "big-1",
        paid: true,
      }),
    });
    await handleRunRequest(queryOf(), d);
    const [message, detail] = vi.mocked(d.confirm).mock.calls[0] ?? ["", ""];
    expect(message).toContain("誤字脱字の検知");
    for (const expected of ["claude-code", "星の町", "第1話.txt", "作り物のクラウドAI", "big-1", "4,000字", "トークンを消費"]) {
      expect(detail).toContain(expected);
    }
  });

  test("走らせた結果（検算済み）を、使ったAI・モデル・プロンプトの版と一緒に書く", async () => {
    const { d, store, history } = deps();
    await handleRunRequest(queryOf(), d);
    expect(d.run).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "typo" }),
      WORK,
      ["C:\\作品\\星の町\\本文\\第1話.txt"]
    );
    expect(history.map((entry) => entry.state)).toEqual(["confirming", "running", "done"]);
    const done = store.get(ID);
    expect(done?.result?.provider).toEqual({ id: "ollama", name: "Ollama", paid: false });
    expect(done?.result?.model).toBe("gemma");
    expect(done?.result?.promptVersion).toBe("9.9");
    expect(done?.result?.dropped.count).toBe(2);
    expect(done?.result?.findings).toHaveLength(1);
    expect(done?.startedAt).toBeDefined();
  });

  test("結果に鍵らしきものを入れない（プロバイダは名前とIDだけ）", async () => {
    const { d, store } = deps();
    await handleRunRequest(queryOf(), d);
    const text = JSON.stringify(store.get(ID));
    expect(text).not.toMatch(/apiKey|secret|token/iu);
  });

  test("作者が断ったら走らせない", async () => {
    const { d, store } = deps({ confirm: vi.fn(async () => false) });
    await handleRunRequest(queryOf(), d);
    expect(d.run).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("declined");
  });

  test("確認が出たまま期限を過ぎてから押されたら走らせない", async () => {
    let clock = NOW + 1000;
    const { d, store } = deps({
      now: () => clock,
      confirm: vi.fn(async () => {
        clock = NOW + RUN_CONFIRM_MS + 1;
        return true;
      }),
    });
    await handleRunRequest(queryOf(), d);
    expect(d.run).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("expired");
  });

  test("AIの失敗は、種別と次の操作を1つ書く", async () => {
    const { d, store } = deps({
      run: vi.fn(async () => {
        throw new Error("残高がありません");
      }),
    });
    await handleRunRequest(queryOf(), d);
    const failed = store.get(ID);
    expect(failed?.state).toBe("failed");
    expect(failed?.errorKind).toBe("insufficient_credit");
    expect(failed?.nextAction).toContain("クレジット");
  });

  test("走り始められなかった（前提が無いなど）は、理由を書く", async () => {
    const { d, store } = deps({
      run: vi.fn(async () => ({ ok: false as const, reason: "プロットがまだ無いため" })),
    });
    await handleRunRequest(queryOf(), d);
    expect(store.get(ID)?.state).toBe("failed");
    expect(store.get(ID)?.reason).toContain("プロット");
  });

  test("途中で作者が止めたら「断った」として返す", async () => {
    const { d, store } = deps({ run: vi.fn(async () => ({ ...DONE, cancelled: true })) });
    await handleRunRequest(queryOf(), d);
    expect(store.get(ID)?.state).toBe("declined");
    expect(store.get(ID)?.result).toBeUndefined();
  });
});

describe("受け口", () => {
  test("/run のパスを見分けて渡す", async () => {
    expect(readerStatsUriAction("/run")).toBe("run");
    const handle = vi.fn(async () => undefined);
    const link = new ReaderStatsHelperLink({
      listWorks: () => [],
      memory: { get: () => undefined, update: async () => undefined } as never,
      afterImport: async () => undefined,
      handleRunRequest: handle,
    } as never);
    await link.handleUri({ path: "/run", query: queryOf() });
    expect(handle).toHaveBeenCalledWith(queryOf());
  });
});
