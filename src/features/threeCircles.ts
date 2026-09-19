import * as vscode from "vscode";
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
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
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
import { formatReaderStatsMetrics } from "../core/postingSiteRecords";
import {
  POSTING_SITES,
  readerStatsForSite,
  type PostingLedger,
} from "../models/posting";
import { ReaderTargetStore } from "../core/readerTargetStore";
import type { ReaderProfile } from "../models/readerProfile";
import { ADVICE_TYPES, resolveAdviceType } from "../core/advicePolicy";
import type { AdviceProfile } from "../core/advicePolicy";
import type { AuthorReaderProfile } from "../core/authorReaderType";
import {
  buildThreeCirclesSheet,
  THREE_CIRCLES_KIND,
  type ThreeCirclesReaction,
  type ThreeCirclesWritten,
} from "../core/threeCirclesSheet";
import { openGeneratedMarkdown } from "../views/openDocument";
import { logFailure, useLogFile } from "../core/logger";

/**
 * 3つの輪（設計書6.101、実装の順「3」と「4」）。
 *
 * **すでに書けたもの・書きたいもの・読者が読みたいもの**を1枚にまとめて
 * 開く。組み立ては `core/threeCirclesSheet.ts` が持ち、ここは**材料を
 * 集めるだけ**である（執筆再開の1枚と同じ形）。
 *
 * **AIを1度も呼ばない。** 材料はどれも既にある台帳と実績から取れる。
 *
 * **原稿も台帳も書き換えない。** 書くのは `.aiwriter/generated/` の紙1枚
 * だけで、読むほうは読むだけである。
 *
 * **読めない材料があっても1枚は出す。** 3つの輪は、どれか1つが欠けても
 * 残りは並べられる。読めなかったものは断り書きを1行残して先へ進む。
 */
export async function showThreeCircles(
  work: WorkEntry,
  deviceId: string,
  sources: {
    /** 作者自身の読者タイプ（6.101の1）。**未診断なら undefined** */
    authorReader?: AuthorReaderProfile;
    /** 作家タイプ（6.86）。**受容度・自信度はここでは使わない** */
    advice?: AdviceProfile;
  }
): Promise<void> {
  // **記録の直前ではなく、集め始める前に書き先を向ける**（0.43.3 と同じ）。
  // ここから先は、どの材料で転んでもこの作品のログへ残る
  useLogFile(work.folderPath);

  const notices: string[] = [];

  /*
    **待たせる可能性があるのは、文体を読むところだけ**（全話の本文を
    読む）である。19話・4万字なら一瞬だが、200話の合本では体感できる
    長さになりうるので、進み具合を出しておく。**中止は付けない**
    ——読むだけで、途中でやめても得るものが無い。
  */
  const sheet = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${THREE_CIRCLES_KIND}を組み立てています`,
    },
    async () => {
      const { episodes } = await scanWork(work);
      const plot = await readPlotSections(work, notices);
      const profile = await loadReaderProfile(work, notices);

      return buildThreeCirclesSheet({
        workTitle: work.title,
        written: await collectWritten(work, episodes, deviceId, notices),
        wanted: {
          writerType: writerTypeOf(sources.advice),
          genre: plot.genre,
          motif: plot.motif,
        },
        profile,
        reactions: await collectReactions(work, notices),
        authorReader: sources.authorReader,
        notices,
      });
    }
  );

  // どの画面で読むかは作者の割り当てに任せる（`openGeneratedMarkdown`）。
  // ファイル名の前置きは種類だけにする（作品名は見出しに入っている）
  await openGeneratedMarkdown(
    THREE_CIRCLES_KIND,
    sheet,
    { preview: false },
    { work }
  );
}

/* ───────────────────────────────────────────────────────────────
   すでに書けたもの
   ─────────────────────────────────────────────────────────────── */

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
): Promise<ThreeCirclesWritten> {
  const written: ThreeCirclesWritten = {};

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
 * 作者が「直さない」と決めた語はここでは使わない（この紙はAIへ渡す
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

/* ───────────────────────────────────────────────────────────────
   書きたいもの・読者が読みたいもの
   ─────────────────────────────────────────────────────────────── */

/**
 * 作家タイプ（設計書6.86）の呼び名と説明。
 *
 * **受容度・自信度（`AdviceState`）は出さない**（6.86 の裁定。見せると
 * それ自体がラベルになる）。ここで読むのは点数からタイプを引くところ
 * までである。
 */
function writerTypeOf(
  profile: AdviceProfile | undefined
): { label: string; summary: string } | undefined {
  if (!profile) return undefined;
  const type = ADVICE_TYPES[resolveAdviceType(profile.scores)];
  return { label: type.label, summary: type.summary };
}

/** プロットのジャンルとモチーフ。書かれていなければ空 */
async function readPlotSections(
  work: WorkEntry,
  notices: string[]
): Promise<{ genre: string; motif: string }> {
  try {
    const sections = parsePlotMarkdown(await readPlotText(work)).sections;
    return {
      genre: isBlankPlotSection(sections.genre) ? "" : sections.genre.trim(),
      motif: isBlankPlotSection(sections.motif) ? "" : sections.motif.trim(),
    };
  } catch (error) {
    notices.push(`プロットを読めませんでした：${messageOf(error)}`);
    return { genre: "", motif: "" };
  }
}

/** この作品の読者像（宣言・実像）。読めなければ undefined */
async function loadReaderProfile(
  work: WorkEntry,
  notices: string[]
): Promise<ReaderProfile | undefined> {
  try {
    return await new ReaderTargetStore(work).load();
  } catch (error) {
    notices.push(`読者像の台帳を読めませんでした：${messageOf(error)}`);
    logFailure("3つの輪：読者像を読めなかった", {
      作品: work.title,
      詳細: messageOf(error),
    });
    return undefined;
  }
}

/**
 * 届いている反応（設計書6.79.7）。**サイトごとに最新の1件だけ。**
 *
 * 見るのは `scope: "work"`（作品全体）の行である。話ごとの数字を混ぜると、
 * 「この作品はどれくらい読まれているか」に1話ぶんの数字が出る。
 *
 * 数字の言い方は `formatReaderStatsMetrics` に任せる——サイトごとの
 * 呼び名（なろうの「評価者数」など）を、ここで言い換えない。
 */
async function collectReactions(
  work: WorkEntry,
  notices: string[]
): Promise<ThreeCirclesReaction[]> {
  let ledger: PostingLedger;
  try {
    ledger = await new PostingStore(work).load();
  } catch (error) {
    notices.push(`投稿の台帳を読めませんでした：${messageOf(error)}`);
    return [];
  }

  const reactions: ThreeCirclesReaction[] = [];
  for (const info of POSTING_SITES) {
    const latest = readerStatsForSite(ledger, info.id).find(
      (record) => record.scope === "work"
    );
    if (!latest) continue;
    const metrics = formatReaderStatsMetrics(latest.metrics);
    // 欄が1つも読めなかった行は、数字を1つも持っていない。
    // 「（サイト名）：」だけの行を出しても何も伝わらない
    if (!metrics) continue;
    reactions.push({
      site: info.label,
      metrics,
      readAt: latest.readAt.slice(0, 10),
    });
  }
  return reactions;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
