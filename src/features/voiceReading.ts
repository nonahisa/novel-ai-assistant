import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
} from "../ai/outputLimit";
import { AIError } from "../ai/types";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { withCancellableProgress } from "../views/progress";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { confirmRun, notifyDone, rememberLabel, warnWithLog } from "../views/notify";
import { rememberedAnswer, withRemembered } from "../core/confirmMemory";
import { readConfirmMemory, saveConfirmMemory } from "../core/confirmMemoryStore";
import { reportAIError } from "./reportAIError";
import { CharacterStore } from "../core/characterStore";
import { ChunkCache, type CacheKeyBase } from "../core/chunkCache";
import { hashText } from "../core/hash";
import { voiceRemoteHostConfirmId } from "../core/confirmMemory";
import { describeVoiceHost } from "../core/voiceHostName";
import { logFailure, logStep, responseExcerptForLog, useLogFile } from "../core/logger";
import type { ReadingSentence } from "../core/readAloud";
import {
  castChunkSpeakerSequence,
  castChunksOf,
  castDialogues,
  castFlowNames,
  castGuessesForStages,
  castSpeakersFromText,
  castLookup,
  countDropReasons,
  editCastEntry,
  mergeCastEntries,
  parseCastResult,
  validateCastSpeakers,
  voicePlanUnits,
  type CastChunk,
  type CastEntry,
  type CastPerson,
  type VoiceAssignmentFile,
  type VoicePlanUnit,
  type VoiceRef,
} from "../core/voiceCast";
import {
  loadVoiceAssignment,
  loadVoiceCast,
  saveVoiceAssignment,
  saveVoiceCast,
} from "../core/voiceCastStore";
import {
  DEFAULT_VOICE_ENGINE_URL,
  engineHostOutsideThisPc,
  normalizeEngineUrl,
  SynthesisCache,
  synthesisKey,
  VOICE_EMOTIONS,
  VOICE_INTENSITIES,
  VoiceEngineClient,
  VoiceEngineError,
  voiceEngineNextStep,
  voiceParamsFor,
  type FetchLike,
  type VoiceEmotion,
  type VoiceIntensity,
  type VoiceSpeaker,
} from "../core/voiceEngine";
import {
  VOICE_CAST_CHUNK_CHARS,
  VOICE_CAST_CONTEXT_AFTER_CHARS,
  VOICE_CAST_CONTEXT_BEFORE_CHARS,
  VOICE_CAST_FLOW_ENABLED,
  VOICE_CAST_FLOW_MAX,
  VOICE_CAST_MAX_PEOPLE,
  VOICE_CAST_VERSION,
  voiceCastStageRequests,
  type VoiceCastStage,
  type VoiceCastStageRequest,
} from "../prompts/voiceCast";

/**
 * 人物の声で朗読する（AivisSpeech／VOICEVOX。設計書6.42.3）。
 *
 * 原稿エディタの読み上げ（6.42）の列から使う。読んでいる文が光る・一時停止・
 * ⚑引っかかった の仕組みはそのままで、声だけを手元の音声合成エンジンに替える。
 *
 * - 文の計画は `core/readAloud.ts`（台詞と地の文の境目でも切る）
 * - 台詞ごとの話者と感情は AI（P-54）が推定し、作者が直せる
 * - 声の割り当て（語り手・台詞の既定・人物ごと）は作品ごとに選ぶ
 * - 音は拡張機能の側で作り（画面からは CORS で叩けない）、先読みして控える
 *
 * **本文へは一切書かない。** 推定の結果と声の割り当ては `.aiwriter/` の別のファイル。
 */

/** 設定の鍵（接続先） */
export const VOICE_ENGINE_URL_SETTING = "readAloud.voiceEngineUrl";

/** 先に作っておく文の数（いま頼まれた文を含めない） */
const PREFETCH_AHEAD = 3;
/** 同時にエンジンへ頼む数。エンジンは1つずつ作るので、並べすぎても早くならない */
const SYNTH_CONCURRENCY = 2;
/** 話者の一覧を引き直すまでの間。作者が話者を足したら、少し待てば並ぶ */
const SPEAKERS_TTL_MS = 30_000;

/**
 * 音を作る係（拡張機能に1つ）。合成の控え・話者の一覧の控え・作っている途中の
 * 頼みを持つ。
 */
export class VoiceReadingService {
  private readonly cache = new SynthesisCache();
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();
  private speakersCache: { url: string; at: number; list: VoiceSpeaker[] } | undefined;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  /** 本文を送ってよいと作者が答えた外のホスト（この起動の間だけ。設定や端末には残さない） */
  private readonly allowedRemoteHosts = new Set<string>();
  private readonly askingRemoteHosts = new Map<string, Promise<boolean>>();

  constructor(
    private readonly engineUrl: () => string | undefined = readEngineUrl,
    private readonly fetchImpl?: FetchLike,
    /** この PC の外のホストへ本文を送る前の確認。テストで差し替える */
    private readonly confirmRemoteHost: (host: string) => Promise<boolean> = askSendToRemoteHost
  ) {}

  /**
   * 本文を運ぶ頼み（audio_query／synthesis）の前に呼ぶ。この PC の外のホストなら、
   * 最初の1回だけ確認の窓を出す。**断られたら本文を送らない。**
   * 覚えるのはホストごと・この起動の間だけ（設定の宛先を書き換えられても、別のホストなら
   * もう一度訊く）。同時に何文も頼まれても窓は1つだけ出す。
   */
  private async mayCarryText(): Promise<{ ok: true } | { ok: false; host: string }> {
    const url = this.engineUrl();
    const host = url ? engineHostOutsideThisPc(url) : undefined;
    if (host === undefined || this.allowedRemoteHosts.has(host)) return { ok: true };
    let asking = this.askingRemoteHosts.get(host);
    if (!asking) {
      asking = this.confirmRemoteHost(host).finally(() => this.askingRemoteHosts.delete(host));
      this.askingRemoteHosts.set(host, asking);
    }
    if (!(await asking)) return { ok: false, host };
    this.allowedRemoteHosts.add(host);
    return { ok: true };
  }

  private client(): VoiceEngineClient {
    const url = this.engineUrl();
    if (!url) {
      throw new VoiceEngineError(
        "badResponse",
        "音声合成のエンジンの接続先（novelai.readAloud.voiceEngineUrl）が読めません。http://127.0.0.1:10101 の形で書いてください"
      );
    }
    return new VoiceEngineClient(url, this.fetchImpl);
  }

  /** 話者の一覧（少しのあいだ控える） */
  async speakers(force = false): Promise<VoiceSpeaker[]> {
    const client = this.client();
    const cached = this.speakersCache;
    if (
      !force &&
      cached &&
      cached.url === client.baseUrl &&
      Date.now() - cached.at < SPEAKERS_TTL_MS
    ) {
      return cached.list;
    }
    const list = await client.speakers();
    this.speakersCache = { url: client.baseUrl, at: Date.now(), list };
    return list;
  }

  /**
   * 文ごとの声を決める。**失敗は作者向けの文で返す**（投げない）
   */
  async plan(
    work: WorkEntry | undefined,
    episodePath: string,
    text: string,
    sentences: readonly ReadingSentence[]
  ): Promise<{ units: VoicePlanUnit[] } | VoiceProblem> {
    let speakers: VoiceSpeaker[];
    try {
      speakers = await this.speakers();
    } catch (error) {
      return engineFailure(error, work);
    }
    let assignment: VoiceAssignmentFile = { version: 1, characters: {} };
    let cast: CastEntry[] = [];
    let names = new Map<string, string>();
    if (work) {
      try {
        assignment = (await loadVoiceAssignment(work)).file;
        cast = (await loadVoiceCast(work, episodePath)).file.entries;
        names = await characterNames(work);
      } catch (error) {
        // **壊れたファイルは直さずに止める**（実装ルール2）。理由を出して読まない
        return { problem: error instanceof Error ? error.message : String(error) };
      }
    }
    const units = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast,
      assignment,
      speakers,
      names,
    });
    if (!units) {
      return {
        problem:
          "音声合成のエンジンに話者が1人も見つかりませんでした。AivisSpeech（または VOICEVOX）で話者（音声合成モデル）を入れてから、もう一度押してください。",
      };
    }
    return { units };
  }

  /**
   * その文の音を作り、後ろの数文も並べて作っておく（先読み）。
   */
  async audio(
    units: readonly VoicePlanUnit[],
    index: number,
    rate: number,
    work?: WorkEntry
  ): Promise<{ wav: Uint8Array } | VoiceProblem> {
    const unit = units[index];
    if (!unit) return { problem: "読む文が見つかりません" };
    const allowed = await this.mayCarryText();
    if (!allowed.ok) {
      return {
        problem: `本文を ${allowed.host} へ送ることを許可していないので、人物の声では読めません。この PC の外のホストへ送りたくなければ、設定 novelai.readAloud.voiceEngineUrl を http://127.0.0.1:10101 に戻すか、［声］で OS の声を選んでください。`,
      };
    }
    let current: Promise<Uint8Array>;
    try {
      // **頼まれた文を先に並べる**（先読みを先に並べると、いま鳴らす文が後回しになる）
      current = this.synthesize(unit, rate);
    } catch (error) {
      return engineFailure(error, work);
    }
    for (let ahead = 1; ahead <= PREFETCH_AHEAD; ahead++) {
      const next = units[index + ahead];
      if (!next) break;
      // 先読みの失敗は、その文を頼まれたときに改めて出す（ここでは黙る）
      try {
        this.synthesize(next, rate).catch(() => undefined);
      } catch {
        break;
      }
    }
    try {
      return { wav: await current };
    } catch (error) {
      return engineFailure(error, work);
    }
  }

  /** 1文の音。控え → 作っている途中 → 新しく作る の順に見る */
  synthesize(unit: VoicePlanUnit, rate: number): Promise<Uint8Array> {
    const client = this.client();
    const params = voiceParamsFor(unit.emotion, unit.intensity, unit.styled, rate);
    const key = synthesisKey(client.baseUrl, unit.styleId, unit.speech, params);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const job = this.limited(() => client.speak(unit.speech, unit.styleId, params))
      .then((wav) => {
        this.cache.set(key, wav);
        return wav;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  /** 同時に頼む数を絞る */
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    while (this.running >= SYNTH_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * 本文を、この PC の外のホストへ送ってよいかを訊く。
 * 設定の接続先に別のホストを書いたときだけ出る。閉じたら送らない。
 *
 * **画面の真ん中の窓（モーダル）で訊く**（作者の答え 2026-11-05「真ん中の窓に戻す」）。本文が外へ
 * 出る確認なので、画面上部の選択の窓では目立ちが足りない。ボタンは［送る］と
 * ［送る（以降は訊かない）］の2つで、後者を選べばそのホストだけ覚える（鍵は
 * `voice.remoteHost.<ホスト:ポート>`）。覚えるのは送ると答えたときだけ。別のホスト・ポートに
 * 変わったら鍵が変わるので、必ず訊き直す。覚えた答えは「訊かないことにした確認を見直す」と
 * 設定から外せる（設計書6.89）
 */
async function askSendToRemoteHost(host: string): Promise<boolean> {
  const id = voiceRemoteHostConfirmId(host);
  const send = "送る";
  if (rememberedAnswer(readConfirmMemory(), id) === send) {
    logStep(`確認を省略（以降は訊かない）: ${id} / ${send}`);
    return true;
  }
  const sendAndRemember = rememberLabel(send);
  /*
    窓には端末名を先に出す（0.141.1。作者の答え 2026-11-07 A）。番地だけではどの機械か
    分からないため。引けなくても・2秒で返事が無くても止めず、書いた宛先のまま出す（実装ルール5）。
    覚えの鍵（上の id）は書いた宛先のまま——名前が変わっても訊き直さない
  */
  const named = await describeVoiceHost(host);
  if (named.outcome !== "resolved" && named.outcome !== "skipped") {
    logStep(
      `人物の声の送り先の名前を引けませんでした（${host}・${named.outcome}${named.error ? `・${named.error}` : ""}）。書いた宛先のまま訊きます`
    );
  }
  // 全角の括弧で終わるときは、続く助詞との間を空けない（「…（192.168.3.15:10101）へ」）
  const label = named.label.endsWith("）") ? named.label : `${named.label} `;
  const picked = await vscode.window.showWarningMessage(
    `本文が ${label}へ送られます。`,
    {
      modal: true,
      detail:
        `人物の声で読むために、読む文を ${label}の音声合成のエンジンへ送ります。` +
        "このホストはこの PC の外にあるため、送った文は相手に届きます。" +
        "心当たりのないホストなら、送らないでください（設定 novelai.readAloud.voiceEngineUrl で変えられます）。",
    },
    send,
    sendAndRemember
  );
  if (picked === sendAndRemember) {
    try {
      await saveConfirmMemory(withRemembered(readConfirmMemory(), id, send));
      logStep(`以降は訊かないことにしました: ${id} / ${send}`);
    } catch (error) {
      // 覚えられなくても、送ると答えたことは変わらない（次にまた訊くだけ）
      logStep(`「以降は訊かない」を覚えられませんでした: ${id} / ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return picked === send || picked === sendAndRemember;
}

let shared: VoiceReadingService | undefined;

/** 拡張機能に1つの係（合成の控えを画面をまたいで使い回す） */
export function voiceReadingService(): VoiceReadingService {
  shared ??= new VoiceReadingService();
  return shared;
}

function readEngineUrl(): string | undefined {
  const raw = vscode.workspace
    .getConfiguration("novelai")
    .get<string>(VOICE_ENGINE_URL_SETTING, DEFAULT_VOICE_ENGINE_URL);
  return normalizeEngineUrl(raw);
}

/**
 * 読めなかった理由。**engineDown はエンジンに届かなかった印**——原稿エディターは
 * この印のときだけ画面の真ん中に窓を出す（voiceEngineDownPrompt）
 */
export type VoiceProblem = { problem: string; engineDown?: true };

function engineFailure(error: unknown, work: WorkEntry | undefined): VoiceProblem {
  const problem = describeEngineFailure(error, work);
  return error instanceof VoiceEngineError && error.kind === "unreachable"
    ? { problem, engineDown: true }
    : { problem };
}

/**
 * 失敗を作者向けの1文にする。**エンジンの返した本文はログへ**（実装ルール5）
 */
function describeEngineFailure(error: unknown, work: WorkEntry | undefined): string {
  if (work) useLogFile(work.folderPath);
  if (error instanceof VoiceEngineError) {
    logFailure("人物の声で朗読", {
      種別: error.kind,
      内容: error.message,
      ...(error.detail ? { 詳しく: error.detail } : {}),
    });
    return voiceEngineNextStep(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  logFailure("人物の声で朗読", { 内容: message });
  return `人物の声で読めませんでした（${message}）。詳しくはログにあります。`;
}

async function loadPeople(work: WorkEntry): Promise<Character[]> {
  const { characters } = await new CharacterStore(work).loadAll();
  return characters;
}

async function characterNames(work: WorkEntry): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const character of await loadPeople(work)) names.set(character.id, character.name);
  return names;
}

function toCastPerson(character: Character): CastPerson {
  return {
    id: character.id,
    name: character.name,
    aliases: character.aliases,
    speechStyle: character.speechStyle,
  };
}

/**
 * 区切りへ渡す人物。**その区切りに名前か別名が出る人物を先に**並べ、上限で切る
 * （話者は名前の出ない台詞でも決まるので、出ない人物も後ろへ並べる）
 */
export function peopleForChunk(
  chunk: Pick<CastChunk, "text">,
  people: readonly CastPerson[],
  max = VOICE_CAST_MAX_PEOPLE
): CastPerson[] {
  const mentioned: CastPerson[] = [];
  const others: CastPerson[] = [];
  for (const person of people) {
    const names = [person.name, ...person.aliases].filter((n) => n.trim() !== "");
    if (names.some((name) => chunk.text.includes(name))) mentioned.push(person);
    else others.push(person);
  }
  return [...mentioned, ...others].slice(0, max);
}

/** 原稿エディタから渡す、推定する話 */
export interface VoiceCastTarget {
  work: WorkEntry;
  episodePath: string;
  /** いま画面が持っている本文（LF区切り） */
  text: string;
}

interface CachedCastChunk {
  items: unknown[];
}

function isCachedCastChunk(value: unknown): value is CachedCastChunk {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).items)
  );
}

/**
 * 区切りの控えの鍵（段ごと。版1.3）。**段の名前を必ず含める**——同じ区切りの1段目と
 * 2段目は答えの形が違うので、鍵が重なると一方の答えを他方として読む。
 *
 * - 1段目（話者）：本文・前後の本文・送った人物の一覧・コードで決めた話者を含める
 *   （一覧が変われば答えも変わる。決めた番号は頼み方に「答えません」と書くので、
 *   決め方の規則が変わったのに古い答えを引くと、訊かなかった番号の答えが無いまま残る）
 *   **添えた話者の流れも含める**（版1.4）。前の区切りの答えが変われば、次の区切りも
 *   訊き直す（同じ流れになれば、その先は当たる）
 * - 2段目（感情）：本文だけ。人物の一覧も1段目の答えも渡さないので、人物を足しても当たる
 */
function stageCacheHash(
  stage: VoiceCastStage,
  chunk: CastChunk,
  people: readonly CastPerson[],
  flow: readonly string[] = []
): string {
  if (stage === "emotion") return hashText(JSON.stringify(["emotion", chunk.text]));
  return hashText(
    JSON.stringify([
      "speaker",
      chunk.text,
      chunk.before,
      chunk.after,
      people.map((p) => [p.id, p.name, p.aliases, p.speechStyle]),
      [...chunk.decided.entries()],
      // 流れが無い区切りは版1.3 と同じ形の鍵にする（区切りの数が1つの話で余計な差を作らない）
      ...(flow.length > 0 ? [flow] : []),
    ])
  );
}

/** 控えから引いた1段目の答えを検算し、番号 → 人物の id（流れを組むため） */
function cachedSpeakers(
  items: readonly unknown[],
  chunk: CastChunk,
  people: readonly CastPerson[]
): Map<number, string | null> {
  return validateCastSpeakers(items, chunk.dialogues.length, people, chunk.decided).speakers;
}

/** 1段で送る本文の字数（確認の窓に出す。1段目は前後の参考の本文も送る） */
function sentChars(stage: VoiceCastStage, chunk: CastChunk): number {
  return stage === "speaker"
    ? chunk.text.length + chunk.before.length + chunk.after.length
    : chunk.text.length;
}

/** 検算で捨てた答えの理由ごとの件数を「理由 n件・理由 m件」にする */
function dropSummary(dropped: ReadonlyArray<{ reason: string; item: unknown }>): string {
  return Object.entries(countDropReasons(dropped))
    .map(([reason, count]) => `${reason} ${count}件`)
    .join("・");
}

/**
 * AIで台詞ごとの話者と感情を推定する（P-54）。
 *
 * 1. 本文を行の切れ目で区切り、台詞の頭に〔番号〕を差し込む。地の文に話者が
 *    はっきり書いてある台詞は、コードで話者を決めておく（案 A。1段目で訊かない）
 * 2. 区切りごとに2段で訊く（案 B。版1.3）：1段目は話者だけ、2段目は感情と強さだけ。
 *    訊く番号が無い区切り（全部コードで決まった）は1段目を呼ばない
 *    印（`VOICE_CAST_FLOW_ENABLED`。製品の既定は切る。0.142.2）を入れたときだけ、1段目に
 *    前の区切りまでに決まった話者の流れ（名前だけ。直前の5件まで）を添える（案 C。版1.4）。
 *    流れは前の区切りの答えで決まるので、**区切りを話の順に1つずつ訊く**
 * 3. 段ごとに、**内容ハッシュ＋プロバイダID＋モデル名＋版＋段**（1段目は添えた流れも）で
 *    控えを引く（実装ルール4）。当たった段は送らない
 * 4. 送る前に台詞の数・呼ぶ回数（段ごとの内訳）・字数を示して確かめる（有料なら料金の確認）
 * 5. 答えを段ごとに検算し、**作者が直した行は残して**AIの行だけ入れ替える
 *
 * 1つでも段が失敗・中止したら書き換えない（済んだ段は控えにあるので、
 * 押し直すと失敗した段から送る）。流れを添えるときだけ、1段目が失敗したらそれより後ろの
 * 区切りの1段目は送らない（流れが決まらず、押し直したときに頼みが変わって送り直しになるため）。
 * 流れを添えないとき（既定）は、区切りの頼みが前の答えに左右されないので、失敗しても後ろを送る。
 *
 * `options.flow` は印の上書き（テスト用）。渡さなければ `VOICE_CAST_FLOW_ENABLED` に従う。
 */
export async function runVoiceCast(
  target: VoiceCastTarget,
  registry: AIRegistry,
  options?: { flow?: boolean }
): Promise<void> {
  const { work } = target;
  const useFlow = options?.flow ?? VOICE_CAST_FLOW_ENABLED;
  useLogFile(work.folderPath);

  if (castDialogues(target.text).length === 0) {
    notifyDone("この話には、話者を推定する台詞（「」）がありません。");
    return;
  }

  // 壊れたファイルはAIを呼ぶ前に止める（呼んでから書けないと分かっても遅い）
  let loaded;
  let people: CastPerson[];
  try {
    loaded = await loadVoiceCast(work, target.episodePath);
    people = (await loadPeople(work)).map(toCastPerson);
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }
  // 話者の決め方は人物の一覧が要るので、一覧を読んでから区切る
  const chunks = castChunksOf(
    target.text,
    VOICE_CAST_CHUNK_CHARS,
    castSpeakersFromText(target.text, people),
    { before: VOICE_CAST_CONTEXT_BEFORE_CHARS, after: VOICE_CAST_CONTEXT_AFTER_CHARS }
  );
  const totalDialogues = chunks.reduce((sum, c) => sum + c.dialogues.length, 0);

  const resolved = await ensureConfigured(registry, "voiceCast");
  if (!resolved) return;
  if (!(await confirmProviderReachable(resolved.provider, "台詞の話者と感情の推定", resolved.model))) {
    return;
  }

  const base: CacheKeyBase = {
    feature: "voiceCast",
    promptVersion: VOICE_CAST_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };
  const cache = new ChunkCache(work);
  await cache.load();
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  // 作者が［台詞の一覧］で直した行の話者（話の通し番号 → 人物の id）。流れへ確かな答えとして入れる
  const authorSpeakers = new Map<number, string | null>();
  for (const [index, entry] of castLookup(
    loaded.file.entries.filter((entry) => entry.source === "author"),
    castDialogues(target.text)
  )) {
    authorSpeakers.set(index, entry.speakerId);
  }

  /**
   * 区切りごとの用意。2段目（感情）の頼みと鍵は本文だけで決まるので先に作る。
   * 1段目（話者）の頼みと鍵は、前の区切りまでの話者の流れ（案 C。版1.4）で変わるので、
   * 区切りを順に歩きながら作る（`speakerStageOf`）。`speakerHash` は最後に混ぜるときに引く鍵
   */
  const prepared = chunks.map((chunk) => {
    const chunkPeople = peopleForChunk(chunk, people);
    const requests = voiceCastStageRequests(chunk, chunkPeople);
    return {
      chunk,
      people: chunkPeople,
      asksSpeaker: requests.speaker !== undefined,
      emotion: { request: requests.emotion, hash: stageCacheHash("emotion", chunk, chunkPeople) },
      speakerHash: undefined as string | undefined,
    };
  });
  type Prepared = (typeof prepared)[number];
  const speakerStageOf = (
    p: Prepared,
    history: ReadonlyArray<string | null>
  ): { request: VoiceCastStageRequest; hash: string } | undefined => {
    // 流れを添えないときは、流れの無い区切りと同じ頼み・同じ鍵（版1.3 と同じ形）にする
    const flow = useFlow ? castFlowNames(history, nameOf, VOICE_CAST_FLOW_MAX) : [];
    const request = voiceCastStageRequests(p.chunk, p.people, { flow }).speaker;
    return request ? { request, hash: stageCacheHash("speaker", p.chunk, p.people, flow) } : undefined;
  };

  // 送る段を数える（確認の窓のため）。控えに当たる区切りが続く間は、流れも控えから組める。
  // 流れを添えるときは、**最初に当たらない1段目より後ろの1段目は、前の答えが出るまで頼みが
  // 決まらない**ので、「送るかもしれない」として数える（上限。前と同じ答えが返れば、控えに
  // 当たって減る）。流れを添えないとき（既定）は頼みが前の答えに左右されないので、正確に数える
  let speakerCalls = 0;
  let speakerMaybe = 0;
  let emotionCalls = 0;
  let chars = 0;
  const pendingChunks = new Set<CastChunk>();
  {
    const history: Array<string | null> = [];
    let flowKnown = true;
    for (const p of prepared) {
      let aiSpeakers: Map<number, string | null> | undefined;
      if (p.asksSpeaker) {
        if (flowKnown) {
          const stage = speakerStageOf(p, history);
          p.speakerHash = stage?.hash;
          const cached = stage ? cache.get(stage.hash, base) : undefined;
          if (isCachedCastChunk(cached)) {
            aiSpeakers = cachedSpeakers(cached.items, p.chunk, p.people);
          } else {
            speakerCalls++;
            if (useFlow) flowKnown = false;
            chars += sentChars("speaker", p.chunk);
            pendingChunks.add(p.chunk);
          }
        } else {
          speakerMaybe++;
          chars += sentChars("speaker", p.chunk);
          pendingChunks.add(p.chunk);
        }
      }
      history.push(...castChunkSpeakerSequence(p.chunk, aiSpeakers, authorSpeakers));
      if (!isCachedCastChunk(cache.get(p.emotion.hash, base))) {
        emotionCalls++;
        chars += sentChars("emotion", p.chunk);
        pendingChunks.add(p.chunk);
      }
    }
  }
  const plannedCalls = speakerCalls + speakerMaybe + emotionCalls;

  if (plannedCalls > 0) {
    // 台詞の数は区切りで数える（2段とも送る区切りの台詞を2度数えない）
    const pendingDialogues = [...pendingChunks].reduce((sum, chunk) => sum + chunk.dialogues.length, 0);
    // 2段に分けたので回数は区切りの数の2倍まで増える。内訳を見せて、増えた理由が分かるようにする
    const breakdown = `話者${speakerCalls + speakerMaybe}回・感情${emotionCalls}回`;
    const upTo = speakerMaybe > 0 ? "最大" : "";
    const ok = resolved.provider.isPaid
      ? await confirmPaidUsage(resolved.provider, {
          actionLabel: "台詞の話者と感情の推定",
          model: resolved.model,
          calls: plannedCalls,
          sends:
            `この話の本文 ${chars.toLocaleString("ja-JP")}字と登場人物の名前・口調` +
            "（前回から変わっていない所は送りません）",
          more: [
            `話者と感情を分けて訊くので、1区切りにつきAIを2回まで呼びます（${breakdown}）。`,
            ...(speakerMaybe > 0
              ? ["話者は前の区切りの答えに続けて訊くので、前と同じ答えが返れば回数は減ります。"]
              : []),
            "本文は書き換えません。推定の結果は作者が［台詞の一覧］で直せます。",
          ],
          remember: { id: "ai.paid.voiceCast" },
          work,
        })
      : await confirmRun(
          `この話の台詞${pendingDialogues}個の話者と感情を推定します。` +
            `AIを${upTo}${plannedCalls}回呼びます（${breakdown}。話者と感情を分けて訊きます。` +
            `${resolved.provider.displayName}・${resolved.model}、` +
            `本文 ${chars.toLocaleString("ja-JP")}字）。前回から変わっていない所は送りません。本文は書き換えません。`,
          "推定する",
          { work }
        );
    if (!ok) return;
  }

  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model,
    "voiceCast"
  );
  const outputLimit = resolveOutputLimitForSend(resolved.provider.id, resolved.model, "voiceCast");

  let failed = 0;
  /** 前の区切りの1段目が失敗したため、送らなかった1段目の数 */
  let speakerHeld = 0;
  let cancelled = false;
  let sentCalls = 0;
  if (plannedCalls > 0) {
    await withCancellableProgress("台詞の話者と感情を推定しています", async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      logStep(
        `台詞の話者と感情の推定を開始: ${work.title} / ${speakerMaybe > 0 ? "最大" : ""}${plannedCalls}回` +
          `（2段に分けて訊く${useFlow ? "・話者は前の区切りの流れを添えて順に訊く" : ""}） / ` +
          `${resolved.provider.displayName} / ${resolved.model} / v${VOICE_CAST_VERSION}`
      );

      /** 1段を送り、読めた答えを控えへ入れる。読めた答えか、失敗（undefined）を返す */
      const send = async (
        request: VoiceCastStageRequest,
        hash: string
      ): Promise<unknown[] | undefined | "cancelled"> => {
        if (token.isCancellationRequested) return "cancelled";
        sentCalls++;
        progress.report({
          message: `${sentCalls}/${plannedCalls}`,
          increment: 100 / plannedCalls,
        });
        const stageLabel = request.stage === "speaker" ? "話者" : "感情";
        try {
          const response = await resolved.provider.generate({
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            model: resolved.model,
            // 揺らさない。同じ本文には同じ演出を返してほしい
            temperature: 0,
            maxOutputTokens: outputLimit.tokens,
            plannedOutputTokens,
            jsonSchema: request.jsonSchema,
            disableThinking: true,
            signal: controller.signal,
            meta: { feature: "voiceCast", workFolder: work.folderPath },
          });
          const items = parseCastResult(response.text);
          if (!items) {
            failed++;
            logFailure("台詞の話者と感情の推定", {
              段: stageLabel,
              理由: response.truncated ? "応答が出力上限で切り詰められました" : "応答を読み取れません",
              応答: responseExcerptForLog(response.text),
            });
            return undefined;
          }
          // 検算は控えから取り出すときに行う（検算を締めたとき古い答えが素通りしないように）
          await cache.set(hash, base, { items } satisfies CachedCastChunk);
          return items;
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") return "cancelled";
          failed++;
          reportAIError("台詞の話者と感情の推定", error, resolved.provider.id);
          return undefined;
        }
      };

      // **区切りを話の順に訊く**（版1.4）。1段目の頼みに、前の区切りまでの話者の流れを添えるため
      const history: Array<string | null> = [];
      let speakerBlocked = false;
      for (const p of prepared) {
        let aiSpeakers: Map<number, string | null> | undefined;
        if (p.asksSpeaker) {
          if (speakerBlocked) {
            // 前の1段目が失敗すると、ここの流れが決まらない。送っても、次に押したとき失敗した
            // 区切りの答えが入って流れが変わり、もう一度送ることになる（無駄撃ち）
            speakerHeld++;
          } else {
            const stage = speakerStageOf(p, history);
            p.speakerHash = stage?.hash;
            if (stage) {
              const cached = cache.get(stage.hash, base);
              const items = isCachedCastChunk(cached) ? cached.items : await send(stage.request, stage.hash);
              if (items === "cancelled") {
                cancelled = true;
                return;
              }
              if (items) aiSpeakers = cachedSpeakers(items, p.chunk, p.people);
              // 止めるのは流れを添えるときだけ。添えないなら後ろの頼みは変わらないので送ってよい
              else if (useFlow) speakerBlocked = true;
            }
          }
        }
        history.push(...castChunkSpeakerSequence(p.chunk, aiSpeakers, authorSpeakers));
        // 2段目は本文だけで決まる（流れに関わらない）ので、1段目が止まっても送る
        if (!isCachedCastChunk(cache.get(p.emotion.hash, base))) {
          const items = await send(p.emotion.request, p.emotion.hash);
          if (items === "cancelled") {
            cancelled = true;
            return;
          }
        }
      }
    });
    await cache.save();
  }

  if (cancelled) {
    notifyDone("台詞の推定を中止しました。結果は書き換えていません（済んだ所は、次に押したときに送りません）。");
    return;
  }
  if (failed > 0) {
    void warnWithLog(
      `台詞の推定で${failed}か所が失敗しました。結果は書き換えていません。` +
        (speakerHeld > 0
          ? `話者は前の区切りの答えに続けて訊くので、その後ろの${speakerHeld}区切りの話者も送っていません。`
          : "") +
        "もう一度押すと、失敗した所から送り直します。"
    );
    return;
  }

  const fresh: CastEntry[] = [];
  const droppedSpeaker: Array<{ reason: string; item: unknown }> = [];
  const droppedEmotion: Array<{ reason: string; item: unknown }> = [];
  let unanswered = 0;
  let decidedByText = 0;
  let calmFilled = 0;
  for (const { chunk, people: chunkPeople, asksSpeaker, emotion, speakerHash } of prepared) {
    const emotionCached = cache.get(emotion.hash, base);
    const speakerCached = speakerHash !== undefined ? cache.get(speakerHash, base) : undefined;
    const emotionItems = isCachedCastChunk(emotionCached) ? emotionCached.items : undefined;
    const speakerItems = isCachedCastChunk(speakerCached) ? speakerCached.items : undefined;
    // 失敗は上で止めているので、ここで控えが欠けるのは控えの読み書きの不調だけ。混ぜずに飛ばす
    if (!emotionItems || (asksSpeaker && !speakerItems)) continue;
    // **AIを信用しない**（実装ルール3）。検算は段ごと。本文に書いてあった話者が先に立つ
    const checked = castGuessesForStages(
      { speakerItems, emotionItems },
      chunk,
      chunkPeople
    );
    droppedSpeaker.push(...checked.droppedSpeaker);
    droppedEmotion.push(...checked.droppedEmotion);
    decidedByText += checked.decidedByText;
    calmFilled += checked.calmFilled;
    chunk.dialogues.forEach((dialogue, i) => {
      const guess = checked.guesses.get(i + 1);
      // 答えが無い・捨てた台詞は書かない（読むときに「不明・平静」で読む）
      if (!guess) {
        unanswered++;
        return;
      }
      fresh.push({
        quote: dialogue.quote,
        nth: dialogue.nth,
        speakerId: guess.speakerId,
        speakerName: guess.speakerId ? nameOf.get(guess.speakerId) ?? null : null,
        emotion: guess.emotion,
        intensity: guess.intensity,
        source: "ai",
      });
    });
  }
  const droppedTotal = droppedSpeaker.length + droppedEmotion.length;
  if (droppedTotal > 0) {
    // 段ごとに分けて出す（どちらの段の頼み方を直せばよいかが分かるように）
    const part = (label: string, dropped: typeof droppedSpeaker): string =>
      dropped.length > 0 ? `${label} ${dropped.length}件（${dropSummary(dropped)}）` : `${label} 0件`;
    logStep(
      `台詞の推定：検算で${droppedTotal}件を捨てました（` +
        `${part("話者の段", droppedSpeaker)} ／ ${part("感情の段", droppedEmotion)}）`
    );
  }

  const entries = mergeCastEntries(loaded.file.entries, fresh);
  try {
    await saveVoiceCast(
      work,
      target.episodePath,
      {
        ...loaded.file,
        entries,
        lastRun: {
          providerId: resolved.provider.id,
          model: resolved.model,
          promptVersion: VOICE_CAST_VERSION,
          at: new Date().toISOString(),
          dropped: droppedTotal,
          droppedSpeaker: droppedSpeaker.length,
          droppedEmotion: droppedEmotion.length,
        },
      },
      loaded.hash
    );
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }
  logStep(
    `台詞の推定が終わりました: 台詞${totalDialogues}個・推定${fresh.length}件` +
      `（うち本文に書いてあった話者${decidedByText}個、その感情が無く平静にした${calmFilled}個）・` +
      `答えの無かった台詞${unanswered}個・AIを呼んだ回数${sentCalls}` +
      `（控えに当たらなかった段。区切り${chunks.length}）`
  );
  notifyDone(
    unanswered > 0
      ? `台詞${totalDialogues}個のうち${fresh.length}個の話者と感情を推定しました（${unanswered}個は決まらず、台詞の既定の声で読みます）。`
      : `台詞${totalDialogues}個の話者と感情を推定しました。次の［▶ 読む］から使います。`
  );
}

/** 列の一言 */
export async function voiceCastStatus(target: VoiceCastTarget): Promise<string> {
  try {
    const dialogues = castDialogues(target.text);
    const cast = (await loadVoiceCast(target.work, target.episodePath)).file.entries;
    const assignment = (await loadVoiceAssignment(target.work)).file;
    const found = castLookup(cast, dialogues).size;
    const voices = Object.keys(assignment.characters).length;
    return (
      `台詞の推定：${found}/${dialogues.length}個` +
      `・声の割り当て：${assignment.narrator ? "語り手あり" : "語り手は未選択"}・人物${voices}人`
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 推定の一覧を見て直す（直した行は作者のもの。再推定で上書きしない） */
export async function manageVoiceCast(target: VoiceCastTarget): Promise<void> {
  const { work } = target;
  let people: CastPerson[];
  try {
    people = (await loadPeople(work)).map(toCastPerson);
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }
  for (;;) {
    let loaded;
    try {
      loaded = await loadVoiceCast(work, target.episodePath);
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return;
    }
    const dialogues = castDialogues(target.text);
    if (dialogues.length === 0) {
      notifyDone("この話には台詞（「」）がありません。");
      return;
    }
    const lookup = castLookup(loaded.file.entries, dialogues);
    const items = dialogues.map((dialogue) => {
      const entry = lookup.get(dialogue.index);
      const who = entry?.speakerName ?? "不明";
      return {
        label: `${dialogue.index + 1}. ${dialogue.quote.slice(0, 40)}`,
        description: entry
          ? `${who}・${entry.emotion}・${entry.intensity}${entry.source === "author" ? "（直した）" : "（AI）"}`
          : "未推定（台詞の既定の声・平静で読みます）",
        dialogue,
        entry,
      };
    });
    const picked = await vscode.window.showQuickPick([...items, cancelItem("閉じる")], {
      title: "台詞の話者と感情（選ぶと直せます。直した行は推定し直しても残ります）",
      matchOnDescription: true,
    });
    if (!picked || isCancelItem(picked) || !("dialogue" in picked)) return;

    // どの段でも［戻る］か閉じたら、直さずに一覧へ戻る
    const speaker = await vscode.window.showQuickPick(
      [
        { label: "不明", id: null as string | null, name: null as string | null },
        ...people.map((p) => ({ label: p.name, description: p.aliases.join("、"), id: p.id, name: p.name })),
        cancelItem("戻る"),
      ],
      { title: `${picked.dialogue.quote.slice(0, 30)} の話者` }
    );
    if (!speaker || isCancelItem(speaker) || !("id" in speaker)) continue;
    const emotion = await vscode.window.showQuickPick(
      [...VOICE_EMOTIONS.map((e) => ({ label: e as VoiceEmotion, emotion: e })), cancelItem("戻る")],
      { title: "感情" }
    );
    if (!emotion || isCancelItem(emotion) || !("emotion" in emotion)) continue;
    const intensity = await vscode.window.showQuickPick(
      [
        ...VOICE_INTENSITIES.map((i) => ({ label: i as VoiceIntensity, intensity: i })),
        cancelItem("戻る"),
      ],
      { title: "強さ" }
    );
    if (!intensity || isCancelItem(intensity) || !("intensity" in intensity)) continue;
    try {
      await saveVoiceCast(
        work,
        target.episodePath,
        {
          ...loaded.file,
          entries: editCastEntry(loaded.file.entries, picked.dialogue, {
            speakerId: speaker.id,
            speakerName: speaker.name,
            emotion: emotion.emotion,
            intensity: intensity.intensity,
          }),
        },
        loaded.hash
      );
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return;
    }
  }
}

/** 声の割り当て（語り手・台詞の既定・人物ごと）。QuickPick で選ぶ */
export async function assignVoices(work: WorkEntry, service: VoiceReadingService): Promise<void> {
  let speakers: VoiceSpeaker[];
  try {
    speakers = await service.speakers(true);
  } catch (error) {
    void warnWithLog(describeEngineFailure(error, work));
    return;
  }
  if (speakers.length === 0) {
    void warnWithLog(
      "音声合成のエンジンに話者が1人も見つかりませんでした。AivisSpeech（または VOICEVOX）で話者を入れてから、もう一度押してください。"
    );
    return;
  }
  let people: Character[];
  try {
    people = await loadPeople(work);
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }
  for (;;) {
    let loaded;
    try {
      loaded = await loadVoiceAssignment(work);
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return;
    }
    const file = loaded.file;
    const label = (ref: VoiceRef | undefined): string =>
      ref ? `${ref.speakerName}／${ref.styleName}` : "未選択";
    const targets: Array<vscode.QuickPickItem & { slot: "narrator" | "dialogueDefault" | Character }> = [
      { label: "語り手（地の文）", description: label(file.narrator), slot: "narrator" },
      {
        label: "台詞の既定",
        description: `${label(file.dialogueDefault)}（話者が分からない・声を決めていない人物の台詞）`,
        slot: "dialogueDefault",
      },
      ...people.map((character) => ({
        label: character.name,
        description: label(file.characters[character.id]),
        slot: character,
      })),
    ];
    const picked = await vscode.window.showQuickPick([...targets, cancelItem("閉じる")], {
      title: "声の割り当て（この作品の声。選ぶとエンジンの声から選べます）",
      matchOnDescription: true,
    });
    if (!picked || isCancelItem(picked) || !("slot" in picked)) return;

    const voice = await vscode.window.showQuickPick(
      [
        ...speakers.flatMap((speaker) =>
          speaker.styles.map((style) => ({
            label: `${speaker.name}／${style.name}`,
            ref: {
              speakerUuid: speaker.uuid,
              speakerName: speaker.name,
              styleName: style.name,
              styleId: style.id,
            } satisfies VoiceRef,
          }))
        ),
        cancelItem("戻る"),
      ],
      { title: `${picked.label}の声`, matchOnDescription: true }
    );
    if (!voice || isCancelItem(voice) || !("ref" in voice)) continue;
    const next: VoiceAssignmentFile = { ...file, characters: { ...file.characters } };
    if (picked.slot === "narrator") next.narrator = voice.ref;
    else if (picked.slot === "dialogueDefault") next.dialogueDefault = voice.ref;
    else next.characters[picked.slot.id] = { ...voice.ref, characterName: picked.slot.name };
    try {
      await saveVoiceAssignment(work, next, loaded.hash);
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return;
    }
  }
}
