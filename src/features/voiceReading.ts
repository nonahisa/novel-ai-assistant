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
  assignedOtherEngines,
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
  voicePlanNotice,
  voicePlanUnits,
  type CastChunk,
  type CastEntry,
  type CastPerson,
  type VoiceAssignmentFile,
  type VoicePlanDownKind,
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
  DEFAULT_ENGINE_URLS,
  ENGINE_URL_SETTING,
  engineHostOutsideThisPc,
  LEGACY_ENGINE_URL_SETTING,
  resolveEngineUrl,
  SynthesisCache,
  VOICE_ENGINE_LABEL,
  type VoiceEngineId,
  synthesisKey,
  VOICE_EMOTIONS,
  VOICE_INTENSITIES,
  VoiceEngineClient,
  VoiceEngineError,
  voiceEngineDownPrompt,
  voiceEngineNextStep,
  voiceEngineSlowPrompt,
  voiceChoiceName,
  voiceChoiceRows,
  voiceParamsFor,
  missingEmotionStyleNotice,
  missingEmotionStyles,
  describeVoiceAdjust,
  formatAdjustValue,
  normalizeVoiceAdjust,
  parseVoiceAdjust,
  presetsForEngine,
  VOICE_ADJUST_STEPS,
  type VoiceAdjust,
  type VoiceEngineDownRoute,
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
import { readEngineUrlSettings } from "./voiceEngineSettings";
import {
  aivisDescriptionsOf,
  arrangeVoiceRows,
  countVoicePick,
  frequentVoiceKeys,
  usedVoiceKey,
  voiceGroupOf,
  VOICE_PICK_COUNTS_KEY,
  type GroupableVoiceRow,
} from "../core/voiceGroups";
import { PaceMemory, slowPaceNotice, SynthesisPaceWatch, VOICE_PACE_STORED_KEY, wavSeconds } from "../core/voicePace";

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

/** 古い設定の鍵（0.145 まで。エンジン1つ分の接続先。消さずに読む） */
export const VOICE_ENGINE_URL_SETTING = LEGACY_ENGINE_URL_SETTING;

/** 知らせに出す、そのエンジンの接続先の設定の名前 */
export function engineUrlSettingLabel(engine: VoiceEngineId): string {
  return `novelai.${ENGINE_URL_SETTING[engine]}`;
}

/** 先に作っておく文の数（いま頼まれた文を含めない） */
const PREFETCH_AHEAD = 3;
/**
 * 同時にエンジンへ頼む数（**エンジンごと**）。エンジンは1つずつ作るので、並べすぎても早くならない。
 * 人物ごとにエンジンを混ぜたとき（2段目。0.151.0）は、2つのエンジンが別々に作れるので枠も別にする
 * （1つの枠だと、遅いエンジンの頼みが枠を埋め、速いエンジンの文まで待たされる）
 */
const SYNTH_CONCURRENCY = 2;
/**
 * ［声の割り当て］で、［声］で選んでいない側のエンジンの話者の一覧を待つ長さ（0.151.0）。
 * 動いていなければ手元ではすぐ断られるが、外のホストで返事が無いと30秒待たせることになる
 */
export const OTHER_ENGINE_SPEAKERS_MS = 5_000;

/** エンジンごとの頼みの枠と、声づくりの速さの見張り（2段目。0.151.0） */
interface EngineLane {
  running: number;
  waiting: Array<() => void>;
  /** 声づくりが読む速さに追いついているかの見張り（1回の読み上げごとに始め直す。0.146.0） */
  pace: SynthesisPaceWatch;
  /** このエンジンでいちばん最後に音ができた時刻（ミリ秒。並べて頼んだときの待ちを数えないため） */
  lastSynthEndAt: number;
}
/** 話者の一覧を引き直すまでの間。作者が話者を足したら、少し待てば並ぶ */
const SPEAKERS_TTL_MS = 30_000;
/** 届かなかったときに、もう片方のエンジンへ問い合わせて待つ長さ（窓が出るのを待たせすぎない） */
export const OTHER_ENGINE_PROBE_MS = 1_500;
/** 測った速さを端末へ書くまでのまとめの待ち（ミリ秒） */
export const PACE_SAVE_DELAY_MS = 3_000;

/**
 * 音を作る係（拡張機能に1つ）。合成の控え・話者の一覧の控え・作っている途中の
 * 頼みを持つ。
 *
 * **エンジンを鍵に持つ**（0.146.0）。接続先・話者の一覧の控えはエンジンごと、音を作る口は
 * 文の印（`VoicePlanUnit.engine`）で選ぶ。合成の控えの鍵（`synthesisKey`）には前から接続先が
 * 入っているので、エンジンが違えば別の控えになる。人物ごとに混ぜる形（2段目。0.151.0）では、
 * 1回の読み上げで2つのエンジンを同時に扱う（頼みの枠と速さの見張りもエンジンごと）。
 */
export class VoiceReadingService {
  private readonly cache = new SynthesisCache();
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();
  private readonly speakersCache = new Map<
    VoiceEngineId,
    { url: string; at: number; list: VoiceSpeaker[] }
  >();
  /**
   * エンジンごとの枠と速さの見張り（2段目。0.151.0）。**見張りもエンジンごと**——1つの見張りだと、
   * 遅いエンジンの文の間に速いエンジンの文が挟まるたびに「続けて遅かった数」が切れ、
   * 並べた待ちの差し引き（前の音ができた時刻）も、速いほうの時刻で遅いほうの時間を削ってしまう
   */
  private readonly lanes = new Map<VoiceEngineId, EngineLane>();
  /** 測った速さの比（エンジンごと。この起動の間だけ）。書き出しの確認の窓の「かかる見込み」に使う */
  private readonly paceMemory = new PaceMemory<VoiceEngineId>();

  /** 端末へ要約を残す先（globalState を `verifiedState` で包んだもの）。無ければ残さない */
  private paceStore: VoicePickMemory | undefined;
  private paceSaveTimer: ReturnType<typeof setTimeout> | undefined;

  /** そのエンジンの、音1秒を作るのにかかる秒（測れていなければ undefined） */
  paceRatio(engine: VoiceEngineId): number | undefined {
    return this.paceMemory.ratio(engine);
  }

  /**
   * 前の起動までに測った比を端末から読み戻し、これからの測りの保存先にする（再起動のあとの
   * 最初の書き出しでも見込みを出すため）。**壊れた値は使わずに捨て、ログに1行残す**（実装ルール2）
   */
  usePaceStore(store: VoicePickMemory): void {
    this.paceStore = store;
    let raw: unknown;
    try {
      raw = store.get<unknown>(VOICE_PACE_STORED_KEY, undefined);
    } catch (error) {
      logStep(`人物の声：前に測った速さを読めませんでした：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!this.paceMemory.restore(raw)) {
      logStep("人物の声：前に測った速さの記録が壊れていたので、壊れた分は使いません");
    }
  }

  /** 新しく測った文があれば、要約を端末へ書く（書く口はここ1か所。失敗しても読み上げ・書き出しは止めない） */
  async savePace(): Promise<void> {
    if (this.paceSaveTimer !== undefined) {
      clearTimeout(this.paceSaveTimer);
      this.paceSaveTimer = undefined;
    }
    const store = this.paceStore;
    if (!store || !this.paceMemory.takeDirty()) return;
    try {
      await store.update(VOICE_PACE_STORED_KEY, this.paceMemory.snapshot());
    } catch (error) {
      logStep(`人物の声：測った速さを残せませんでした：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 測るたびに書かず、少しまとめて書く（1文ごとに端末へ書かない） */
  private schedulePaceSave(): void {
    if (!this.paceStore || this.paceSaveTimer !== undefined) return;
    this.paceSaveTimer = setTimeout(() => {
      this.paceSaveTimer = undefined;
      void this.savePace();
    }, PACE_SAVE_DELAY_MS);
    // 終了を待たせない（拡張機能の終了で残るタイマーにしない）
    (this.paceSaveTimer as { unref?: () => void }).unref?.();
  }

  /** 本文を送ってよいと作者が答えた外のホスト（この起動の間だけ。設定や端末には残さない） */
  private readonly allowedRemoteHosts = new Set<string>();
  private readonly askingRemoteHosts = new Map<string, Promise<boolean>>();

  /** 見張りが出した知らせ。次の音の答えに添えて1回だけ渡す */
  private slowNotice: string | undefined;
  /** この読み上げで知らせを出したか（エンジンが2つでも、1回の読み上げで1回） */
  private slowTold = false;
  /**
   * 読み始めのときに届かなかった、［声］で選んでいない側のエンジン（2段目。0.151.0）。
   * **次に読み始める（`start`）まで問い合わせ直さない**——読んでいる途中に打つと計画を取り直すので、
   * そのたびに届かないエンジンを待つことになる。値は届かなかった種類（一言の書き分けに使う）
   */
  private readonly downEngines = new Map<VoiceEngineId, VoicePlanDownKind>();

  constructor(
    private readonly engineUrl: (engine: VoiceEngineId) => string | undefined = readEngineUrl,
    private readonly fetchImpl?: FetchLike,
    /** この PC の外のホストへ本文を送る前の確認。テストで差し替える */
    private readonly confirmRemoteHost: (host: string) => Promise<boolean> = askSendToRemoteHost,
    /** 時刻（ミリ秒）。声づくりにかかった時間を測る。テストで差し替える */
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * 本文を運ぶ頼み（audio_query／synthesis）の前に呼ぶ。この PC の外のホストなら、
   * 最初の1回だけ確認の窓を出す。**断られたら本文を送らない。**
   * 覚えるのはホストごと・この起動の間だけ（設定の宛先を書き換えられても、別のホストなら
   * もう一度訊く）。同時に何文も頼まれても窓は1つだけ出す。
   * 見るのはそのエンジンの接続先（エンジンごとに別のホストを書ける）。
   */
  private async mayCarryText(
    engine: VoiceEngineId
  ): Promise<{ ok: true } | { ok: false; host: string }> {
    const url = this.engineUrl(engine);
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

  /**
   * いま、確認の窓を出さずにそのエンジンへ本文を送ってよいか（この PC か、許可済みのホスト）。
   * **先読みはこれで見る**（2段目。0.151.0）——後ろの文が別のエンジン（外のホスト）の声だと、
   * 確認より先に先読みで本文が出てしまう。許可がまだなら先読みせず、その文を頼まれたときに訊く
   */
  private carryAllowedNow(engine: VoiceEngineId): boolean {
    const url = this.engineUrl(engine);
    const host = url ? engineHostOutsideThisPc(url) : undefined;
    return host === undefined || this.allowedRemoteHosts.has(host);
  }

  /**
   * 本文を運ぶ前の確認（`mayCarryText`）を、音の書き出し（設計書6.42.4）からも通すための口。
   * 画面の朗読と同じ覚え方（ホストごと・この起動の間）を使う
   */
  allowCarryText(engine: VoiceEngineId): Promise<{ ok: true } | { ok: false; host: string }> {
    return this.mayCarryText(engine);
  }

  /**
   * 選んだエンジンに届かなかったとき、**もう片方のエンジンが動いているかを1回だけ短く問い合わせる**
   * （0.146.0。ノートPCの実機確認：設定は VOICEVOX を指していたが起動しておらず、AivisSpeech は
   * 動いていたのに読まなかった）。前もっては問い合わせない決まりはそのまま——呼ぶのは読み始めて
   * 届かなかったときだけ。
   *
   * - 問い合わせるのは名乗り（`/engine_manifest`。本文は運ばない）。`timeoutMs` で切る
   * - もう片方の接続先がこの PC の外なら、**問い合わせる前に**本文を送る前と同じ確認を通す
   *   （そちらで読むと本文が送られるので、確認なしに外へ繋がない）。断られたら問い合わせない
   * - 動いていればそのエンジンと宛先（`127.0.0.1:10101` の形）、動いていなければ undefined。
   *   失敗の中身はログだけ（原因は決め打ちしない）
   */
  async otherEngineRunning(
    engine: VoiceEngineId,
    timeoutMs = OTHER_ENGINE_PROBE_MS
  ): Promise<{ engine: VoiceEngineId; host: string } | undefined> {
    const other: VoiceEngineId = engine === "aivisspeech" ? "voicevox" : "aivisspeech";
    const url = this.engineUrl(other);
    if (!url) return undefined;
    const allowed = await this.mayCarryText(other);
    if (!allowed.ok) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await new VoiceEngineClient(url, this.fetchImpl, other).engineManifest(controller.signal);
      return { engine: other, host: new URL(url).host };
    } catch (error) {
      logStep(
        `人物の声：もう片方のエンジン（${VOICE_ENGINE_LABEL[other]}・${url}）も応答しませんでした（${
          error instanceof Error ? error.message : String(error)
        }）`
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** そのエンジンへの口（書き出しでライセンス・規約を引くのに使う） */
  engineClient(engine: VoiceEngineId): VoiceEngineClient {
    return this.client(engine);
  }

  /**
   * 書き出し用に1文の音を作る。**中止を通す**（長い話は数分かかるため）。
   * 控えにあればそれを使い、新しく作った音は控えへ入れない——1話ぶんの音で
   * 朗読の控え（64MB）を押し流すと、画面の［▶ 読む］がまた作り直しになる。
   * 同時に頼む数は朗読と同じ枠（`limited`。エンジンごと）で絞る。
   *
   * `outputSamplingRate` を渡すと、その標本化の速さで作らせる（2つのエンジンを混ぜて1つの MP3 に
   * するとき。0.151.0）。そのときは**朗読の控えを使わない**——控えの音はエンジンの既定の速さで、
   * 混ぜると速さが揃わずつなげない
   */
  synthesizeForExport(
    unit: VoicePlanUnit,
    rate: number,
    signal: AbortSignal,
    options: { outputSamplingRate?: number } = {}
  ): Promise<Uint8Array> {
    const client = this.client(unit.engine);
    const params = voiceParamsFor(unit.emotion, unit.intensity, unit.styled, rate, unit.adjust, unit.engine);
    if (options.outputSamplingRate === undefined) {
      const cached = this.cache.get(synthesisKey(client.baseUrl, unit.styleId, unit.speech, params));
      if (cached) return Promise.resolve(cached);
    }
    const lane = this.lane(unit.engine);
    return this.limited(unit.engine, async () => {
      if (signal.aborted) throw new VoiceEngineError("aborted", "中止しました", undefined, unit.engine);
      const startedAt = this.now();
      const wav = await client.speak(unit.speech, unit.styleId, params, signal, options.outputSamplingRate);
      const endedAt = this.now();
      // 読み上げと同じ測り方（前の音ができた時刻より前は数えない）。書き出しの見込みの材料にする
      const busyFrom = Math.max(startedAt, lane.lastSynthEndAt);
      lane.lastSynthEndAt = Math.max(lane.lastSynthEndAt, endedAt);
      this.paceMemory.record(unit.engine, (endedAt - busyFrom) / 1000, wavSeconds(wav));
      this.schedulePaceSave();
      return wav;
    });
  }

  private client(engine: VoiceEngineId): VoiceEngineClient {
    const url = this.engineUrl(engine);
    if (!url) {
      throw new VoiceEngineError(
        "badResponse",
        `${VOICE_ENGINE_LABEL[engine]}の接続先（${engineUrlSettingLabel(engine)}）が読めません。${DEFAULT_ENGINE_URLS[engine]} の形で書いてください`,
        undefined,
        engine
      );
    }
    return new VoiceEngineClient(url, this.fetchImpl, engine);
  }

  /**
   * そのエンジンの話者の一覧（少しのあいだ控える。控えはエンジンごと）。`signal` で打ち切れる
   * （［声の割り当て］で、［声］で選んでいない側を短く待つため）
   */
  async speakers(engine: VoiceEngineId, force = false, signal?: AbortSignal): Promise<VoiceSpeaker[]> {
    const client = this.client(engine);
    const cached = this.speakersCache.get(engine);
    if (
      !force &&
      cached &&
      cached.url === client.baseUrl &&
      Date.now() - cached.at < SPEAKERS_TTL_MS
    ) {
      return cached.list;
    }
    const list = await client.speakers(signal);
    this.speakersCache.set(engine, { url: client.baseUrl, at: Date.now(), list });
    return list;
  }

  /**
   * 文ごとの声を決める。**失敗は作者向けの文で返す**（投げない）。
   *
   * 割り当てた声は、その声の印のエンジンで読む（2段目。0.151.0）。［声］で選んでいない側の
   * エンジンは、割り当てにその印の声があるときだけ話者の一覧を引く（前もって問い合わせない決まり）。
   *
   * - ［声］のエンジンに届かない … 今までどおり読まない（`engineDown` で窓。［〇〇で読む］がある）
   * - もう片方のエンジンに届かない … **止めない**。そのエンジンの声だけ代わりの声で読み、一言を返す。
   *   止めると、窓の［〇〇で読む］で［声］を切り替えても、届かないエンジンの声が残る限り読めない
   * - 引けない声（入れ直して消えた・前の版の声）… 代わりの声で読み、一言を返す（0.146.0）
   *
   * 一言（`notice`）を出すのは呼ぶ側で、1回の読み上げで1回
   */
  async plan(
    work: WorkEntry | undefined,
    episodePath: string,
    text: string,
    sentences: readonly ReadingSentence[],
    engine: VoiceEngineId,
    /**
     * `start`：［▶ 読む］で読み始めたときの計画か（声づくりの速さの見張りを始め直す）。
     * `recheckEngines`：届かなかったエンジンの覚えを使わず問い合わせ直す（書き出し。0.151.0）——
     * 読み上げの間に作者がエンジンを起動していても、覚えのまま代わりの声で MP3 を作ってしまうため。
     * 速さの見張りは読んでいる最中のものなので、`start` と分けて始め直さない
     */
    options: { start?: boolean; recheckEngines?: boolean } = {}
  ): Promise<{ units: VoicePlanUnit[]; notice?: string } | VoiceProblem> {
    if (options.recheckEngines) this.downEngines.clear();
    if (options.start) {
      // 1回の読み上げで1回だけ知らせる。覚えずに、読み始めるたびに見直す（作者の決定 2026-11-08）
      for (const lane of this.lanes.values()) lane.pace.reset();
      this.slowNotice = undefined;
      this.slowTold = false;
      // 届かなかったエンジンも、読み始めるたびに問い合わせ直す（起動していれば、その声で読む）
      this.downEngines.clear();
    }
    let speakers: VoiceSpeaker[];
    try {
      speakers = await this.speakers(engine);
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
    const others = new Map<VoiceEngineId, VoiceSpeaker[]>();
    for (const other of assignedOtherEngines(assignment, engine)) {
      if (this.downEngines.has(other)) continue;
      try {
        others.set(other, await this.speakers(other));
      } catch (error) {
        // ログは残す（実装ルール5）。届かない種類は、一言の書き分けにだけ使う（原因を当てない）
        describeEngineFailure(error, work);
        this.downEngines.set(other, error instanceof VoiceEngineError ? error.kind : "badResponse");
      }
    }
    const planned = voicePlanUnits({
      sentences,
      dialogues: castDialogues(text),
      cast,
      assignment,
      speakers,
      engine,
      others,
      downEngines: new Set(this.downEngines.keys()),
      names,
    });
    if (!planned) {
      return {
        problem: `音声合成のエンジン（${VOICE_ENGINE_LABEL[engine]}）に話者が1人も見つかりませんでした。${VOICE_ENGINE_LABEL[engine]}で話者（音声合成モデル）を入れてから、もう一度押してください。`,
      };
    }
    const notice = voicePlanNotice(planned, this.downEngines);
    if (notice) logStep(`人物の声：${notice}`);
    return notice ? { units: planned.units, notice } : { units: planned.units };
  }

  /**
   * その文の音を作り、後ろの数文も並べて作っておく（先読み）。
   */
  async audio(
    units: readonly VoicePlanUnit[],
    index: number,
    rate: number,
    work?: WorkEntry
  ): Promise<{ wav: Uint8Array; slowNotice?: string } | VoiceProblem> {
    const unit = units[index];
    if (!unit) return { problem: "読む文が見つかりません" };
    const allowed = await this.mayCarryText(unit.engine);
    if (!allowed.ok) {
      return {
        problem: `本文を ${allowed.host} へ送ることを許可していないので、人物の声では読めません。この PC の外のホストへ送りたくなければ、設定 ${engineUrlSettingLabel(unit.engine)} を ${DEFAULT_ENGINE_URLS[unit.engine]} にするか、［声］で OS の声を選んでください。`,
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
      // 確認の窓をまだ通っていないエンジン（外のホスト）の文は先読みしない。頼まれたときに訊く
      if (!this.carryAllowedNow(next.engine)) continue;
      // 先読みの失敗は、その文を頼まれたときに改めて出す（ここでは黙る）
      try {
        this.synthesize(next, rate).catch(() => undefined);
      } catch {
        break;
      }
    }
    try {
      const wav = await current;
      // 声づくりが追いつかない知らせ（先読みの文で出たものも、次の答えに添えて1回だけ）
      const slowNotice = this.slowNotice;
      this.slowNotice = undefined;
      return slowNotice ? { wav, slowNotice } : { wav };
    } catch (error) {
      return engineFailure(error, work);
    }
  }

  /** 1文の音。控え → 作っている途中 → 新しく作る の順に見る */
  synthesize(unit: VoicePlanUnit, rate: number): Promise<Uint8Array> {
    const client = this.client(unit.engine);
    const params = voiceParamsFor(unit.emotion, unit.intensity, unit.styled, rate, unit.adjust, unit.engine);
    // 鍵には接続先が入る（エンジンが違えば別の音として控える）
    const key = synthesisKey(client.baseUrl, unit.styleId, unit.speech, params);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const lane = this.lane(unit.engine);
    const job = this.limited(unit.engine, async () => {
      /*
        作るのにかかった時間を測る（0.146.0）。測り始めは**枠が空いて頼んだとき**——枠を待った
        時間まで数えると、先読みを並べただけで遅く見える。控えから出した音は数えない
      */
      const startedAt = this.now();
      const wav = await client.speak(unit.speech, unit.styleId, params);
      const endedAt = this.now();
      /*
        **エンジンは1つずつ作る**ので、2つ並べて頼むと、後の頼みは前の音ができるまで
        エンジンの中で待つ。頼んでからの時間で測ると、待ちの分だけ倍近く遅く見える（速い PC でも
        知らせてしまう）。そこで、前の音ができた時刻より前は数えない（エンジンが1文に使った時間）。

        **時間切れ（timeout）で止まった文は、遅さの数に入れない**（0.147.1）。音が無いので
        「何秒の音に何秒」が測れず、当て推量の値で知らせることになる。数えずに飛ばすだけで、
        続けて遅かった数（streak）も切らない——遅い PC では、前後の文の値で知らせが出る

        **前の音ができた時刻は、同じエンジンのものだけ見る**（2段目。0.151.0）。2つのエンジンは
        別々に作るので、もう片方の音ができた時刻を引くと、遅いほうの時間が削られて見える
      */
      const busyFrom = Math.max(startedAt, lane.lastSynthEndAt);
      lane.lastSynthEndAt = Math.max(lane.lastSynthEndAt, endedAt);
      this.notePace(unit.engine, (endedAt - busyFrom) / 1000, wav);
      return wav;
    })
      .then(
        (wav) => {
          this.cache.set(key, wav);
          return wav;
        },
        (error: unknown) => {
          /*
            **届かなかったら、そのエンジンの話者の控えを捨てる**（2026-11-13。画面の自動テストで再現）。
            読み始めに控えた一覧が残ると、［〇〇で読む］で［声］を替えて計画し直したときに、
            閉じたエンジンを「届く」と読み、その声の人物をまた閉じたエンジンへ頼んで止まる。
            時間切れ（timeout）は届いている見込みがあるので捨てない
          */
          if (isEngineUnreachable(error)) this.speakersCache.delete(unit.engine);
          throw error;
        }
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  /** 1文の速さを見張りへ。追いつかない状態が続いたら、知らせを1回ぶん貯める */
  private notePace(engine: VoiceEngineId, elapsedSeconds: number, wav: Uint8Array): void {
    const audioSeconds = wavSeconds(wav);
    this.paceMemory.record(engine, elapsedSeconds, audioSeconds);
    this.schedulePaceSave();
    // 見張りはエンジンごと。知らせの文には、追いつかないほうのエンジンの名前が入る
    const slow = this.lane(engine).pace.record(elapsedSeconds, audioSeconds);
    if (!slow) return;
    /*
      2つのエンジンがどちらも遅くても、**知らせは1回の読み上げで1回**（作者の決定 2026-11-08）。
      先に追いつかなくなったほうを名指しする。もう片方はログにだけ残す
    */
    if (this.slowTold) {
      logStep(
        `人物の声：${VOICE_ENGINE_LABEL[engine]} の声づくりも読む速さに追いついていません（知らせは1回だけ。` +
          `1文あたり ${slow.audioSeconds.toFixed(2)}秒の音に ${slow.elapsedSeconds.toFixed(2)}秒）`
      );
      return;
    }
    this.slowTold = true;
    this.slowNotice = slowPaceNotice(VOICE_ENGINE_LABEL[engine], slow);
    logStep(
      `人物の声：声づくりが読む速さに追いついていません（${VOICE_ENGINE_LABEL[engine]}・` +
        `1文あたり ${slow.audioSeconds.toFixed(2)}秒の音に ${slow.elapsedSeconds.toFixed(2)}秒）`
    );
  }

  /** エンジンごとの枠と見張り（初めて使うときに作る） */
  private lane(engine: VoiceEngineId): EngineLane {
    let lane = this.lanes.get(engine);
    if (!lane) {
      lane = { running: 0, waiting: [], pace: new SynthesisPaceWatch(), lastSynthEndAt: 0 };
      this.lanes.set(engine, lane);
    }
    return lane;
  }

  /** 同時に頼む数を絞る（エンジンごと） */
  private async limited<T>(engine: VoiceEngineId, task: () => Promise<T>): Promise<T> {
    const lane = this.lane(engine);
    while (lane.running >= SYNTH_CONCURRENCY) {
      await new Promise<void>((resolve) => lane.waiting.push(resolve));
    }
    lane.running++;
    try {
      return await task();
    } finally {
      lane.running--;
      lane.waiting.shift()?.();
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
        "心当たりのないホストなら、送らないでください（接続先は設定 novelai.readAloud.aivisSpeechUrl・novelai.readAloud.voicevoxUrl で変えられます）。",
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

function readEngineUrl(engine: VoiceEngineId): string | undefined {
  return resolveEngineUrl(engine, readEngineUrlSettings()).url;
}

/**
 * 読めなかった理由。**engineDown はエンジンに届かなかった印**——原稿エディターは
 * この印のときだけ画面の真ん中に窓を出す（voiceEngineDownPrompt）
 */
export type VoiceProblem = {
  problem: string;
  engineDown?: true;
  /**
   * 待てる時間のうちに答えが来なかった印（0.147.1）。原稿エディターは時間切れの窓
   * （voiceEngineSlowPrompt）を出す。**engineDown とは同時に立てない**——立てると、
   * もう片方のエンジンへの問い合わせ（otherEngineRunning）と［OSの声で読む］の窓が、
   * 動いているエンジンに対して出てしまう
   */
  engineSlow?: true;
};

function engineFailure(error: unknown, work: WorkEntry | undefined): VoiceProblem {
  const problem = describeEngineFailure(error, work);
  if (isEngineUnreachable(error)) return { problem, engineDown: true };
  if (isEngineTimeout(error)) return { problem, engineSlow: true };
  return { problem };
}

/**
 * エンジンに届かなかった（unreachable）ときに、画面の真ん中に窓を出す（設計書6.42.3）。
 * 届いたが受け付けなかった（http・badResponse）は、今までどおり右下の知らせにする。
 *
 * **答えを待たない**——ボタンは閉じるだけで、待っても次にすることが無い。
 * ［OSの声で読む］の付く読む道は、原稿エディターの askUseOsVoice が出す。
 * 返すのは窓に出した文（書き出しの結果の理由に使う）
 */
export function showVoiceEngineDown(
  route: Exclude<VoiceEngineDownRoute, "read">,
  engine: VoiceEngineId
): string {
  const prompt = voiceEngineDownPrompt(route, engine);
  void Promise.resolve(
    vscode.window.showWarningMessage(prompt.message, { modal: true, detail: prompt.detail })
  ).catch(() => undefined);
  return `${prompt.message}${prompt.detail}`;
}

/** エンジンに届かなかった失敗か（窓にするかどうかの分かれ目） */
export function isEngineUnreachable(error: unknown): boolean {
  return error instanceof VoiceEngineError && error.kind === "unreachable";
}

/** 待てる時間のうちに答えが来なかった失敗か（0.147.1。届かないとは別の窓にする） */
export function isEngineTimeout(error: unknown): boolean {
  return error instanceof VoiceEngineError && error.kind === "timeout";
}

/**
 * 待てる時間のうちに答えが来なかったときの、画面の真ん中の窓（0.147.1。設計書6.42.3）。
 * 届かないときの窓（showVoiceEngineDown）と同じく答えを待たない。ボタンは付けない
 * （次の操作は文の中の1つ。閉じるは VS Code が添える）。返すのは窓に出した文
 */
export function showVoiceEngineSlow(route: VoiceEngineDownRoute, engine: VoiceEngineId): string {
  const prompt = voiceEngineSlowPrompt(route, engine);
  void Promise.resolve(
    vscode.window.showWarningMessage(prompt.message, { modal: true, detail: prompt.detail })
  ).catch(() => undefined);
  return `${prompt.message}${prompt.detail}`;
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

/**
 * 声の割り当て（語り手・台詞の既定・人物ごと）。QuickPick で選ぶ。
 *
 * **両方のエンジンの話者を並べる**（2段目。0.151.0。作者の決定 2026-11-08「人物ごとにエンジンを
 * 混ぜられる」）。［声］で選んだエンジン（`engine`）の声を先に、もう片方の声を後ろに並べ、説明の欄に
 * エンジンの名前を出す。**選んだ声には、その声のエンジンの印を付けて書く**（0.146.0 と同じ）。
 *
 * 両方の話者の一覧を引くのは、作者が［声の割り当て］を押したとき（割り当てる操作）だけ。読み上げを
 * 始める前や画面を開いたときには問い合わせない（作者の答え 2026-11-08）。本文は運ばない（話者の一覧と、AivisSpeech の声を区切るためのモデルの説明〔`/aivm_models`〕だけ）。
 *
 * - 片方だけ届かない … 届いた側の声だけ並べ、上の一言（`placeHolder`）で届かない側を知らせる
 * - ［声］の側も、もう片方も届かない … 今までどおり［声］の側の窓・知らせ（0.143.1）
 * - もう片方は短く待つ（`OTHER_ENGINE_SPEAKERS_MS`）。外のホストで返事が無いときに待たせない
 */
export async function assignVoices(
  work: WorkEntry,
  service: VoiceReadingService,
  engine: VoiceEngineId,
  /** よく使う声を数える保管庫（端末の globalState を verifiedState で包んだもの）。無ければ数えない */
  memory?: VoicePickMemory
): Promise<void> {
  const other: VoiceEngineId = engine === "aivisspeech" ? "voicevox" : "aivisspeech";
  const fetchList = async (which: VoiceEngineId): Promise<VoiceSpeaker[]> => {
    if (which === engine) return service.speakers(which, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OTHER_ENGINE_SPEAKERS_MS);
    try {
      return await service.speakers(which, true, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };
  type Fetched = { engine: VoiceEngineId; list: VoiceSpeaker[] } | { engine: VoiceEngineId; error: unknown };
  const results = await Promise.all(
    [engine, other].map(async (which): Promise<Fetched> => {
      try {
        return { engine: which, list: await fetchList(which) };
      } catch (error) {
        return { engine: which, error };
      }
    })
  );
  const available = results.flatMap((r) => ("list" in r && r.list.length > 0 ? [{ engine: r.engine, list: r.list }] : []));
  const chosen = results[0];
  if ("error" in chosen && available.length === 0) {
    // ログは窓のときも残す（describeEngineFailure が書く。実装ルール5）
    const problem = describeEngineFailure(chosen.error, work);
    const otherResult = results[1];
    if ("error" in otherResult) describeEngineFailure(otherResult.error, work);
    if (isEngineUnreachable(chosen.error)) showVoiceEngineDown("assign", engine);
    else if (isEngineTimeout(chosen.error)) showVoiceEngineSlow("assign", engine);
    else void warnWithLog(problem);
    return;
  }
  if (available.length === 0) {
    const engineLabel = VOICE_ENGINE_LABEL[engine];
    void warnWithLog(
      `音声合成のエンジン（${engineLabel}）に話者が1人も見つかりませんでした。${engineLabel}で話者を入れてから、もう一度押してください。`
    );
    return;
  }
  /** 届かなかった・話者のいなかった側の一言（届いた側の声は選べるので、止めずに上に出す） */
  const notes: string[] = [];
  for (const result of results) {
    const name = VOICE_ENGINE_LABEL[result.engine];
    if ("error" in result) {
      describeEngineFailure(result.error, work);
      notes.push(
        isEngineUnreachable(result.error)
          ? `${name} に繋がらないので、${name} の声は並んでいません（${name} を起動してから開き直すと並びます）。`
          : `${name} から話者の一覧を受け取れなかったので、${name} の声は並んでいません（詳しくはログにあります）。`
      );
    } else if (result.list.length === 0) {
      notes.push(`${name} に話者が1人も見つからないので、${name} の声は並んでいません。`);
    }
  }
  const placeHolder = notes.length > 0 ? notes.join("") : undefined;
  if (placeHolder) logStep(`人物の声：声の割り当て：${placeHolder}`);
  const shownLabels = available.map((a) => VOICE_ENGINE_LABEL[a.engine]).join("・");
  // AivisSpeech の声を区切るための説明（`/aivm_models`。本文は運ばない）。短く待ち、取れなくても窓は開く
  // （その声は「その他」に並ぶ）。VOICEVOX は同梱の表で引くので問い合わせない
  const aivisDescriptions = available.some((a) => a.engine === "aivisspeech")
    ? await (async (): Promise<Map<string, string>> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), OTHER_ENGINE_SPEAKERS_MS);
        try {
          return aivisDescriptionsOf(await service.engineClient("aivisspeech").aivmModels(controller.signal));
        } catch (error) {
          logStep(
            `人物の声：声の割り当て：AivisSpeech のモデルの説明が取れず、声の区切りは「その他」に並べます：${error instanceof Error ? error.message : String(error)}`
          );
          return new Map();
        } finally {
          clearTimeout(timer);
        }
      })()
    : new Map<string, string>();

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
    const label = (ref: VoiceRef | undefined): string => {
      if (!ref) return "未選択";
      // 感情のスタイルは台詞ごとに自動で選ぶので、選んだのが感情のスタイルかノーマルなら話者名だけ
      // （前の版で選んだ「青山龍星／喜び」も同じ。作者の答え 2026-11-13）
      const name = voiceChoiceName(ref.speakerName, ref.styleName, file.emotionStyles);
      // 調整があれば添える（作者の頼み 2026-11-13「人物ごとに高さ・速さ・抑揚」）
      const tuned = describeVoiceAdjust(ref.adjust);
      const tail = tuned === "" ? "" : `（${tuned}）`;
      // 混ぜて読めるので、エンジンの名前として添える（注意ではない）。印の無い声は［声］のエンジンで探す
      if (ref.engine === undefined) return `${name}（感情に合わせて自動・前の版で選んだ声）${tail}`;
      return `${name}（感情に合わせて自動・${VOICE_ENGINE_LABEL[ref.engine]}）${tail}`;
    };
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
      title: `声の割り当て（この作品の声。選ぶと ${shownLabels} の声から選べます）`,
      matchOnDescription: true,
      ...(placeHolder ? { placeHolder } : {}),
    });
    if (!picked || isCancelItem(picked) || !("slot" in picked)) return;
    const slot = picked.slot;
    const current = slotRef(file, slot);

    // 行は「話者 × 声の形」だけ。感情のスタイルは台詞ごとに自動で選ぶので並べない（作者の答え 2026-11-13）
    type VoiceRow = GroupableVoiceRow & { ref: VoiceRef };
    const rows: VoiceRow[] = available.flatMap(({ engine: which, list }) =>
      voiceChoiceRows(list, file.emotionStyles).map(({ speaker, style, label: rowLabel }) => ({
        engine: which,
        speakerUuid: speaker.uuid,
        speakerName: speaker.name,
        label: rowLabel,
        ref: {
          speakerUuid: speaker.uuid,
          speakerName: speaker.name,
          styleName: style.name,
          styleId: style.id,
          engine: which,
        } satisfies VoiceRef,
      }))
    );
    // 区切りで並べる（作者の頼み 2026-11-13「選択肢が長すぎるので、分類して」）
    const used = new Set(
      [file.narrator, file.dialogueDefault, ...Object.values(file.characters)].flatMap((ref) =>
        ref
          ? [usedVoiceKey(ref.engine ?? engine, ref.speakerUuid, voiceChoiceName(ref.speakerName, ref.styleName, file.emotionStyles))]
          : []
      )
    );
    const sections = arrangeVoiceRows(rows, {
      used,
      frequent: frequentVoiceKeys(memory?.get<unknown>(VOICE_PICK_COUNTS_KEY, {})),
      groupOf: (row) =>
        voiceGroupOf(row.engine, row.speakerUuid, row.speakerName, {
          overrides: file.speakerGroups,
          descriptions: aivisDescriptions,
        }),
    });
    const adjustItem = {
      label: "この声の高さ・速さ・抑揚を変える",
      description: describeVoiceAdjust(current?.adjust) || "いまは標準",
      openAdjust: true as const,
    };
    const voice = await vscode.window.showQuickPick<vscode.QuickPickItem & { ref?: VoiceRef; openAdjust?: true }>(
      [
        // 調整は選びたいときだけ入る行（声を選ぶだけなら段は増えない）。声が決まっている枠だけ
        ...(current ? [adjustItem] : []),
        ...sections.flatMap((section) => [
          { label: section.heading, kind: vscode.QuickPickItemKind.Separator },
          ...section.rows.map((row) => ({
            label: row.label,
            description: `${VOICE_ENGINE_LABEL[row.engine]}・スタイルは感情に合わせて自動`,
            ref: row.ref,
          })),
        ]),
        cancelItem("戻る"),
      ],
      {
        title: `${picked.label}の声（${shownLabels}）`,
        matchOnDescription: true,
        ...(placeHolder ? { placeHolder } : {}),
      }
    );
    if (!voice || isCancelItem(voice)) continue;
    if (voice.openAdjust) {
      const stop = await adjustVoiceOf(work, slot, picked.label, engine);
      if (stop) return;
      continue;
    }
    if (!voice.ref) continue;
    // 声を選び直しても、その枠の調整は残す（作者がその人物のために決めた高さや速さ）
    const chosenRef: VoiceRef = { ...voice.ref, ...(current?.adjust ? { adjust: current.adjust } : {}) };
    try {
      await saveVoiceAssignment(work, withSlotRef(file, slot, chosenRef), loaded.hash);
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return;
    }
    // 専用のスタイルが無い感情を1回知らせる（作者の決定 2026-11-13）。判定は朗読と同じ pickStyleForEmotion。
    // 答えを待たない（ボタンは無く、次の枠を選ぶ窓をすぐ出す）
    const chosenEngine = voice.ref.engine ?? engine;
    const chosenList = available.find((a) => a.engine === chosenEngine)?.list ?? [];
    const missingNotice = missingEmotionStyleNotice(
      voiceChoiceName(voice.ref.speakerName, voice.ref.styleName, file.emotionStyles),
      missingEmotionStyles(chosenList, voice.ref.styleId, file.emotionStyles),
      chosenEngine
    );
    if (missingNotice) {
      logStep(`人物の声：声の割り当て：${picked.label}：${missingNotice}`);
      void vscode.window.showInformationMessage(missingNotice);
    }
    // よく使う声を数える（端末だけ。数えられなくても割り当ては済んでいるので止めない）
    if (memory) {
      try {
        await memory.update(
          VOICE_PICK_COUNTS_KEY,
          countVoicePick(memory.get<unknown>(VOICE_PICK_COUNTS_KEY, {}), voice.ref.engine ?? engine, voice.ref.speakerUuid)
        );
      } catch (error) {
        logStep(`人物の声：よく使う声を数えられませんでした：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** 声の割り当ての枠（語り手・台詞の既定・人物） */
type VoiceSlot = "narrator" | "dialogueDefault" | Character;

function slotRef(file: VoiceAssignmentFile, slot: VoiceSlot): VoiceRef | undefined {
  if (slot === "narrator") return file.narrator;
  if (slot === "dialogueDefault") return file.dialogueDefault;
  return file.characters[slot.id];
}

/** 枠の声を差し替えた写し（ほかの欄〔emotionStyles・speakerGroups〕はそのまま残す） */
function withSlotRef(file: VoiceAssignmentFile, slot: VoiceSlot, ref: VoiceRef): VoiceAssignmentFile {
  const next: VoiceAssignmentFile = { ...file, characters: { ...file.characters } };
  if (slot === "narrator") next.narrator = ref;
  else if (slot === "dialogueDefault") next.dialogueDefault = ref;
  else next.characters[slot.id] = { ...ref, characterName: slot.name };
  return next;
}

/** よく使う声を数える保管庫（`verifiedState(globalState)`。読み書きの形だけ） */
export interface VoicePickMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const ADJUST_FIELD_LABEL: Record<keyof VoiceAdjust, string> = { pitch: "高さ", speed: "速さ", intonation: "抑揚" };

/**
 * AivisSpeech の声の調整の窓に置く知らせの行（作者の決定 2026-11-13 夕）。見本「老けた声」の代わり。
 * 右下の知らせにしないのは、変えるたびに窓を開き直すので毎回出てうるさいため。窓の中の行なら、見たいときだけ読める。
 * 長いので2行に分ける（label と detail。続けて読むと1つの文になる）
 */
export const AIVIS_AGED_NOTE_LABEL = "AivisSpeech では、調整では老けた声に聞こえにくいです。";
const AIVIS_AGED_NOTE_DETAIL = "年配の声のモデル（例：ろてじん）を選んでください。";

/**
 * 枠の声の高さ・速さ・抑揚を選ぶ（作者の頼み 2026-11-13）。打ち込まずに段から選ぶ。
 * 変えるたびに保存する（書く直前のハッシュ照合は今までどおり）。
 *
 * @returns 割り当ての窓ごと閉じるとき true（保存に失敗したとき）
 */
async function adjustVoiceOf(
  work: WorkEntry,
  slot: VoiceSlot,
  slotLabel: string,
  /** ［声］のエンジン。印の無い声（前の版）はこのエンジンの声として扱う（ほかの所と同じ） */
  engine: VoiceEngineId
): Promise<boolean> {
  for (;;) {
    let loaded;
    try {
      loaded = await loadVoiceAssignment(work);
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return true;
    }
    const ref = slotRef(loaded.file, slot);
    if (!ref) return false;
    const now = normalizeVoiceAdjust(ref.adjust);
    type Item = vscode.QuickPickItem & { apply?: VoiceAdjust | null; field?: keyof VoiceAdjust };
    const refEngine = ref.engine ?? engine;
    const items: Item[] = [
      // 選んでも何も変えない行（選ぶと窓を開き直す）
      ...(refEngine === "aivisspeech" ? [{ label: AIVIS_AGED_NOTE_LABEL, detail: AIVIS_AGED_NOTE_DETAIL }] : []),
      ...presetsForEngine(refEngine).map((preset) => ({
        label: `見本：${preset.name}`,
        description: describeVoiceAdjust(preset.adjust),
        apply: preset.adjust as VoiceAdjust,
      })),
      ...(["pitch", "speed", "intonation"] as const).map((field) => ({
        label: ADJUST_FIELD_LABEL[field],
        description: `いま ${formatAdjustValue(field, now[field])}`,
        field,
      })),
      ...(ref.adjust ? [{ label: "調整を外す（標準に戻す）", apply: null }] : []),
    ];
    const chosen = await vscode.window.showQuickPick<Item>([...items, cancelItem("戻る")], {
      title: `${slotLabel}の声の調整（${describeVoiceAdjust(ref.adjust) || "いまは標準"}）`,
    });
    if (!chosen || isCancelItem(chosen)) return false;
    let nextAdjust: VoiceAdjust | null | undefined = chosen.apply;
    if (chosen.field) {
      const field = chosen.field;
      const step = await vscode.window.showQuickPick<vscode.QuickPickItem & { value?: number }>(
        [
          ...VOICE_ADJUST_STEPS[field].map((value) => ({
            label: formatAdjustValue(field, value),
            ...(value === now[field] ? { description: "いま" } : {}),
            value,
          })),
          cancelItem("戻る"),
        ],
        { title: `${slotLabel}の声の${ADJUST_FIELD_LABEL[field]}` }
      );
      if (!step || isCancelItem(step) || step.value === undefined) continue;
      nextAdjust = { ...now, [field]: step.value };
    }
    if (nextAdjust === undefined) continue;
    // 標準の値の欄は持たない（parseVoiceAdjust が落とす）。何も残らなければ欄ごと外す
    const kept = nextAdjust === null ? undefined : parseVoiceAdjust(nextAdjust);
    const nextRef: VoiceRef = { ...ref };
    delete nextRef.adjust;
    if (kept) nextRef.adjust = kept;
    try {
      await saveVoiceAssignment(work, withSlotRef(loaded.file, slot, nextRef), loaded.hash);
    } catch (error) {
      void warnWithLog(error instanceof Error ? error.message : String(error));
      return true;
    }
  }
}
