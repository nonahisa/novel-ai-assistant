import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { startFakeVoiceEngine, type FakeEngine } from "../support/fakeVoiceEngine";

/**
 * 読み間違いの見込みを調べて行を置く道と、［読みの辞書へ足す］（設計書6.42.5）。
 * 偽のエンジンは語ごとの読みを返す。本文と辞書と置き場はメモリの上
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  responseExcerptForLog: (text: string) => text,
  useLogFile: vi.fn(),
}));
vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: [], errors: [] };
    }
  },
}));
vi.mock("../../../src/core/voiceCastStore", () => ({
  loadVoiceCast: async () => ({ file: { version: 1, episode: "01.md", entries: [] }, hash: undefined }),
  saveVoiceCast: async () => "h",
  loadVoiceAssignment: async () => ({ file: { version: 1, characters: {} }, hash: undefined }),
  saveVoiceAssignment: async () => "h",
}));

const { VoiceReadingService } = await import("../../../src/features/voiceReading");
const { addMisreadToDictionary, checkReadingMisreads, forgetMisreadAnswers } = await import(
  "../../../src/features/readingMisread"
);
const { FindingStore } = await import("../../../src/features/findingStore");
const { loadReadingDictionary } = await import("../../../src/core/readingDictionaryStore");
const { readingSpansFor } = await import("../../../src/core/readingDictionary");
const { buildReadingPlan } = await import("../../../src/core/readAloud");
const paths = await import("../../../src/core/paths");

const work = { id: "w1", title: "灯の話", folderPath: paths.join("C:", "works", "akari") } as WorkEntry;
const EP1 = paths.join(work.folderPath, "本文", "01.md");
const EP2 = paths.join(work.folderPath, "本文", "02.md");
const TEXT1 = "　{灯|あかり}が笑った。";
const TEXT2 = "　灯は走った。\n　港へ行く。";

const disk = new Map<string, Uint8Array>();
let engine: FakeEngine | undefined;

function put(file: string, text: string): void {
  disk.set(Uri.file(file).fsPath, new TextEncoder().encode(text));
}

function episodeFile(filePath: string, chapter: number): EpisodeFile {
  return { filePath, fileName: paths.basename(filePath), chapterStart: chapter } as EpisodeFile;
}

const episodes = async () => [episodeFile(EP1, 1), episodeFile(EP2, 2)];

async function serviceWith(readings: Record<string, string>) {
  engine = await startFakeVoiceEngine({ readings });
  const url = engine.url;
  return new VoiceReadingService(() => url, undefined, async () => true);
}

function audioQueries(): number {
  return (engine?.requests ?? []).filter((r) => r.path === "/audio_query").length;
}

beforeEach(() => {
  disk.clear();
  workspace.fs = memoryFs(disk);
  forgetMisreadAnswers();
  put(EP1, TEXT1);
  put(EP2, TEXT2);
});

afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

const target = { work, episodePath: EP2, text: TEXT2, readings: [], engine: "aivisspeech" as const };

describe("読み間違いを調べる", () => {
  it("第1話のルビで分かる語を、第2話でエンジンが別の読みで読むと、行が置かれる（音声は作らない）", async () => {
    const service = await serviceWith({ 灯: "ヒ", 走: "ハシ", 港: "ミナト", 行: "イ" });
    const outcome = await checkReadingMisreads(target, service, { episodes, askRemote: true });
    expect(outcome).toEqual({ kind: "checked", found: 1, shown: 1 });
    const rows = await new FindingStore(work).load();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("読み間違いの見込み");
    expect(rows[0].hintLine).toBe(1);
    expect(rows[0].target).toBe("灯");
    expect(rows[0].suggestion).toBe("{灯|あかり}");
    expect(rows[0].message).toContain("「ヒ」");
    expect(rows[0].message).toContain("第1話のルビ");
    expect(engine?.requests.some((r) => r.path === "/synthesis")).toBe(false);
    // 調べただけでは辞書は作らない（押したときだけ）
    expect((await loadReadingDictionary(work, EP2)).hash).toBeUndefined();
  });

  it("エンジンが正しく読めば、行は置かれない", async () => {
    const service = await serviceWith({ 灯: "アカリ", 走: "ハシ" });
    const outcome = await checkReadingMisreads(target, service, { episodes, askRemote: true });
    expect(outcome).toEqual({ kind: "checked", found: 0, shown: 0 });
    expect(await new FindingStore(work).load()).toEqual([]);
  });

  it("同じ文は、調べ直しても2回目からはエンジンへ問わない", async () => {
    const service = await serviceWith({ 灯: "ヒ", 走: "ハシ" });
    await checkReadingMisreads(target, service, { episodes, askRemote: true });
    const first = audioQueries();
    expect(first).toBeGreaterThan(0);
    const again = await checkReadingMisreads(target, service, { episodes, askRemote: true });
    expect(again).toEqual({ kind: "checked", found: 1, shown: 1 });
    expect(audioQueries()).toBe(first);
    // まだ並んでいる行は足し直さない
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  it("エンジンが起きていなければ、調べずに理由を返す（エンジンに届かない印つき）", async () => {
    const service = new VoiceReadingService(() => "http://127.0.0.1:9", undefined, async () => true);
    const outcome = await checkReadingMisreads(target, service, { episodes, askRemote: true });
    expect(outcome.kind).toBe("stopped");
    expect(outcome.kind === "stopped" && outcome.engineDown).toBe(true);
    expect(await new FindingStore(work).load()).toEqual([]);
  });

  it("書き出しの手前（確認の窓を出せない）では、許可していない外のホストへは問わない", async () => {
    const asked = vi.fn(async () => true);
    const service = new VoiceReadingService(() => "http://192.0.2.10:10101", undefined, asked);
    const outcome = await checkReadingMisreads(target, service, { episodes, askRemote: false });
    expect(outcome.kind).toBe("skipped");
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("［読みの辞書へ足す］", () => {
  it("押すと、その話の辞書に作者の項目が入り、次の計画ではその漢字が写しから消える。行は一覧から外れる", async () => {
    const service = await serviceWith({ 灯: "ヒ", 走: "ハシ" });
    await checkReadingMisreads(target, service, { episodes, askRemote: true });
    const [row] = await new FindingStore(work).load();
    const added = await addMisreadToDictionary(work, { ...row, filePath: EP2 });
    expect(added.ok).toBe(true);

    const { file } = await loadReadingDictionary(work, EP2);
    expect(file.entries).toEqual([{ word: "灯", quote: row.original, reading: "あかり", source: "author" }]);
    const spans = readingSpansFor(TEXT2, file.entries).spans;
    const plan = buildReadingPlan(TEXT2, "curly", spans, { splitDialogue: true });
    expect(plan[0].speech).toBe("あかりは走った。");

    const [after] = await new FindingStore(work).load();
    expect(after.status).toBe("accepted");
    // 次に調べても、辞書の読みで置き換わるので問う語にならない
    const outcome = await checkReadingMisreads(
      { ...target, readings: spans },
      service,
      { episodes, askRemote: true }
    );
    expect(outcome).toEqual({ kind: "checked", found: 0, shown: 0 });
  });

  it("同じ語・同じ句のAIの項目があれば、足さずに作者の項目へ直す", async () => {
    const service = await serviceWith({ 灯: "ヒ", 走: "ハシ" });
    await checkReadingMisreads(target, service, { episodes, askRemote: true });
    const [row] = await new FindingStore(work).load();
    const dictionaryPath = paths.join(work.folderPath, ".aiwriter", "readings", "本文__02.md.json");
    put(
      dictionaryPath,
      JSON.stringify({
        version: 1,
        episode: "本文/02.md",
        entries: [{ word: "灯", quote: row.original, reading: "ひ", source: "ai" }],
      })
    );
    expect((await addMisreadToDictionary(work, { ...row, filePath: EP2 })).ok).toBe(true);
    const { file } = await loadReadingDictionary(work, EP2);
    expect(file.entries).toEqual([{ word: "灯", quote: row.original, reading: "あかり", source: "author" }]);
  });
});
