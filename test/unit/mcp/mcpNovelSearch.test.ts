import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { novelSearch, SEARCH_EXCERPT_CHARS, type NovelSearchDeps } from "../../../src/mcp/tools/search";
import { pastSceneSourcesOf } from "../../../src/mcp/tools/contradiction";
import { manuscriptItems } from "../../../src/core/manuscriptItems";
import { VECTOR_INDEX_DIR, VECTOR_INDEX_VERSION } from "../../../src/core/vectorIndexFormat";
import { exposureOf } from "../../../src/mcp/tools/accessLog";

/**
 * MCP `novel.search`（設計書6.87.23。0.99.19）。索引があれば同じモデルで引き、
 * 無い・使えないときは語句の一致で探して理由を返す（作者の裁定、2026-10-05）。
 */

let folder: string;

const EP1 = ["第1話 旅立ち", "", "少年は剣を握り、村を出た。", "空は高く、風は冷たかった。"].join("\n");
const EP2 = ["第2話 市場", "", "市場で銅貨を細かい硬貨に替えてもらう。", "商人は渋い顔をした。"].join("\n");

beforeEach(() => {
  folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novel-search-"));
  fs.mkdirSync(nodePath.join(folder, "本文"));
  fs.writeFileSync(nodePath.join(folder, "本文", "第1話.txt"), EP1, "utf8");
  fs.writeFileSync(nodePath.join(folder, "本文", "第2話.txt"), EP2, "utf8");
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

/** 製品と同じ割り方で場面を組み、場面ごとのベクトルを索引のファイルに書く */
function writeIndex(vectorOf: (text: string) => number[], extra: Record<string, unknown> = {}) {
  const items = pastSceneSourcesOf(folder).flatMap((source) =>
    manuscriptItems(source.label, source.text, { chapter: source.chapter ?? null })
  );
  const unique = [...new Map(items.map((item) => [item.hash, item])).values()];
  const dims = vectorOf("").length;
  const floats = new Float32Array(unique.length * dims);
  unique.forEach((item, i) => floats.set(vectorOf(item.text), i * dims));
  const dir = nodePath.join(folder, ...VECTOR_INDEX_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "vectors.bin"), Buffer.from(floats.buffer));
  fs.writeFileSync(
    nodePath.join(dir, "index.json"),
    JSON.stringify({
      version: VECTOR_INDEX_VERSION,
      model: "bge-m3",
      dimensions: dims,
      hashes: unique.map((item) => item.hash),
      builtAt: "2026-10-05T01:00:00.000Z",
      ...extra,
    })
  );
}

const coinVector = (text: string) => (text.includes("硬貨") ? [1, 0, 0] : [0, 1, 0]);

function deps(overrides: Partial<NovelSearchDeps> = {}): NovelSearchDeps & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    embedded,
    setting: () => ({ enabled: true, model: "bge-m3", endpoint: "http://localhost:11434" }),
    embed: async (_endpoint, model, text) => {
      embedded.push(`${model}:${text}`);
      return Float32Array.from([0.9, 0.1, 0]);
    },
    ...overrides,
  };
}

describe("novel.search", () => {
  test("索引が無ければ語句の一致で探し、理由を返す（埋め込みは呼ばない）", async () => {
    const d = deps();
    const result = await novelSearch({ folder, query: "銅貨" }, d);
    expect(result.method).toBe("wordMatch");
    expect(result.reason).toContain("索引がありません");
    expect(result.index).toBeNull();
    expect(d.embedded).toHaveLength(0);
    expect(result.hits[0]?.file).toBe(nodePath.join("本文", "第2話.txt"));
    expect(result.hits[0]?.score).toBeNull();
  });

  test("索引があれば、索引のモデルで質問を埋め込み、近い場面を近さつきで返す", async () => {
    writeIndex(coinVector);
    const d = deps();
    const result = await novelSearch({ folder, query: "お金を両替する交渉" }, d);
    expect(result.method).toBe("vector");
    expect(d.embedded).toEqual(["bge-m3:お金を両替する交渉"]);
    expect(result.hits[0]?.episode).toContain("2");
    expect(result.hits[0]?.foundBy).not.toBe("語句一致");
    expect(result.hits[0]?.score).toBeGreaterThan(0.9);
    expect(result.hits[0]?.line).toBe(1);
    expect(result.index?.builtAt).toBe("2026-10-05T01:00:00.000Z");
    expect(result.index?.builtAtSource).toBe("record");
  });

  test("索引のモデルが今の設定と違えば、意味では引かない", async () => {
    writeIndex(coinVector);
    const d = deps({ setting: () => ({ enabled: true, model: "other-embed", endpoint: "http://localhost:11434" }) });
    const result = await novelSearch({ folder, query: "銅貨" }, d);
    expect(result.method).toBe("wordMatch");
    expect(result.reason).toContain("今の設定（other-embed）と違います");
    expect(d.embedded).toHaveLength(0);
  });

  test("埋め込みに失敗しても止めず、語句の一致へ落とす", async () => {
    writeIndex(coinVector);
    const d = deps({
      embed: async () => {
        throw new Error("Ollama に接続できません");
      },
    });
    const result = await novelSearch({ folder, query: "銅貨" }, d);
    expect(result.method).toBe("wordMatch");
    expect(result.reason).toContain("埋め込めませんでした");
  });

  test("索引が本文に追いついていなければ語句の一致（9割の門は製品と同じ）", async () => {
    writeIndex(coinVector);
    fs.writeFileSync(nodePath.join(folder, "本文", "第3話.txt"), "第3話 森\n\n深い森を歩く。\n", "utf8");
    fs.writeFileSync(nodePath.join(folder, "本文", "第4話.txt"), "第4話 湖\n\n湖で魚を釣る。\n", "utf8");
    const result = await novelSearch({ folder, query: "森" }, deps());
    expect(result.method).toBe("wordMatch");
    expect(result.reason).toContain("追いついていません");
  });

  test("遠くの Ollama で作った索引なら、検索語を送らない", async () => {
    writeIndex(coinVector, { endpoint: "http://192.0.2.10:11434" });
    const d = deps();
    const result = await novelSearch({ folder, query: "銅貨" }, d);
    expect(result.method).toBe("wordMatch");
    expect(d.embedded).toHaveLength(0);
  });

  test("抜粋は上限まで、件数は limit まで。全文は返さない", async () => {
    fs.writeFileSync(
      nodePath.join(folder, "本文", "第1話.txt"),
      `第1話 旅立ち\n\n${"剣".repeat(380)}\n`,
      "utf8"
    );
    // 語句の一致は2文字組みで数えるので、2文字以上で問う
    const result = await novelSearch({ folder, query: "剣剣", limit: 1 }, deps());
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS + 1);
  });

  test("作品フォルダーにも索引にも書かない", async () => {
    writeIndex(coinVector);
    const before = fs.readdirSync(folder, { recursive: true }).map(String).sort();
    await novelSearch({ folder, query: "銅貨" }, deps());
    expect(fs.readdirSync(folder, { recursive: true }).map(String).sort()).toEqual(before);
  });

  test("記録の重さは excerpt（抜粋が渡る）", () => {
    expect(exposureOf("novel.search", { folder })).toBe("excerpt");
  });
});
