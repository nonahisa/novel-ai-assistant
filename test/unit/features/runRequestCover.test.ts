import { describe, expect, test, vi } from "vitest";
import {
  handleRunRequest,
  type RunCoverDeps,
  type RunRequestHandlerDeps,
  type RunWork,
} from "../../../src/features/runRequestHandler";
import {
  buildRunUri,
  checkRunCover,
  formatRunTicket,
  parseRunTicket,
  runStatusOf,
  type RunCoverRow,
  type RunStateRecord,
  type RunTicket,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";

/**
 * 外部AIから頼まれた「表紙を焼く」（coverBake。設計書6.65.9・6.87.22。2026-10-15）。
 *
 * - 合言葉・1回限り・許可・回数の上限は、ほかの依頼と同じ道を通る
 * - **焼けない作品（元イラストが無い）は、確認を出さずに理由を返す**
 * - 確認には「いまの焼いた画像が置き換わる」「EPUBエディターが開く」を必ず並べ、ボタンは「焼く」
 * - 焼けたら findings に場所・体裁・題名の範囲を返す。AIは呼ばない（provider: none・本文0字）
 */

const ID = "0123456789abcdef";
const TOKEN = "d".repeat(64);
const NOW = Date.parse("2026-10-15T23:00:00+09:00");
const WORK: RunWork = { id: "w", title: "いじめられっ子_確認用", folderPath: "C:\\作品\\確認用" };
const COVER = { side: "front" as const, vertical: true, size: "large" as const };

function ticket(overrides: Partial<RunTicket> = {}): RunTicket {
  return {
    version: 1,
    id: ID,
    tokenHash: sha256Text(TOKEN),
    feature: "coverBake",
    folder: WORK.folderPath,
    cover: COVER,
    client: "claude-code",
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function queryOf(): string {
  const uri = buildRunUri(ID, TOKEN);
  return uri.slice(uri.indexOf("?") + 1);
}

const ROW: RunCoverRow = {
  side: "front",
  filePath: "設定/書籍/表紙_合成済み.png",
  bytes: 1234,
  cover: COVER,
  bookWritingMode: "vertical",
  title: WORK.title,
  titleColor: "#ffffff",
  canvasWidth: 1714,
  canvasHeight: 2400,
  titleBlock: { left: 800, top: 168, width: 120, height: 1900, fontSize: 100, lines: 1, vertical: true },
  vscodeVersion: "1.141.0",
};

function setup(
  t: RunTicket,
  options: { allowed?: boolean; cover?: Partial<RunCoverDeps> | null; confirm?: boolean; states?: RunStateRecord[] } = {}
) {
  const store = new Map<string, RunStateRecord>();
  const cover: RunCoverDeps = {
    inspect: vi.fn(async () => ({
      ok: true as const,
      bookVertical: true,
      bakedExists: true,
      bakedRelative: "設定/書籍/表紙_合成済み.png",
    })),
    bake: vi.fn(async () => ({ ok: true as const, row: ROW })),
    ...(options.cover ?? {}),
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
    listStates: async () => options.states ?? [],
    findWork: (folder) => (folder === WORK.folderPath ? WORK : undefined),
    isAllowed: vi.fn(async () => options.allowed ?? true),
    resolveAi: vi.fn(() => undefined),
    measure: vi.fn(async () => ({ ok: false as const, reason: "呼ばれないはず" })),
    confirm: vi.fn(async () => options.confirm ?? true),
    run: vi.fn(),
    describeFailure: (error) => ({ reason: error instanceof Error ? error.message : String(error) }),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    ...(options.cover === null ? {} : { cover }),
  };
  return { d, store, cover };
}

describe("札の形（core）", () => {
  test("coverBake は体裁が必須。ほかの機能に付いた体裁・file は見覚えのない札", () => {
    expect(parseRunTicket(formatRunTicket(ticket()))?.cover).toEqual(COVER);
    const { cover: _drop, ...noCover } = ticket();
    expect(parseRunTicket(formatRunTicket(noCover as RunTicket))).toBeUndefined();
    expect(parseRunTicket(formatRunTicket(ticket({ feature: "typo" })))).toBeUndefined();
    expect(parseRunTicket(formatRunTicket(ticket({ file: "本文/第1話.txt" })))).toBeUndefined();
    expect(
      parseRunTicket(formatRunTicket(ticket({ cover: { ...COVER, size: "huge" as "large" } })))
    ).toBeUndefined();
  });

  test("体裁の確かめは理由を言う（MCP の入力と札で同じ判定）", () => {
    expect(checkRunCover(COVER)).toBeUndefined();
    expect(checkRunCover(undefined)).toContain("cover");
    expect(checkRunCover({ ...COVER, side: "spine" })).toContain("front");
    expect(checkRunCover({ ...COVER, vertical: "縦" })).toContain("true");
    expect(checkRunCover({ ...COVER, title: "一" })).toContain("知らない項目");
  });

  test("done の一言は、測り方（cover.ink と titleBlock）まで言う", () => {
    const view = runStatusOf(ticket(), {
      version: 1,
      id: ID,
      state: "done",
      at: new Date(NOW).toISOString(),
    }, NOW + 1000);
    expect(view.message).toContain("cover.ink");
    expect(view.message).toContain("titleBlock");
  });
});

describe("表紙を焼く依頼", () => {
  test("確認（ボタンは「焼く」・置き換わる・画面が開く）を出してから焼き、結果を書く", async () => {
    const { d, store, cover } = setup(ticket());
    await handleRunRequest(queryOf(), d);
    expect(cover.inspect).toHaveBeenCalledWith(WORK, COVER);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    const [message, detail, button] = vi.mocked(d.confirm).mock.calls[0];
    expect(button).toBe("焼く");
    expect(message).toContain("表紙を焼きますか");
    expect(detail.split("\n")[0]).toBe("作品：いじめられっ子_確認用（本の組み方：縦書き）");
    expect(detail).toContain("題名：縦・大");
    expect(detail).toContain("置き換わります");
    expect(detail).toContain("EPUBエディターの画面が開きます");
    expect(detail).toContain("AIは呼びません");
    expect(cover.bake).toHaveBeenCalledWith(WORK, COVER);
    // AIの割当も送る量も見ない
    expect(d.resolveAi).not.toHaveBeenCalled();
    expect(d.measure).not.toHaveBeenCalled();
    const state = store.get(ID);
    expect(state?.state).toBe("done");
    expect(state?.result?.feature).toBe("coverBake");
    expect(state?.result?.provider).toMatchObject({ id: "none", paid: false });
    expect(state?.result?.bodyChars).toBe(0);
    expect(state?.result?.findings).toEqual([ROW]);
  });

  test("許可の無い作品は、確認も焼きもせずに断る", async () => {
    const { d, store, cover } = setup(ticket(), { allowed: false });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(cover.bake).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
    expect(store.get(ID)?.reason).toContain("許可されていません");
  });

  test("焼けない作品（元イラストが無い）は、確認を出さずに理由を返す", async () => {
    const { d, store, cover } = setup(ticket(), {
      cover: {
        inspect: vi.fn(async () => ({
          ok: false as const,
          reason: "表紙の元イラストが指定されていません。",
          nextAction: "EPUBエディターで表紙の画像を選んでください",
        })),
      },
    });
    await handleRunRequest(queryOf(), d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(cover.bake).not.toHaveBeenCalled();
    expect(store.get(ID)).toMatchObject({ state: "refused", nextAction: "EPUBエディターで表紙の画像を選んでください" });
  });

  test("手足の無い拡張機能では断る", async () => {
    const { d, store } = setup(ticket(), { cover: null });
    await handleRunRequest(queryOf(), d);
    expect(store.get(ID)?.state).toBe("refused");
  });

  test("作者が断れば焼かない", async () => {
    const { d, store, cover } = setup(ticket(), { confirm: false });
    await handleRunRequest(queryOf(), d);
    expect(cover.bake).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("declined");
  });

  test("焼けなかった（画面から返事が無い等）は failed と理由で返す", async () => {
    const { d, store } = setup(ticket(), {
      cover: { bake: vi.fn(async () => ({ ok: false as const, reason: "EPUBエディターから返事がありません。" })) },
    });
    await handleRunRequest(queryOf(), d);
    expect(store.get(ID)).toMatchObject({ state: "failed", reason: "EPUBエディターから返事がありません。" });
    expect(d.warn).toHaveBeenCalled();
  });

  test("回数の上限は、ほかの依頼と同じに効く", async () => {
    const states: RunStateRecord[] = Array.from({ length: 6 }, (_, index) => ({
      version: 1,
      id: `${index}`.padStart(16, "0"),
      state: "done",
      at: new Date(NOW).toISOString(),
      startedAt: new Date(NOW - 60_000).toISOString(),
    }));
    const { d, store, cover } = setup(ticket(), { states });
    await handleRunRequest(queryOf(), d);
    expect(cover.inspect).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("refused");
  });
});
