import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Mp3Encoder } from "@breezystack/lamejs";
import type { WorkEntry } from "../../../src/models/types";
import type { CastFile, VoiceAssignmentFile } from "../../../src/core/voiceCast";
import type { VoiceEngineId } from "../../../src/core/voiceEngine";
import { window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import {
  FAKE_ACML_NC_TEXT,
  FAKE_ACML_TEXT,
  FAKE_VOICEVOX_SPEAKERS,
  fakeAivmModels,
  startFakeVoiceEngine,
  type FakeEngine,
  type FakeEngineTerms,
} from "../support/fakeVoiceEngine";

/**
 * 人物の声の朗読を音声ファイルに書き出す（設計書6.42.4）。
 *
 * 作者の答え（2026-11-07 夜）：
 * 1. 形式は MP3。1話を1ファイル（文ごとの WAV を計画どおりに作り、文の間の無音を入れてつなぐ）
 * 2. 書き出したフォルダーに「クレジットと利用条件.txt」と「ライセンス/〈モデル名か話者名〉.txt」
 * 3. ライセンス・規約が取れない声・分からない声を使う話は、書き出さずに止める（何も作らない）
 * 4. 非商用の声が混じるときは、書き出す前に確かめ、注意書きの先頭に書く
 * 5. 置き場は作品の .aiwriter/exports/音声/〈話〉/（GitHub の同期に載せない）
 * 6. 長い話は進み具合を出し、中止できる
 *
 * 本物のエンジンは動かさない。偽のエンジン（`fakeVoiceEngine`）が本物の形の WAV を返す。
 */

const state = vi.hoisted(() => ({
  confirmAnswer: true,
  confirms: [] as Array<{ message: string; label?: string; options?: { kind?: string; detail?: string } }>,
  warnings: [] as string[],
  done: [] as string[],
  cancelAfterMs: undefined as number | undefined,
  progress: [] as string[],
  cast: undefined as CastFile | undefined,
  assignment: { version: 1, characters: {} } as VoiceAssignmentFile,
}));

vi.mock("../../../src/views/progress", () => ({
  withCancellableProgress: async <T>(
    _title: string,
    task: (progress: unknown, token: unknown) => Promise<T>
  ) => {
    const listeners: Array<() => void> = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    };
    if (state.cancelAfterMs !== undefined) {
      setTimeout(() => {
        token.isCancellationRequested = true;
        for (const listener of listeners) listener();
      }, state.cancelAfterMs);
    }
    return task(
      { report: (value: { message?: string }) => state.progress.push(value.message ?? "") },
      token
    );
  },
}));
vi.mock("../../../src/views/notify", () => ({
  confirmRun: async (message: string, label?: string, options?: { kind?: string; detail?: string }) => {
    state.confirms.push({ message, label, options });
    return state.confirmAnswer;
  },
  notifyDone: (message: string) => state.done.push(message),
  warnWithLog: async (message: string) => {
    state.warnings.push(message);
  },
  whenNoticePicked: (shown: Thenable<unknown>, act: (picked: unknown) => unknown) => {
    void Promise.resolve(shown).then(act);
  },
  rememberLabel: (label: string) => `${label}（以降は訊かない）`,
}));
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
      return {
        characters: [
          { id: "c-akari", name: "灯", aliases: [], speechStyle: null },
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
    hash: undefined,
  }),
  saveVoiceCast: async () => "h",
  loadVoiceAssignment: async () => ({ file: state.assignment, hash: undefined }),
  saveVoiceAssignment: async () => "h",
}));

const { VoiceReadingService } = await import("../../../src/features/voiceReading");
const { exportVoiceAudio, voiceExportFolder } = await import("../../../src/features/voiceExport");
const { buildReadingPlan } = await import("../../../src/core/readAloud");
const { IGNORED_PATHS } = await import("../../../src/core/workRegistry");
const pathModule = await import("../../../src/core/paths");

const work = { id: "w1", title: "鉛の海", folderPath: "C:\\works\\namari" } as WorkEntry;
const EPISODE = "C:\\works\\namari\\本文\\01_はじまり.txt";
const TEXT = "「やった！」と灯は笑った。\n「静かにしろ」と蓮は囁いた。";
const lame = { mp3Encoder: async () => (c: number, r: number, k: number) => new Mp3Encoder(c, r, k) };

const disk = new Map<string, Uint8Array>();
const infoMessages: Array<{ message: string; items: string[] }> = [];

function exported(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of disk) {
    if (key.includes("exports")) out.set(key, key.endsWith(".mp3") ? `mp3:${value.length}` : new TextDecoder().decode(value));
  }
  return out;
}

function fileNamed(suffix: string): string | undefined {
  for (const [key, value] of exported()) if (key.replace(/\\/g, "/").endsWith(suffix)) return value;
  return undefined;
}

beforeEach(() => {
  state.confirmAnswer = true;
  state.confirms.length = 0;
  state.warnings.length = 0;
  state.done.length = 0;
  state.progress.length = 0;
  state.cancelAfterMs = undefined;
  state.cast = undefined;
  // 語り手は花音、灯は まい（2つのモデル）
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
    },
  };
  state.cast = {
    version: 1,
    episode: "01_はじまり.txt",
    entries: [
      { quote: "「やった！」", nth: 0, speakerId: "c-akari", speakerName: "灯", emotion: "平静", intensity: "中", source: "ai" },
    ],
  };
  disk.clear();
  workspace.fs = memoryFs(disk);
  infoMessages.length = 0;
  window.showInformationMessage = (async (message: string, ...items: string[]) => {
    infoMessages.push({ message, items });
    return undefined;
  }) as typeof window.showInformationMessage;
});

const ACML_BOTH: FakeEngineTerms = {
  brand: "AivisSpeech",
  aivmModels: fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: FAKE_ACML_TEXT }),
  policies: { "uuid-mai": "まいの話者の規約", "uuid-kanon": "花音の話者の規約" },
};

describe("人物の声で音声に書き出す（偽のエンジン）", () => {
  let engine: FakeEngine | undefined;
  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  async function run(
    terms: FakeEngineTerms,
    options: { synthesisDelayMs?: number; engine?: VoiceEngineId; paceRatio?: number } = {}
  ) {
    const { engine: chosen, paceRatio, ...rest } = options;
    engine = await startFakeVoiceEngine({ pcm: true, terms, ...rest });
    const url = engine.url;
    const service = new VoiceReadingService(() => url, undefined, async () => true);
    // 測った比があるときの窓の文を見る（比の覚え方そのものは別の試験）
    if (paceRatio !== undefined) vi.spyOn(service, "paceRatio").mockReturnValue(paceRatio);
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    // ［声］で選んだエンジン。偽のエンジンの名乗りに合わせる（違えば止まるのは別の試験）
    const picked = chosen ?? (terms.brand === "VOICEVOX" ? "voicevox" : "aivisspeech");
    return exportVoiceAudio({ work, episodePath: EPISODE, text: TEXT, sentences, engine: picked }, service, lame);
  }

  test("［声］で選んだエンジンと名乗りが違えば、ライセンスを確かめずに止める（何も作らない）", async () => {
    const outcome = await run(ACML_BOTH, { engine: "voicevox" });
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind !== "stopped") return;
    expect(outcome.reason).toContain("［声］で VOICEVOX を選んでいますが、接続先のエンジンは AivisSpeech と名乗りました");
    expect(outcome.reason).toContain("novelai.readAloud.voicevoxUrl");
    expect(engine!.requests.filter((r) => r.path === "/synthesis")).toHaveLength(0);
  });

  test("1話の MP3 と注意書きと全文ができる", async () => {
    const outcome = await run(ACML_BOTH);
    expect(outcome.kind).toBe("written");
    // 代役の Uri はドライブの字を小文字にする（本物の fsPath と同じ）。比べる前に揃える
    const files = [...exported().keys()].map((key) => key.replace(/\\/g, "/").toLowerCase());
    const folder = `${work.folderPath.replace(/\\/g, "/")}/.aiwriter/exports/音声/01_はじまり`.toLowerCase();
    expect(files.sort()).toEqual(
      [
        `${folder}/01_はじまり.mp3`,
        `${folder}/クレジットと利用条件.txt`,
        `${folder}/ライセンス/まいモデル.txt`,
        `${folder}/ライセンス/花音モデル.txt`,
      ].sort()
    );
    // MP3 のフレームで始まる
    for (const [key, bytes] of disk) {
      if (key.endsWith(".mp3")) {
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1] & 0xe0).toBe(0xe0);
      }
    }
    // 4文を合成した（語り・台詞の両方）
    expect(engine!.requests.filter((r) => r.path === "/synthesis")).toHaveLength(4);
    // 書き出す前の確認に、文の数・おおよその時間・置き場
    expect(state.confirms).toHaveLength(1);
    expect(state.confirms[0].message).toContain("4文");
    expect(state.confirms[0].message).toMatch(/おおよそ/);
    expect(state.confirms[0].message).toContain(".aiwriter/exports/音声/01_はじまり");
    // 知らせに要点と［フォルダーを開く］
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0].items).toEqual(["フォルダーを開く"]);
    expect(infoMessages[0].message).toContain("ACML");
    expect(infoMessages[0].message).toContain("非公式");
  });

  test("測った比が無ければ、確認の窓に「かかる見込み」を出さない（推測の数字を出さない）", async () => {
    await run(ACML_BOTH);
    expect(state.confirms[0].message).not.toContain("かかる見込み");
    expect(state.confirms[0].message).toContain("長い話は数分かかります");
  });

  test("測った比があれば、音の長さの見積もり×比で「この PC では、書き出しにおおよそN分かかる見込み」を出す", async () => {
    // 4文・音の見積もりは数秒。比を 1000 にして、分の単位で見える大きさにする
    await run(ACML_BOTH, { paceRatio: 1000 });
    const message = state.confirms[0].message;
    expect(message).toMatch(/この PC では、書き出しにおおよそ(\d+分|\d+時間\d+分)かかる見込みです（前に測った速さから）。/);
    // 音の長さの見積もりの行はそのまま残る
    expect(message).toMatch(/長さはおおよそ/);
  });

  test("書き出し・読み上げで新しく作った文の速さをエンジンごとに覚え、次の窓の見込みに使う", async () => {
    engine = await startFakeVoiceEngine({ pcm: true, terms: ACML_BOTH });
    const url = engine.url;
    // 1文ごとに（始め→終わり）を 400ミリ秒ずつ進める。音は 200ミリ秒なので比は 2
    let clock = 0;
    let call = 0;
    const service = new VoiceReadingService(
      () => url,
      undefined,
      async () => true,
      () => (call++ % 2 === 0 ? clock : (clock += 400))
    );
    expect(service.paceRatio("aivisspeech")).toBeUndefined();
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    const unit = {
      engine: "aivisspeech" as const,
      speech: sentences[0].speech,
      styleId: 1325133120,
      gapMs: 0,
      emotion: "平静",
      intensity: "中",
      styled: false,
    } as unknown as Parameters<InstanceType<typeof VoiceReadingService>["synthesizeForExport"]>[0];
    const signal = new AbortController().signal;
    // はじめの2文は数えず、そのあと3文たまるまでは返さない
    for (let i = 0; i < 4; i++) await service.synthesizeForExport({ ...unit, speech: `${unit.speech}${i}` }, 1, signal);
    expect(service.paceRatio("aivisspeech")).toBeUndefined();
    await service.synthesizeForExport({ ...unit, speech: `${unit.speech}z` }, 1, signal);
    expect(service.paceRatio("aivisspeech")).toBeCloseTo(2, 1);
    // 別のエンジンは測っていないので返さない
    expect(service.paceRatio("voicevox")).toBeUndefined();
  });

  test("測った速さは端末へ要約だけ残り、再起動のあとの新しい係が読み戻して見込みに使う。壊れた値は使わない", async () => {
    engine = await startFakeVoiceEngine({ pcm: true, terms: ACML_BOTH });
    const url = engine.url;
    const kept = new Map<string, unknown>();
    const store = {
      get: <T,>(key: string, fallback: T): T => (kept.has(key) ? (kept.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => void kept.set(key, value),
    };
    let clock = 0;
    let call = 0;
    const first = new VoiceReadingService(
      () => url,
      undefined,
      async () => true,
      () => (call++ % 2 === 0 ? clock : (clock += 400))
    );
    first.usePaceStore(store);
    const unit = {
      engine: "aivisspeech" as const,
      speech: "あ",
      styleId: 1325133120,
      gapMs: 0,
      emotion: "平静",
      intensity: "中",
      styled: false,
    } as unknown as Parameters<InstanceType<typeof VoiceReadingService>["synthesizeForExport"]>[0];
    const signal = new AbortController().signal;
    for (let i = 0; i < 6; i++) await first.synthesizeForExport({ ...unit, speech: `あ${i}` }, 1, signal);
    await first.savePace();
    const saved = kept.get("novelai.voicePace.ratios") as Record<string, { ratio: number; count: number; at: string }>;
    expect(Object.keys(saved)).toEqual(["aivisspeech"]);
    expect(Object.keys(saved.aivisspeech).sort()).toEqual(["at", "count", "ratio"]);
    expect(saved.aivisspeech.ratio).toBeCloseTo(2, 1);

    // 再起動（新しい係）：読み戻すと同じ比
    const second = new VoiceReadingService(() => url, undefined, async () => true);
    expect(second.paceRatio("aivisspeech")).toBeUndefined();
    second.usePaceStore(store);
    expect(second.paceRatio("aivisspeech")).toBeCloseTo(saved.aivisspeech.ratio, 5);

    // 壊れた値は使わない
    kept.set("novelai.voicePace.ratios", { aivisspeech: { ratio: "遅い", count: 9, at: "いつか" } });
    const third = new VoiceReadingService(() => url, undefined, async () => true);
    third.usePaceStore(store);
    expect(third.paceRatio("aivisspeech")).toBeUndefined();
  });

  test("人物の声の調整（老けた声）は、書き出しの道でもエンジンへの頼みの値に効く。語りには当てない（作者の頼み 2026-11-13）", async () => {
    state.assignment.characters["c-akari"] = {
      ...state.assignment.characters["c-akari"],
      adjust: { pitch: -0.06, speed: 0.85, intonation: 0.8 },
    };
    const outcome = await run(ACML_BOTH);
    expect(outcome.kind).toBe("written");
    const synth = engine!.requests.filter((r) => r.path === "/synthesis");
    const akari = synth.filter((r) => r.query.speaker === "888753760").map((r) => r.body as Record<string, number>);
    const narration = synth.filter((r) => r.query.speaker === "1325133120").map((r) => r.body as Record<string, number>);
    expect(akari.length).toBeGreaterThan(0);
    for (const body of akari) expect(body).toMatchObject({ speedScale: 0.85, pitchScale: -0.06, intonationScale: 0.8 });
    expect(narration.length).toBeGreaterThan(0);
    for (const body of narration) expect(body).toMatchObject({ speedScale: 1, pitchScale: 0, intonationScale: 1 });
  });

  test("注意書きに、声ごとの要点・非公式の一文・全文のファイルがある", async () => {
    await run(ACML_BOTH);
    const notice = fileNamed("クレジットと利用条件.txt")!;
    expect(notice).toContain("※非公式です。話者本人・制作者とは関係ありません。");
    for (const word of ["まい", "花音", "まいモデル", "花音モデル", "まいモデルの制作者", "Aivis Common Model License (ACML) 1.0"]) {
      expect(notice).toContain(word);
    }
    expect(notice).toContain("ライセンス/まいモデル.txt");
    expect(notice).toContain("ライセンス/花音モデル.txt");
    expect(notice).toContain("営利・非営利とも使えます");
    const full = fileNamed("まいモデル.txt")!;
    expect(full).toContain("# Aivis Common Model License (ACML) 1.0");
    expect(full).toContain("まいの話者の規約");
  });

  test("ライセンスが取れない声では止まり、何も作らない。どの声か・どこを確かめるかを出す", async () => {
    const outcome = await run({
      ...ACML_BOTH,
      aivmModels: fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: null }),
    });
    expect(outcome.kind).toBe("stopped");
    expect(exported().size).toBe(0);
    // 合成もしない（本文をエンジンへ送らない）
    expect(engine!.requests.filter((r) => r.path === "/synthesis")).toHaveLength(0);
    expect(state.confirms).toHaveLength(0);
    expect(state.warnings.join("\n")).toContain("花音");
    expect(state.warnings.join("\n")).toContain("AivisSpeech");
  });

  test("知らないライセンスの声でも止まる（分からないものを推し量らない）", async () => {
    const outcome = await run({
      ...ACML_BOTH,
      aivmModels: fakeAivmModels({ mai: "# 独自のライセンス\n自由に", kanon: FAKE_ACML_TEXT }),
    });
    expect(outcome.kind).toBe("stopped");
    expect(exported().size).toBe(0);
    expect(state.warnings.join("\n")).toContain("まい");
    expect(state.warnings.join("\n")).toContain("独自のライセンス");
  });

  test("どのエンジンか分からなければ止まる", async () => {
    const outcome = await run({ ...ACML_BOTH, brand: undefined });
    expect(outcome.kind).toBe("stopped");
    expect(exported().size).toBe(0);
  });

  test("非商用の声で確かめが出て、注意書きの先頭に書かれる", async () => {
    await run({ ...ACML_BOTH, aivmModels: fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: FAKE_ACML_NC_TEXT }) });
    expect(state.confirms).toHaveLength(1);
    expect(state.confirms[0].message).toContain("非商用のみ");
    expect(state.confirms[0].message).toContain("花音");
    const notice = fileNamed("クレジットと利用条件.txt")!;
    expect(notice.split("\n").slice(0, 3).join("\n")).toContain("非商用のみ");
  });

  test("確かめで断ったら、何も作らない", async () => {
    state.confirmAnswer = false;
    const outcome = await run(ACML_BOTH);
    expect(outcome.kind).toBe("declined");
    expect(exported().size).toBe(0);
    expect(engine!.requests.filter((r) => r.path === "/synthesis")).toHaveLength(0);
  });

  test("VOICEVOX は規約を全文として置き、「VOICEVOX:キャラ名」のクレジットを書く", async () => {
    const outcome = await run({
      brand: "VOICEVOX",
      policies: { "uuid-mai": "まいの利用規約（VOICEVOX）", "uuid-kanon": "花音の利用規約（VOICEVOX）" },
    });
    expect(outcome.kind).toBe("written");
    const notice = fileNamed("クレジットと利用条件.txt")!;
    expect(notice).toContain("VOICEVOX:まい");
    expect(notice).toContain("VOICEVOX:花音");
    expect(fileNamed("ライセンス/まい.txt")).toContain("まいの利用規約（VOICEVOX）");
    expect(infoMessages[0].message).toContain("VOICEVOX:まい");
  });

  test("VOICEVOX でも規約が取れない声では止まる", async () => {
    const outcome = await run({ brand: "VOICEVOX", policies: { "uuid-mai": "まいの利用規約" } });
    expect(outcome.kind).toBe("stopped");
    expect(exported().size).toBe(0);
    expect(state.warnings.join("\n")).toContain("花音");
  });

  test("同じ名前のファイルがあれば、上書きせず別名で作る", async () => {
    await run(ACML_BOTH);
    const firstMp3 = [...disk.keys()].find((key) => key.endsWith(".mp3"))!;
    const firstBytes = disk.get(firstMp3);
    await engine?.close();
    engine = undefined;
    await run(ACML_BOTH);
    expect(disk.get(firstMp3)).toBe(firstBytes);
    const names = [...exported().keys()].map((key) => key.replace(/\\/g, "/").split("/音声/")[1]);
    expect(names).toContain("01_はじまり/01_はじまり (2).mp3");
    expect(names).toContain("01_はじまり/クレジットと利用条件 (2).txt");
    expect(names).toContain("01_はじまり/ライセンス (2)/まいモデル.txt");
  });

  test("置き場は .gitignore 済みの .aiwriter/exports/ の下（同期に載せない）", () => {
    const folder = voiceExportFolder(work, EPISODE);
    const relative = pathModule.relative(work.folderPath, folder).replace(/\\/g, "/");
    expect(relative).toBe(".aiwriter/exports/音声/01_はじまり");
    expect(IGNORED_PATHS.some((ignored) => `${relative}/`.startsWith(ignored))).toBe(true);
  });

  test("中止できる（何も作らない）", async () => {
    state.cancelAfterMs = 30;
    const outcome = await run(ACML_BOTH, { synthesisDelayMs: 200 });
    expect(outcome.kind).toBe("cancelled");
    expect(exported().size).toBe(0);
    expect(state.done.join("\n")).toContain("中止");
  });

  test("進み具合を出す", async () => {
    await run(ACML_BOTH);
    expect(state.progress.some((message) => message.includes("4"))).toBe(true);
  });

  /**
   * 書き出しで読むのは題と本文だけ（2026-11-08 作者の答え。設計書6.42.4）。
   * 頭の欄・前書き・後書きをエンジンへ送らず、確認の窓の文の数にも数えない
   */
  test("カクヨム形式の頭の欄・前書き・後書きは書き出さない。文の数も飛ばしたあとで数える", async () => {
    engine = await startFakeVoiceEngine({ pcm: true, terms: ACML_BOTH });
    const url = engine.url;
    const service = new VoiceReadingService(() => url, undefined, async () => true);
    const text = [
      "【タイトル】",
      "はじまり",
      "",
      "【公開状態】",
      "下書き",
      "",
      "【文字数】",
      "5,529文字",
      "",
      "【前書き】",
      "読んでくださってありがとうございます。",
      "",
      "【本文】",
      TEXT,
      "",
      "【後書き】",
      "次回もお楽しみに。",
    ].join("\n");
    const sentences = buildReadingPlan(text, "site", [], { splitDialogue: true });
    const outcome = await exportVoiceAudio(
      { work, episodePath: EPISODE, text, sentences, engine: "aivisspeech" },
      service,
      lame
    );
    expect(outcome.kind).toBe("written");
    const spoken = engine.requests
      .filter((r) => r.path === "/audio_query")
      .map((r) => r.query.text ?? "")
      .join("\n");
    expect(spoken).toContain("はじまり");
    expect(spoken).toContain("やった");
    for (const word of ["タイトル", "公開状態", "下書き", "文字数", "5,529", "ありがとう", "お楽しみ"]) {
      expect(spoken, word).not.toContain(word);
    }
    // 題1文＋本文4文
    expect(engine.requests.filter((r) => r.path === "/synthesis")).toHaveLength(5);
    expect(state.confirms[0].message).toContain("5文");
  });
});

describe("エンジンに届かないときは、画面の真ん中の窓（2026-11-08 作者の実機確認）", () => {
  let engine: FakeEngine | undefined;
  const shown: Array<{ message: string; options: unknown; items: unknown[] }> = [];
  let original: typeof window.showWarningMessage;
  beforeEach(() => {
    shown.length = 0;
    original = window.showWarningMessage;
    window.showWarningMessage = (async (message: string, options: unknown, ...items: unknown[]) => {
      shown.push({ message, options, items });
      return undefined;
    }) as typeof window.showWarningMessage;
  });
  afterEach(async () => {
    window.showWarningMessage = original;
    await engine?.close();
    engine = undefined;
  });

  function expectEngineDownModal(): void {
    // 右下の知らせ（［ログを見る］）は出さない
    expect(state.warnings).toEqual([]);
    expect(shown).toHaveLength(1);
    // どちらのエンジンかを窓に入れる（0.146.0）
    expect(shown[0].message).toContain("音声合成のエンジン（AivisSpeech）に繋がりませんでした");
    expect(shown[0].options).toMatchObject({
      modal: true,
      detail: expect.stringContaining("AivisSpeech を起動してから、もう一度［音声に書き出す］"),
    });
    // 書き出しの道では OS の声で読めないので、ボタンは付けない（閉じるだけ）
    expect(shown[0].items).toEqual([]);
  }

  test("エンジンを閉じたまま押したとき", async () => {
    engine = await startFakeVoiceEngine({ pcm: true, terms: ACML_BOTH });
    const url = engine.url;
    await engine.close();
    engine = undefined;
    const service = new VoiceReadingService(() => url, undefined, async () => true);
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    const outcome = await exportVoiceAudio(
      { work, episodePath: EPISODE, text: TEXT, sentences, engine: "aivisspeech" },
      service,
      lame
    );
    expect(outcome.kind).toBe("stopped");
    expect(exported().size).toBe(0);
    expectEngineDownModal();
  });

  test("合成の途中でエンジンに届かなくなったとき（ファイルは作らない）", async () => {
    engine = await startFakeVoiceEngine({ pcm: true, terms: ACML_BOTH });
    const url = engine.url;
    // 本物の fetch で通し、合成の頼みだけ繋がらない形にする（エンジンが落ちたのと同じ）
    const service = new VoiceReadingService(
      () => url,
      async (input, init) => {
        if (new URL(input).pathname === "/synthesis") throw new TypeError("fetch failed");
        return fetch(input, init);
      },
      async () => true
    );
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    const outcome = await exportVoiceAudio(
      { work, episodePath: EPISODE, text: TEXT, sentences, engine: "aivisspeech" },
      service,
      lame
    );
    expect(outcome.kind).toBe("stopped");
    expect(exported().size).toBe(0);
    expectEngineDownModal();
  });

  test("エンジンが受け付けなかったとき（http）は、今までどおり右下の知らせ", async () => {
    engine = await startFakeVoiceEngine({ pcm: true, terms: ACML_BOTH, failSynthesis: true });
    const url = engine.url;
    const service = new VoiceReadingService(() => url, undefined, async () => true);
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    const outcome = await exportVoiceAudio(
      { work, episodePath: EPISODE, text: TEXT, sentences, engine: "aivisspeech" },
      service,
      lame
    );
    expect(outcome.kind).toBe("stopped");
    expect(shown).toHaveLength(0);
    expect(state.warnings.join("\n")).toContain("受け付けませんでした");
  });
});

/*
  人物ごとにエンジンを混ぜて書き出す（2段目。0.151.0）。語りは AivisSpeech の花音、灯は VOICEVOX のずんだもん。
  **本物の既定の標本化の速さは AivisSpeech が 44100、VOICEVOX が 24000** で、文ごとの WAV の速さが揃わないと
  つなげない（`joinClips` は合わせ直す計算を持たない）。偽のエンジンも2つを違う速さで立てる
*/
describe("人物ごとにエンジンを混ぜて書き出す（0.151.0）", () => {
  const engines: FakeEngine[] = [];
  afterEach(async () => {
    await Promise.all(engines.map((engine) => engine.close()));
    engines.length = 0;
  });

  async function mixedRun(
    options: { voicevoxBrand?: string; ratios?: Partial<Record<VoiceEngineId, number>> } = {}
  ) {
    const aivis = await startFakeVoiceEngine({ pcm: true, sampleRate: 44100, terms: ACML_BOTH });
    const voicevox = await startFakeVoiceEngine({
      pcm: true,
      sampleRate: 24000,
      speakers: FAKE_VOICEVOX_SPEAKERS,
      terms: {
        brand: options.voicevoxBrand ?? "VOICEVOX",
        policies: { "uuid-zunda": "ずんだもんの利用規約（VOICEVOX）" },
      },
    });
    engines.push(aivis, voicevox);
    state.assignment = {
      version: 1,
      narrator: {
        speakerUuid: "uuid-kanon",
        speakerName: "花音",
        styleName: "ノーマル",
        styleId: 1325133120,
        engine: "aivisspeech",
      },
      characters: {
        "c-akari": {
          speakerUuid: "uuid-zunda",
          speakerName: "ずんだもん",
          styleName: "ノーマル",
          styleId: 3,
          engine: "voicevox",
          characterName: "灯",
        },
      },
    };
    const service = new VoiceReadingService(
      (engine) => (engine === "voicevox" ? voicevox.url : aivis.url),
      undefined,
      async () => true
    );
    const ratios = options.ratios;
    if (ratios) vi.spyOn(service, "paceRatio").mockImplementation((engine) => ratios[engine]);
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    const outcome = await exportVoiceAudio(
      { work, episodePath: EPISODE, text: TEXT, sentences, engine: "aivisspeech" },
      service,
      lame
    );
    return { outcome, aivis, voicevox };
  }

  test("見込みは、使う全部のエンジンの比がそろったときだけ出す（片方だけなら出さない）", async () => {
    await mixedRun({ ratios: { aivisspeech: 1000 } });
    expect(state.confirms[0].message).not.toContain("かかる見込み");
    state.confirms.length = 0;
    disk.clear();
    await mixedRun({ ratios: { aivisspeech: 1000, voicevox: 1000 } });
    expect(state.confirms[0].message).toContain("かかる見込みです（前に測った速さから）");
  });

  test("2つのエンジンの音を1つの MP3 にし、クレジットと利用条件はエンジンごとに並べる", async () => {
    const { outcome, aivis, voicevox } = await mixedRun();
    expect(state.warnings).toEqual([]);
    expect(outcome.kind).toBe("written");
    // 灯の台詞は VOICEVOX、語りと蓮（割り当てなし→語り）は AivisSpeech
    const said = (engine: FakeEngine) =>
      engine.requests.filter((r) => r.path === "/audio_query").map((r) => r.query.text);
    expect(said(voicevox)).toEqual(["「やった！」"]);
    expect(said(aivis)).toHaveLength(3);
    // 速さを揃えて頼む（混ぜるときだけ。どちらのエンジンにも同じ速さ）
    for (const engine of [aivis, voicevox]) {
      for (const request of engine.requests.filter((r) => r.path === "/synthesis")) {
        expect((request.body as Record<string, unknown>).outputSamplingRate).toBe(44100);
      }
    }
    const notice = fileNamed("クレジットと利用条件.txt")!;
    expect(notice).toContain("音声合成：AivisSpeech・VOICEVOX");
    expect(notice).toContain("VOICEVOX:ずんだもん");
    expect(notice).toContain("花音");
    expect(fileNamed("ライセンス/ずんだもん.txt")).toContain("ずんだもんの利用規約（VOICEVOX）");
    expect(fileNamed("ライセンス/花音モデル.txt")).toContain("Aivis Common Model License");
    // 確認の窓の「使う声」にも両方
    expect(state.confirms[0].message).toContain("ずんだもん");
    expect(state.confirms[0].message).toContain("花音");
  });

  test("読み上げで閉じていた VOICEVOX を起動してから書き出すと、問い合わせ直して VOICEVOX の声で書き出す（届かなかった覚えを使わない）", async () => {
    const aivis = await startFakeVoiceEngine({ pcm: true, sampleRate: 44100, terms: ACML_BOTH });
    const voicevox = await startFakeVoiceEngine({
      pcm: true,
      speakers: FAKE_VOICEVOX_SPEAKERS,
      terms: { brand: "VOICEVOX", policies: { "uuid-zunda": "ずんだもんの利用規約（VOICEVOX）" } },
    });
    engines.push(aivis, voicevox);
    const closed = await startFakeVoiceEngine();
    const closedUrl = closed.url;
    await closed.close();
    let voicevoxUrl = closedUrl;
    state.assignment = {
      version: 1,
      narrator: { speakerUuid: "uuid-kanon", speakerName: "花音", styleName: "ノーマル", styleId: 1325133120, engine: "aivisspeech" },
      characters: {
        "c-akari": { speakerUuid: "uuid-zunda", speakerName: "ずんだもん", styleName: "ノーマル", styleId: 3, engine: "voicevox", characterName: "灯" },
      },
    };
    const service = new VoiceReadingService((engine) => (engine === "voicevox" ? voicevoxUrl : aivis.url), undefined, async () => true);
    const sentences = buildReadingPlan(TEXT, "site", [], { splitDialogue: true });
    // 読み上げ：VOICEVOX が閉じていたので、灯は代わりの声（覚えは次の読み始めまで）
    const read = await service.plan(work, EPISODE, TEXT, sentences, "aivisspeech", { start: true });
    if (!("units" in read)) throw new Error(read.problem);
    expect(read.notice).toContain("VOICEVOX に繋がらないので");
    // 作者が VOICEVOX を起動した（接続先へ繋がるようになった）
    voicevoxUrl = voicevox.url;
    const outcome = await exportVoiceAudio(
      { work, episodePath: EPISODE, text: TEXT, sentences, engine: "aivisspeech" },
      service,
      lame
    );
    expect(outcome.kind).toBe("written");
    expect(state.confirms[0].message).not.toContain("繋がらない");
    expect(voicevox.requests.filter((r) => r.path === "/audio_query").map((r) => r.query.text)).toEqual(["「やった！」"]);
  });

  test("［声］で選んでいない側のエンジンの名乗りが違えば、その声の割り当てを名指しして止める", async () => {
    const { outcome } = await mixedRun({ voicevoxBrand: "AivisSpeech" });
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind !== "stopped") return;
    expect(outcome.reason).toContain("VOICEVOX の声を割り当てていますが、接続先のエンジンは AivisSpeech と名乗りました");
    expect(outcome.reason).toContain("novelai.readAloud.voicevoxUrl");
    expect(exported().size).toBe(0);
  });
});
