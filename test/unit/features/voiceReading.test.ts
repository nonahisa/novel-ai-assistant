import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import type { CastEntry, CastFile, VoiceAssignmentFile } from "../../../src/core/voiceCast";
import { FAKE_VOICEVOX_SPEAKERS, startFakeVoiceEngine, type FakeEngine } from "../support/fakeVoiceEngine";
import { window } from "../support/vscodeStub";

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
  savedAssignments: [] as VoiceAssignmentFile[],
  chunkCache: new Map<string, unknown>(),
  warnings: [] as string[],
  done: [] as string[],
  steps: [] as string[],
  people: [] as Array<{ id: string; name: string; aliases: string[]; speechStyle: string | null }>,
}));

const DEFAULT_PEOPLE = [
  { id: "c-akari", name: "灯", aliases: ["あかりちゃん"], speechStyle: "丁寧語で話す" },
  { id: "c-ren", name: "蓮", aliases: [], speechStyle: null },
];

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
      return { characters: state.people, errors: [] };
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
  saveVoiceAssignment: async (_w: unknown, file: VoiceAssignmentFile) => {
    state.savedAssignments.push(file);
    return "h3";
  },
}));

const { VoiceReadingService, runVoiceCast, assignVoices } = await import("../../../src/features/voiceReading");
const { buildReadingPlan } = await import("../../../src/core/readAloud");
const { VOICE_ENGINE_LABEL } = await import("../../../src/core/voiceEngine");
const { unresolvedVoiceNotice, voicePlanNotice } = await import("../../../src/core/voiceCast");
type Registry = import("../../../src/ai/registry").AIRegistry;

const work = { id: "w1", title: "鉛の海", folderPath: "/w" } as WorkEntry;
const TEXT = "「やった！」と灯は笑った。\n「静かにしろ」と蓮は囁いた。";

/**
 * 声を選ぶ窓の行のうち、声の行だけ（区切りの見出し・調整の行・戻るを除く）。
 * 同じ声は上の区切りと下の区切りの両方に出るので、初めて出た所だけを残す
 */
function voiceRowsOf<T extends { label: string; description?: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.description?.endsWith("スタイルは感情に合わせて自動")) return false;
    const key = `${item.label}|${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  state.savedAssignments.length = 0;
  state.chunkCache.clear();
  state.warnings.length = 0;
  state.done.length = 0;
  state.steps.length = 0;
  state.people = DEFAULT_PEOPLE.map((p) => ({ ...p, aliases: [...p.aliases] }));
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
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech");
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units.map((u) => [u.speech, u.who, u.styleId])).toEqual([
      ["「やった！」", "灯", 888753761], // まいの「上機嫌」へ
      ["と灯は笑った。", "語り", 1325133120],
      ["「静かにしろ」", "蓮", 1325133121], // 花音の「ささやき」へ
      ["と蓮は囁いた。", "語り", 1325133120],
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
    // 4文すべてが先読みで作り済みなので、どちらもエンジンへ新しく頼まない
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine!.requests.length).toBe(before);
  });

  test("速さを変えると speedScale に掛かり、別の音として作る", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    const service = new VoiceReadingService(() => url);
    const sentences = buildReadingPlan("地の文。", "curly", [], { splitDialogue: true });
    const planned = await service.plan(undefined, "/x.txt", "地の文。", sentences, "aivisspeech");
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
    const planned = await service.plan(undefined, "/x.txt", "文。", buildReadingPlan("文。", "curly"), "aivisspeech");
    expect(planned).toEqual({
      // どちらのエンジンかを名指しする（0.146.0）
      problem: expect.stringContaining(
        "音声合成のエンジン（AivisSpeech）に繋がりませんでした。AivisSpeech を起動してから、もう一度押してください"
      ),
      // 届かなかったことを印で返す。原稿エディターはこの印で画面の真ん中に窓を出す
      // （右下の知らせ・列の小さな文では、作者がしばらく気づかなかった。2026-11-07 作者の実機確認）
      engineDown: true,
    });
  });

  test("エンジンが途中で落ちたとき：音の頼みも、届かなかった印つきで返す", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    const service = new VoiceReadingService(() => url);
    const planned = await service.plan(undefined, "/x.txt", "文。", buildReadingPlan("文。", "curly"), "aivisspeech");
    if (!("units" in planned)) throw new Error(planned.problem);
    await engine.close();
    engine = undefined;
    const result = await service.audio(planned.units, 0, 1);
    expect(result).toMatchObject({ engineDown: true });
  });

  test("［声の割り当て］でエンジンが動いていないとき：真ん中の窓を出し、右下の知らせは出さない（2026-11-08 作者の実機確認）", async () => {
    engine = await startFakeVoiceEngine();
    const url = engine.url;
    await engine.close();
    engine = undefined;
    const shown: Array<{ message: string; options: unknown; items: unknown[] }> = [];
    const original = window.showWarningMessage;
    window.showWarningMessage = (async (message: string, options: unknown, ...items: unknown[]) => {
      shown.push({ message, options, items });
      return undefined;
    }) as typeof window.showWarningMessage;
    try {
      await assignVoices(work, new VoiceReadingService(() => url), "aivisspeech");
    } finally {
      window.showWarningMessage = original;
    }
    expect(state.warnings).toEqual([]);
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain("音声合成のエンジン（AivisSpeech）に繋がりませんでした");
    expect(shown[0].options).toMatchObject({
      modal: true,
      detail: expect.stringContaining("AivisSpeech を起動してから、もう一度［声の割り当て］"),
    });
    // 割り当ての道では OS の声で読めないので、ボタンは付けない（閉じるだけ）
    expect(shown[0].items).toEqual([]);
  });

  test("［声の割り当て］でエンジンが受け付けなかったとき（http）は、今までどおり右下の知らせ", async () => {
    const service = new VoiceReadingService(
      () => "http://127.0.0.1:1",
      async () => new Response("壊れています", { status: 500 })
    );
    let modal = 0;
    const original = window.showWarningMessage;
    window.showWarningMessage = (async () => {
      modal++;
      return undefined;
    }) as typeof window.showWarningMessage;
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      window.showWarningMessage = original;
    }
    expect(modal).toBe(0);
    expect(state.warnings.join("\n")).toContain("受け付けませんでした");
  });
});

/*
  ［声］でエンジンを選び分ける（0.146.0。設計書6.42.3。実機確認リスト 0.146.0 の「VOICEVOX で読む・割り当てる」
  「エンジンを戻したときに代わりの声で読み、一言が出るか」のうち、機械で見られる所）。
  偽のエンジンを2つ立て、エンジンごとの接続先へ頼みが分かれて届くかを、受けた頼みで見る。
  声が自然か・読み分けて聞こえるかは耳の仕事なので、ここでは見ない。
  一言が「1回の読み上げで1回」なのは原稿エディターの受け口（読み始めのときだけ出す）の仕事で、
  ここでは計画が一言を返すところまで（画面は test/e2e/voiceEngineChoiceFlow.test.ts）
*/
describe("エンジンを選んだ声の割り当てと、戻したときの代わりの声（0.146.0）", () => {
  const engines: FakeEngine[] = [];
  afterEach(async () => {
    await Promise.all(engines.map((engine) => engine.close()));
    engines.length = 0;
  });

  /** AivisSpeech と VOICEVOX のふりをする偽のエンジンを1つずつ立て、エンジンごとに接続先を引く係を作る */
  async function twoEngines() {
    const aivis = await startFakeVoiceEngine();
    const voicevox = await startFakeVoiceEngine();
    engines.push(aivis, voicevox);
    const service = new VoiceReadingService((engine) => (engine === "voicevox" ? voicevox.url : aivis.url));
    return { aivis, voicevox, service };
  }

  /** 選ぶ画面の代役。出た題と並びを控え、`answers` を順に選ぶ（尽きたら閉じる） */
  function scriptQuickPick(answers: Array<(items: readonly unknown[]) => unknown>) {
    const shown: Array<{ title: string | undefined; items: Array<{ label: string; description?: string }> }> = [];
    const original = window.showQuickPick;
    window.showQuickPick = (async (items: readonly unknown[], options?: { title?: string }) => {
      shown.push({
        title: options?.title,
        items: (items as Array<{ label: string; description?: string }>).map((item) => ({
          label: item.label,
          description: item.description,
        })),
      });
      const answer = answers.shift();
      return answer ? answer(items) : undefined;
    }) as typeof window.showQuickPick;
    return { shown, restore: () => (window.showQuickPick = original) };
  }

  const labelled = (label: string) => (items: readonly unknown[]) =>
    (items as Array<{ label: string }>).find((item) => item.label === label);

  test("VOICEVOX を選んで［声の割り当て］を開くと、［声］の VOICEVOX の声を先に並べ、選んだ声に VOICEVOX の印を付けて残す", async () => {
    const { aivis, voicevox, service } = await twoEngines();
    const pick = scriptQuickPick([labelled("灯"), labelled("花音")]);
    try {
      await assignVoices(work, service, "voicevox");
    } finally {
      pick.restore();
    }
    // 2段目（0.151.0）：両方のエンジンの話者を並べる。［声］のエンジンを先に
    expect(pick.shown[0].title).toBe(
      `声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.voicevox}・${VOICE_ENGINE_LABEL.aivisspeech} の声から選べます）`
    );
    expect(pick.shown[1].title).toBe(`灯の声（${VOICE_ENGINE_LABEL.voicevox}・${VOICE_ENGINE_LABEL.aivisspeech}）`);
    // 行は話者だけ（ノーマル）。スタイルは感情に合わせて自動で選ぶ（作者の答え 2026-11-13）
    // 先頭は調整の行（声の決まっている枠だけ）、そのあとに区切りの見出しと声の行
    const voiceRows = voiceRowsOf(pick.shown[1].items);
    expect(voiceRows[0]).toEqual({
      label: "まい",
      description: `${VOICE_ENGINE_LABEL.voicevox}・スタイルは感情に合わせて自動`,
    });
    // 感情のスタイル（上機嫌・怒り・悲しみ・ささやき）の行は出さない
    const labels = voiceRows.map((item) => item.label);
    expect(labels.filter((label) => label.includes("／"))).toEqual([]);
    expect(voicevox.requests.filter((r) => r.path === "/speakers").length).toBeGreaterThan(0);
    // もう片方は話者の一覧と、区切りに使うモデルの説明だけ（本文を運ぶ頼みは無い）
    expect(aivis.requests.map((r) => r.path)).toEqual(["/speakers", "/aivm_models"]);
    expect(aivis.requests.filter((r) => r.path === "/audio_query" || r.path === "/synthesis")).toEqual([]);
    expect(state.savedAssignments).toHaveLength(1);
    expect(state.savedAssignments[0].characters["c-akari"]).toMatchObject({
      speakerUuid: "uuid-kanon",
      styleName: "ノーマル",
      styleId: 1325133120,
      engine: "voicevox",
      characterName: "灯",
    });
  });

  test("［声の割り当て］の一覧で、前の版で選んだ感情のスタイル（まい／上機嫌）は「感情に合わせて自動」で出る（ファイルは書き換えない）", async () => {
    const { service } = await twoEngines();
    state.assignment.characters["c-akari"] = {
      ...state.assignment.characters["c-akari"],
      styleName: "上機嫌",
      styleId: 888753761,
      engine: "voicevox",
    };
    const pick = scriptQuickPick([]);
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      pick.restore();
    }
    expect(pick.shown[0].items.find((item) => item.label === "灯")?.description).toBe(
      `まい（感情に合わせて自動・${VOICE_ENGINE_LABEL.voicevox}）`
    );
    expect(state.savedAssignments).toHaveLength(0);
  });

  test("［声の割り当て］の一覧で、人物の声にエンジンの名前が添えてある", async () => {
    const { service } = await twoEngines();
    state.assignment.characters["c-akari"] = { ...state.assignment.characters["c-akari"], engine: "voicevox" };
    const pick = scriptQuickPick([]);
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      pick.restore();
    }
    const row = pick.shown[0].items.find((item) => item.label === "灯");
    // 混ぜて読めるので、注意ではなくエンジンの名前として添える（0.151.0）
    expect(row?.description).toBe(`まい（感情に合わせて自動・${VOICE_ENGINE_LABEL.voicevox}）`);
    // 同じエンジンの印が無い前の版の声（蓮）は、前の版の声として添える
    expect(pick.shown[0].items.find((item) => item.label === "蓮")?.description).toBe(
      "花音（感情に合わせて自動・前の版で選んだ声）"
    );
  });

  test("［声］を AivisSpeech にしていても、VOICEVOX で選んだ人物の台詞は VOICEVOX で読む（2段目。0.151.0）", async () => {
    const { aivis, voicevox, service } = await twoEngines();
    state.assignment.characters["c-akari"] = { ...state.assignment.characters["c-akari"], engine: "voicevox" };
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯" })],
    };
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units[0]).toMatchObject({ speech: "「やった！」", who: "灯", styleId: 888753760, engine: "voicevox" });
    expect(planned.units[1]).toMatchObject({ engine: "aivisspeech" });
    expect(planned.notice).toBeUndefined();
    const result = await service.audio(planned.units, 0, 1);
    expect("wav" in result).toBe(true);
    expect(voicevox.requests.find((r) => r.path === "/audio_query")?.query.text).toBe("「やった！」");
    await vi.waitFor(() => expect(aivis.requests.filter((r) => r.path === "/synthesis").length).toBeGreaterThan(0));
    expect(aivis.requests.some((r) => r.path === "/audio_query" && r.query.text === "「やった！」")).toBe(false);
  });

  test("前の版で選んだ（印の無い）声が一覧から消えていれば、代わりの声で読み、［声の割り当て］へ案内する一言を返す", async () => {
    const { service } = await twoEngines();
    state.assignment.characters["c-akari"] = {
      ...state.assignment.characters["c-akari"],
      speakerUuid: "uuid-gone",
      styleName: "消えた",
    };
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯" })],
    };
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units[0]).toMatchObject({ who: "灯", styleId: 1325133120, engine: "aivisspeech" });
    expect(planned.notice).toBe(unresolvedVoiceNotice(["灯"], VOICE_ENGINE_LABEL.aivisspeech));
    expect(planned.notice).toContain(`割り当てた声のうち 灯 の声が ${VOICE_ENGINE_LABEL.aivisspeech} に見つからないので`);
  });
});

/*
  人物ごとにエンジンを混ぜる（2段目。0.151.0。作者の決定 2026-11-08）。偽のエンジンを2つ（AivisSpeech の話者と
  VOICEVOX の話者）立て、1回の読み上げで2つのエンジンへ頼みが分かれて届くか・片方が閉じていたら代わりの声で
  読むか・［声の割り当て］に両方の声が並ぶかを、受けた頼みで見る
*/
describe("声を選ぶ窓の区切りと、人物ごとの声の調整（作者の頼み 2026-11-13）", () => {
  const engines: FakeEngine[] = [];
  afterEach(async () => {
    await Promise.all(engines.map((engine) => engine.close()));
    engines.length = 0;
  });

  async function oneEngine() {
    const aivis = await startFakeVoiceEngine();
    engines.push(aivis);
    // VOICEVOX 役は立てない（繋がらない口）。両方へ同じ偽を向けると同じ声が2つずつ並ぶ
    return { aivis, service: new VoiceReadingService((engine) => (engine === "voicevox" ? "http://127.0.0.1:9" : aivis.url)) };
  }

  /** 選ぶ画面の代役（区切りの見出しも控える）。`answers` を順に選ぶ（尽きたら閉じる） */
  function scriptQuickPick(answers: Array<(items: readonly unknown[]) => unknown>) {
    const shown: Array<{ title: string | undefined; items: Array<{ label: string; description?: string; separator: boolean }> }> = [];
    const original = window.showQuickPick;
    window.showQuickPick = (async (items: readonly unknown[], options?: { title?: string }) => {
      shown.push({
        title: options?.title,
        items: (items as Array<{ label: string; description?: string; kind?: number }>).map((item) => ({
          label: item.label,
          description: item.description,
          separator: item.kind === -1,
        })),
      });
      const answer = answers.shift();
      return answer ? answer(items) : undefined;
    }) as typeof window.showQuickPick;
    return { shown, restore: () => (window.showQuickPick = original) };
  }
  const labelled = (label: string) => (items: readonly unknown[]) =>
    (items as Array<{ label: string; kind?: number }>).find((item) => item.label === label && item.kind !== -1);

  /** globalState の代役（verifiedState と同じ読み書きの形） */
  function memory(initial: Record<string, unknown> = {}) {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
      values,
      get<T>(key: string, defaultValue: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        values.set(key, value);
      },
    };
  }

  test("区切りは「この作品で使っている声」→「よく使う声」→ 声の印象の順。speakerGroups の直しが効き、選ぶとよく使う声を数える", async () => {
    const { service } = await oneEngine();
    state.assignment = { ...state.assignment, speakerGroups: { "uuid-mai": "女性" } };
    // 蓮だけが花音を使っている作品にする（灯は割り当てを外す）
    delete state.assignment.characters["c-akari"];
    state.assignment.narrator = undefined;
    const store = memory({ "novelai.voiceAssign.pickCounts": { "aivisspeech|uuid-mai": 3 } });
    const pick = scriptQuickPick([labelled("灯"), labelled("まい")]);
    try {
      await assignVoices(work, service, "aivisspeech", store);
    } finally {
      pick.restore();
    }
    const voices = pick.shown[1].items;
    expect(voices.filter((item) => item.separator).map((item) => item.label)).toEqual([
      "この作品で使っている声",
      "よく使う声",
      "女性",
      "その他",
    ]);
    // 区切りの中の声：使っている＝花音、よく使う＝まい、女性＝まい（直し）、その他＝花音
    const sectionOf = (heading: string) => {
      const start = voices.findIndex((item) => item.separator && item.label === heading);
      const next = voices.findIndex((item, index) => index > start && item.separator);
      return voices.slice(start + 1, next === -1 ? undefined : next).filter((item) => !item.label.includes("戻る")).map((item) => item.label);
    };
    expect(sectionOf("この作品で使っている声")).toEqual(["花音"]);
    expect(sectionOf("よく使う声")).toEqual(["まい"]);
    expect(sectionOf("女性")).toEqual(["まい"]);
    expect(sectionOf("その他")[0]).toBe("花音");
    // 声の決まっていない枠（灯）には調整の行を出さない
    expect(voices.some((item) => item.label === "この声の高さ・速さ・抑揚を変える")).toBe(false);
    expect(store.values.get("novelai.voiceAssign.pickCounts")).toEqual({ "aivisspeech|uuid-mai": 4 });
  });

  test("調整の行から見本「老けた声」を1回で選べ、声を選び直しても調整と区切りの直しは残る", async () => {
    const { service } = await oneEngine();
    state.assignment = { ...state.assignment, speakerGroups: { "uuid-mai": "女性" } };
    const pick = scriptQuickPick([
      labelled("灯"),
      labelled("この声の高さ・速さ・抑揚を変える"),
      labelled("見本：老けた声"),
    ]);
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      pick.restore();
    }
    expect(pick.shown[2].title).toBe("灯の声の調整（いまは標準）");
    expect(pick.shown[2].items.find((item) => item.label === "見本：老けた声")?.description).toBe("高さ −0.06・速さ 0.85・抑揚 0.8");
    expect(state.savedAssignments[0].characters["c-akari"].adjust).toEqual({ pitch: -0.06, speed: 0.85, intonation: 0.8 });
    expect(state.savedAssignments[0].speakerGroups).toEqual({ "uuid-mai": "女性" });

    // 調整のある声を選び直す：調整は残り、一覧の枠に添えてある
    state.savedAssignments.length = 0;
    state.assignment.characters["c-akari"] = { ...state.assignment.characters["c-akari"], adjust: { pitch: -0.06, speed: 0.85, intonation: 0.8 } };
    const again = scriptQuickPick([labelled("灯"), labelled("花音")]);
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      again.restore();
    }
    expect(again.shown[0].items.find((item) => item.label === "灯")?.description).toBe(
      "まい（感情に合わせて自動・前の版で選んだ声）（高さ −0.06・速さ 0.85・抑揚 0.8）"
    );
    expect(state.savedAssignments[0].characters["c-akari"]).toMatchObject({
      speakerUuid: "uuid-kanon",
      adjust: { pitch: -0.06, speed: 0.85, intonation: 0.8 },
      characterName: "灯",
    });
    expect(state.savedAssignments[0].speakerGroups).toEqual({ "uuid-mai": "女性" });
  });

  test("高さだけを段から選ぶと、その欄だけを残す。［調整を外す］で欄ごと外す", async () => {
    const { service } = await oneEngine();
    const pick = scriptQuickPick([labelled("灯"), labelled("この声の高さ・速さ・抑揚を変える"), labelled("高さ"), labelled("+0.03")]);
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      pick.restore();
    }
    expect(pick.shown[3].items.map((item) => item.label)).toEqual(["−0.06", "−0.03", "0", "+0.03", "+0.06", expect.stringContaining("戻る")]);
    expect(state.savedAssignments[0].characters["c-akari"].adjust).toEqual({ pitch: 0.03 });

    state.savedAssignments.length = 0;
    state.assignment.characters["c-akari"] = { ...state.assignment.characters["c-akari"], adjust: { pitch: 0.03 } };
    const off = scriptQuickPick([labelled("灯"), labelled("この声の高さ・速さ・抑揚を変える"), labelled("調整を外す（標準に戻す）")]);
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      off.restore();
    }
    expect(state.savedAssignments[0].characters["c-akari"]).not.toHaveProperty("adjust");
  });

  test("人物の調整は、朗読と書き出しの両方の道で、エンジンへの頼みの値に効く", async () => {
    const { aivis, service } = await oneEngine();
    const aged = { pitch: -0.06, speed: 0.85, intonation: 0.8 };
    state.assignment.characters["c-akari"] = { ...state.assignment.characters["c-akari"], adjust: aged };
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯", emotion: "平静", intensity: "中" })],
    };
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech");
    if (!("units" in planned)) throw new Error(planned.problem);
    const akari = planned.units[0];
    expect(akari.adjust).toEqual(aged);
    // 語り（花音）には灯の調整を当てない
    expect(planned.units[1].adjust).toBeUndefined();

    await service.synthesize(akari, 1);
    await service.synthesizeForExport(akari, 1, new AbortController().signal, { outputSamplingRate: 24000 });
    const bodies = aivis.requests
      .filter((r) => r.path === "/synthesis" && r.query.speaker === "888753760")
      .map((r) => r.body as Record<string, number>);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ speedScale: 0.85, pitchScale: -0.06, intonationScale: 0.8 });
    }
  });
});

describe("人物ごとにエンジンを混ぜる（2段目。0.151.0）", () => {
  const engines: FakeEngine[] = [];
  afterEach(async () => {
    await Promise.all(engines.map((engine) => engine.close()));
    engines.length = 0;
  });

  const ZUNDA = {
    speakerUuid: "uuid-zunda",
    speakerName: "ずんだもん",
    styleName: "ノーマル",
    styleId: 3,
    engine: "voicevox" as const,
  };

  async function mixed(options: { voicevoxClosed?: boolean; voicevoxUrl?: string } = {}) {
    const aivis = await startFakeVoiceEngine();
    const voicevox = await startFakeVoiceEngine({ speakers: FAKE_VOICEVOX_SPEAKERS });
    engines.push(aivis);
    const voicevoxUrl = options.voicevoxUrl ?? voicevox.url;
    if (options.voicevoxClosed) await voicevox.close();
    else engines.push(voicevox);
    const service = new VoiceReadingService((engine) => (engine === "voicevox" ? voicevoxUrl : aivis.url));
    // 語り手は AivisSpeech の花音、灯は VOICEVOX のずんだもん
    state.assignment = {
      version: 1,
      narrator: {
        speakerUuid: "uuid-kanon",
        speakerName: "花音",
        styleName: "ノーマル",
        styleId: 1325133120,
        engine: "aivisspeech",
      },
      characters: { "c-akari": { ...ZUNDA, characterName: "灯" } },
    };
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯", emotion: "喜び" })],
    };
    return { aivis, voicevox, service };
  }

  test("1回の読み上げで、灯の台詞は VOICEVOX・語りは AivisSpeech へ頼み、続けて全部の音ができる", async () => {
    const { aivis, voicevox, service } = await mixed();
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units.map((u) => [u.speech, u.engine, u.styleId])).toEqual([
      ["「やった！」", "voicevox", 1], // ずんだもんの「あまあま」（喜び）
      ["と灯は笑った。", "aivisspeech", 1325133120],
      ["「静かにしろ」", "aivisspeech", 1325133120], // 蓮は推定が無いので台詞の既定→語り
      ["と蓮は囁いた。", "aivisspeech", 1325133120],
    ]);
    for (let i = 0; i < planned.units.length; i++) {
      expect("wav" in (await service.audio(planned.units, i, 1))).toBe(true);
    }
    const said = (engine: FakeEngine) =>
      engine.requests.filter((r) => r.path === "/audio_query").map((r) => r.query.text);
    expect(said(voicevox)).toEqual(["「やった！」"]);
    expect(said(aivis).sort()).toEqual(["「静かにしろ」", "と灯は笑った。", "と蓮は囁いた。"].sort());
  });

  test("VOICEVOX が閉じていれば、灯の台詞は AivisSpeech の代わりの声で読み、VOICEVOX を名指しする一言を返す（止めない）", async () => {
    const { aivis, service } = await mixed({ voicevoxClosed: true });
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units.every((u) => u.engine === "aivisspeech")).toBe(true);
    expect(planned.units[0]).toMatchObject({ who: "灯", styleId: 1325133120 });
    expect(planned.notice).toBe(
      "VOICEVOX に繋がらないので、灯 の声は代わりの声（台詞の既定か語りの声）で読みます。" +
        "VOICEVOX を起動してからもう一度押すと、割り当てた声で読みます。"
    );
    expect("wav" in (await service.audio(planned.units, 0, 1))).toBe(true);
    expect(aivis.requests.some((r) => r.path === "/audio_query" && r.query.text === "「やった！」")).toBe(true);
  });

  test("閉じていたエンジンには、次に読み始めるまで問い合わせ直さない（読んでいる途中の取り直しで毎回待たせない）", async () => {
    const closed = await startFakeVoiceEngine();
    const url = closed.url;
    await closed.close();
    const { service } = await mixed({ voicevoxUrl: url });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
      await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
      const toVoicevox = () => fetchSpy.mock.calls.filter(([input]) => String(input).startsWith(url)).length;
      const first = toVoicevox();
      expect(first).toBeGreaterThan(0);
      const again = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech");
      expect(toVoicevox()).toBe(first);
      // 取り直しの計画でも、代わりの声のまま（一言は読み始めのときだけ原稿エディターが出す）
      if (!("units" in again)) throw new Error(again.problem);
      expect(again.units[0].engine).toBe("aivisspeech");
      await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
      expect(toVoicevox()).toBeGreaterThan(first);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("割り当てに無いエンジンには問い合わせない（前もって問い合わせない決まり）", async () => {
    const { voicevox, service } = await mixed();
    delete state.assignment.characters["c-akari"];
    const sentences = buildReadingPlan(TEXT, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", TEXT, sentences, "aivisspeech", { start: true });
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(voicevox.requests).toHaveLength(0);
  });

  test("先読みの文が外のホストのエンジンの声なら、確認の前に本文を送らない", async () => {
    // VOICEVOX を外のホストに見せる（中身は手元の偽のエンジン。確認で断る）
    const voicevoxReal = await startFakeVoiceEngine({ speakers: FAKE_VOICEVOX_SPEAKERS });
    engines.push(voicevoxReal);
    const aivis = await startFakeVoiceEngine();
    engines.push(aivis);
    const remote = "http://voice.example.com:50021";
    const calls: string[] = [];
    const impl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push(input);
      return fetch(input.replace(remote, voicevoxReal.url), init);
    };
    const confirm = vi.fn(async (_host: string) => false);
    const service = new VoiceReadingService((engine) => (engine === "voicevox" ? remote : aivis.url), impl, confirm);
    state.assignment = {
      version: 1,
      characters: { "c-akari": { ...ZUNDA, characterName: "灯" } },
    };
    const text = "地の文。\n「やった！」と灯は笑った。";
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯" })],
    };
    const sentences = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    const planned = await service.plan(work, "/w/01.txt", text, sentences, "aivisspeech", { start: true });
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units[1].engine).toBe("voicevox");
    const carrying = () => calls.filter((u) => u.startsWith(remote) && /\/(audio_query|synthesis)/.test(u));
    // 1文目（AivisSpeech）を頼むと、後ろの VOICEVOX の文が先読みに入る
    expect("wav" in (await service.audio(planned.units, 0, 1))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(carrying()).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    // その文を頼まれたときに確認し、断られたら送らない
    const answer = await service.audio(planned.units, 1, 1);
    expect(answer).toEqual({ problem: expect.stringContaining("voice.example.com:50021") });
    expect(confirm).toHaveBeenCalledWith("voice.example.com:50021");
    expect(carrying()).toEqual([]);
  });

  test("［声の割り当て］に両方のエンジンの話者が並び、どちらの声もそのエンジンの印で残す", async () => {
    const { service } = await mixed();
    const original = window.showQuickPick;
    const shown: Array<{ title?: string; items: Array<{ label: string; description?: string }> }> = [];
    const answers = [
      (items: readonly unknown[]) => (items as Array<{ label: string }>).find((i) => i.label === "蓮"),
      (items: readonly unknown[]) =>
        (items as Array<{ label: string; description?: string }>).find(
          (i) => i.label === "四国めたん" && i.description?.startsWith(VOICE_ENGINE_LABEL.voicevox)
        ),
    ];
    window.showQuickPick = (async (items: readonly unknown[], options?: { title?: string }) => {
      shown.push({
        title: options?.title,
        items: (items as Array<{ label: string; description?: string }>).map((i) => ({
          label: i.label,
          description: i.description,
        })),
      });
      return answers.shift()?.(items);
    }) as typeof window.showQuickPick;
    try {
      await assignVoices(work, service, "aivisspeech");
    } finally {
      window.showQuickPick = original;
    }
    const voices = voiceRowsOf(shown[1].items);
    const auto = "・スタイルは感情に合わせて自動";
    expect(voices.find((i) => i.label === "まい")?.description).toBe(`${VOICE_ENGINE_LABEL.aivisspeech}${auto}`);
    expect(voices.find((i) => i.label === "ずんだもん")?.description).toBe(`${VOICE_ENGINE_LABEL.voicevox}${auto}`);
    // ［声］の AivisSpeech の声が先
    expect(voices[0].description).toBe(`${VOICE_ENGINE_LABEL.aivisspeech}${auto}`);
    expect(shown[0].items.find((i) => i.label === "灯")?.description).toBe(
      `ずんだもん（感情に合わせて自動・${VOICE_ENGINE_LABEL.voicevox}）`
    );
    expect(state.savedAssignments[0].characters["c-ren"]).toMatchObject({
      speakerUuid: "uuid-metan",
      styleId: 2,
      engine: "voicevox",
      characterName: "蓮",
    });
  });

  /** 選ぶ画面の代役（何も選ばずに閉じる）。出た題と説明の欄を控える */
  async function openAssign(service: InstanceType<typeof VoiceReadingService>, engine: "aivisspeech" | "voicevox") {
    const original = window.showQuickPick;
    const originalWarn = window.showWarningMessage;
    const shown: Array<{ title?: string; placeHolder?: string }> = [];
    let modal = 0;
    window.showQuickPick = (async (_items: readonly unknown[], options?: { title?: string; placeHolder?: string }) => {
      shown.push({ title: options?.title, placeHolder: options?.placeHolder });
      return undefined;
    }) as typeof window.showQuickPick;
    window.showWarningMessage = (async () => {
      modal++;
      return undefined;
    }) as typeof window.showWarningMessage;
    try {
      await assignVoices(work, service, engine);
    } finally {
      window.showQuickPick = original;
      window.showWarningMessage = originalWarn;
    }
    return { shown, modal };
  }

  test("［声の割り当て］で片方のエンジンが閉じていれば、動いている側の声だけ並べ、閉じている側を一言で知らせる", async () => {
    const { service } = await mixed({ voicevoxClosed: true });
    const { shown, modal } = await openAssign(service, "aivisspeech");
    expect(modal).toBe(0);
    expect(shown[0].title).toBe(`声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.aivisspeech} の声から選べます）`);
    expect(shown[0].placeHolder).toBe(
      "VOICEVOX に繋がらないので、VOICEVOX の声は並んでいません（VOICEVOX を起動してから開き直すと並びます）。"
    );
    expect(state.warnings).toEqual([]);
  });

  test("［声の割り当て］で［声］のエンジンが閉じていても、もう片方が動いていれば、その声から選べる（窓は出さない）", async () => {
    const closed = await startFakeVoiceEngine();
    const url = closed.url;
    await closed.close();
    const voicevox = await startFakeVoiceEngine({ speakers: FAKE_VOICEVOX_SPEAKERS });
    engines.push(voicevox);
    const service = new VoiceReadingService((engine) => (engine === "voicevox" ? voicevox.url : url));
    const { shown, modal } = await openAssign(service, "aivisspeech");
    expect(modal).toBe(0);
    expect(shown[0].title).toBe(`声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.voicevox} の声から選べます）`);
    expect(shown[0].placeHolder).toContain("AivisSpeech に繋がらないので");
  });

  test("一言の組み立て：見つからない声と届かないエンジンを、エンジンの名前で分けて書く", () => {
    const notice = voicePlanNotice(
      {
        missing: [{ engine: "aivisspeech", slots: ["蓮"] }],
        down: [{ engine: "voicevox", slots: ["灯", "語り手"] }],
      },
      new Map([["voicevox", "timeout"]])
    );
    expect(notice).toContain("割り当てた声のうち 蓮 の声が AivisSpeech に見つからないので");
    expect(notice).toContain("VOICEVOX から話者の一覧を受け取れなかったので、灯・語り手 の声は代わりの声");
  });
});

describe("この PC の外のエンジンへ本文を送る前の確認", () => {
  /** 送られた頼みの宛先を数える偽の fetch（話者の一覧・音声の返事を最小限で返す） */
  function fakeFetch() {
    const calls: string[] = [];
    const impl = async (input: string): Promise<Response> => {
      calls.push(input);
      const path = new URL(input).pathname;
      if (path === "/speakers") {
        return new Response(
          JSON.stringify([
            { name: "まい", speaker_uuid: "u", styles: [{ name: "ノーマル", id: 1, type: "talk" }] },
          ])
        );
      }
      if (path === "/audio_query") return new Response(JSON.stringify({ speedScale: 1 }));
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]));
    };
    return { calls, impl };
  }
  async function planned(service: InstanceType<typeof VoiceReadingService>) {
    const sentences = buildReadingPlan("地の文。", "curly", [], { splitDialogue: true });
    const result = await service.plan(undefined, "/x.txt", "地の文。", sentences, "aivisspeech");
    if (!("units" in result)) throw new Error(result.problem);
    return result.units;
  }

  test("外のホストでは、本文を送る前に確認し、断られたら本文を1文字も送らない", async () => {
    const { calls, impl } = fakeFetch();
    const confirm = vi.fn(async (_host: string) => false);
    const service = new VoiceReadingService(() => "http://voice.example.com:10101", impl, confirm);
    const units = await planned(service);
    const answer = await service.audio(units, 0, 1);
    expect(confirm).toHaveBeenCalledWith("voice.example.com:10101");
    expect(answer).toEqual({ problem: expect.stringContaining("voice.example.com:10101") });
    // 話者の一覧（本文なし）は通るが、本文を運ぶ audio_query／synthesis は送らない
    expect(calls.filter((u) => /\/(audio_query|synthesis)/.test(u))).toEqual([]);
  });

  test("［送る］を押したら送る。同じホストへは、同じ起動の間は訊き直さない", async () => {
    const { calls, impl } = fakeFetch();
    const confirm = vi.fn(async (_host: string) => true);
    const service = new VoiceReadingService(() => "http://voice.example.com:10101", impl, confirm);
    const units = await planned(service);
    expect("wav" in (await service.audio(units, 0, 1))).toBe(true);
    expect("wav" in (await service.audio(units, 0, 1.5))).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some((u) => u.includes("/audio_query"))).toBe(true);
  });

  test("この PC のエンジン（127.0.0.1）では確認を出さない", async () => {
    const { impl } = fakeFetch();
    const confirm = vi.fn(async (_host: string) => false);
    const service = new VoiceReadingService(() => "http://127.0.0.1:10101", impl, confirm);
    const units = await planned(service);
    expect("wav" in (await service.audio(units, 0, 1))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});

/** 頼みのスキーマの欄の名前（どちらの段の頼みかを、スキーマで見分ける） */
function fieldsOf(request: { jsonSchema: unknown }): string[] {
  const schema = request.jsonSchema as { properties: { lines: { items: { properties: object } } } };
  return Object.keys(schema.properties.lines.items.properties);
}

/**
 * 偽のAI：1段目（話者の欄があるスキーマ）と2段目（感情の欄だけ）で別の答えを返す。
 * **段を取り違えて頼むと、もう一方の段の答えが返り、検算で落ちる**ので取り違えを拾える
 */
function staged(speakerLines: unknown[], emotionLines: unknown[]): void {
  state.generate.mockImplementation(async (request: { jsonSchema: unknown }) => ({
    text: JSON.stringify({ lines: fieldsOf(request).includes("speaker") ? speakerLines : emotionLines }),
  }));
}

describe("台詞の話者と感情の推定（P-54）", () => {
  // 割当の解決は差し替えてあるので、登録簿の中身は使わない
  const registry = {} as Registry;
  // 話者が地の文に書いていない本文（AIの道を確かめる。書いてあるとコードが先に決める。版1.2）
  const CAST_TEXT = "「やった！」\n「静かにしろ」";

  test("割当 voiceCast のAIへ2段で送り（話者だけ→感情だけ）、検算を通ったものだけ保存する。作者の行は残す", async () => {
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「静かにしろ」", { speakerId: "c-akari", speakerName: "灯", source: "author" })],
    };
    staged(
      [
        { number: 1, speaker: "あかりちゃん" },
        // 作者が直した行は、AIが別の答えを返しても上書きしない
        { number: 2, speaker: "蓮" },
      ],
      [
        { number: 1, emotion: "喜び", intensity: "強" },
        { number: 2, emotion: "ささやき", intensity: "中" },
      ]
    );

    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);

    expect(state.confirmRun).toHaveBeenCalledTimes(1);
    expect(state.confirmRun.mock.calls[0][0]).toContain("台詞2個");
    // 2段に分けたので、呼ぶ回数は区切りの数の2倍。内訳も示す
    expect(state.confirmRun.mock.calls[0][0]).toContain("AIを2回呼びます（話者1回・感情1回");
    expect(state.generate).toHaveBeenCalledTimes(2);
    const [speakerRequest, emotionRequest] = state.generate.mock.calls.map((c) => c[0]);
    // 1段目：話者だけ。人物の一覧を渡し、感情は訊かない
    expect(speakerRequest.userPrompt).toContain("〔1〕「やった！」");
    expect(speakerRequest.userPrompt).toContain("〔2〕「静かにしろ」");
    expect(speakerRequest.userPrompt).toContain("- 灯（別名：あかりちゃん） 口調：丁寧語で話す");
    expect(fieldsOf(speakerRequest)).toEqual(["number", "speaker"]);
    expect(
      (speakerRequest.jsonSchema as { properties: { lines: { items: { properties: { speaker: { enum: string[] } } } } } })
        .properties.lines.items.properties.speaker.enum
    ).toEqual(["不明", "灯", "あかりちゃん", "蓮"]);
    // 2段目：感情と強さだけ。人物の一覧は渡さない
    expect(emotionRequest.userPrompt).toContain("〔1〕「やった！」");
    expect(emotionRequest.userPrompt).not.toContain("【登場人物】");
    expect(fieldsOf(emotionRequest)).toEqual(["number", "emotion", "intensity"]);
    for (const request of [speakerRequest, emotionRequest]) {
      expect(request.disableThinking).toBe(true);
      expect(request.temperature).toBe(0);
      expect(request.meta.feature).toBe("voiceCast");
    }

    expect(state.savedCast).toHaveLength(1);
    expect(state.savedCast[0].hash).toBe("h1");
    const saved = state.savedCast[0].file.entries;
    expect(saved).toEqual([
      castEntry("「静かにしろ」", { speakerId: "c-akari", speakerName: "灯", source: "author" }),
      castEntry("「やった！」", { speakerId: "c-akari", speakerName: "灯", emotion: "喜び", intensity: "強" }),
    ]);
    expect(state.savedCast[0].file.lastRun).toMatchObject({ providerId: "ollama", model: "gemma4:e4b" });
  });

  test("通らない答えは段ごとに捨てて数える。2回目は両段とも控えが当たりAIを呼ばない", async () => {
    staged(
      [
        { number: 1, speaker: "話者" },
        { number: 2, speaker: "蓮" },
      ],
      [
        { number: 1, emotion: "喜び", intensity: "中" },
        { number: 2, emotion: "切ない", intensity: "中" },
        { number: 3, emotion: "平静", intensity: "中" },
      ]
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    // 話者を捨てた台詞も感情は残る。感情を捨てた台詞は、話者が分かれば「平静・中」
    expect(state.savedCast[0].file.entries).toEqual([
      castEntry("「やった！」", { emotion: "喜び" }),
      castEntry("「静かにしろ」", { speakerId: "c-ren", speakerName: "蓮" }),
    ]);
    const dropLine = state.steps.find((s) => s.includes("検算で"));
    expect(dropLine).toContain("話者の段 1件（話者が指示の言葉のまま 1件）");
    expect(dropLine).toContain("感情の段 2件（感情が列挙の外 1件・番号が区切りに無い 1件）");
    expect(state.savedCast[0].file.lastRun).toMatchObject({ dropped: 3, droppedSpeaker: 1, droppedEmotion: 2 });

    state.generate.mockClear();
    state.confirmRun.mockClear();
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    expect(state.generate).not.toHaveBeenCalled();
    // 送るものが無ければ確かめない
    expect(state.confirmRun).not.toHaveBeenCalled();
  });

  test("段ごとの控え：人物の一覧だけが変わったら、1段目だけ送り直す（感情の段は当たる）", async () => {
    staged([{ number: 1, speaker: "灯" }, { number: 2, speaker: "蓮" }], [
      { number: 1, emotion: "喜び", intensity: "中" },
      { number: 2, emotion: "ささやき", intensity: "中" },
    ]);
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    expect(state.generate).toHaveBeenCalledTimes(2);

    state.generate.mockClear();
    state.people.push({ id: "c-sora", name: "空", aliases: [], speechStyle: null });
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(fieldsOf(state.generate.mock.calls[0][0])).toEqual(["number", "speaker"]);
    expect(state.confirmRun.mock.calls.at(-1)?.[0]).toContain("AIを1回呼びます（話者1回・感情0回");
  });

  test("1段目が全部「不明」でも、2段目を呼んで感情を残す", async () => {
    staged(
      [
        { number: 1, speaker: "不明" },
        { number: 2, speaker: "不明" },
      ],
      [
        { number: 1, emotion: "驚き", intensity: "強" },
        { number: 2, emotion: "恐れ", intensity: "弱" },
      ]
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    expect(state.generate).toHaveBeenCalledTimes(2);
    expect(state.savedCast[0].file.entries).toEqual([
      castEntry("「やった！」", { emotion: "驚き", intensity: "強" }),
      castEntry("「静かにしろ」", { emotion: "恐れ", intensity: "弱" }),
    ]);
  });

  test("区切りが失敗したら書き換えない", async () => {
    state.generate.mockResolvedValue({ text: "ごめんなさい" });
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    expect(state.savedCast).toHaveLength(0);
    expect(state.warnings[0]).toContain("書き換えていません");
  });

  test("確認で取りやめたらAIを呼ばない", async () => {
    state.confirmRun.mockResolvedValueOnce(false);
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: CAST_TEXT }, registry);
    expect(state.generate).not.toHaveBeenCalled();
  });
});

/**
 * 案 A「書いてある所はコードで決める」（2026-11-07。版1.2）。小さいモデル（e4b）は、
 * 地の文に「と灯は言った」と書いてある台詞まで「不明」に倒していた（見逃し）。
 */
describe("話者が書いてある台詞はコードで決める（P-54 版1.2）", () => {
  const registry = {} as Registry;
  const ATTRIBUTED = [
    "「行こう」と灯は言った。", // 〔1〕直後の「と灯は」→ 灯
    "「どこへ」", //                〔2〕書いていない → AI
    "　蓮が答えた。",
    "「港だ」", //                  〔3〕直前の行の「蓮が答えた」→ 蓮（作者が直した行）
    "「止まれ」と兵士が叫んだ。", // 〔4〕一覧にいない役名 → AI
    "　灯は蓮を見て笑った。",
    "「平気」", //                  〔5〕2人の名前がある地の文 → AI
  ].join("\n");

  function answer(lines: Array<[number, string, string]>): void {
    staged(
      lines.map(([number, speaker]) => ({ number, speaker })),
      lines.map(([number, , emotion]) => ({ number, emotion, intensity: "中" }))
    );
  }

  test("1段目は、コードで決めた台詞の話者を訊かない（本文の〔番号〕は残す）。2段目は全部の感情を訊く", async () => {
    answer([[1, "灯", "喜び"]]);
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: ATTRIBUTED }, registry);
    const [speakerRequest, emotionRequest] = state.generate.mock.calls.map((c) => c[0]);
    const prompt: string = speakerRequest.userPrompt;
    expect(prompt).toContain("〔1〕「行こう」");
    expect(prompt).toContain("〔3〕「港だ」");
    expect(prompt).toContain("答えるのは〔2〕〔4〕〔5〕だけです");
    expect(prompt).toContain("〔1〕〔3〕は、本文に話し手が書いてあるので答えません");
    expect(emotionRequest.userPrompt).toContain("〔1〕〜〔5〕");
    expect(emotionRequest.userPrompt).not.toContain("本文に話し手が書いてある");
  });

  test("全部の台詞をコードで決めた区切りは、1段目を呼ばない（感情の段だけ）", async () => {
    answer([[1, "灯", "喜び"]]);
    await runVoiceCast(
      { work, episodePath: "/w/01.txt", text: "「行こう」と灯は言った。\n「港だ」と蓮が答えた。" },
      registry
    );
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(fieldsOf(state.generate.mock.calls[0][0])).toEqual(["number", "emotion", "intensity"]);
    expect(state.confirmRun.mock.calls[0][0]).toContain("AIを1回呼びます（話者0回・感情1回");
  });

  test("コードの話者とAIの感情を混ぜる。AIが不明と答えても書いてある話者にする。作者の行は上書きしない", async () => {
    state.cast = {
      version: 1,
      episode: "01.txt",
      entries: [castEntry("「港だ」", { speakerId: "c-akari", speakerName: "灯", source: "author" })],
    };
    // 1段目は〔1〕〔3〕を訊いていないので、その答えは捨てて数える（コードの話者のまま）
    answer([
      [1, "不明", "喜び"],
      [2, "不明", "驚き"],
      [3, "蓮", "平静"],
      [4, "灯", "叫び"],
      [5, "不明", "平静"],
    ]);
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: ATTRIBUTED }, registry);
    expect(state.steps.some((s) => s.includes("話者の段 2件（話者を訊いていない番号 2件）"))).toBe(true);
    const saved = state.savedCast[0].file.entries;
    const byQuote = new Map(saved.map((e) => [e.quote, e]));
    expect(byQuote.get("「行こう」")).toMatchObject({ speakerId: "c-akari", emotion: "喜び", source: "ai" });
    // 作者の行は、コードの答え（蓮）でもAIの答えでも上書きしない
    expect(byQuote.get("「港だ」")).toMatchObject({ speakerId: "c-akari", source: "author" });
    expect(saved.filter((e) => e.quote === "「港だ」")).toHaveLength(1);
    // 一覧にいない役名の台詞は、コードでは当てない（AIの答えがそのまま通る道）
    expect(byQuote.get("「止まれ」")).toMatchObject({ speakerId: "c-akari", emotion: "叫び" });
    // 2人の名前がある地の文の台詞は、コードで決めずAIの「不明」のまま
    expect(byQuote.get("「平気」")).toMatchObject({ speakerId: null });
    expect(state.steps.some((s) => s.includes("本文に書いてあった話者2個"))).toBe(true);
  });
});

// 長い地の文の行をはさみ、区切りを2つにする（1区切り2,000字。地の文だけの区切りは送らない）
const LONG = "　" + "波".repeat(1995);
const TWO_CHUNKS = ["「一」", "「二」", "「三」", LONG, "「四」"].join("\n");
/** 案 C の印を入れて呼ぶ（製品の既定は切ってある。0.142.2） */
const FLOW_ON = { flow: true } as const;

/**
 * 案 C は製品の既定で切る（2026-11-08 の測定。0.142.2）。流れがあると e4b は迷って
 * 「不明」へ倒れ、26b でも取り違えが1件増えた。切ったときは 0.141.0（版1.3）と同じ動きに戻す。
 */
describe("既定では前の区切りの話者の流れを添えない（0.142.2）", () => {
  const registry = {} as Registry;

  test("既定では、2つ目の区切りの1段目にも流れを添えない", async () => {
    state.generate.mockImplementation(async (request: { jsonSchema: unknown }) =>
      fieldsOf(request).includes("speaker")
        ? { text: JSON.stringify({ lines: [1, 2, 3].map((number) => ({ number, speaker: "灯" })) }) }
        : { text: JSON.stringify({ lines: [{ number: 1, emotion: "平静", intensity: "中" }] }) }
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry);
    const prompts = state.generate.mock.calls
      .map((c) => c[0])
      .filter((r) => fieldsOf(r).includes("speaker"))
      .map((r) => r.userPrompt as string);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("【前の区切りの話者の流れ】");
      expect(prompt).not.toContain("流れも参考");
    }
  });

  test("既定では、1段目が失敗しても後ろの区切りの1段目を送る（頼みが前の答えに左右されない）", async () => {
    state.generate.mockImplementation(async (request: { jsonSchema: unknown }) =>
      fieldsOf(request).includes("speaker")
        ? { text: "ごめんなさい" }
        : { text: JSON.stringify({ lines: [{ number: 1, emotion: "平静", intensity: "中" }] }) }
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry);
    const stages = state.generate.mock.calls.map((c) => (fieldsOf(c[0]).includes("speaker") ? "話者" : "感情"));
    expect(stages.filter((s) => s === "話者")).toHaveLength(2);
    expect(stages.filter((s) => s === "感情")).toHaveLength(2);
    expect(state.savedCast).toHaveLength(0);
    expect(state.warnings[0]).toContain("書き換えていません");
    expect(state.warnings[0]).not.toContain("前の区切りの答えに続けて");
  });

  test("既定では、確認の窓で回数を正確に言う（「最大」と言わない）", async () => {
    state.generate.mockImplementation(async (request: { jsonSchema: unknown }) =>
      fieldsOf(request).includes("speaker")
        ? { text: JSON.stringify({ lines: [{ number: 1, speaker: "灯" }] }) }
        : { text: JSON.stringify({ lines: [{ number: 1, emotion: "平静", intensity: "中" }] }) }
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry);
    const message = state.confirmRun.mock.calls[0][0] as string;
    expect(message).toContain("AIを4回呼びます（話者2回・感情2回");
    expect(message).not.toContain("最大");
  });
});

/**
 * 案 C「掛け合いの流れを渡す」（2026-11-07。版1.4）。2つ目の区切りの1段目に、
 * 1つ目の区切りまでで決まった話者の名前を、直前の数件だけ添える。
 * 製品の既定では切ってある（0.142.2）。ここは印を入れたときの動き（測る台本の VC_FLOW=on）
 */
describe("前の区切りの話者の流れを1段目に添える（P-54 版1.4。印を入れたとき）", () => {
  const registry = {} as Registry;

  /** 1段目の答えを、区切りの本文で分けて返す偽のAI（区切りごとに違う答えを返せるように） */
  function byChunk(first: unknown[], second: unknown[]): void {
    state.generate.mockImplementation(async (request: { jsonSchema: unknown; userPrompt: string }) => {
      if (!fieldsOf(request).includes("speaker")) {
        return { text: JSON.stringify({ lines: [{ number: 1, emotion: "平静", intensity: "中" }] }) };
      }
      const isFirst = request.userPrompt.includes("〔1〕「一」");
      return { text: JSON.stringify({ lines: isFirst ? first : second }) };
    });
  }
  const speakerPrompts = (): string[] =>
    state.generate.mock.calls
      .map((c) => c[0])
      .filter((r) => fieldsOf(r).includes("speaker"))
      .map((r) => r.userPrompt as string);

  test("2つ目の区切りの1段目に、1つ目で決まった話者の流れが入る。「不明」は抜かずに書く。1つ目には無い", async () => {
    byChunk(
      [
        { number: 1, speaker: "灯" },
        { number: 2, speaker: "不明" },
        { number: 3, speaker: "蓮" },
      ],
      [{ number: 1, speaker: "灯" }]
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    const [first, second] = speakerPrompts();
    expect(first).not.toContain("【前の区切りの話者の流れ】");
    expect(second).toContain("【前の区切りの話者の流れ】");
    expect(second).toContain("灯 → 不明 → 蓮");
    // 台詞の本文は添えない（名前の列だけ）
    expect(second.split("【前の区切りの話者の流れ】")[1].split("【")[0]).not.toContain("「一」");
  });

  test("添えるのは直前の5件まで", async () => {
    const many = ["「一」", "「二」", "「三」", "「四」", "「五」", "「六」", "「七」", LONG, "「八」"].join("\n");
    byChunk(
      [1, 2, 3, 4, 5, 6, 7].map((number) => ({ number, speaker: number % 2 === 1 ? "灯" : "蓮" })),
      [{ number: 1, speaker: "灯" }]
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: many }, registry, FLOW_ON);
    const second = speakerPrompts()[1];
    // 〔3〕〜〔7〕＝灯・蓮・灯・蓮・灯
    expect(second).toContain("：灯 → 蓮 → 灯 → 蓮 → 灯\n");
  });

  test("前の区切りが全部「不明」なら流れを添えない", async () => {
    byChunk(
      [1, 2, 3].map((number) => ({ number, speaker: "不明" })),
      [{ number: 1, speaker: "灯" }]
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    expect(speakerPrompts()[1]).not.toContain("【前の区切りの話者の流れ】");
  });

  test("控えの鍵に流れが入る：作者が1つ目の区切りの話者を直すと、2つ目の1段目だけ送り直す（作者の話者が流れに入る）", async () => {
    byChunk(
      [
        { number: 1, speaker: "灯" },
        { number: 2, speaker: "灯" },
        { number: 3, speaker: "灯" },
      ],
      [{ number: 1, speaker: "灯" }]
    );
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    expect(state.generate).toHaveBeenCalledTimes(4);

    // 何も変えなければ、全部の段が控えに当たる
    state.generate.mockClear();
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    expect(state.generate).not.toHaveBeenCalled();

    // 作者が［台詞の一覧］で〔3〕を蓮に直した
    state.cast = {
      ...state.cast!,
      entries: state.cast!.entries.map((e) =>
        e.quote === "「三」" ? { ...e, speakerId: "c-ren", speakerName: "蓮", source: "author" as const } : e
      ),
    };
    state.generate.mockClear();
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    const sent = state.generate.mock.calls.map((c) => c[0]);
    expect(sent).toHaveLength(1);
    expect(fieldsOf(sent[0])).toEqual(["number", "speaker"]);
    expect(sent[0].userPrompt).toContain("灯 → 灯 → 蓮");
    // 作者の行は上書きしない
    expect(state.cast!.entries.find((e) => e.quote === "「三」")).toMatchObject({ speakerId: "c-ren", source: "author" });
  });

  test("後ろの区切りの1段目の数は前の答え次第なので、確認では「最大」で示す", async () => {
    byChunk([{ number: 1, speaker: "灯" }], [{ number: 1, speaker: "灯" }]);
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    expect(state.confirmRun.mock.calls[0][0]).toContain("AIを最大4回呼びます（話者2回・感情2回");
  });

  test("1段目が失敗したら、それより後ろの区切りの1段目は送らない（流れが決まらず、次に押すと送り直しになるため）", async () => {
    state.generate.mockImplementation(async (request: { jsonSchema: unknown; userPrompt: string }) => {
      if (!fieldsOf(request).includes("speaker")) {
        return { text: JSON.stringify({ lines: [{ number: 1, emotion: "平静", intensity: "中" }] }) };
      }
      return { text: "ごめんなさい" };
    });
    await runVoiceCast({ work, episodePath: "/w/01.txt", text: TWO_CHUNKS }, registry, FLOW_ON);
    const stages = state.generate.mock.calls.map((c) => (fieldsOf(c[0]).includes("speaker") ? "話者" : "感情"));
    expect(stages.filter((s) => s === "話者")).toHaveLength(1);
    expect(stages.filter((s) => s === "感情")).toHaveLength(2);
    expect(state.savedCast).toHaveLength(0);
    expect(state.warnings[0]).toContain("書き換えていません");
  });
});

describe("遅い PC で、声づくりの時間切れを届かないと取り違えない（0.147.1。ノートPCの実機確認）", () => {
  /**
   * 1つずつ作る偽のエンジン。`synthesisMs` が undefined なら、声づくりの答えを返さない（止まったまま）。
   * 話者の一覧はすぐ返す
   */
  function serialFetch(synthesisMs: number | undefined) {
    let busyUntil = 0;
    const impl = (input: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        const path = new URL(input).pathname;
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError"))
        );
        if (path === "/speakers") {
          resolve(
            new Response(
              JSON.stringify([
                { name: "まい", speaker_uuid: "u", styles: [{ name: "ノーマル", id: 1, type: "talk" }] },
              ])
            )
          );
          return;
        }
        if (path === "/synthesis" && synthesisMs === undefined) return;
        const took = path === "/synthesis" ? (synthesisMs ?? 0) : 300;
        const startAt = Math.max(Date.now(), busyUntil);
        busyUntil = startAt + took;
        setTimeout(() => {
          resolve(
            path === "/synthesis"
              ? new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))
              : new Response(JSON.stringify({ speedScale: 1 }))
          );
        }, busyUntil - Date.now());
      });
    return impl;
  }
  const TEXT4 = "一つ目の文。二つ目の文。三つ目の文。四つ目の文。";

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("1文25秒かかるエンジンでも、先読みを並べた後ろの文まで音ができる（時間切れで止まらない）", async () => {
    const service = new VoiceReadingService(() => "http://127.0.0.1:10101", serialFetch(25_000));
    const sentences = buildReadingPlan(TEXT4, "curly", [], { splitDialogue: true });
    const planned = await service.plan(undefined, "/x.txt", TEXT4, sentences, "aivisspeech");
    if (!("units" in planned)) throw new Error(planned.problem);
    expect(planned.units).toHaveLength(4);
    const results = planned.units.map((_unit, index) => service.audio(planned.units, index, 1));
    await vi.advanceTimersByTimeAsync(4 * 26_000);
    for (const result of await Promise.all(results)) {
      expect(result).not.toHaveProperty("engineDown");
      expect(result).not.toHaveProperty("engineSlow");
      expect("wav" in result).toBe(true);
    }
  });

  test("止まったままのエンジンは時間切れの印（engineSlow）で返し、届かない印（engineDown）は立てない", async () => {
    const service = new VoiceReadingService(() => "http://127.0.0.1:10101", serialFetch(undefined));
    const planned = await service.plan(undefined, "/x.txt", "文。", buildReadingPlan("文。", "curly"), "aivisspeech");
    if (!("units" in planned)) throw new Error(planned.problem);
    const pending = service.audio(planned.units, 0, 1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const answer = await pending;
    expect(answer).toMatchObject({ engineSlow: true });
    expect(answer).not.toHaveProperty("engineDown");
    const problem = "problem" in answer ? answer.problem : "";
    expect(problem).toContain("［音声に書き出す］");
    expect(problem).not.toContain("繋がりませんでした");
  });
});
