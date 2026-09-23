import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { DeviceWritingStats } from "../models/writingStats";
import { readWorkGoals } from "../core/workGoalsStore";
import { targetCharsOf, daysUntil } from "../core/contestProgress";
import { scanWork } from "../core/scanner";
import { mergeDailyStats, statsDayKey } from "../core/writingStats";
import { WritingStatsStore } from "../core/writingStatsStore";
import {
  chooseCruisingPace,
  DEFAULT_SLACK_DAYS,
  forecastCompletion,
  PACE_WINDOW_DAYS,
  selectContestsForForecast,
  type ForecastCandidate,
  type ForecastSelection,
} from "../core/contestForecast";
import { asOfLabel, charLimitSummary, type RankedContest, type StoredContest } from "../core/contestInbox";
import { CONTEST_SOURCE_LABELS } from "../core/contestListing";
import type { WorkProfile } from "../core/contestMatchText";
import { useLogFile } from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { boundaryHour } from "./writingProgress";
import { confirmAndSave, loadContestInbox, type ContestImportDeps } from "./contestImport";
import { readWorkProfile } from "./contestWorkProfile";
import {
  scoreContestsByWork,
  similarityGuide,
  similarityReadiness,
  type SimilarityReadiness,
} from "./contestSimilarity";

/**
 * 完成予定から公募を選ぶ（設計書6.3.6.3）。入口は作品目標設定。
 *
 * 1. 巡航速度（直近30日の平均。記録が少なければ全作品）と予定の字数から完成予定日を出す
 * 2. 締切が完成予定日より余裕（7日）をもってあとの公募を、締切の近い順に並べる
 * 3. 選べば、これまでの「応募先に入れる」流れ（確かめる画面）へ
 *
 * 計算の決め事は `core/contestForecast.ts` の冒頭にある。
 */

export interface ContestForecastDeps extends ContestImportDeps {
  /** この端末の名前（執筆量の記録を読む） */
  readonly deviceId: string;
  /** 執筆量の記録を読む口（テストで差し替える。既定は作品フォルダーの記録） */
  loadStats?(work: WorkEntry): Promise<DeviceWritingStats[]>;
}

/** 完成予定と、選び出した候補 */
export interface ForecastPlan {
  readonly today: string;
  readonly written: number;
  readonly target: number;
  /** 1日あたりの字数と、どの記録で測ったか */
  readonly perDay: number;
  readonly basis: "work" | "allWorks" | "manual";
  /** 完成予定日（届いていれば今日） */
  readonly finishDate: string;
  readonly selection: ForecastSelection;
  /** 作品の概要（近さ・AIの提案の材料） */
  readonly profile: WorkProfile;
  readonly similarity: SimilarityReadiness;
}

const BASIS_LABELS: Record<ForecastPlan["basis"], string> = {
  work: `この作品の直近${PACE_WINDOW_DAYS}日の平均`,
  allWorks: `全作品の直近${PACE_WINDOW_DAYS}日の平均`,
  manual: "入れた字数",
};

function todayKey(): string {
  return statsDayKey(new Date(), boundaryHour());
}

const count = (value: number) => Math.round(value).toLocaleString("ja-JP");

/** 「10月23日」 */
export function monthDayLabel(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}月${day}日`;
}

/** 選ぶ画面の見出し：「完成予定 10月23日（直近30日の平均 1日2,000字）」 */
export function forecastTitle(plan: Pick<ForecastPlan, "finishDate" | "perDay" | "basis" | "today">): string {
  const when = plan.finishDate === plan.today ? "予定の字数に届いています" : `完成予定 ${monthDayLabel(plan.finishDate)}`;
  const pace =
    plan.basis === "manual"
      ? `入れた速さ 1日${count(plan.perDay)}字`
      : `直近${PACE_WINDOW_DAYS}日の平均 1日${count(plan.perDay)}字`;
  return `${when}（${pace}）`;
}

/**
 * 完成予定を出し、候補を選び出す。作者に訊くのは2つだけ——
 * 予定の字数が決まっていないとき、速度が0（記録が無い）のとき。
 *
 * @returns 取りやめたら undefined
 */
export async function prepareForecast(
  work: WorkEntry,
  deps: ContestForecastDeps
): Promise<ForecastPlan | undefined> {
  const inbox = loadContestInbox(deps.memory);
  if (inbox.length === 0) {
    void vscode.window.showInformationMessage(
      "取り込んだ公募がありません。作品目標設定の「公募を RSS から取り込む」か" +
        "「公募の一覧を貼り付けて取り込む」で、先に公募を取り込んでください。"
    );
    return undefined;
  }
  const today = todayKey();

  let written = 0;
  try {
    written = (await scanWork(work)).stats.totals.net;
  } catch {
    // 数えられなくても続ける（0字として出す）
  }

  let target: number | null = null;
  try {
    const contest = (await readWorkGoals(work)).contest;
    target = contest ? targetCharsOf(contest) : null;
  } catch {
    // 壊れた目標のファイルは、ここでは直さない（訊くだけ）
  }
  if (target === null) {
    const input = await askText({
      title: `「${work.title}」の予定の文字数`,
      prompt:
        `書き上げたときの作品全体の字数を入れてください（いま ${count(written)}字）。` +
        "応募先の字数を作品目標設定で入れておくと、次からは訊きません",
      placeHolder: "100000",
      ignoreFocusOut: true,
      validateInput: (value) => (parseCount(value) === null ? "1以上の数を入れてください" : null),
    });
    if (input === undefined) return undefined;
    target = parseCount(input);
    if (target === null) return undefined;
  }

  const loadStats =
    deps.loadStats ?? ((entry: WorkEntry) => new WritingStatsStore(entry, deps.deviceId).loadAll());
  const workSets = await loadStats(work).catch(() => [] as DeviceWritingStats[]);
  const otherSets = await Promise.all(
    deps
      .listWorks()
      .filter((entry) => entry.id !== work.id)
      .map((entry) => loadStats(entry).catch(() => [] as DeviceWritingStats[]))
  );
  const pace = chooseCruisingPace(
    mergeDailyStats(workSets),
    mergeDailyStats([...workSets, ...otherSets.flat()]),
    today
  );

  let perDay = pace.perDay;
  let basis: ForecastPlan["basis"] = pace.basis;
  let forecast = forecastCompletion({ target, written, perDay, today });
  if (forecast.kind === "noPace" || forecast.kind === "tooSlow") {
    // **0で割らない。** 記録が無ければ、1日に書ける字数を作者に訊く
    const reason =
      forecast.kind === "noPace"
        ? `直近${PACE_WINDOW_DAYS}日の執筆の記録が無いため、完成予定を出せません。`
        : `直近${PACE_WINDOW_DAYS}日の平均（1日${count(perDay)}字）では、完成が10年より先になります。`;
    const input = await askText({
      title: "1日に書ける字数",
      prompt: `${reason}これから1日に書けそうな字数を入れてください（残り ${count(forecast.remaining)}字）`,
      placeHolder: "1500",
      ignoreFocusOut: true,
      validateInput: (value) => (parseCount(value) === null ? "1以上の数を入れてください" : null),
    });
    if (input === undefined) return undefined;
    const manual = parseCount(input);
    if (manual === null) return undefined;
    perDay = manual;
    basis = "manual";
    forecast = forecastCompletion({ target, written, perDay, today });
  }
  if (forecast.kind !== "dated" && forecast.kind !== "reached") {
    void vscode.window.showWarningMessage(
      "完成が10年より先になるため、公募を選び出せませんでした。予定の字数か1日の字数を見直してください。"
    );
    return undefined;
  }

  const selection = selectContestsForForecast(inbox, {
    finishDate: forecast.date,
    today,
    written,
    target,
  });
  const profile = await readWorkProfile(work);
  return {
    today,
    written,
    target,
    perDay,
    basis,
    finishDate: forecast.date,
    selection,
    profile,
    similarity: await similarityReadiness(work, profile),
  };
}

/** 全角数字・桁区切り・「字」を受ける。0以下や数でなければ null */
export function parseCount(value: string): number | null {
  const text = value.normalize("NFKC").replace(/[,，\s]/gu, "").replace(/字$/u, "");
  if (!/^\d+$/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** 外したものの数を1文にする（0件のときにも「何を外したか」を言う） */
export function excludedSummary(selection: ForecastSelection): string {
  const { tooSoon, charMismatch, noDeadline, past } = selection.excluded;
  const parts = [
    tooSoon > 0 ? `締切が完成予定より${DEFAULT_SLACK_DAYS}日以上あとでないもの ${tooSoon}件` : "",
    charMismatch > 0 ? `字数が合わないもの ${charMismatch}件` : "",
    noDeadline > 0 ? `締切を読めなかったもの ${noDeadline}件` : "",
    past > 0 ? `締切の過ぎたもの ${past}件` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `外したもの：${parts.join("・")}` : "";
}

type ForecastPick = vscode.QuickPickItem & {
  candidate?: ForecastCandidate;
  action?: "nearest" | "setupVector";
};

/**
 * 完成予定から公募を選ぶ（作品目標設定の「完成予定から公募を選ぶ」）。
 *
 * @returns 応募先を入れたか
 */
export async function chooseContestByForecast(
  work: WorkEntry,
  deps: ContestForecastDeps
): Promise<boolean> {
  // 近さを測れなかったときの記録（`contestSimilarity.ts`）を、この作品のログへ残す
  useLogFile(work.folderPath);
  const plan = await prepareForecast(work, deps);
  if (!plan) return false;
  const candidates = plan.selection.candidates;
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      `${forecastTitle(plan)}。締切に間に合う公募が、取り込んだ中にありませんでした。` +
        `${excludedSummary(plan.selection)}。新しい一覧を取り込むと見つかるかもしれません。`
    );
    return false;
  }

  let scores: Map<StoredContest, number> | undefined;
  for (;;) {
    const picked = await vscode.window.showQuickPick(
      [...forecastItems(plan, scores), cancelItem()],
      {
        title: `「${work.title}」${forecastTitle(plan)}`,
        placeHolder: forecastPlaceholder(plan, scores !== undefined),
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return false;
    if ("action" in picked && picked.action === "setupVector") {
      await vscode.commands.executeCommand("novelai.setupVectorSearch");
      return false;
    }
    if ("action" in picked && picked.action === "nearest") {
      scores = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "公募と作品の近さを測っています" },
        () => scoreContestsByWork(plan.profile, candidates.map((entry) => entry.contest))
      );
      if (!scores) {
        void vscode.window.showWarningMessage(
          "近さを測れなかったため、締切の近い順のまま並べます（記録に理由を残しました）。"
        );
      }
      continue;
    }
    if ("candidate" in picked && picked.candidate) {
      return confirmAndSave(work, toRanked(picked.candidate, plan.today), deps);
    }
    // 案内だけの項目（押しても何もしない）。一覧へ戻す
  }
}

function forecastPlaceholder(plan: ForecastPlan, sortedByNearness: boolean): string {
  const basis =
    plan.basis === "allWorks"
      ? `${BASIS_LABELS.allWorks}で測りました（この作品の記録が少ないため）`
      : `${BASIS_LABELS[plan.basis]}で測りました`;
  const order = sortedByNearness ? "作品に近い順" : "締切の近い順";
  const excluded = excludedSummary(plan.selection);
  return `${basis}。${order}に並べています。${excluded}`;
}

/** 選ぶ画面の項目。字数の合うもの → 字数を読めなかったもの の順に区切る */
function forecastItems(
  plan: ForecastPlan,
  scores: Map<StoredContest, number> | undefined
): ForecastPick[] {
  const items: ForecastPick[] = [];
  if (!scores) {
    items.push(
      plan.similarity.ready
        ? {
            label: "$(list-ordered) 作品に近い順に並べ替える",
            detail: "プロット・紹介文と、公募の募集内容の近さで並べます（手元のOllamaを使います。無料）。",
            action: "nearest",
          }
        : plan.similarity.reason === "noProfile"
          ? {
              label: "$(info) 作品に近い順にも並べられます",
              detail: similarityGuide(plan.similarity),
            }
          : {
              label: "$(info) 作品に近い順にも並べられます",
              detail: `${similarityGuide(plan.similarity)}押すと準備の案内を開きます。`,
              action: "setupVector",
            }
    );
  }
  const ordered = scores
    ? [...plan.selection.candidates].sort(
        (a, b) => (scores.get(b.contest) ?? -2) - (scores.get(a.contest) ?? -2)
      )
    : plan.selection.candidates;
  let heading: ForecastCandidate["chars"] | undefined;
  for (const candidate of ordered) {
    if (!scores && candidate.chars !== heading) {
      heading = candidate.chars;
      items.push({
        label:
          candidate.chars === "fits"
            ? "締切に間に合い、字数の合うもの"
            : "締切に間に合うが、字数を読めなかったもの（原文で確かめてください）",
        kind: vscode.QuickPickItemKind.Separator,
      });
    }
    const contest = candidate.contest;
    const score = scores?.get(contest);
    items.push({
      label: contest.name,
      description:
        `締切 ${candidate.deadline}（締切まで余裕${candidate.slackDays}日）` +
        (score !== undefined ? `　近さ ${Math.round(Math.max(0, score) * 100)}%` : ""),
      detail: [
        charLimitSummary(contest.charLimit),
        contest.genre ? `募集作品：${contest.genre}` : "",
        contest.organizer ? `主催：${contest.organizer}` : "",
        `${CONTEST_SOURCE_LABELS[contest.source]}・${asOfLabel(contest.importedAt)}`,
      ]
        .filter(Boolean)
        .join("　"),
      candidate,
    });
  }
  return items;
}

/** 確かめる画面（`confirmAndSave`）へ渡す形にする */
export function toRanked(candidate: ForecastCandidate, today: string): RankedContest {
  return {
    contest: candidate.contest,
    deadline: candidate.deadline,
    daysLeft: daysUntil(candidate.deadline, today),
    fit: candidate.chars === "fits" ? "fits" : "unknownChars",
    neededPerDay: null,
  };
}
