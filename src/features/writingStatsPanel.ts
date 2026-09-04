import { openInDefaultEditor } from "../views/openDocument";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { toManuscriptPages } from "../core/charCount";
import { buildEpisodeCountTable } from "../core/episodeCharTable";
import { scanWork } from "../core/scanner";
import {
  aggregate,
  dailyPaceNeeded,
  deviceTotals,
  mergeDailyStats,
  monthKey,
  progressAgainstGoal,
  statsDayKey,
  sumRange,
  weekStartKey,
  yearKey,
  type StatsGranularity,
} from "../core/writingStats";
import { WritingStatsStore } from "../core/writingStatsStore";
import { buildWritingStatsPanelHtml } from "../views/writingStatsPanelHtml";
import {
  buildPostingSiteRecords,
  isOpenableWorkUrl,
  type PostingSiteRecord,
} from "../core/postingSiteRecords";
import { PostingStore } from "../core/postingStore";
import { logFailure } from "../core/logger";
import { episodeUnit } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import { readWorkGoalsOrEmpty } from "../core/workGoalsStore";
import {
  buildContestProgress,
  describeContestProgress,
} from "../core/contestProgress";
import {
  boundaryHour,
  dailyGoal,
  monthlyGoal,
  summarize,
  weekStart,
} from "./writingProgress";

/**
 * 執筆量パネル（設計書6.3）。
 *
 * 日次・週次・月次・年次の執筆量と、話ごとの文字数一覧を1枚で見せる。
 * 作品ごとに1枚だけ開く。同じ作品を何枚も開いても見比べる意味がない。
 */

const openPanels = new Map<string, vscode.WebviewPanel>();

export async function openWritingStatsPanel(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  deviceId: string
): Promise<void> {
  const existing = openPanels.get(work.id);
  if (existing) {
    existing.reveal();
    existing.webview.postMessage({
      type: "stats",
      data: await buildStatsPanelData(work, deviceId),
    });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.writingStats",
    `執筆量: ${work.title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  openPanels.set(work.id, panel);
  context.subscriptions.push(panel);
  panel.onDidDispose(() => openPanels.delete(work.id));

  const nonce = createNonce();
  panel.webview.html = buildWritingStatsPanelHtml(
    nonce,
    panel.webview.cspSource,
    // SNS記事では「投稿ごとの文字数」。話数ではなく投稿の並びである
    { unitNoun: episodeUnit(await readWorkFormat(work)).noun }
  );

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const parsed = message as {
      type?: string;
      filePath?: string;
      url?: string;
    };
    if (parsed.type === "openExternal" && parsed.url) {
      /*
        作品ページを**開くだけ**（設計書6.68.5）。中身は読みにいかない。
        台帳は作者が手で直せるファイルなので、開く直前にも http/https で
        あることを確かめる（`javascript:` を踏ませない）。
      */
      if (!isOpenableWorkUrl(parsed.url)) return;
      await vscode.env.openExternal(vscode.Uri.parse(parsed.url));
      return;
    }
    if (parsed.type === "ready") {
      // HTMLを流し込んだ直後は受け手がまだ居ない。
      // WebView側から準備完了を知らせてもらってから送る
      panel.webview.postMessage({
        type: "stats",
        data: await buildStatsPanelData(work, deviceId),
      });
      return;
    }
    if (parsed.type === "open" && parsed.filePath) {
      await openInDefaultEditor(parsed.filePath, {
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  });
}

/** 開いているパネルがあれば内容を作り直す */
export async function refreshWritingStatsPanel(
  work: WorkEntry,
  deviceId: string
): Promise<void> {
  const panel = openPanels.get(work.id);
  if (!panel) return;
  panel.webview.postMessage({
    type: "stats",
    data: await buildStatsPanelData(work, deviceId),
  });
}

async function buildStatsPanelData(work: WorkEntry, deviceId: string) {
  const scanned = await scanWork(work);
  const sets = await new WritingStatsStore(work, deviceId).loadAll();
  const days = mergeDailyStats(sets);

  const today = statsDayKey(new Date(), boundaryHour());
  const start = weekStart();
  const month = monthKey(today);
  const summary = summarize(days, today);
  const monthTotal = sumRange(days, `${month}-01`, `${month}-31`);
  const monthProgress = progressAgainstGoal(monthTotal.net, monthlyGoal());

  const granularities: StatsGranularity[] = [
    "daily",
    "weekly",
    "monthly",
    "yearly",
  ];
  const buckets = Object.fromEntries(
    granularities.map((granularity) => [
      granularity,
      aggregate(days, granularity, { today, weekStart: start }),
    ])
  );

  const goals = await readWorkGoalsOrEmpty(work);
  const table = buildEpisodeCountTable(scanned.episodes, {
    format: await readWorkFormat(work),
    perEpisodeGoal: goals.perEpisodeChars,
  });
  const contest = buildContestProgress(goals, scanned.stats.totals.net, today);

  return {
    title: `${work.title} の執筆量`,
    buckets,
    // 「今」に当たる棒を色分けするために、粒度ごとの現在のキーを渡す
    currentBucketKey: {
      daily: today,
      weekly: weekStartKey(today, start),
      monthly: month,
      yearly: yearKey(today),
    },
    goal: { daily: dailyGoal(), monthly: monthlyGoal() },
    today: { key: today, progress: summary.todayProgress },
    month: {
      key: month,
      progress: monthProgress,
      paceNeeded: dailyPaceNeeded(monthProgress.remaining, today),
      activeDays: monthTotal.activeDays,
    },
    streak: summary.streak,
    devices: deviceTotals(sets).map((device) => ({
      label: device.deviceId,
      net: device.net,
      activeDays: device.activeDays,
    })),
    devicesTitle: "環境ごとの内訳",
    devicesColumn: "環境",
    totals: {
      net: scanned.stats.totals.net,
      // **総文字数と段落数も渡す**（設計書6.56.4）。「作品の文字数を表示」を
      // 畳んだので、あちらでしか見られなかった2つをここで見せる
      gross: scanned.stats.totals.gross,
      paragraphs: scanned.stats.totals.paragraphs,
      pages: toManuscriptPages(scanned.stats.totals.manuscriptLines),
      files: scanned.stats.fileCount,
    },
    episodes: table,
    // サイトごとの作品情報と順位の履歴（設計書6.68.5）。
    // **1件も無ければ空の配列**で渡し、画面は節ごと出さない
    siteRecords: await readSiteRecords(work),
    // 締切のある作品では、いちばん上に「あと何日・あと何字」を出す。
    // 数字だけでは間に合うか判断できないので、文にして添える
    contest: contest
      ? {
          headline: describeContestProgress(contest),
          name: contest.contest.name,
          url: contest.contest.url,
          deadline: contest.contest.deadline,
          daysLeft: contest.daysLeft,
          overdue: contest.overdue,
          overMax: contest.overMax,
          written: contest.written,
          targetChars: contest.targetChars,
          remainingChars: contest.remainingChars,
          neededPerDay: contest.neededPerDay,
        }
      : null,
    notice:
      days.length === 0
        ? "まだ記録がありません。本文を保存すると、前回からの差がその日の執筆量になります" +
          "（最初の保存は基準を作るだけで数えません）。"
        : "記録は本文を保存したときに増えます。ファイルの追加・削除や競合の解消は、" +
          "書いた量ではないので数えません。",
  };
}

/**
 * 投稿状態の台帳から「サイトの記録」を読む（設計書6.68.5）。
 *
 * **読めなくても執筆量パネルは開く。** ここは添え物なので、台帳が壊れて
 * いるからといって文字数のグラフまで見られなくなるのは筋が悪い。
 * 黙って落とさないよう、理由はログへ残す（通知は出さない——パネルを
 * 開くたびに同じ知らせが出ると、直すまで邪魔になる）。
 */
async function readSiteRecords(work: WorkEntry): Promise<PostingSiteRecord[]> {
  try {
    return buildPostingSiteRecords(await new PostingStore(work).load());
  } catch (error) {
    logFailure("執筆量パネルのサイトの記録の読み込み", {
      作品: work.title,
      内容: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
