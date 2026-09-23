// ログの書き先：作品ごと（呼び出し側の `openTargetSheet` が `useLogFile(work.folderPath)` 済み）
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readWorkFormat } from "../core/workFormatStore";
import { readWorkGoalsOrEmpty } from "../core/workGoalsStore";
import { buildEpisodeCountTable } from "../core/episodeCharTable";
import { readTextFile } from "../core/textFile";
import { episodeBodySources } from "../core/episodeChunks";
import { blankMemoLines } from "../core/sceneMemo";
import { collectWorkStyle } from "../core/workStyleFacts";
import { readNarrativePerson } from "../core/workStyle";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { KIND_LABELS } from "../core/settingsSummary";
import { WritingStatsStore } from "../core/writingStatsStore";
import {
  currentStreak,
  mergeDailyStats,
  statsDayKey,
} from "../core/writingStats";
import { boundaryHour } from "./writingProgress";
import { PostingStore } from "../core/postingStore";
import type { PostingLedger } from "../models/posting";
import {
  collectReactions,
  type TargetSheetReaction,
  type TargetSheetWritten,
  type TargetSheetWrittenRecord,
} from "../core/targetSheetWritten";
import { logFailure } from "../core/logger";

/**
 * ターゲットシートの「書けたものの実績」の材料を集める（設計書6.108.6）。
 *
 * 0.82.2 まで在った単独の3つの輪の紙（`features/threeCircles.ts`）の
 * 集め方を、**そのまま**移したものである（作者の裁定、2026-09-23）。
 * 同じ作品で、前の紙と違う数字を出さないため。
 *
 * **AIを1度も呼ばない。原稿も台帳も書き換えない**——読むだけである。
 *
 * **読めない材料があっても先へ進む。** 読めなかったものは断り書きを
 * 1行残し（シートの「読めなかったもの」に並ぶ）、その行だけを出さない。
 */
export async function collectTargetSheetWritten(
  work: WorkEntry,
  deviceId: string,
  notices: string[]
): Promise<TargetSheetWrittenRecord> {
  let facts: TargetSheetWritten = {};
  try {
    const { episodes } = await scanWork(work);
    facts = await collectWritten(work, episodes, deviceId, notices);
  } catch (error) {
    // 話の一覧そのものが取れない（作品フォルダーが読めない等）。
    // 実績の節は「まだ記録がありません」になるが、黙ってそうしない
    notices.push(`原稿の一覧を読めませんでした：${messageOf(error)}`);
    logFailure("ターゲットシート：原稿の一覧を読めなかった", {
      作品: work.title,
      詳細: messageOf(error),
    });
  }
  return { facts, reactions: await readReactions(work, notices) };
}

/**
 * 実績から数える。
 *
 * **話数と1話の長さは `buildEpisodeCountTable` に任せる**（設計書6.3）。
 * 合本を平均の母集団から外す扱いも、目標を基準にする扱いも、あちらが
 * 既に持っている——ここで数え直すと、執筆統計の画面と違う数字が出る。
 */
async function collectWritten(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  deviceId: string,
  notices: string[]
): Promise<TargetSheetWritten> {
  const written: TargetSheetWritten = {};

  const goals = await readWorkGoalsOrEmpty(work);
  const { summary } = buildEpisodeCountTable([...episodes], {
    format: await readWorkFormat(work),
    perEpisodeGoal: goals.perEpisodeChars,
  });

  // **合本は中の話を数える。** ファイルの数で言うと、219話の作品が
  // 「1話」になる
  const counted = episodes.reduce(
    (total, episode) => total + (episode.collectedCount ?? 1),
    0
  );
  if (counted > 0) written.episodes = counted;
  if (summary.totalNet > 0) written.chars = summary.totalNet;

  // **1話ずつのファイルが無ければ、長さの癖は言えない**（合本1件では
  // 中央値も最短・最長も、その1ファイルの数字にしかならない）
  if (summary.medianNet > 0 && summary.shortest && summary.longest) {
    written.length = {
      typical: Math.round(summary.medianNet),
      shortest: summary.shortest.net,
      longest: summary.longest.net,
    };
  }

  written.days = await collectDays(work, deviceId, notices);
  written.settings = await collectSettingsCounts(work, notices);

  const style = await collectStyle(work, episodes, notices);
  written.narrativePerson = style.narrativePerson;
  written.firstPerson = style.firstPerson;
  written.archaic = style.archaic;

  return written;
}

/** 書いた日数と、いま続いている日数。読めなければ undefined */
async function collectDays(
  work: WorkEntry,
  deviceId: string,
  notices: string[]
): Promise<{ active: number; streak: number } | undefined> {
  try {
    const days = mergeDailyStats(
      await new WritingStatsStore(work, deviceId).loadAll()
    );
    const today = statsDayKey(new Date(), boundaryHour());
    const active = days.filter((day) => day.net > 0).length;
    if (active === 0) return undefined;
    return { active, streak: currentStreak(days, today) };
  } catch (error) {
    notices.push(`執筆の記録を読めませんでした：${messageOf(error)}`);
    return undefined;
  }
}

/**
 * 設定資料の厚み。
 *
 * **0件の種類は落とす**（「能力0件」は厚みの話ではない）。呼び名は
 * `KIND_LABELS` を使い回す——画面と違う呼び方をしない。
 */
async function collectSettingsCounts(
  work: WorkEntry,
  notices: string[]
): Promise<{ label: string; count: number }[]> {
  try {
    const [characters, abilities, locations, organizations, world] =
      await Promise.all([
        new CharacterStore(work).loadAll(),
        createAbilityStore(work).loadAll(),
        createLocationStore(work).loadAll(),
        createOrganizationStore(work).loadAll(),
        createWorldStore(work).loadAll(),
      ]);

    return [
      { label: KIND_LABELS.character, count: characters.characters.length },
      { label: KIND_LABELS.location, count: locations.records.length },
      { label: KIND_LABELS.organization, count: organizations.records.length },
      { label: KIND_LABELS.ability, count: abilities.records.length },
      { label: KIND_LABELS.world, count: world.records.length },
    ].filter((entry) => entry.count > 0);
  } catch (error) {
    notices.push(`設定資料を読めませんでした：${messageOf(error)}`);
    return [];
  }
}

/**
 * 人称と文体。
 *
 * **全話を繋いで見る**（`checkProofread` と同じ）。1話だけでは一人称も
 * 文語かも決められない。**シーンメモは落とす**——作者の付箋であって
 * 地の文ではない。
 *
 * 作者が「直さない」と決めた語はここでは使わない（この節はAIへ渡す
 * 作法ではなく、作者が読む1行である）。
 */
async function collectStyle(
  work: WorkEntry,
  episodes: readonly EpisodeFile[],
  notices: string[]
): Promise<{
  narrativePerson: string;
  firstPerson: string;
  archaic: boolean;
}> {
  const bodies: string[] = [];
  let unreadable = 0;

  for (const episode of episodes) {
    // 競合の跡が残ったままのファイルは触らない（両方の版が混ざった
    // 文章から文体を読むと、どちらでもない答えが出る）
    if (episode.hasConflictMarkers) continue;
    try {
      const content = await readTextFile(episode.filePath);
      for (const source of episodeBodySources(
        episode.filePath,
        content.text,
        episode
      )) {
        bodies.push(blankMemoLines(source.body));
      }
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0) {
    notices.push(
      `本文を${unreadable}件読めませんでした。文体は残りから読んでいます。`
    );
  }

  const narrativePerson = await readNarrativePerson(work);
  const facts = collectWorkStyle({
    bodyText: bodies.join("\n"),
    narrativePerson,
    keepWords: [],
  });
  return {
    narrativePerson: facts.narrativePerson,
    firstPerson: facts.firstPerson ?? "",
    archaic: facts.archaic,
  };
}

/**
 * 届いている反応（設計書6.79.7）。**サイトごとに最新の1件だけ。**
 *
 * **ここは台帳を読むだけ。** どの行を採るかは `core/targetSheetWritten.ts`
 * の `collectReactions` が持つ（`vscode` を通さずに選び方を測れるように）。
 * 読めなければ `undefined`——「まだ記録がありません」と区別する。
 */
async function readReactions(
  work: WorkEntry,
  notices: string[]
): Promise<TargetSheetReaction[] | undefined> {
  let ledger: PostingLedger;
  try {
    ledger = await new PostingStore(work).load();
  } catch (error) {
    notices.push(`投稿の記録を読めませんでした：${messageOf(error)}`);
    return undefined;
  }
  return collectReactions(ledger);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
