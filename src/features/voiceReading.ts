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
import { confirmRun, notifyDone, warnWithLog } from "../views/notify";
import { reportAIError } from "./reportAIError";
import { CharacterStore } from "../core/characterStore";
import { ChunkCache, type CacheKeyBase } from "../core/chunkCache";
import { hashText } from "../core/hash";
import { logFailure, logStep, responseExcerptForLog, useLogFile } from "../core/logger";
import type { ReadingSentence } from "../core/readAloud";
import {
  castChunksOf,
  castDialogues,
  castLookup,
  countDropReasons,
  editCastEntry,
  mergeCastEntries,
  parseCastResult,
  validateCastItems,
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
  buildVoiceCastPrompt,
  buildVoiceCastSchema,
  VOICE_CAST_CHUNK_CHARS,
  VOICE_CAST_MAX_PEOPLE,
  VOICE_CAST_SYSTEM_PROMPT,
  VOICE_CAST_VERSION,
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

  constructor(
    private readonly engineUrl: () => string | undefined = readEngineUrl,
    private readonly fetchImpl?: FetchLike
  ) {}

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
  ): Promise<{ units: VoicePlanUnit[] } | { problem: string }> {
    let speakers: VoiceSpeaker[];
    try {
      speakers = await this.speakers();
    } catch (error) {
      return { problem: describeEngineFailure(error, work) };
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
  ): Promise<{ wav: Uint8Array } | { problem: string }> {
    const unit = units[index];
    if (!unit) return { problem: "読む文が見つかりません" };
    let current: Promise<Uint8Array>;
    try {
      // **頼まれた文を先に並べる**（先読みを先に並べると、いま鳴らす文が後回しになる）
      current = this.synthesize(unit, rate);
    } catch (error) {
      return { problem: describeEngineFailure(error, work) };
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
      return { problem: describeEngineFailure(error, work) };
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

/** 区切りの控えの鍵。**送った人物の一覧も含める**（一覧が変われば答えも変わる） */
function chunkCacheHash(chunk: CastChunk, people: readonly CastPerson[]): string {
  return hashText(
    JSON.stringify([
      chunk.text,
      people.map((p) => [p.id, p.name, p.aliases, p.speechStyle]),
    ])
  );
}

/**
 * AIで台詞ごとの話者と感情を推定する（P-54）。
 *
 * 1. 本文を行の切れ目で区切り、台詞の頭に〔番号〕を差し込む
 * 2. 区切りごとに、**内容ハッシュ（人物の一覧を含む）＋プロバイダID＋モデル名＋版**で
 *    控えを引く（実装ルール4）。当たった区切りは送らない
 * 3. 送る前に区切りの数・台詞の数を示して確かめる（有料なら料金の確認）
 * 4. 答えを検算し、**作者が直した行は残して**AIの行だけ入れ替える
 *
 * 1つでも区切りが失敗・中止したら書き換えない（済んだ区切りは控えにあるので、
 * 押し直すと失敗した所だけ送る）。
 */
export async function runVoiceCast(target: VoiceCastTarget, registry: AIRegistry): Promise<void> {
  const { work } = target;
  useLogFile(work.folderPath);

  const chunks = castChunksOf(target.text, VOICE_CAST_CHUNK_CHARS);
  const totalDialogues = chunks.reduce((sum, c) => sum + c.dialogues.length, 0);
  if (chunks.length === 0) {
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
  const prepared = chunks.map((chunk) => {
    const chunkPeople = peopleForChunk(chunk, people);
    return { chunk, people: chunkPeople, hash: chunkCacheHash(chunk, chunkPeople) };
  });
  const pending = prepared.filter(({ hash }) => !isCachedCastChunk(cache.get(hash, base)));

  if (pending.length > 0) {
    const chars = pending.reduce((sum, { chunk }) => sum + chunk.text.length, 0);
    const pendingDialogues = pending.reduce((sum, { chunk }) => sum + chunk.dialogues.length, 0);
    const ok = resolved.provider.isPaid
      ? await confirmPaidUsage(resolved.provider, {
          actionLabel: "台詞の話者と感情の推定",
          model: resolved.model,
          calls: pending.length,
          sends:
            `この話の本文 ${chars.toLocaleString("ja-JP")}字と登場人物の名前・口調` +
            "（前回から変わっていない所は送りません）",
          more: ["本文は書き換えません。推定の結果は作者が［台詞の一覧］で直せます。"],
          remember: { id: "ai.paid.voiceCast" },
          work,
        })
      : await confirmRun(
          `この話の台詞${pendingDialogues}個の話者と感情を推定します。` +
            `AIを${pending.length}回呼びます（${resolved.provider.displayName}・${resolved.model}、` +
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
  let cancelled = false;
  if (pending.length > 0) {
    await withCancellableProgress("台詞の話者と感情を推定しています", async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      logStep(
        `台詞の話者と感情の推定を開始: ${work.title} / ${pending.length}区切り / ` +
          `${resolved.provider.displayName} / ${resolved.model} / v${VOICE_CAST_VERSION}`
      );
      for (let i = 0; i < pending.length; i++) {
        if (token.isCancellationRequested) {
          cancelled = true;
          return;
        }
        progress.report({ message: `${i + 1}/${pending.length}`, increment: 100 / pending.length });
        const { chunk, people: chunkPeople, hash } = pending[i];
        try {
          const response = await resolved.provider.generate({
            systemPrompt: VOICE_CAST_SYSTEM_PROMPT,
            userPrompt: buildVoiceCastPrompt({
              text: chunk.text,
              count: chunk.dialogues.length,
              people: chunkPeople,
            }),
            model: resolved.model,
            // 揺らさない。同じ本文には同じ演出を返してほしい
            temperature: 0,
            maxOutputTokens: outputLimit.tokens,
            plannedOutputTokens,
            jsonSchema: buildVoiceCastSchema(chunkPeople),
            disableThinking: true,
            signal: controller.signal,
            meta: { feature: "voiceCast", workFolder: work.folderPath },
          });
          const items = parseCastResult(response.text);
          if (!items) {
            failed++;
            logFailure("台詞の話者と感情の推定", {
              理由: response.truncated ? "応答が出力上限で切り詰められました" : "応答を読み取れません",
              応答: responseExcerptForLog(response.text),
            });
            continue;
          }
          // 検算は控えから取り出すときに行う（検算を締めたとき古い答えが素通りしないように）
          await cache.set(hash, base, { items } satisfies CachedCastChunk);
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") {
            cancelled = true;
            return;
          }
          failed++;
          reportAIError("台詞の話者と感情の推定", error, resolved.provider.id);
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
        "もう一度押すと、失敗した所だけを送り直します。"
    );
    return;
  }

  const fresh: CastEntry[] = [];
  const allDropped: Array<{ reason: string; item: unknown }> = [];
  let unanswered = 0;
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  for (const { chunk, people: chunkPeople, hash } of prepared) {
    const cached = cache.get(hash, base);
    if (!isCachedCastChunk(cached)) continue;
    // **AIを信用しない**（実装ルール3）
    const checked = validateCastItems(cached.items, chunk.dialogues.length, chunkPeople);
    allDropped.push(...checked.dropped);
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
  if (allDropped.length > 0) {
    const counts = countDropReasons(allDropped);
    logStep(
      `台詞の推定：検算で${allDropped.length}件を捨てました（` +
        Object.entries(counts)
          .map(([reason, count]) => `${reason} ${count}件`)
          .join("・") +
        "）"
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
          dropped: allDropped.length,
        },
      },
      loaded.hash
    );
  } catch (error) {
    void warnWithLog(error instanceof Error ? error.message : String(error));
    return;
  }
  logStep(
    `台詞の推定が終わりました: 台詞${totalDialogues}個・AIの答え${fresh.length}件・` +
      `答えの無かった台詞${unanswered}個・送った区切り${pending.length}/${chunks.length}`
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

    const speaker = await vscode.window.showQuickPick(
      [
        { label: "不明", id: null as string | null, name: null as string | null },
        ...people.map((p) => ({ label: p.name, description: p.aliases.join("、"), id: p.id, name: p.name })),
      ],
      { title: `${picked.dialogue.quote.slice(0, 30)} の話者` }
    );
    if (!speaker) continue;
    const emotion = await vscode.window.showQuickPick(
      VOICE_EMOTIONS.map((e) => ({ label: e as VoiceEmotion })),
      { title: "感情" }
    );
    if (!emotion) continue;
    const intensity = await vscode.window.showQuickPick(
      VOICE_INTENSITIES.map((i) => ({ label: i as VoiceIntensity })),
      { title: "強さ" }
    );
    if (!intensity) continue;
    try {
      await saveVoiceCast(
        work,
        target.episodePath,
        {
          ...loaded.file,
          entries: editCastEntry(loaded.file.entries, picked.dialogue, {
            speakerId: speaker.id,
            speakerName: speaker.name,
            emotion: emotion.label,
            intensity: intensity.label,
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
      speakers.flatMap((speaker) =>
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
      { title: `${picked.label}の声`, matchOnDescription: true }
    );
    if (!voice) continue;
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
