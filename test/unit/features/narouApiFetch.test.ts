import { beforeEach, describe, expect, test, vi } from "vitest";

const logged: Array<{ what: string; detail: Record<string, unknown> }> = [];
vi.mock("../../../src/core/logger", () => ({
  logFailure: (what: string, detail: Record<string, unknown>) => logged.push({ what, detail }),
  logStep: () => undefined,
  useLogFile: () => undefined,
}));

import {
  fetchNarouApi,
  narouApiPanelState,
  openNarouGuideline,
  setNarouApiAgreement,
  type NarouApiDeps,
  type NarouApiResponse,
} from "../../../src/features/narouApiFetch";
import { NAROU_GUIDELINE_URL } from "../../../src/core/narouApi";
import { NAROU_API_CONSENT_KEY } from "../../../src/core/narouApiGate";
import { emptyPostingLedger, type PostingLedger } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";

/**
 * ［なろうAPIによる作品情報取得］（作者の指示 2026-11-02）。**fetch は差し替え、本物の API は
 * 呼ばない。** 同意なしでは押せない・同意すると押せる・取り消せる・Nコード無しでは出ない・
 * 時間の上限・失敗の種類ごとの文・本文をログへ、を見る。
 */

const work = { id: "w1", title: "苦手の流転", folderPath: "C:/works/a" } as unknown as WorkEntry;

class FakeMemento {
  values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}

class FakeStore {
  saved: PostingLedger[] = [];
  constructor(public ledger: PostingLedger) {}
  async load(): Promise<PostingLedger> {
    return this.ledger;
  }
  async save(ledger: PostingLedger): Promise<void> {
    this.ledger = ledger;
    this.saved.push(ledger);
  }
}

function narouLedger(workId: string | null = "n1234ab"): PostingLedger {
  return {
    ...emptyPostingLedger(),
    sites: [{ site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/123/" }],
    ...(workId ? { siteProfiles: [{ site: "narou", workId }] } : {}),
  };
}

const NOVEL_OK = JSON.stringify([
  { allcount: 1 },
  { ncode: "N1234AB", global_point: 4808, fav_novel_cnt: 1111, all_point: 2586, all_hyoka_cnt: 300, review_cnt: 2, impression_cnt: 15, general_all_no: 19, end: 1, noveltype: 1 },
]);
const RANK_OK = JSON.stringify([{ rtype: "20261020-d", pt: 120, rank: 45 }]);

function response(body: string, status = 200): NarouApiResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function deps(
  memento: FakeMemento,
  store: FakeStore,
  fetcher: (url: string) => Promise<NarouApiResponse>,
  options: { isWeb?: boolean; now?: string } = {}
): NarouApiDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    memento,
    store,
    isWeb: options.isWeb ?? false,
    now: () => new Date(options.now ?? "2026-11-02T10:00:00+09:00"),
    fetch: (url) => {
      calls.push(url);
      return fetcher(url);
    },
  };
}

const okFetch = async (url: string): Promise<NarouApiResponse> =>
  response(url.includes("/rank/rankin/") ? RANK_OK : NOVEL_OK);

async function agree(memento: FakeMemento): Promise<void> {
  await openNarouGuideline(memento, async () => true);
  await setNarouApiAgreement(memento, true);
}

beforeEach(() => {
  logged.length = 0;
});

describe("同意", () => {
  test("同意なしでは取りにいかない（fetch を呼ばない）", async () => {
    const memento = new FakeMemento();
    const store = new FakeStore(narouLedger());
    const d = deps(memento, store, okFetch);
    const outcome = await fetchNarouApi(work, d);
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("同意のチェック");
    expect(d.calls).toEqual([]);
    expect(store.saved).toEqual([]);
  });

  test("ガイドラインを開く前は同意できず、開くと同意できる", async () => {
    const memento = new FakeMemento();
    expect(await setNarouApiAgreement(memento, true)).toBe(false);
    expect(narouApiPanelState(memento, narouLedger(), false)).toMatchObject({
      status: "ready",
      opened: false,
      agreed: false,
    });
    const opened: string[] = [];
    expect(await openNarouGuideline(memento, async (url) => (opened.push(url), true))).toBe(true);
    expect(opened).toEqual([NAROU_GUIDELINE_URL]);
    expect(narouApiPanelState(memento, narouLedger(), false)).toMatchObject({ opened: true, agreed: false });
    expect(await setNarouApiAgreement(memento, true)).toBe(true);
    const state = narouApiPanelState(memento, narouLedger(), false);
    expect(state).toMatchObject({ opened: true, agreed: true });
    expect(state?.agreedAt).toEqual(expect.any(String));
  });

  test("開けなかった（openExternal が false）ときは開いたことにしない", async () => {
    const memento = new FakeMemento();
    expect(await openNarouGuideline(memento, async () => false)).toBe(false);
    expect(memento.values.has(NAROU_API_CONSENT_KEY)).toBe(false);
    expect(await setNarouApiAgreement(memento, true)).toBe(false);
  });

  test("同意すると押せ、外せば取り消せる（作品をまたいで同じ同意）", async () => {
    const memento = new FakeMemento();
    await agree(memento);
    const first = await fetchNarouApi(work, deps(memento, new FakeStore(narouLedger()), okFetch));
    expect(first.kind).toBe("done");
    expect(await setNarouApiAgreement(memento, false)).toBe(false);
    const other = { ...work, id: "w2" } as WorkEntry;
    const d = deps(memento, new FakeStore(narouLedger("n5555cd")), okFetch);
    expect((await fetchNarouApi(other, d)).kind).toBe("refused");
    expect(d.calls).toEqual([]);
  });
});

describe("出す・出さない", () => {
  test("なろうに載っていない作品では欄を出さない", () => {
    expect(narouApiPanelState(new FakeMemento(), emptyPostingLedger(), false)).toBeNull();
  });

  test("Nコードが無ければ案内だけ（押されても取りにいかない）", async () => {
    const memento = new FakeMemento();
    expect(narouApiPanelState(memento, narouLedger(null), false)?.status).toBe("no-ncode");
    await agree(memento);
    const d = deps(memento, new FakeStore(narouLedger(null)), okFetch);
    const outcome = await fetchNarouApi(work, d);
    expect(outcome).toEqual({ kind: "refused", message: "投稿サイト設定で Nコードを登録すると使えます。" });
    expect(d.calls).toEqual([]);
  });

  test("ブラウザ版ではボタンを出さず、届いても取りにいかない", async () => {
    const memento = new FakeMemento();
    expect(narouApiPanelState(memento, narouLedger(), true)?.status).toBe("web");
    await agree(memento);
    const d = deps(memento, new FakeStore(narouLedger()), okFetch, { isWeb: true });
    const outcome = await fetchNarouApi(work, d);
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("パソコンの VS Code で使えます");
    expect(d.calls).toEqual([]);
  });
});

describe("取得", () => {
  test("作品の数と順位を続けて取り、出どころの印つきで台帳へ書く。文に出典", async () => {
    const memento = new FakeMemento();
    await agree(memento);
    const store = new FakeStore(narouLedger());
    const d = deps(memento, store, okFetch);
    const outcome = await fetchNarouApi(work, d);
    expect(outcome.kind).toBe("done");
    expect(outcome.message).toContain("出典：なろうデベロッパー（なろう小説API・なろう殿堂入りAPI）");
    expect(d.calls).toHaveLength(2);
    expect(d.calls[0]).toContain("ncode=n1234ab");
    expect(d.calls[1]).toContain("/rank/rankin/");
    expect(store.ledger.readerStats.map((row) => row.source)).toEqual(["narou-api"]);
    expect(store.ledger.rankings.map((row) => row.source)).toEqual(["narou-api"]);
  });

  test("前に押してから1時間は取りにいかず「〇分後にもう一度押せます」", async () => {
    const memento = new FakeMemento();
    await agree(memento);
    const store = new FakeStore(narouLedger());
    await fetchNarouApi(work, deps(memento, store, okFetch, { now: "2026-11-02T10:00:00+09:00" }));
    const d = deps(memento, store, okFetch, { now: "2026-11-02T10:20:00+09:00" });
    const outcome = await fetchNarouApi(work, d);
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("40分後にもう一度押せます");
    expect(d.calls).toEqual([]);
  });

  test("失敗した回も1回に数える（失敗から上限を緩めない）", async () => {
    const memento = new FakeMemento();
    await agree(memento);
    const store = new FakeStore(narouLedger());
    await fetchNarouApi(work, deps(memento, store, async () => { throw new Error("offline"); }));
    const d = deps(memento, store, okFetch, { now: "2026-11-02T10:05:00+09:00" });
    expect((await fetchNarouApi(work, d)).kind).toBe("refused");
    expect(d.calls).toEqual([]);
  });

  test.each([
    ["通信できない", async () => { throw new Error("getaddrinfo ENOTFOUND"); }, "つながりませんでした", "getaddrinfo ENOTFOUND"],
    ["API が返さない", async () => response("Service Unavailable", 503), "HTTP 503", "Service Unavailable"],
    ["該当作品が無い", async () => response(JSON.stringify([{ allcount: 0 }])), "見つかりませんでした", "allcount"],
    ["形が違う", async () => response("<html>maintenance</html>"), "形と違いました", "maintenance"],
  ] as const)("%s：1文と次の一手を返し、返事の本文はログへ残す。台帳は書かない", async (_name, fetcher, words, body) => {
    const memento = new FakeMemento();
    await agree(memento);
    const store = new FakeStore(narouLedger());
    const outcome = await fetchNarouApi(work, deps(memento, store, fetcher));
    expect(outcome.kind).toBe("failed");
    expect(outcome.message).toContain(words);
    expect(outcome.message).toContain("なろう小説API");
    expect(store.saved).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(String(logged[0].detail["返事の本文"])).toContain(body);
  });

  test("順位だけ取れなかったときは、作品の数は書いて順位の失敗を言う", async () => {
    const memento = new FakeMemento();
    await agree(memento);
    const store = new FakeStore(narouLedger());
    const outcome = await fetchNarouApi(
      work,
      deps(memento, store, async (url) =>
        url.includes("/rank/rankin/") ? response("Error: Novel not found.") : response(NOVEL_OK)
      )
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.message).toContain("作品の数を記録しました");
    expect(outcome.message).toContain("順位は取れませんでした");
    expect(outcome.message).toContain("なろう殿堂入りAPI");
    expect(store.ledger.readerStats).toHaveLength(1);
    expect(store.ledger.rankings).toHaveLength(0);
  });
});
