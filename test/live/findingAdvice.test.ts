import * as fs from "node:fs";
import * as nodePath from "node:path";
import { expect, test, vi } from "vitest";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { LIVE_MODEL, SKIP_REASON, liveWorkPath } from "./support/liveEnv";

/**
 * 推敲の指摘への短い助言（P-47、設計書6.96.5の［AIに相談］）を、
 * **手元の Ollama で実際に回す。**
 *
 * 製品と同じ道を通す——`askFindingAdvice`（プロンプト・スキーマ・思考なし・
 * 読み取りと検証）。AIは実物の `OllamaProvider`。迂回するのは、割当の解決
 * （名指しのモデルを返す）・繋がるかと料金の確認・キャッシュ（作品の
 * `.aiwriter` へ書かないよう記憶の中に置く）・ログの書き先だけ。
 *
 * 指摘は作品の本文の段落に、推敲（P-10）が出す形の指摘文を手で付けたもの。
 * **作品は読むだけで書き換えない。**
 *
 *   $env:NOVELAI_LIVE_WORK = "C:/path/to/作品"   # 教科書チートの確認用コピー
 *   $env:NOVELAI_MODEL = "gemma4:e4b"
 *   npx vitest run --config vitest.live.config.mts test/live/findingAdvice.test.ts
 */

const logs: string[] = [];
vi.mock("../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/logger")>()),
  logFailure: (...args: unknown[]) => logs.push(`（ログ・失敗）${JSON.stringify(args)}`),
  logStep: (text: string) => logs.push(`（ログ）${text}`),
  logLine: () => undefined,
  useLogFile: () => undefined,
}));
vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));
vi.mock("../../src/core/chunkCache", () => {
  const entries = new Map<string, unknown>();
  return {
    ChunkCache: class {
      async load() {}
      async save() {}
      get(hash: string, base: Record<string, string>) {
        return entries.get(`${base.providerId}|${base.model}|${base.promptVersion}|${hash}`);
      }
      async set(hash: string, base: Record<string, string>, value: unknown) {
        entries.set(`${base.providerId}|${base.model}|${base.promptVersion}|${hash}`, value);
      }
    },
  };
});

const { askFindingAdvice } = await import("../../src/features/findingAdvice");

const work = liveWorkPath();

/** 話のファイルと、指摘を付ける段落の頭の文字・指摘の中身 */
const CASES = [
  {
    file: "episode_0003_心肺蘇生と出会い.txt",
    head: "　僕が持っている棒きれを警戒しているのだろう。",
    finding: "重複：「警戒している」が1つの段落で2度使われています",
  },
  {
    file: "episode_0003_心肺蘇生と出会い.txt",
    head: "　狼が呻り声をあげて踏み込もうとしてきたので、",
    finding: "係り受け：「狼は」の後に「飛び退いて」「目で追う」と動作が続き、文が長く感じられます",
  },
  {
    file: "episode_0003_心肺蘇生と出会い.txt",
    head: "　僕は踵を返すと、全速力で走り出す。",
    finding: "視点：転生前の記憶（体育祭）がここで唐突に出てきます",
  },
];

/** 空の行を飛ばした前後の段落 */
function neighbors(lines: string[], index: number): { before?: string; after?: string } {
  const find = (step: -1 | 1) => {
    for (let i = index + step; i >= 0 && i < lines.length; i += step) {
      if (lines[i].trim()) return lines[i];
    }
    return undefined;
  };
  return { before: find(-1), after: find(1) };
}

test.skipIf(!work)(`推敲の指摘への短い助言を ${LIVE_MODEL} で回す（${SKIP_REASON}）`, async () => {
  const provider = new OllamaProvider();
  const registry = { resolve: () => ({ provider, model: LIVE_MODEL }) };
  const results: string[] = [];
  for (const item of CASES) {
    const lines = fs
      .readFileSync(nodePath.join(work as string, item.file), "utf8")
      .split(/\r?\n/);
    const index = lines.findIndex((line) => line.startsWith(item.head));
    expect(index, `${item.head} が見つからない`).toBeGreaterThanOrEqual(0);
    const material = { quote: lines[index], finding: item.finding, ...neighbors(lines, index) };

    const started = Date.now();
    const outcome = await askFindingAdvice({
      work: {
        id: "live",
        title: "確認用",
        folderPath: work as string,
        registeredAt: "2026-10-05T00:00:00.000Z",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: registry as any,
      material,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push(
      `■ ${item.finding}\n一文：${material.quote}\n結果（${seconds}秒）：${JSON.stringify(outcome, null, 1)}`
    );
    expect(outcome.kind).not.toBe("cancelled");
  }
  const out = process.env.PROBE_OUT;
  const text = [...results, ...logs].join("\n\n");
  if (out) fs.writeFileSync(out, text, "utf8");
  else console.log(text);
}, 600_000);
