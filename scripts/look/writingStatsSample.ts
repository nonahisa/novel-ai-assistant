/**
 * 見比べの写真（作者の決定 2026-11-15「見た目を比べさせて」）に使う、執筆統計の見本。
 *
 * **作者の作品の数字は使わない。** 字数・日ごとの記録・サイトの反応はここで作った作り物。
 * 画面へ送る便は、製品（`features/writingStatsPanel.ts` の `buildStatsPanelData`）と同じ
 * core の部品で組む（形を写し書きすると、画面が受け取る便と食い違う日が来るため）。
 *
 * 使う側：`scripts/look/vscodeElementsLook.mjs` が esbuild で束ねてから読む。
 * **配布物には入れない**（`.vscodeignore` が `scripts/**` を外す）。
 */
import { buildWritingStatsPanelHtml } from "../../src/views/writingStatsPanelHtml";
import {
  aggregate,
  currentStreak,
  dailyPaceNeeded,
  monthKey,
  progressAgainstGoal,
  sumRange,
  weekStartKey,
  yearKey,
  addDays,
} from "../../src/core/writingStats";
import { buildEpisodeCountTable } from "../../src/core/episodeCharTable";
import { toManuscriptPages } from "../../src/core/charCount";
import {
  buildPostingSiteRecords,
  buildWorkPostingFacts,
  readerSiteTabs,
} from "../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withRanking,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../src/models/posting";
import type { DailyStat } from "../../src/models/writingStats";
import type { EpisodeFile } from "../../src/models/types";
import type { StatsGranularity } from "../../src/core/writingStats";

/** 見本の「今日」。写真が日によって変わらないように決め打ちする */
const TODAY = "2026-11-15";

/** 決まった並びの作り物の数（毎回同じ写真になるように、乱数を使わない） */
function wave(index: number, base: number, swing: number): number {
  return Math.max(0, Math.round(base + swing * Math.sin(index * 1.7) + (index % 5) * 37));
}

function sampleDays(): DailyStat[] {
  const days: DailyStat[] = [];
  for (let back = 120; back >= 0; back--) {
    // 週に1〜2日は書かない日を作る（棒が抜ける形を見るため）
    if (back % 7 === 3 || back % 11 === 5) continue;
    const net = back === 9 ? -420 : wave(back, 1400, 900);
    days.push({ date: addDays(TODAY, -back), net, gross: Math.round(net * 1.08), saves: 3 });
  }
  return days;
}

const SUBTITLES = [
  "雨の駅で", "封筒の宛名", "夜の図書室", "二度目の約束", "灯台守の手紙",
  "冬の市場", "鍵のない箱", "遠い汽笛", "名前を呼ぶ", "春を待つ部屋",
  "白い船", "最後の頁",
];

function sampleEpisodes(): EpisodeFile[] {
  return SUBTITLES.map((subtitle, index) => {
    const net = [3120, 2890, 4210, 3550, 1980, 3740, 5230, 3010, 2760, 3380, 4020, 1450][index];
    const number = index + 1;
    return {
      filePath: `C:/見本/本文/${String(number).padStart(2, "0")}_${subtitle}.txt`,
      fileName: `${String(number).padStart(2, "0")}_${subtitle}.txt`,
      ext: ".txt",
      chapterStart: number,
      chapterEnd: number,
      subtitle,
      kind: "本編",
      isInitialName: false,
      counts: {
        gross: Math.round(net * 1.07),
        net,
        lines: Math.round(net / 38),
        paragraphs: Math.round(net / 120),
        manuscriptLines: Math.round(net / 16),
      },
    } as EpisodeFile;
  });
}

function sampleLedger(): PostingLedger {
  let ledger = withSites(emptyPostingLedger(), [
    { site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/0000000000000000000/episodes/new" },
    { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n0000aa/" },
  ]);
  ledger = withSiteProfile(ledger, "kakuyomu", {
    workId: "0000000000000000000",
    workUrl: "https://kakuyomu.jp/works/0000000000000000000",
    genre: "現代ドラマ",
  });
  ledger = withSiteProfile(ledger, "narou", {
    workId: "n0000aa",
    workUrl: "https://ncode.syosetu.com/n0000aa/",
    genre: "ヒューマンドラマ",
  });
  // 作品全体の反応を5回ぶん（新しい3回が表に出て、残りは畳まれる）
  const reads = ["2026-11-15", "2026-11-12", "2026-11-08", "2026-11-04", "2026-10-31"];
  reads.forEach((day, index) => {
    const shrink = index * 140;
    ledger = withReaderStats(ledger, {
      site: "kakuyomu",
      readAt: `${day}T12:00:00.000Z`,
      scope: "work",
      metrics: { pv: 2480 - shrink, bookmarks: 61 - index * 4, points: 128 - index * 9, comments: 12 - index },
      source: "manual",
    });
    ledger = withReaderStats(ledger, {
      site: "narou",
      readAt: `${day}T12:00:00.000Z`,
      scope: "work",
      metrics: { pv: 1730 - shrink, bookmarks: 38 - index * 3, points: 96 - index * 6 },
      source: "manual",
    });
  });
  // 話ごとの記録（最新の1回）。後ろの話ほど読まれる数が減る形
  SUBTITLES.forEach((_, index) => {
    ledger = withReaderStats(ledger, {
      site: "kakuyomu",
      readAt: "2026-11-15T12:00:00.000Z",
      scope: "episode",
      episode: index + 1,
      metrics: { pv: Math.round(640 * Math.pow(0.86, index)) },
      source: "manual",
      updatedAt: addDays(TODAY, -(40 - index * 3)) + "T09:00:00+09:00",
    });
  });
  for (const [day, rank] of [["2026-11-14", 18], ["2026-11-10", 24], ["2026-11-05", 31]] as const) {
    ledger = withRanking(ledger, { site: "kakuyomu", recordedAt: `${day}T00:00:00.000Z`, board: "週間", rank });
  }
  return ledger;
}

/** 製品の `buildStatsPanelData` と同じ形の便（作り物の数字で） */
export function sampleStatsData(): Record<string, unknown> {
  const days = sampleDays();
  const granularities: StatsGranularity[] = ["daily", "weekly", "monthly", "yearly"];
  const buckets = Object.fromEntries(
    granularities.map((granularity) => [granularity, aggregate(days, granularity, { today: TODAY, weekStart: 1 })])
  );
  const month = monthKey(TODAY);
  const dailyGoal = 2000;
  const monthlyGoal = 45000;
  const monthTotal = sumRange(days, `${month}-01`, `${month}-31`);
  const monthProgress = progressAgainstGoal(monthTotal.net, monthlyGoal);
  const todayNet = days.find((day) => day.date === TODAY)?.net ?? 0;
  const episodes = sampleEpisodes();
  const table = buildEpisodeCountTable(episodes, { format: "long", perEpisodeGoal: 3500, countMode: "net" });
  const ledger = sampleLedger();
  const records = buildPostingSiteRecords(ledger);
  const net = episodes.reduce((sum, episode) => sum + episode.counts.net, 0);
  const gross = episodes.reduce((sum, episode) => sum + episode.counts.gross, 0);
  const lines = episodes.reduce((sum, episode) => sum + episode.counts.manuscriptLines, 0);
  return {
    title: "灯台の見える町（見本） の執筆統計",
    buckets,
    currentBucketKey: { daily: TODAY, weekly: weekStartKey(TODAY, 1), monthly: month, yearly: yearKey(TODAY) },
    goal: { daily: dailyGoal, monthly: monthlyGoal },
    today: { key: TODAY, progress: progressAgainstGoal(todayNet, dailyGoal) },
    month: {
      key: month,
      progress: monthProgress,
      paceNeeded: dailyPaceNeeded(monthProgress.remaining, TODAY),
      activeDays: monthTotal.activeDays,
    },
    streak: currentStreak(days, TODAY),
    devices: [
      { label: "書斎のパソコン", net: 98210, activeDays: 71 },
      { label: "ノートPC", net: 31450, activeDays: 22 },
    ],
    devicesTitle: "環境ごとの内訳",
    devicesColumn: "環境",
    totals: { net, gross, paragraphs: Math.round(net / 120), pages: toManuscriptPages(lines), files: episodes.length, measure: null },
    episodes: table,
    siteRecords: records,
    siteRecordsError: null,
    readerSites: readerSiteTabs(ledger, records),
    // なろうAPIの欄（同意済み。取得のボタンとアイコンが見える形）
    narouApi: { status: "ready", ncode: "n0000aa", opened: true, agreed: true, agreedAt: "2026-11-10T00:00:00.000Z", intervalMinutes: 60, dailyLimit: 10 },
    workFacts: buildWorkPostingFacts(ledger),
    achievements: [
      { day: "2026-11-14", text: "1日の目標 2,000字", streak: "3日連続" },
      { day: "2026-11-02", text: "1日の目標 2,000字", streak: "" },
    ],
    achievementStreaks: { dailyBest: 6 },
    contest: {
      headline: "締切まであと 46 日。目標まであと 20,640 字（1日 449 字）",
      name: "見本の文学賞",
      url: null,
      asOf: null,
      deadline: "2026-12-31",
      daysLeft: 46,
      overdue: false,
      overMax: false,
      written: net,
      targetChars: 60000,
      remainingChars: 60000 - net,
      neededPerDay: Math.ceil((60000 - net) / 46),
    },
    notice: "記録は本文を保存したときに増えます。ファイルの追加・削除や競合の解消は、書いた量ではないので数えません。",
  };
}

/** 画面の HTML（今の形・置き換えた形のどちらも、この関数の出力を使う） */
export function sampleStatsHtml(options: {
  nonce: string;
  cspSource: string;
  elementsScriptUri?: string;
  codiconsCssUri?: string;
  initialTab?: string;
}): string {
  const ledger = sampleLedger();
  const records = buildPostingSiteRecords(ledger);
  return buildWritingStatsPanelHtml(options.nonce, options.cspSource, {
    initialTab: options.initialTab,
    readerSites: readerSiteTabs(ledger, records),
    elementsScriptUri: options.elementsScriptUri,
    codiconsCssUri: options.codiconsCssUri,
  } as Parameters<typeof buildWritingStatsPanelHtml>[2]);
}
