import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import type { CastEntry, CastFile, VoiceAssignmentFile } from "../../../src/core/voiceCast";
import { startFakeVoiceEngine, type FakeEngine } from "../support/fakeVoiceEngine";

/**
 * 人物の声で朗読する（設計書6.42.3）の流れ。
 *
 * 動いたと言える条件：
 * 1. 製品のコード経由で /speakers → /audio_query → /synthesis が通り、
 *    **感情ごとにスタイル／調子が変わって送られる**（偽のエンジンが受けた頼みで見る）
 * 2. 先読みで後ろの文も作り、同じ文は二度作らない（控え）
 * 3. 推定（P-54）は割当 voiceCast のAIへ、スキーマ・think:false・温度0で送り、
 *    検算を通ったものだけ保存する。**作者が直した行は上書きしない**
 * 4. 2回目は控えが当たり、AIを呼ばない（内容ハッシュ＋プロバイダ＋モデル＋版）
 */

const state = vi.hoisted(() => ({
  generate: vi.fn(),
  confirmRun: vi.fn(async (_message: string, _label?: string, _options?: unknown) => true),
  paid: vi.fn(async () => true),
  cast: undefined as CastFile | undefined,
  savedCast: [] as Array<{ file: CastFile; hash: string | undefined }>,
  assignment: { version: 1, characters: {} } as VoiceAssignmentFile,
  chunkCache: new Map<string, unknown>(),
  warnings: [] as string[],
  done: [] as string[],
  steps: [] as string[],
}));

vi.mock("../../../src/ai/registry", () => ({
  AIRegistry: class {},
  ensureConfigured: vi.fn(async (_registry: unknown, feature: string) => {
    if (feature !== "voiceCast") throw new Error(`割当キーが違う：${feature}`);
    return {
      provider: { id: "ollama", displayName: "Ollama", isPaid: false, generate: state.generate },
      model: "gemma4:e4b",
    };
  }),
}));
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: state.paid,
  confirmProviderReachable: vi.fn(async () => true),
}));
vi.mock("../../../src/features/reportAIError", () => ({ reportAIError: vi.fn() }));
vi.mock("../../../src/views/progress", () => ({
  withCancellableProgress: async <T>(
    _title: string,
    task: (progress: unknown, token: unknown) => Promise<T>
  ) =>
    task(
      { report: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }
    ),
}));
vi.mock("../../../src/views/notify", () => ({
  confirmRun: state.confirmRun,
  notifyDone: (message: string) => state.done.push(message),
  warnWithLog: async (message: string) => {
    state.warnings.push(message);
  },
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: (message: string) => state.steps.push(message),
  logLine: vi.fn(),
  responseExcerptForLog: (text: string) => text,
  useLogFile: vi.fn(),
}));
vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load(): Promise<void> {}
    async save(): Promise<void> {}
    get(hash: string, base: Record<string, string>): unknown {
      return state.chunkCache.get(JSON.stringify([base, hash]));
    }
    async set(hash: string, base: Record<string, string>, value: unknown): Promise<void> {
      state.chunkCache.set(JSON.stringify([base, hash]), value);
    }
  },
}));
vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return {
        characters: [
          { id: "c-akari", name: "灯", aliases: ["あかりちゃん"], speechStyle: "丁寧語で話す" },
          { id: "c-ren", name: "蓮", aliases: [], speechStyle: null },
        ],
        errors: [],
      };
    }
  },
}));
vi.mock("../../../src/core/voiceCastStore", () => ({
  loadVoiceCast: async () => ({
    file: state.cast ?? { version: 1, episode: "01.txt", entries: [] },
    hash: state.cast ? "h1" : undefined,
  }),
  saveVoiceCast: async (_w: unknown, _e: unknown, file: CastFile, hash: string | undefined) => {
    state.savedCast.push({ file, hash });
    state.cast = file;
    return "h2";
  },
  loadVoiceAssignment: async () => ({ file: state.assignment, hash: undefined }),
  saveVoiceAssignment: async () => "h3",
}));

const { VoiceReadingService, runVoiceCast } = await import("../../../src/features/voiceReading");
const { buildReadingPlan } = await import("../../../src/core/readAloud");
type Registry = import("../../../src/ai/registry").AIRegistry;

const work = { id: "w1", title: "鉛の海", folderPath: "/w" } as WorkEntry;
const TEXT = "「やった！」と灯は笑った。\n蓮は「静かにしろ」と囁いた。";

function castEntry(quote: string, patch: Partial<CastEntry>): CastEntry {
  return {
    quote,
    nth: 0,
    speakerId: null,
    speakerName: null,
    emotion: "平静",
    intensity: "中",
    source: "ai",
    ...patch,
  };
}

beforeEach(() => {
  state.generate.mockReset();
  state.confirmRun.mockClear();
  state.cast = undefined;
  state.savedCast.length = 0;
  state.chunkCache.clear();
  state.warnings.length = 0;
  state.done.length = 0;
  state.steps.length = 0;
  state.assignment = {
    version: 1,
    narrator: { speakerUuid: "uuid-kanon", speakerName: "花音", styleName: "ノーマル", styleId: 1325133120 },
    characters: {
      "c-akari": {
        speakerUuid: "uuid-mai",
        speakerName: "まい",
        styleName: "ノーマル",
        styleId: 888753760,
        characterName: "灯",
      },
      "c-ren": {
        speakerUuid: "uuid-kanon",
        speakerName: "花音",
        styleName: "ノーマル",
        styleId: 1325133120,
        characterName: "蓮",
      },
    },
  };
});

describe("偽のエンジンで朗読の音を作る", () => {
  let engine: FakeEngine | undefined;
  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  test("感情ごとにスタイルと調子が変わって送られる。先読みし、同じ文は二度作らない", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [
        castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯", emotion: "喜び", intensity: "強" }),
        castEntry("「静かにしろ」", { speakerId: "c-ren", speakerName: "蓮", emotion: "ささやき", intensity: "中" }),
      ],
    };
    const service = new VoiceReadingService(() => url);
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences);
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units.map((u) => [u.speech, u.who, u.styleId])).toEqual([
      ["「やった！」", "灯", 888753761], // まいの「上機嫌」へ
      ["と灯は笑った。", "語り", 1325133120],
      ["蓮は", "語り", 1325133120],
      ["「静かにしろ」", "蓮", 1325133121], // 花音の「ささやき」へ
      ["と囁いた。", "語り", 1325133120],
    ]);

    const first = await service.audio(planned.units, 0, 1);
    expect("wav" in first).toBe(true);
    // 先読みの3文が作り終わるのを待つ
    await vi.waitFor(() =>
      expect(engine!.requests.filter((r) => r.path === "/synthesis")).toHaveLength(4)
    );

    const synth = engine.requests.filter((r) => r.path === "/synthesis");
    const joy = synth.find((r) => r.query.speaker === "888753761")?.body as Record<string, number>;
    const calm = synth.find((r) => r.query.speaker === "1325133120")?.body as Record<string, number>;
    const whisper = synth.find((r) => r.query.speaker === "1325133121")?.body as Record<string, number>;
    expect(joy.intonationScale).toBeGreaterThan(calm.intonationScale);
    expect(whisper.volumeScale).toBeLessThan(calm.volumeScale);
    expect(calm).toMatchObject({ speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1 });
    // audio_query は文字列とスタイルで頼む
    expect(engine.requests.find((r) => r.path === "/audio_query")?.query).toEqual({
      text: "「やった！」",
      speaker: "888753761",
    });

    // 先読み済みの文は控えから（エンジンへ頼まない）
    const before = engine.requests.length;
    await service.audio(planned.units, 1, 1);
    await service.audio(planned.units, 0, 1);
    // index 1 の先読みで index 4 だけが新しく作られる
    await vi.waitFor(() => expect(engine!.requests.length).toBe(before + 2));
  });

  test("速さを変えると speedScale に掛かり、別の音として作る", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    const service = new VoiceReadingService(() => url);
    const sentences = buildReadingPlan("地の文。", "curly", [], { splitDialogue: true });
    const planned = await service.plan(undefined, "/x.txt", "地の文。", sentences);
    if (!("units" in planned)) throw new Error(planned.problem);
    await service.audio(planned.units, 0, 1);
    await service.audio(planned.units, 0, 1.5);
    const speeds = engine.requests
      .filter((r) => r.path === "/synthesis")
      .map((r) => (r.body as Record<string, number>).speedScale);
    expect(speeds).toEqual([1, 1.5]);
  });

  test("エンジンが動いていないとき：計画は作らず、起動の案内を返す（投げない）", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    await engine.close();
    engine = undefined;
    const service = new VoiceReadingService(() => url);
    const planned = await service.plan(undefined, "/x.txt", "文。", buildReadingPlan("文。", "curly"));
    expect(planned).toEqual({
      problem: expect.stringContaining("AivisSpeech（または VOICEVOX）を起動してから、もう一度押してください"),
    });
  });
});

describe("台詞の話者と感情の推定（P-54）", () => {
  // 割当の解決は差し替えてあるので、登録簿の中身は使わない
  const registry = {} as Registry;

  test("割当 voiceCast のAIへ送り、検算を通ったものだけ保存する。作者の行は残す", async () => {
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「静かにしろ」", { speakerId: "c-akari", speakerName: "灯", source: "author" })],
    };
    state.generate.mockResolvedValue({
      text: JSON.stringify({
        lines: [
          { number: 1, speaker: "あかりちゃん", emotion: "喜び", intensity: "強" },
          // 作者が直した行は、AIが別の答えを返しても上書きしない
          { number: 2, speaker: "蓮", emotion: "ささやき", intensity: "中" },
        ],
      }),
    });

    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TEXT }, registry);

    expect(state.confirmRun).toHaveBeenCalledTimes(1);
    expect(state.confirmRun.mock.calls[0][0]).toContain("台詞2個");
    expect(state.confirmRun.mock.calls[0][0]).toContain("AIを1回呼びます");
    expect(state.generate).toHaveBeenCalledTimes(1);
    const request = state.generate.mock.calls[0][0];
    expect(request.userPrompt).toContain("〔1〕「やった！」");
    expect(request.userPrompt).toContain("〔2〕「静かにしろ」");
    expect(request.userPrompt).toContain("- 灯（別名：あかりちゃん） 口調：丁寧語で話す");
    expect(request.disableThinking).toBe(true);
    expect(request.temperature).toBe(0);
    expect(request.meta.feature).toBe("voiceCast");
    const schema = request.jsonSchema as {
      properties: { lines: { items: { properties: { speaker: { enum: string[] } } } } };
    };
    expect(schema.properties.lines.items.properties.speaker.enum).toEqual([
      "不明",
      "灯",
      "あかりちゃん",
      "蓮",
    ]);

    expect(state.savedCast).toHaveLength(1);
    expect(state.savedCast[0].hash).toBe("h1");
    const saved = state.savedCast[0].file.entries;
    expect(saved).toEqual([
      castEntry("「静かにしろ」", { speakerId: "c-akari", speakerName: "灯", source: "author" }),
      castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯", emotion: "喜び", intensity: "強" }),
    ]);
    expect(state.savedCast[0].file.lastRun).toMatchObject({ providerId: "ollama", model: "gemma4:e4b" });
  });

  test("通らない答えは捨てて数える。2回目は控えが当たりAIを呼ばない", async () => {
    state.generate.mockResolvedValue({
      text: JSON.stringify({
        lines: [
          { number: 1, speaker: "話者", emotion: "喜び", intensity: "中" },
          { number: 2, speaker: "蓮", emotion: "切ない", intensity: "中" },
        ],
      }),
    });
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TEXT }, registry);
    expect(state.savedCast[0].file.entries).toEqual([]);
    expect(state.steps.some((s) => s.includes("話者が指示の言葉のまま 1件") && s.includes("感情が列挙の外 1件"))).toBe(true);
    expect(state.done[0]).toContain("2個は決まらず");

    state.generate.mockClear();
    state.confirmRun.mockClear();
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TEXT }, registry);
    expect(state.generate).not.toHaveBeenCalled();
    // 送るものが無ければ確かめない
    expect(state.confirmRun).not.toHaveBeenCalled();
  });

  test("区切りが失敗したら書き換えない", async () => {
    state.generate.mockResolvedValue({ text: "ごめんなさい" });
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TEXT }, registry);
    expect(state.savedCast).toHaveLength(0);
    expect(state.warnings[0]).toContain("書き換えていません");
  });

  test("確認で取りやめたらAIを呼ばない", async () => {
    state.confirmRun.mockResolvedValueOnce(false);
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TEXT }, registry);
    expect(state.generate).not.toHaveBeenCalled();
  });
});
