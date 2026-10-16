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

describe("2026-10-16 に足した機能", () => {
  test("冒頭診断：送る量は measure が機能ごとに見積もる（機能を渡す）", async () => {
    const { d } = deps({}, { ticket: ticket({ feature: "opening" }) });
    await handleRunRequest(queryOf(), d);
    expect(d.measure).toHaveBeenCalledWith(WORK, undefined, expect.objectContaining({ feature: "opening" }));
    expect(d.run).toHaveBeenCalledWith(expect.objectContaining({ feature: "opening" }), WORK, expect.anything());
  });

  test("事実の照合：取り出しと判定の2つのAIを確認に並べ、結果にも両方を書く", async () => {
    const resolveAi = vi.fn((def: { assigned: string }) =>
      def.assigned === "contradiction"
        ? { providerId: "cloud", providerName: "判定のクラウドAI", model: "judge-1", paid: true }
        : { providerId: "ollama", providerName: "Ollama", model: "gemma", paid: false }
    );
    const { d, store } = deps({ resolveAi }, { ticket: ticket({ feature: "factContradiction" }) });
    await handleRunRequest(queryOf(), d);
    const [, detail] = vi.mocked(d.confirm).mock.calls[0] ?? ["", ""];
    expect(detail).toContain("Ollama（gemma）");
    expect(detail).toContain("判定のクラウドAI（judge-1）");
    // 判定のAIが有料なら、料金の断りを出す（取り出しが無料でも）
    expect(detail).toContain("トークンを消費");
    const result = store.get(ID)?.result;
    expect(result?.provider.name).toBe("Ollama");
    expect(result?.verifyProvider).toEqual({ id: "cloud", name: "判定のクラウドAI", paid: true });
    expect(result?.verifyModel).toBe("judge-1");
  });

  test("事実の照合：判定のAIが未設定なら断る", async () => {
    const { d, store } = deps(
      {
        resolveAi: (def) =>
          def.assigned === "contradiction"
            ? undefined
            : { providerId: "ollama", providerName: "Ollama", model: "gemma", paid: false },
      },
      { ticket: ticket({ feature: "factContradiction" }) }
    );
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("AI接続確認：本文を量らず、確認を出してから試し、繋がらなくても答えとして返す", async () => {
    const testAi = {
      resolve: vi.fn(() => ({ providerId: "cloud", providerName: "作り物のクラウドAI", model: "big-1", paid: true })),
      run: vi.fn(async () => ({
        ok: false,
        stage: "generate" as const,
        message: "残高がありません",
        errorKind: "insufficient_credit",
        nextAction: "請求画面でクレジットを購入してください。",
      })),
    };
    const { d, store, history } = deps({ testAi }, { ticket: ticket({ feature: "testAI" }) });
    await handleRunRequest(queryOf(), d);
    expect(d.measure).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    const [message, detail] = vi.mocked(d.confirm).mock.calls[0] ?? ["", ""];
    expect(message).toContain("AI接続確認");
    expect(detail).toContain("作り物のクラウドAI");
    expect(testAi.run).toHaveBeenCalledTimes(1);
    expect(history.map((entry) => entry.state)).toEqual(["confirming", "running", "done"]);
    const result = store.get(ID)?.result;
    expect(result?.feature).toBe("testAI");
    expect(result?.bodyChars).toBe(0);
    expect(result?.findings[0]).toMatchObject({ ok: false, errorKind: "insufficient_credit" });
  });

  test("AI接続確認：作者が断ったら試さない／AIが未設定なら確認も出さずに断る", async () => {
    const testAi = { resolve: vi.fn(() => undefined), run: vi.fn() };
    const first = deps({ testAi }, { ticket: ticket({ feature: "testAI" }) });
    await handleRunRequest(queryOf(), first.d);
    expect(first.d.confirm).not.toHaveBeenCalled();
    expect(first.store.get(ID)?.state).toBe("refused");

    const declined = {
      resolve: vi.fn(() => ({ providerId: "ollama", providerName: "Ollama", model: "gemma", paid: false })),
      run: vi.fn(),
    };
    const second = deps(
      { testAi: declined, confirm: vi.fn(async () => false) },
      { ticket: ticket({ feature: "testAI" }) }
    );
    await handleRunRequest(queryOf(), second.d);
    expect(declined.run).not.toHaveBeenCalled();
    expect(second.store.get(ID)?.state).toBe("declined");
  });

  test("AI接続確認：手足が無ければ断る", async () => {
    const { d, store } = deps({}, { ticket: ticket({ feature: "testAI" }) });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("書き出し：AIを使わず本文を量らず、確認を出してから作り、置いた場所を結果に入れる", async () => {
    const row = {
      format: "epub" as const,
      filePath: ".aiwriter/exports/星の町_20261016.epub",
      bytes: 12345,
      chapters: 19,
      conflicted: [],
      notices: [],
      cover: "焼いた表紙",
    };
    const exporter = {
      inspect: vi.fn(async () => ({ ok: true as const, episodeCount: 19 })),
      run: vi.fn(async () => ({ ok: true as const, row })),
    };
    const resolveAi = vi.fn();
    const { d, store, history } = deps(
      { export: exporter, resolveAi },
      { ticket: ticket({ feature: "exportEpub" }) }
    );
    await handleRunRequest(queryOf(), d);
    expect(d.measure).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    expect(resolveAi).not.toHaveBeenCalled();
    const [message, detail, button] = vi.mocked(d.confirm).mock.calls[0] ?? ["", "", ""];
    expect(message).toContain("EPUB");
    expect(detail).toContain("19話");
    expect(button).toBe("作る");
    expect(exporter.run).toHaveBeenCalledWith(WORK, "exportEpub");
    expect(history.map((entry) => entry.state)).toEqual(["confirming", "running", "done"]);
    const result = store.get(ID)?.result;
    expect(result?.feature).toBe("exportEpub");
    expect(result?.bodyChars).toBe(0);
    expect(result?.provider.paid).toBe(false);
    expect(result?.findings[0]).toEqual(row);
  });

  test("書き出し：作者が断ったら作らない／作れなかったら理由を返す／手足が無ければ断る", async () => {
    const exporter = {
      inspect: vi.fn(async () => ({ ok: true as const, episodeCount: 2 })),
      run: vi.fn(async () => ({ ok: false as const, reason: "本文が見つかりません" })),
    };
    const declined = deps(
      { export: exporter, confirm: vi.fn(async () => false) },
      { ticket: ticket({ feature: "exportPdf" }) }
    );
    await handleRunRequest(queryOf(), declined.d);
    expect(exporter.run).not.toHaveBeenCalled();
    expect(declined.store.get(ID)?.state).toBe("declined");

    const failed = deps({ export: exporter }, { ticket: ticket({ feature: "exportPdf" }) });
    await handleRunRequest(queryOf(), failed.d);
    expect(failed.store.get(ID)?.state).toBe("failed");
    expect(failed.store.get(ID)?.reason).toContain("本文が見つかりません");

    const missing = deps({}, { ticket: ticket({ feature: "exportPdf" }) });
    await handleRunRequest(queryOf(), missing.d);
    expect(missing.d.confirm).not.toHaveBeenCalled();
    expect(missing.store.get(ID)?.state).toBe("refused");
  });

  test("書き出し：本文が1つも無い作品は確認を出さずに断る", async () => {
    const exporter = {
      inspect: vi.fn(async () => ({ ok: false as const, reason: "本文のファイルが見つかりません。" })),
      run: vi.fn(),
    };
    const { d, store } = deps({ export: exporter }, { ticket: ticket({ feature: "exportPdf" }) });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(exporter.run).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
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
