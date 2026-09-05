import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  latestReaderStats,
  parseReaderStatsCount,
  postingSiteInfo,
  READER_STATS_METRICS,
  validateReaderStatsCount,
  validateReaderStatsPeriodKey,
  withReaderStats,
  type PostingLedger,
  type PostingSiteId,
  type ReaderStatsMetrics,
  type ReaderStatsPeriod,
  type ReaderStatsScope,
} from "../models/posting";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import {
  matchReaderStatsEnvelope,
  parseReaderStatsEnvelope,
} from "../core/readerStatsEnvelope";
import { formatReaderStatsMetrics } from "../core/postingSiteRecords";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { logFailure } from "../core/logger";
import { configurePostingSites } from "./postingKit";

/**
 * 読者の反応を台帳へ入れる2つの入口（設計書6.79.7）。
 *
 * ## サイトへは触りにいかない
 *
 * 投稿キット（6.68.1）と同じ線の内側にある。ここが読むのは
 * **クリップボード**と**作者が打った数字**だけで、アクセス解析のページを
 * 機械で開くことも、HTTPを発することもしない。
 *
 * 貼り込み係（ブラウザ拡張）が読むのは、**作者が自分で開いた自分の管理画面**を
 * ボタン1回ぶんだけである（6.79.7の1と2）。母艦はその結果を封筒として受ける。
 *
 * ## 手入力の口を必ず残す
 *
 * なろう・pixiv・ハーメルン・noteは規約の判断から**読み取りに対応しない**。
 * 手入力があれば、対応しないサイトでも記録は残せる——「対応していないから
 * 何もできない」を作らないための口である。
 *
 * ## 台帳は追記だけ
 *
 * 書き込むのは `設定/投稿状態.json` の `readerStats` だけで、原稿にも
 * 設定資料にも触らない。畳まない（同じ日に2回読めば2件）。
 */

export interface ReaderStatsResult {
  /** 台帳を書き換えたか。呼ぶ側が執筆量パネルを作り直すのに使う */
  changed: boolean;
}

const UNCHANGED: ReaderStatsResult = { changed: false };

/**
 * クリップボードの封筒から取り込む（設計書6.79.7）。
 *
 * **読めなければ、何も書かずに理由を言う。** 押したのに何も起きない、を
 * 作らない——とくに「このサイトは読み取りに対応していない」は仕様であって
 * 故障ではないので、そう言わないと伝わらない。
 */
export async function importReaderStats(
  work: WorkEntry
): Promise<ReaderStatsResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return UNCHANGED;

  const raw = await vscode.env.clipboard.readText();
  const parsed = parseReaderStatsEnvelope(raw);
  if (!parsed.ok) {
    void vscode.window.showWarningMessage(parsed.reason);
    return UNCHANGED;
  }

  // **取り違えを止めるのが、書き込む前の最後の関所**（6.79.7の4）。
  // 別の作品の管理画面を開いたまま押すことは現実に起きる
  const mismatch = matchReaderStatsEnvelope(parsed.envelope, ledger);
  if (mismatch) {
    void vscode.window.showWarningMessage(mismatch);
    return UNCHANGED;
  }

  const info = postingSiteInfo(parsed.envelope.site);
  let next = ledger;
  try {
    for (const entry of parsed.envelope.entries) {
      next = withReaderStats(next, {
        site: parsed.envelope.site,
        // **封筒の読み取り時刻を使う。** いま取り込んだ時刻ではない
        readAt: parsed.envelope.readAt,
        ...entry,
        source: "helper",
      });
    }
  } catch (error) {
    // 封筒の検証を通っていれば来ないが、黙って落とさない
    await report("読者の反応の取り込み", work, error);
    return UNCHANGED;
  }

  if (!(await save(store, work, next))) return UNCHANGED;

  void vscode.window.showInformationMessage(
    `${info.label} の読者の反応を ${parsed.envelope.entries.length}件 取り込みました。` +
      "執筆量パネルの「サイトの記録」で履歴を見られます。"
  );
  return { changed: true };
}

/**
 * 手で入力して記録する（設計書6.79.7）。
 *
 * 訊く順は「サイト → 範囲 → 粒度 → 数値」。**空欄は飛ばせる**——サイトに
 * よって読める数字が違い、全部を埋めさせると使えない画面になる。
 * 読み取った日時は打ち込んだ時刻を入れる（サイトが集計した時刻ではない）。
 */
export async function recordReaderStats(
  work: WorkEntry
): Promise<ReaderStatsResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return UNCHANGED;

  /*
    **サイトが1つも登録されていなければ、そこへ誘導する**
    （「ランキングを記録する」と同じ入口の作り）。どのサイトの数字かを
    訊いても答えようがないので、選択画面すら出さない。
  */
  if (ledger.sites.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      `${work.title} には投稿サイトが登録されていません。` +
        "「投稿サイトの設定」でサイトを登録すると、そのサイトの反応を記録できます。",
      "投稿サイトの設定"
    );
    if (answer === "投稿サイトの設定") {
      const result = await configurePostingSites(work);
      return { changed: result.changed };
    }
    return UNCHANGED;
  }

  const site = await askSite(work, ledger);
  if (!site) return UNCHANGED;
  const info = postingSiteInfo(site);

  const scope = await askScope(info.label);
  if (!scope) return UNCHANGED;

  let episode: number | undefined;
  if (scope === "episode") {
    const text = await askText({
      title: `${info.label} の何話の数字ですか`,
      prompt: "話番号を数字で入れてください（第3話なら 3）",
      placeHolder: "3",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.trim()) return "話番号を入力してください。";
        const parsed = parseReaderStatsCount(value);
        // 数の読み方は数値と同じ（全角も受ける）が、**0話は無い**
        return parsed === null || parsed < 1
          ? "話番号は1以上の整数で入力してください。"
          : undefined;
      },
    });
    if (text === undefined) return UNCHANGED;
    const parsed = parseReaderStatsCount(text);
    // 入力欄で断っているので、ここへ来るのは画面の作りが変わったときだけ
    if (parsed === null || parsed < 1) return UNCHANGED;
    episode = parsed;
  }

  const period = await askPeriod(info.label);
  if (period === undefined) return UNCHANGED;

  let periodKey: string | undefined;
  if (period !== null) {
    const text = await askText({
      title: `${info.label} の${PERIOD_LABELS[period]}の期間`,
      prompt: `どの${PERIOD_LABELS[period]}の数字ですか`,
      // 今日の値を入れておく。ふつうは「いま見ている期間」を打つ
      value: todayPeriodKey(period),
      ignoreFocusOut: true,
      validateInput: (value) =>
        validateReaderStatsPeriodKey(period, value) ?? undefined,
    });
    if (text === undefined) return UNCHANGED;
    periodKey = text.trim();
  }

  const metrics = await askMetrics(info.label);
  // Escは取りやめ（ここまでの答えも書かない）
  if (!metrics) return UNCHANGED;

  if (Object.keys(metrics).length === 0) {
    void vscode.window.showInformationMessage(
      "数値が1つも入らなかったので、記録しませんでした。" +
        "読めた数字だけで構いませんので、いずれかにご記入ください。"
    );
    return UNCHANGED;
  }

  const next = withReaderStats(ledger, {
    site,
    readAt: new Date().toISOString(),
    scope,
    ...(episode === undefined ? {} : { episode }),
    ...(period === null ? {} : { period, periodKey }),
    metrics,
    source: "manual",
  });
  if (!(await save(store, work, next))) return UNCHANGED;

  void vscode.window.showInformationMessage(
    `${info.label} の読者の反応を記録しました（${formatReaderStatsMetrics(metrics)}）。` +
      "執筆量パネルの「サイトの記録」で履歴を見られます。"
  );
  return { changed: true };
}

/** どのサイトの数字か。**登録してあるサイトの中から選ぶ** */
async function askSite(
  work: WorkEntry,
  ledger: PostingLedger
): Promise<PostingSiteId | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...ledger.sites.map((entry) => {
        const info = postingSiteInfo(entry.site);
        const latest = latestReaderStats(ledger, entry.site);
        return {
          label: info.label,
          // 前回の値を添える。「前より増えたか」がこの操作の関心である
          description: latest
            ? `前回 ${formatReaderStatsMetrics(latest.metrics)}`
            : "記録はまだありません",
          site: entry.site,
        };
      }),
      cancelItem(),
    ],
    {
      title: `${work.title} の読者の反応を記録`,
      placeHolder: "どのサイトの数字ですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("site" in picked)) return undefined;
  return picked.site;
}

/** 作品全体の数字か、1話ぶんか */
async function askScope(
  siteLabel: string
): Promise<ReaderStatsScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "作品全体",
        detail: "作品のページや解析画面に出ている、作品ぜんぶの数字",
        scope: "work" as const,
      },
      {
        label: "話を指定する",
        detail: "1話ぶんの数字（話ごとの解析画面）",
        scope: "episode" as const,
      },
      cancelItem(),
    ],
    {
      title: `${siteLabel} のどの範囲の数字ですか`,
      placeHolder: "作品全体か、1話ぶんか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("scope" in picked)) return undefined;
  return picked.scope;
}

/** 粒度の呼び名（画面と入力欄で同じ言葉を使う） */
const PERIOD_LABELS: Record<Exclude<ReaderStatsPeriod, "total">, string> = {
  day: "日",
  month: "月",
  year: "年",
};

/**
 * 解析の粒度を訊く。
 *
 * `null` は「その時点の値」（粒度を持たない）。**`undefined` は取りやめ**で、
 * 2つを同じ値で表すと、取りやめが「時点の値」として記録されてしまう。
 */
async function askPeriod(
  siteLabel: string
): Promise<Exclude<ReaderStatsPeriod, "total"> | null | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "その時点の値",
        detail: "画面に出ている数字をそのまま（累計のPVやブックマークなど）",
        period: null,
      },
      { label: "日別", detail: "その日ぶんの数字", period: "day" as const },
      { label: "月別", detail: "その月ぶんの数字", period: "month" as const },
      { label: "年別", detail: "その年ぶんの数字", period: "year" as const },
      cancelItem(),
    ],
    {
      title: `${siteLabel} の数字の粒度`,
      placeHolder: "いつぶんの数字ですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("period" in picked)) return undefined;
  return picked.period;
}

/**
 * 数値を順に訊く。**空欄は飛ばせる。**
 *
 * @returns 入れてもらった数値。取りやめ（Esc）なら undefined
 */
async function askMetrics(
  siteLabel: string
): Promise<ReaderStatsMetrics | undefined> {
  const metrics: ReaderStatsMetrics = {};
  for (const info of READER_STATS_METRICS) {
    const text = await askText({
      title: `${siteLabel} の${info.label}`,
      prompt:
        `${info.label}の数を入れてください` +
        "（そのサイトに無い項目や、読めなかった項目は空のままで構いません）",
      placeHolder: info.example,
      ignoreFocusOut: true,
      validateInput: (value) => validateReaderStatsCount(value) ?? undefined,
    });
    if (text === undefined) return undefined;
    const value = parseReaderStatsCount(text);
    // 空欄は「読めなかった」。0で埋めると、次に読んだとき減ったように見える
    if (value !== null) metrics[info.key] = value;
  }
  return metrics;
}

/** 今日の期間（入力欄の初期値）。**手元の時計の日付で作る** */
function todayPeriodKey(
  period: Exclude<ReaderStatsPeriod, "total">
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  if (period === "year") return year;
  if (period === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

async function load(
  store: PostingStore,
  work: WorkEntry
): Promise<PostingLedger | undefined> {
  try {
    return await store.load();
  } catch (error) {
    await report("投稿状態の読み込み", work, error);
    return undefined;
  }
}

async function save(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger
): Promise<boolean> {
  try {
    await store.save(ledger);
    return true;
  } catch (error) {
    await report("投稿状態の保存", work, error);
    return false;
  }
}

/** 失敗はログに残してから知らせる（原因にたどり着けるようにする） */
async function report(
  what: string,
  work: WorkEntry,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logFailure(what, {
    作品: work.title,
    種類: error instanceof PostingStoreError ? error.kind : "unknown",
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
