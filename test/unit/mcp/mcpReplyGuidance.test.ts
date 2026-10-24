import { afterEach, beforeEach, describe, expect, test } from "vitest";
import nodePath from "node:path";
import { z } from "zod";
import {
  clearSamplingHost,
  setSamplingHost,
} from "../../../src/mcp/tools/sampling";
import { assertRunner, runChunks } from "../../../src/mcp/tools/run";
import {
  NOVEL_RUN_INPUT,
  novelPrompt,
  novelRun,
  novelValidate,
  type FeatureCallInput,
} from "../../../src/mcp/tools/features";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";

/**
 * 柱2の3〜5：AI が迷わない返事（設計書6.87.15。作者の裁定、2026-10-24）。
 *
 * 3. runner の断り文句に、いま使える選択肢だけを出す
 * 4. failures の理由を種類で畳む（元の一覧は残す）
 * 5. prompt の返事に、novel.validate へ戻すときの引数の雛形（next）を添える
 */

const WORK = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");

/** 宣言だけを差し替えられる作り物のクライアント */
function useHost(capabilities: Record<string, unknown> | undefined): void {
  const host = { getClientCapabilities: () => capabilities };
  setSamplingHost(host as unknown as Parameters<typeof setSamplingHost>[0]);
}

function refusalOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("断られるはず");
}

beforeEach(() => {
  setExternalClientName("試験のクライアント");
});

afterEach(() => {
  setExternalClientName("");
  clearSamplingHost();
});

/* ── 3：使える選択肢だけを出す ─────────────────────────────── */

describe("runner の断り文句（柱2の3）", () => {
  test("sampling に対応していない相手には、sampling を選択肢に出さない", () => {
    // LM Studio のように、接続時に sampling を宣言しない相手
    useHost({});
    const message = refusalOf(() => assertRunner(undefined));
    expect(message).toContain("ollama＝");
    expect(message).toContain("claude＝");
    // 選択肢として並べない（選んでもまた断られるだけ）
    expect(message).not.toContain("sampling＝");
    expect(message).not.toMatch(/sampling/);
  });

  test("対応している相手には、3つとも出す", () => {
    useHost({ sampling: {} });
    const message = refusalOf(() => assertRunner(undefined));
    expect(message).toContain("ollama＝");
    expect(message).toContain("claude＝");
    expect(message).toContain("sampling＝");
    expect(message).not.toContain("分かりません");
  });

  test("分からないとき（相手がいない・宣言をまだ受け取っていない）は、3つ並べてそう書く", () => {
    for (const setUp of [
      () => clearSamplingHost(),
      () => useHost(undefined),
    ]) {
      setUp();
      const message = refusalOf(() => assertRunner(undefined));
      expect(message).toContain("sampling＝");
      expect(message).toContain("分かりません");
    }
  });

  test("転送層（zod）で断るときも、同じ文を出す", () => {
    /*
      **runner を省いた呼び出しは、ハンドラへ届く前に入力の形で断られる**
      （runner は必須）。そこで SDK の既定の文（3つの名前の羅列）が出ると、
      ハンドラの断り文句を直しても AI には届かない
    */
    useHost({});
    const parsed = z.object(NOVEL_RUN_INPUT).safeParse({
      folder: WORK,
      feature: "typo",
      filePath: "本文/004_よあけ.txt",
      numCtx: 32768,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const runnerIssue = parsed.error.issues.find((issue) => issue.path[0] === "runner");
    expect(runnerIssue?.message).toContain("ollama＝");
    expect(runnerIssue?.message).not.toMatch(/sampling/);
  });
});

/* ── 4：失敗を種類で畳む ───────────────────────────────── */

describe("failures を種類で畳む（柱2の4）", () => {
  test("同じ理由は1つにまとめ、件数と話数を添える。元の一覧は残す", async () => {
    const items = [
      { chunkId: "本文/collected.txt#4-0@1000" },
      { chunkId: "本文/collected.txt#5-0@1000" },
      { chunkId: "本文/collected.txt#7-0@1000" },
      { chunkId: "本文/collected.txt#12-0@1000" },
      { chunkId: "本文/collected.txt#12-1@1000" },
    ];
    const outcome = await runChunks("テスト", 0, items, async (item) => {
      if (item.chunkId.includes("#5-")) {
        throw new Error("応答を読み取れません（JSONの形ではありません）");
      }
      if (item.chunkId.includes("#12-1")) return "ok";
      throw new Error("この作品では、まだ許可していません。許可するには……");
    });

    // 元の一覧は1件ずつのまま（外の AI と既存の読み手のため）
    expect(outcome.failures).toHaveLength(4);
    expect(outcome.failureSummary).toEqual([
      {
        reason: "この作品では、まだ許可していません。許可するには……",
        count: 3,
        chunkIds: [
          "本文/collected.txt#4-0@1000",
          "本文/collected.txt#7-0@1000",
          "本文/collected.txt#12-0@1000",
        ],
        chapters: [4, 7, 12],
        label: "「この作品では、まだ許可していません。」×3（第4・7・12話）",
      },
      {
        reason: "応答を読み取れません（JSONの形ではありません）",
        count: 1,
        chunkIds: ["本文/collected.txt#5-0@1000"],
        chapters: [5],
        label: "「応答を読み取れません（JSONの形ではありません）」×1（第5話）",
      },
    ]);
    // 1行の報告にも種類ごとに出す
    expect(outcome.note).toContain("×3（第4・7・12話）");
  });

  test("話数の読めない chunkId でも投げない", async () => {
    const outcome = await runChunks("テスト", 0, [{ chunkId: "へんな形" }], async () => {
      throw new Error("だめでした");
    });
    expect(outcome.failureSummary?.[0]).toMatchObject({
      count: 1,
      chunkIds: ["へんな形"],
      chapters: [],
    });
  });

  test("失敗が無ければ付けない（起きた回だけ）", async () => {
    const outcome = await runChunks("テスト", 0, [{ chunkId: "a#1-0@1" }], async () => "ok");
    expect(outcome.failureSummary).toBeUndefined();
  });

  test("novel.run の sampling で許可が無いと、全チャンクの断りが1種類に畳まれる", async () => {
    // 試験の作品は考えさせる許可を持たない（既定は拒否）。宣言はしている相手
    useHost({ sampling: {} });
    const outcome = (await novelRun({
      folder: WORK,
      feature: "typo",
      filePath: "本文/collected.txt",
      numCtx: 2048,
      runner: "sampling",
    })) as {
      failures: Array<{ chunkId: string }>;
      failureSummary: Array<{ count: number; chapters: number[] }>;
    };
    expect(outcome.failures.length).toBeGreaterThan(1);
    expect(outcome.failureSummary).toHaveLength(1);
    expect(outcome.failureSummary[0].count).toBe(outcome.failures.length);
    expect(outcome.failureSummary[0].chapters.length).toBeGreaterThan(1);
  });
});

/* ── 5：validate へ戻す引数の雛形 ─────────────────────────── */

interface NextTemplate {
  tool: string;
  fill: string;
  note: string;
  calls: Array<{ args: Record<string, unknown> }>;
}

describe("next——validate へ戻す引数の雛形（柱2の5）", () => {
  const typoCall: FeatureCallInput = {
    folder: WORK,
    feature: "typo",
    filePath: "本文/004_よあけ.txt",
    numCtx: 32768,
    options: { modelSize: "large" },
  };

  test("チャンクごとに、chunkId まで埋めた雛形を返す", () => {
    const result = novelPrompt(typoCall) as {
      chunks: Array<{ chunkId: string }>;
      next: NextTemplate;
    };
    expect(result.next.tool).toBe("novel.validate");
    expect(result.next.fill).toBe("response");
    expect(result.next.calls).toHaveLength(result.chunks.length);
    expect(result.next.calls[0].args).toEqual({
      folder: WORK,
      feature: "typo",
      filePath: "本文/004_よあけ.txt",
      options: { modelSize: "large" },
      chunkId: result.chunks[0].chunkId,
      response: null,
    });
    // 切り方は chunkId に入っているので、numCtx・chunkIndex は渡さない
    expect(result.next.calls[0].args).not.toHaveProperty("numCtx");
  });

  test("**雛形を埋めずに戻すと、response が要ると断られる**（空ける所は文字列にしない）", () => {
    /*
      指示の言葉はそのまま答えとして返ってくる（CLAUDE.md の失敗3）。
      空ける所に「ここへ応答を」のような文字列を置くと、埋め忘れた雛形が
      そのまま検算へ流れる。null なら、形の検査（z.string）でもハンドラでも止まる
    */
    const result = novelPrompt(typoCall) as { next: NextTemplate };
    const args = result.next.calls[0].args;
    expect(args.response).toBeNull();
    expect(() => novelValidate(args as unknown as FeatureCallInput)).toThrow(/response/);
  });

  test("雛形の response を答えに替えれば、そのまま検算を通る", () => {
    const result = novelPrompt({
      ...typoCall,
      feature: "proofread",
      options: undefined,
    }) as { next: NextTemplate };
    const args = {
      ...result.next.calls[0].args,
      response: JSON.stringify({ issues: [] }),
    };
    expect(() => novelValidate(args as unknown as FeatureCallInput)).not.toThrow();
  });

  test("チャンクに切らない機能は、雛形1件（chunkId なし）", () => {
    const result = novelPrompt({ folder: WORK, feature: "opening" }) as {
      next: NextTemplate;
    };
    expect(result.next.calls).toHaveLength(1);
    expect(result.next.calls[0].args).toEqual({
      folder: WORK,
      feature: "opening",
      response: null,
    });
  });

  test("novel.run の runner: claude にも同じ雛形が付く", async () => {
    const result = (await novelRun({ ...typoCall, runner: "claude" })) as {
      chunks: Array<{ chunkId: string }>;
      next: NextTemplate;
    };
    expect(result.next.calls[0].args.chunkId).toBe(result.chunks[0].chunkId);
  });
});
