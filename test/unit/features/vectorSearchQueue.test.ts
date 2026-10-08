import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import type { OllamaEmbeddingProvider } from "../../../src/ai/ollamaEmbedding";

/**
 * 索引づくりの順番待ち（作者の裁定 2026-10-05。設計書6.87.23）。
 *
 * 作者が「検索索引作成／更新」を押している最中に、外部AI（MCP の run.request）
 * からの索引づくりが走ると、`vectors.bin` と `index.json` の組が食い違い、
 * 意味検索が黙って語句一致へ落ちる。**断らずに、先の索引づくりが終わるまで待つ。**
 *
 * 画面から来ても外部AIから来ても同じ芯（`buildVectorIndexCore`）を通るので、
 * 芯の入口で並ばせれば両方が同じ列に乗る。ここでは芯の最初の仕事
 * （材料を集める `buildRetrievalCorpus`）を作り物にして、**2つ目が1つ目の完了まで
 * 材料集めにすら入らないこと**を順番で確かめる。本物の Ollama は叩かない。
 */

type Corpus = Awaited<
  ReturnType<typeof import("../../../src/core/retrievalCorpus").buildRetrievalCorpus>
>;

/** 作品ごとに「材料集めが呼ばれた」を記録し、終わる時機を手で決める */
const corpusCalls: string[] = [];
const gates = new Map<string, () => void>();

vi.mock("../../../src/core/retrievalCorpus", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/core/retrievalCorpus")>();
  return {
    ...original,
    buildRetrievalCorpus: vi.fn(async (work: WorkEntry): Promise<Corpus> => {
      corpusCalls.push(work.title);
      await new Promise<void>((resolve) => gates.set(work.title, resolve));
      // 材料が空なら、芯は索引のファイルに触れずに返る（作り物のファイル操作が要らない）
      return { items: [] } as unknown as Corpus;
    }),
  };
});

const { buildVectorIndexCore, buildVectorIndexForWorks } = await import(
  "../../../src/features/vectorSearch"
);

function workOf(title: string): WorkEntry {
  return {
    id: title,
    title,
    folderPath: `C:/作品/${title}`,
    registeredAt: new Date(0).toISOString(),
  };
}

/** 材料が空なので、作り物の口は呼ばれない */
const provider = {} as unknown as OllamaEmbeddingProvider;

/** 次のマイクロタスクまで待つ（「まだ進んでいない」ことを見るのに要る） */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** 材料集めが呼ばれるまで待って、終わらせる */
async function finish(title: string): Promise<void> {
  for (let i = 0; i < 50 && !gates.has(title); i++) await settle();
  const open = gates.get(title);
  if (!open) throw new Error(`「${title}」の材料集めが始まっていません`);
  gates.delete(title);
  open();
}

afterEach(() => {
  corpusCalls.length = 0;
  gates.clear();
});

describe("索引づくりは同時に1つ（順番待ち）", () => {
  test("2つ同時に始めると、2つ目は1つ目が終わってから始まり、待っている間は知らせを出す", async () => {
    const waits: string[] = [];
    const first = buildVectorIndexCore(workOf("星の町"), provider, {
      isCancelled: () => false,
      report: () => undefined,
    });
    await settle();
    const second = buildVectorIndexCore(workOf("海の駅"), provider, {
      isCancelled: () => false,
      report: () => undefined,
      onWaiting: (message) => waits.push(message),
    });
    await settle();

    // 1つ目が走っている間、2つ目は材料集めにも入らない
    expect(corpusCalls).toEqual(["星の町"]);
    expect(waits).toEqual(["順番待ち：ほかの索引づくりが終わるまで待っています"]);

    await finish("星の町");
    await first;
    await finish("海の駅");
    await second;
    expect(corpusCalls).toEqual(["星の町", "海の駅"]);
  });

  test("空いていれば待たず、順番待ちの知らせも出さない", async () => {
    const waits: string[] = [];
    const run = buildVectorIndexCore(workOf("星の町"), provider, {
      isCancelled: () => false,
      report: () => undefined,
      onWaiting: (message) => waits.push(message),
    });
    await finish("星の町");
    await run;
    expect(waits).toEqual([]);
  });

  test("待っている間に中止すると、何も作らずに「中止」で返り、先の索引づくりは続く", async () => {
    const first = buildVectorIndexCore(workOf("星の町"), provider, {
      isCancelled: () => false,
      report: () => undefined,
    });
    await settle();
    const controller = new AbortController();
    const second = buildVectorIndexCore(workOf("海の駅"), provider, {
      isCancelled: () => controller.signal.aborted,
      report: () => undefined,
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    const outcome = await second;
    // 失敗（failed）ではなく中止として返す——全作品の行で「失敗」と数えないため
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.cancelled).toBe(true);
    expect(outcome.ok && outcome.result.built).toBe(0);
    expect(corpusCalls).toEqual(["星の町"]);

    await finish("星の町");
    await first;

    // 列は壊れていない。次の索引づくりはすぐ始まる
    const third = buildVectorIndexCore(workOf("森の家"), provider, {
      isCancelled: () => false,
      report: () => undefined,
    });
    await finish("森の家");
    await third;
    expect(corpusCalls).toEqual(["星の町", "森の家"]);
  });

  test("外部AIからの全作品の索引づくりも、画面から押した1作品の完了を待つ", async () => {
    const messages: string[] = [];
    const screen = buildVectorIndexCore(workOf("星の町"), provider, {
      isCancelled: () => false,
      report: () => undefined,
    });
    await settle();
    const outside = buildVectorIndexForWorks([workOf("海の駅"), workOf("森の家")], provider, {
      isCancelled: () => false,
      report: (message) => messages.push(message),
    });
    await settle();
    expect(corpusCalls).toEqual(["星の町"]);
    expect(messages.some((message) => message.includes("順番待ち"))).toBe(true);

    await finish("星の町");
    await screen;
    await finish("海の駅");
    await finish("森の家");
    const rows = await outside;
    expect(corpusCalls).toEqual(["星の町", "海の駅", "森の家"]);
    expect(rows.map((row) => row.status)).toEqual(["failed", "failed"]);
  });

  test("全作品の索引づくりを待っている間に中止すると、残りは「中止」の行になる（失敗と数えない）", async () => {
    const screen = buildVectorIndexCore(workOf("星の町"), provider, {
      isCancelled: () => false,
      report: () => undefined,
    });
    await settle();
    const controller = new AbortController();
    const outside = buildVectorIndexForWorks([workOf("海の駅"), workOf("森の家")], provider, {
      isCancelled: () => controller.signal.aborted,
      report: () => undefined,
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    const rows = await outside;
    expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    expect(corpusCalls).toEqual(["星の町"]);

    await finish("星の町");
    await screen;
  });
});
