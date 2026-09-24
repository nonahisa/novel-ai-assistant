import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { saveModelTuning } from "../../../src/core/modelTuning";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * チューニングしたあとに同じ作品を処理すると、**AIを呼ぶ回数が減る**
 * （実機確認リスト F-63「チャンクが大きくなり呼び出し回数が減るか（ログの件数で確認）」）。
 *
 * チャンクの上限が広がる仕組みは `chunkSizeMode.test.ts` が見ている。ここは
 * その先——**矛盾検知と事実の照合が実際に通る割り方（`collectManuscriptChunks`）**
 * で同じ本文を割り、送る塊の数（＝AIを呼ぶ回数）が減ることを数える。
 * ログの「AIへ送信: 1/N」の N はこの塊の数である。
 */

const EPISODES = 10;
const CHARS_PER_EPISODE = 5_000;

/** 1話ぶんの本文。1段落100字で、改行の位置で割れるようにする */
function episodeText(chapter: number): string {
  const paragraph = `第${chapter}話の本文。`.padEnd(99, "あ") + "。";
  return Array.from({ length: CHARS_PER_EPISODE / 100 }, () => paragraph).join("\n");
}

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: Array.from({ length: EPISODES }, (_, index) => ({
      filePath: `C:/作品/本文/${String(index + 1).padStart(3, "0")}.txt`,
      fileName: `${String(index + 1).padStart(3, "0")}.txt`,
      chapterStart: index + 1,
      chapterEnd: index + 1,
      hasConflictMarkers: false,
    })),
  })),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async (filePath: string) => ({
    text: episodeText(Number(/(\d+)\.txt$/.exec(filePath)?.[1] ?? 0)),
    hasConflictMarkers: false,
  })),
  hashText: (text: string) => `hash-${text.length}-${text.slice(0, 8)}`,
}));

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => undefined),
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
}));

import { collectManuscriptChunks } from "../../../src/features/manuscriptChunks";

const work: WorkEntry = {
  id: "work-1",
  title: "作品",
  folderPath: "C:/作品",
  registeredAt: "2026-09-24T00:00:00.000Z",
};

async function sendCount(): Promise<{ calls: number; totalChars: number }> {
  const { chunks } = await collectManuscriptChunks({
    work,
    info: { id: "gemma4:12b", contextWindow: 131_072 } as never,
    options: {},
    fixedCost: { overheadChars: 3_000, outputTokens: 4_096 },
    outputTuning: {
      providerId: "ollama",
      model: "gemma4:12b",
      feature: "contradiction_check",
    },
    logLabel: "矛盾検知",
  });
  return {
    calls: chunks.length,
    totalChars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
  };
}

beforeEach(async () => {
  await useMemoryTuningStore({});
});

describe("チューニングの前と後で、同じ作品を割った数", () => {
  test("読める量を測ったあとは、塊が大きくなって呼ぶ回数が減る（本文は同じだけ送る）", async () => {
    const before = await sendCount();

    // 「AIチューニング」で読める量を測り、設定に反映したのと同じ状態にする
    await saveModelTuning("ollama", "gemma4:12b", { measuredChars: 90_000 });
    const after = await sendCount();

    expect(after.calls).toBeLessThan(before.calls);
    // 送る本文の総量は変わらない（減ったのは回数だけで、読み落としではない）
    expect(after.totalChars).toBeGreaterThanOrEqual(EPISODES * CHARS_PER_EPISODE);
    expect(before.totalChars).toBeGreaterThanOrEqual(EPISODES * CHARS_PER_EPISODE);
    // 数字は記録に残す（どれだけ減ったかを、次に読む人が知れるように）
    console.log(
      `チューニング前 ${before.calls} 回 → 後 ${after.calls} 回（${EPISODES}話×${CHARS_PER_EPISODE}字）`
    );
  });
});
