import type { EpisodeFile, WorkEntry } from "../models/types";
import type { Finding } from "../models/finding";
import { notationModeFor } from "../core/manuscriptRender";
import { readMemoMarkers } from "../core/memoMarkerStore";
import { readTextFile } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import * as paths from "../core/paths";
import {
  editReading,
  readingEntryKey,
  type ReadingEntry,
  type ReadingSpan,
} from "../core/readingDictionary";
import { loadReadingDictionary, saveReadingDictionary } from "../core/readingDictionaryStore";
import {
  buildMisreadFindings,
  collectKnownReadings,
  findMisreadCandidates,
  judgeMisreads,
  MisreadAnswerError,
  misreadDictionaryEntry,
  type KnownNameReading,
  type KnownReadingEpisode,
} from "../core/readingMisread";
import { VOICE_ENGINE_LABEL, VoiceEngineError, type VoiceEngineId } from "../core/voiceEngine";
import { FindingStore, findingsRetentionDays, visibleFindings } from "./findingStore";
import { engineFailure, type VoiceReadingService } from "./voiceReading";

/**
 * 読み上げの読み間違いを、声を作る前に見つける（設計書6.42.6）——エンジンへ問い、行を置く側。
 *
 * 判定は `core/readingMisread.ts`。ここは作品の話と読みの辞書を読み、エンジンへ
 * `audio_query` だけを頼み（音声は作らない）、見込みを校正・メモパネルの行として置く。
 *
 * - **本文も辞書も書き換えない。** 行を置くのは指摘の置き場（`.aiwriter/findings.jsonl`）だけ。
 *   辞書へ足すのは作者が行の［読みの辞書へ足す］を押したとき（`addMisreadToDictionary`）、
 *   本文へルビを振るのは［ここにルビを振る］を押したとき（提案パネルの［適用］と同じ道）だけ
 * - **頼みの順番待ちは `VoiceEngineClient` の列**（朗読・書き出しと同じ接続先の列に並ぶ）
 */

/** 調べる話 */
export interface MisreadCheckTarget {
  work: WorkEntry;
  episodePath: string;
  /** 本文（LF区切り）。開いていれば画面の本文 */
  text: string;
  /** 声へ渡す写しで差し替える読みの範囲（朗読・書き出しと同じもの。`extension.ts` の `voiceReadingsFor`） */
  readings: readonly ReadingSpan[];
  engine: VoiceEngineId;
}

export interface MisreadCheckDeps {
  /** 作品の話の並び（ルビと読みの辞書を集める） */
  episodes: () => Promise<EpisodeFile[]>;
  /** 設定資料の名前・別名の読み。無ければ使わない */
  names?: () => Promise<KnownNameReading[]>;
  /**
   * この PC の外のホストへ本文を送る前の確認の窓を出してよいか。
   * 命令からは true。［音声に書き出す］の手前（自動）では false——窓を出さずに済むときだけ調べる
   */
  askRemote: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export type MisreadCheckOutcome =
  /** 調べた。`found`＝見込みの数、`shown`＝そのうち校正・メモパネルに並ぶ数（見送った・直したものを除く） */
  | { kind: "checked"; found: number; shown: number }
  /** 調べなかった（窓を出せない外のホスト・中止）。理由は作者向けの文 */
  | { kind: "skipped"; reason: string }
  /** 調べられなかった。`engineDown` はエンジンに届かなかった印 */
  | { kind: "stopped"; reason: string; engineDown?: boolean };

/**
 * エンジンの答え（モーラのかな）の控え。**鍵はエンジン＋接続先＋送る文の中身**（実装ルール4と同じ考え方）。
 * 同じ文を何度も問わない——書き出しのたびに調べるので、直していない話は2回目から頼みが出ない。
 * 覚えるのは通った答えだけ（失敗は覚えない。実装ルール5）。起動のあいだだけ・件数で上限
 */
const answerCache = new Map<string, unknown>();
const ANSWER_CACHE_MAX = 4000;

function rememberAnswer(key: string, answer: unknown): void {
  if (answerCache.size >= ANSWER_CACHE_MAX) {
    const oldest = answerCache.keys().next().value;
    if (oldest !== undefined) answerCache.delete(oldest);
  }
  answerCache.set(key, answer);
}

/** 試験のため：控えを空にする */
export function forgetMisreadAnswers(): void {
  answerCache.clear();
}

function episodeLabelOf(file: EpisodeFile): string {
  return file.chapterStart !== null ? `第${file.chapterStart}話` : file.fileName;
}

/** 作品の話ごとの本文と辞書（読みを集める材料）。読めない話は飛ばしてログへ */
async function knownEpisodes(
  target: MisreadCheckTarget,
  files: readonly EpisodeFile[]
): Promise<KnownReadingEpisode[]> {
  const out: KnownReadingEpisode[] = [];
  const current = paths.pathKeyForComparison(target.episodePath);
  for (const file of files) {
    const isCurrent = paths.pathKeyForComparison(file.filePath) === current;
    let text = target.text;
    if (!isCurrent) {
      try {
        const read = await readTextFile(file.filePath);
        // 競合の印のある話は、どちらが本文か決められないので読まない
        if (read.hasConflictMarkers) continue;
        text = read.text.replace(/\r\n?/g, "\n");
      } catch (error) {
        logStep(`読み間違いの見込み：${file.fileName} を読めませんでした（${messageOf(error)}）`);
        continue;
      }
    }
    let dictionary: ReadingEntry[] = [];
    try {
      dictionary = (await loadReadingDictionary(target.work, file.filePath)).file.entries;
    } catch (error) {
      // 壊れた辞書は直さない（実装ルール2）。その話の辞書を使わずに続ける
      logStep(`読み間違いの見込み：${file.fileName} の読みの辞書を使えませんでした（${messageOf(error)}）`);
    }
    out.push({ label: episodeLabelOf(file), text, notation: notationModeFor(file.filePath), dictionary });
  }
  // 開いている話が一覧に無い（作品に登録したばかり等）ときも、その話のルビは使う
  if (!files.some((file) => paths.pathKeyForComparison(file.filePath) === current)) {
    out.push({
      label: paths.basename(target.episodePath),
      text: target.text,
      notation: notationModeFor(target.episodePath),
      dictionary: [],
    });
  }
  return out;
}

/**
 * その話の読み間違いの見込みを調べ、校正・メモパネルの行として置く。**投げない**（結果で返す）
 */
export async function checkReadingMisreads(
  target: MisreadCheckTarget,
  service: VoiceReadingService,
  deps: MisreadCheckDeps
): Promise<MisreadCheckOutcome> {
  const { work, episodePath, engine } = target;
  useLogFile(work.folderPath);
  const engineName = VOICE_ENGINE_LABEL[engine];
  try {
    const memoMarkers = await readMemoMarkers(work);
    const episodes = await knownEpisodes(target, await deps.episodes());
    let names: KnownNameReading[] = [];
    try {
      names = (await deps.names?.()) ?? [];
    } catch (error) {
      logStep(`読み間違いの見込み：設定資料の名前の読みを使えませんでした（${messageOf(error)}）`);
    }
    const known = collectKnownReadings(episodes, names, memoMarkers);
    const notation = notationModeFor(episodePath);
    const { sentences, candidates } = findMisreadCandidates(
      target.text,
      notation,
      target.readings,
      known,
      memoMarkers
    );
    if (candidates.length === 0) {
      logStep(`読み間違いの見込み：${paths.basename(episodePath)} には問う語がありませんでした（分かっている読み ${known.size}語）`);
      return { kind: "checked", found: 0, shown: 0 };
    }

    // 本文を運ぶ前の確認（朗読・書き出しと同じ覚え方）
    if (deps.askRemote) {
      const allowed = await service.allowCarryText(engine);
      if (!allowed.ok) {
        return {
          kind: "stopped",
          reason: `本文を ${allowed.host} へ送ることを許可していないので、読み間違いを調べませんでした。`,
        };
      }
    } else if (!service.carryAllowedWithoutAsking(engine)) {
      return { kind: "skipped", reason: `${engineName}の接続先がこの PC の外なので、読み間違いは調べませんでした。` };
    }

    // 話者は作品の地の文の声で1つに決める（読みは話者で変わらない前提。設計書6.42.6）
    const planned = await service.plan(work, episodePath, target.text, sentences, engine);
    if ("problem" in planned) {
      return { kind: "stopped", reason: planned.problem, ...(planned.engineDown ? { engineDown: true } : {}) };
    }
    const narration = planned.units.find(
      (unit, index) => unit.engine === engine && sentences[index]?.kind === "narration"
    );
    const unit = narration ?? planned.units.find((item) => item.engine === engine);
    if (!unit) {
      return { kind: "stopped", reason: `${engineName}で読む文がありません。` };
    }
    const client = service.engineClient(engine);
    const query = async (speech: string): Promise<unknown> => {
      const key = `${engine}\u0000${client.baseUrl}\u0000${speech}`;
      if (answerCache.has(key)) return answerCache.get(key);
      const answer = await client.audioQuery(speech, unit.styleId, deps.signal);
      rememberAnswer(key, answer);
      return answer;
    };

    const found = await judgeMisreads(candidates, query, deps.signal);
    if (deps.signal?.aborted) return { kind: "skipped", reason: "読み間違いを調べるのを止めました。" };

    const time = (deps.now?.() ?? new Date()).toISOString();
    const findings = buildMisreadFindings(work.folderPath, episodePath, target.text, notation, found, time);
    const shown = await recordNew(work, findings);
    logStep(
      `読み間違いの見込み：${paths.basename(episodePath)} / ${engineName} / 問うた語 ${candidates.length}か所・見込み ${findings.length}件（並ぶのは ${shown}件）`
    );
    return { kind: "checked", found: findings.length, shown };
  } catch (error) {
    if (error instanceof VoiceEngineError && error.kind === "aborted") {
      return { kind: "skipped", reason: "読み間違いを調べるのを止めました。" };
    }
    if (error instanceof MisreadAnswerError) {
      logFailure("読み間違いの見込み", { 内容: error.message, 文: error.speech.slice(0, 80) });
      return {
        kind: "stopped",
        reason: `${engineName}の答えに読み（モーラ）の並びが無かったので、読み間違いを調べられませんでした。詳しくはログにあります。`,
      };
    }
    if (error instanceof VoiceEngineError) {
      const problem = engineFailure(error, work);
      return { kind: "stopped", reason: problem.problem, ...(problem.engineDown ? { engineDown: true } : {}) };
    }
    // 壊れた設定（メモの印）など。直さずに理由を出す（実装ルール2）
    logFailure("読み間違いの見込み", { 内容: messageOf(error) });
    return { kind: "stopped", reason: `読み間違いを調べられませんでした（${messageOf(error)}）。` };
  }
}

/**
 * 新しい見込みだけを置き場へ足す。返すのは、校正・メモパネルに並ぶ数。
 *
 * - **まだ並んでいる同じ行は足し直さない**（書き出しのたびに置き場を太らせない）
 * - **見送った・直した行も足し直さない**（足しても判断の行が効いて出ないが、置き場が太る）
 * - 期限で隠れた行は足し直す（また出てきた見込みなので、また並べる）
 */
async function recordNew(work: WorkEntry, findings: readonly Finding[]): Promise<number> {
  if (findings.length === 0) return 0;
  const store = new FindingStore(work);
  const all = await store.load();
  const visible = new Set(visibleFindings(all, findingsRetentionDays()).map((item) => item.id));
  const decided = new Set(all.filter((item) => item.status !== "pending").map((item) => item.id));
  const fresh = findings.filter((item) => !visible.has(item.id) && !decided.has(item.id));
  if (fresh.length > 0) await store.record(fresh);
  return findings.filter((item) => !decided.has(item.id)).length;
}

/**
 * ［読みの辞書へ足す］——その行の語・句・読みを、その話の読みの辞書へ作者の項目として足す。
 *
 * - **押したときだけ**（実装ルール2）。本文は変えない
 * - 同じ語・同じ句の項目（AIの項目・消した印）があれば、足さずに作者の項目へ直す（一覧での直しと同じ）
 * - 保存は読みの辞書の道（読んだときと書く直前の中身を照らす）
 * - 足したら、その行に「採った」を足して一覧から外す（次の調べでは、辞書の読みで置き換わるので出ない）
 */
export async function addMisreadToDictionary(
  work: WorkEntry,
  finding: Finding & { filePath: string }
): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  useLogFile(work.folderPath);
  let text: string;
  try {
    const read = await readTextFile(finding.filePath);
    if (read.hasConflictMarkers) {
      return { ok: false, reason: "この話には Git の競合の印（<<<<<<<）が残っています。競合を解いてから押してください。" };
    }
    text = read.text.replace(/\r\n?/g, "\n");
  } catch (error) {
    return { ok: false, reason: `話のファイルを読めませんでした（${messageOf(error)}）。` };
  }
  const entry = misreadDictionaryEntry(finding, notationModeFor(finding.filePath), text);
  if (typeof entry === "string") return { ok: false, reason: entry };
  try {
    const loaded = await loadReadingDictionary(work, finding.filePath);
    const key = readingEntryKey(entry);
    const entries = loaded.file.entries.some((item) => readingEntryKey(item) === key)
      ? editReading(loaded.file.entries, key, entry.reading)
      : [...loaded.file.entries, { ...entry, source: "author" as const }];
    await saveReadingDictionary(work, finding.filePath, { ...loaded.file, entries }, loaded.hash);
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  await new FindingStore(work).decide([
    { findingId: finding.id, time: new Date().toISOString(), status: "accepted", note: "読みの辞書へ足した" },
  ]);
  logStep(`読み間違いの見込み：「${entry.word}」を「${entry.reading}」として読みの辞書へ足しました（${paths.basename(finding.filePath)}）`);
  return { ok: true, detail: `「${entry.word}」を「${entry.reading}」と読むように、読みの辞書へ足しました。` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
