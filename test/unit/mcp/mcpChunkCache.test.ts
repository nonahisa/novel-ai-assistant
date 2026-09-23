import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * 外から呼んだとき（MCP）も、チャンクキャッシュを使う
 * （作者の裁定 2026-09-19「読み書き両方使う」、設計書6.87.17）。
 *
 * ## ここで見張りたいこと
 *
 * 1. **2回目はAIを呼ばない。** 呼んでいたら、実装ルール4（処理量を節約する）に
 *    反したまま気づけない——実機では「速くなった気がする」で終わってしまう
 * 2. **拡張機能と同じ鍵で貯まる。** 鍵がずれると、拡張機能が貯めたぶんを
 *    外部AIが使えない（逆も同じ）。ここでは**製品（`features/checkTypos.ts`）が
 *    組み立てるのと同じ `CacheKeyBase`** で読み直して確かめる
 * 3. **貯める形も製品と同じ。** 製品が入れているのは生の応答ではなく、
 *    読み取ったあとの形（`parseTypoCheckResult` の返り値）である
 */

/** AIへ何回投げたか数える。**キャッシュが効いたかは、ここでしか分からない** */
const asked: string[] = [];
const reply = JSON.stringify({
  issues: [
    {
      line: 2,
      original: "まず最初に、少年は窓を開けた。",
      target: "まず最初に",
      suggestion: "まず",
      reason: "重言",
      confidence: "high",
    },
  ],
});

vi.mock("../../../src/mcp/tools/ollama", () => ({
  ollamaGenerate: vi.fn(async (params: { userPrompt: string }) => {
    asked.push(params.userPrompt);
    return { text: reply };
  }),
}));

import { typoRun, typoPrompt } from "../../../src/mcp/tools/typo";
import { chunkFromId } from "../../../src/mcp/tools/shared";
import { chunkCacheFileOf } from "../../../src/mcp/tools/chunkCacheFile";
import {
  ChunkCacheStore,
  type CacheKeyBase,
  type ChunkCacheIo,
} from "../../../src/core/chunkCacheStore";
import { TYPO_CHECK_VERSION } from "../../../src/prompts/typoCheck";

const WORK = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const FILE = nodePath.join("本文", "004_よあけ.txt");
const NUM_CTX = 32768;
const MODEL = "gemma4:e4b";

const temporaries: string[] = [];

/** 作り物の作品を写す。**`.aiwriter/cache/` を作るので、原本は使わない** */
function copiedWork(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mcp-cache-"));
  temporaries.push(folder);
  fs.cpSync(WORK, folder, { recursive: true });
  return folder;
}

/** 読むだけの `io`。**製品がこのファイルをどう読むか**を真似る */
const readOnlyIo: ChunkCacheIo = {
  async read(file) {
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  },
  async write() {
    throw new Error("この試験では書かない");
  },
  log() {},
};

afterEach(() => {
  asked.length = 0;
  for (const folder of temporaries.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("外から呼んだときのチャンクキャッシュ", () => {
  test("同じ本文を2回撃つと、2回目はAIを呼ばずに同じ結果を返す", async () => {
    const folder = copiedWork();
    const input = {
      folder,
      filePath: FILE,
      numCtx: NUM_CTX,
      runner: "ollama" as const,
      model: MODEL,
    };

    const first = await typoRun(input);
    expect(asked).toHaveLength(1);
    if (first.runner !== "ollama") throw new Error("形が違う");
    expect(first.results[0].accepted).toHaveLength(1);

    const second = await typoRun(input);

    // **ここが要点。** 2回目はAIへ一度も投げていない
    expect(asked).toHaveLength(1);
    if (second.runner !== "ollama") throw new Error("形が違う");
    expect(second.results).toEqual(first.results);
    expect(second.failures).toEqual([]);
  });

  test("拡張機能が使うのと同じ鍵・同じ形で貯まる", async () => {
    const folder = copiedWork();
    await typoRun({
      folder,
      filePath: FILE,
      numCtx: NUM_CTX,
      runner: "ollama",
      model: MODEL,
    });

    // **製品（`features/checkTypos.ts`）が組み立てる鍵をそのまま書く。**
    // 写しではなく、ずれたら落ちるための控えである
    const productKey: CacheKeyBase = {
      feature: "typo_check",
      promptVersion: TYPO_CHECK_VERSION,
      providerId: "ollama",
      model: MODEL,
    };
    const chunkId = typoPrompt({ folder, filePath: FILE, numCtx: NUM_CTX })
      .chunks[0].chunkId;
    const chunkHash = chunkFromId(folder, chunkId).hash;

    const store = new ChunkCacheStore(chunkCacheFileOf(folder), readOnlyIo);
    await store.load();

    // 製品の鍵で引ける（＝拡張機能から見ても当たる）
    const cached = store.get(chunkHash, productKey);
    // 貯まっているのは生の応答ではなく、読み取ったあとの形
    expect(cached).toEqual(JSON.parse(reply));
  });

  test("モデルが違えば、貯めたものを使い回さない", async () => {
    const folder = copiedWork();
    const input = {
      folder,
      filePath: FILE,
      numCtx: NUM_CTX,
      runner: "ollama" as const,
    };

    await typoRun({ ...input, model: MODEL });
    expect(asked).toHaveLength(1);

    // **地力も設定も違うので、答えは揃わない**（設計書6.28.7）
    await typoRun({ ...input, model: "別のモデル" });
    expect(asked).toHaveLength(2);
  });

  test("`runner: claude` は貯めない（結果を持たないので貯めるものが無い）", async () => {
    const folder = copiedWork();

    await typoRun({
      folder,
      filePath: FILE,
      numCtx: NUM_CTX,
      runner: "claude",
    });

    expect(fs.existsSync(chunkCacheFileOf(folder))).toBe(false);
  });
});
