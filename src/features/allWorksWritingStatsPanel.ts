import * as vscode from "vscode";
import type { WorkRegistry } from "../core/workRegistry";
import { toManuscriptPages } from "../core/charCount";
import { scanWork } from "../core/scanner";
import {
  aggregate,
  dailyPaceNeeded,
  mergeDailyStats,
  monthKey,
  statsDayKey,
  totalsByLabel,
  weekStartKey,
  yearKey,
  type StatsGranularity,
} from "../core/writingStats";
import { WritingStatsStore } from "../core/writingStatsStore";
import { buildWritingStatsPanelHtml } from "../views/writingStatsPanelHtml";
import {
  boundaryHour,
  dailyGoal,
  monthlyGoal,
  summarize,
  weekStart,
} from "./writingProgress";

/**
 * 全作品の執筆量パネル（作者の要望、2026-08-13）。
 *
 * 「執筆量を見る」は1作品ぶんの集計しか出さない。複数作品を並行して
 * 書いている作者には、全作品を合わせた量が見えない。
 *
 * 目標（1日・1月の字数）は作品ごとではなく `novelai.stats.dailyGoal` /
 * `monthlyGoal` という**設定全体で共有**する値のため、実は全作品を
 * 合算したこちらのほうが「目標に届いたか」を正しく判定できる
 * （1作品の画面だけでは、今日ほかの作品に書いた分が反映されない）。
 *
 * 「話ごとの文字数」タブは出さない。話数の単位が作品ごとにバラバラで、
 * 全作品分をまとめても比較の意味がない。
 */

let panel: vscode.WebviewPanel | undefined;

export async function openAllWorksWritingStatsPanel(
  context: vscode.ExtensionContext,
  registry: WorkRegistry,
  deviceId: string
): Promise<void> {
  if (registry.list().length === 0) {
    vscode.window.showInformationMessage("作品が登録されていません。");
    return;
  }

  if (panel) {
    panel.reveal();
    panel.webview.postMessage({
      type: "stats",
      data: await buildAllWorksStatsPanelData(registry, deviceId),
    });
    return;
  }

  const created = vscode.window.createWebviewPanel(
    "novelai.allWorksWritingStats",
    "全作品の執筆量",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel = created;
  context.subscriptions.push(created);
  created.onDidDispose(() => {
    panel = undefined;
  });

  const nonce = createNonce();
  created.webview.html = buildWritingStatsPanelHtml(nonce, created.webview.cspSource, {
    hasEpisodesTab: false,
  });

  created.webview.onDidReceiveMessage(async (message: unknown) => {
    const parsed = message as { type?: string };
    if (parsed.type === "ready") {
      created.webview.postMessage({
        type: "stats",
        data: await buildAllWorksStatsPanelData(registry, deviceId),
      });
    }
  });
}

/** 開いているパネルがあれば内容を作り直す */
export async function refreshAllWorksWritingStatsPanel(
  registry: WorkRegistry,
  deviceId: string
): Promise<void> {
  if (!panel) return;
  panel.webview.postMessage({
    type: "stats",
    data: await buildAllWorksStatsPanelData(registry, deviceId),
  });
}

async function buildAllWorksStatsPanelData(
  registry: WorkRegistry,
  deviceId: string
) {
  const works = registry.list();

  const perWork = await Promise.all(
    works.map(async (work) => {
      const [scanned, sets] = await Promise.all([
        scanWork(work),
        new WritingStatsStore(work, deviceId).loadAll(),
      ]);
      return { work, scanned, sets, days: mergeDailyStats(sets) };
    })
  );

  const days = mergeDailyStats(perWork.flatMap((entry) => entry.sets));

  const today = statsDayKey(new Date(), boundaryHour());
  const start = weekStart();
  const month = monthKey(today);
  const summary = summarize(days, today);

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

  const totals = perWork.reduce(
    (acc, entry) => ({
      net: acc.net + entry.scanned.stats.totals.net,
      manuscriptLines: acc.manuscriptLines + entry.scanned.stats.totals.manuscriptLines,
      files: acc.files + entry.scanned.stats.fileCount,
    }),
    { net: 0, manuscriptLines: 0, files: 0 }
  );

  return {
    title: "全作品の執筆量",
    buckets,
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
      progress: summary.monthProgress,
      paceNeeded: dailyPaceNeeded(summary.monthProgress.remaining, today),
      activeDays: summary.monthActiveDays,
    },
    streak: summary.streak,
    devices: totalsByLabel(
      perWork.map((entry) => ({ label: entry.work.title, days: entry.days }))
    ),
    devicesTitle: "作品ごとの内訳",
    devicesColumn: "作品",
    totalsCardLabel: "全作品の合計",
    totals: {
      net: totals.net,
      pages: toManuscriptPages(totals.manuscriptLines),
      files: totals.files,
      workCount: works.length,
    },
    notice:
      days.length === 0
        ? "まだ記録がありません。本文を保存すると、前回からの差がその日の執筆量になります" +
          "（最初の保存は基準を作るだけで数えません）。"
        : "記録は本文を保存したときに増えます。ファイルの追加・削除や競合の解消は、" +
          "書いた量ではないので数えません。",
  };
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
