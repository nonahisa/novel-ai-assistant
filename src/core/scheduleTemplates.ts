import {
  DEFAULT_BUFFER_EPISODES,
  type Schedule,
  type ScheduleKind,
  type ScheduleStep,
  type SerialRule,
  type StepKey,
} from "../models/schedule";

/**
 * 種類ごとの既定の段取り（設計書6.111.4）。
 *
 * **目安であって決まりではない。** スケジュールごとに段の追加・削除・日数の変更ができる。
 * 日数を変えたくなったら、設計書の表とこの表を一緒に直す（根拠は設計書に書いてある）。
 *
 * 並びは**時間の順**（上が先）。最後の段の終わりがマイルストーンの前日になる。
 *
 * VS Code API には依存しない。
 */

interface StepTemplate {
  readonly key: StepKey;
  readonly label: string;
  /** 所要日数。執筆の段では巡航速度が無いときの仮の日数 */
  readonly days: number;
}

/** 執筆の段の仮の日数（巡航速度が無いとき） */
export const FALLBACK_WRITE_DAYS = 30;

export const SCHEDULE_TEMPLATES: Record<ScheduleKind, readonly StepTemplate[]> = {
  contest: [
    { key: "write", label: "執筆（初稿まで）", days: FALLBACK_WRITE_DAYS },
    { key: "revise", label: "推敲", days: 7 },
    { key: "finalCheck", label: "最終見直し", days: 3 },
  ],
  selfPublish: [
    { key: "write", label: "執筆（初稿まで）", days: FALLBACK_WRITE_DAYS },
    { key: "revise", label: "推敲", days: 10 },
    { key: "cover", label: "表紙の用意", days: 14 },
    { key: "proof", label: "最終校正", days: 7 },
    { key: "submitFiles", label: "入稿（EPUB・PDF）", days: 3 },
    { key: "storeReview", label: "配信の申請（ストアの審査）", days: 7 },
  ],
  publisher: [
    { key: "meeting", label: "打ち合わせ", days: 7 },
    { key: "rewrite", label: "改稿", days: 30 },
    { key: "firstProof", label: "初校", days: 14 },
    { key: "secondProof", label: "再校", days: 10 },
    { key: "sample", label: "見本", days: 21 },
  ],
  webSerial: [
    { key: "serialBuffer", label: "書き溜めの執筆", days: FALLBACK_WRITE_DAYS },
    { key: "serialPrep", label: "投稿の準備", days: 2 },
  ],
};

/** 新しいIDを作る口。テストでは決まった値を返すものを渡す */
export type IdMaker = (prefix: "sch" | "stp") => string;

/** 既定のID。時刻と乱数から作る（同期した別の機器と重ならないように乱数を足す） */
export const defaultIdMaker: IdMaker = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function templateSteps(kind: ScheduleKind, makeId: IdMaker): ScheduleStep[] {
  return SCHEDULE_TEMPLATES[kind].map((template) => ({
    id: makeId("stp"),
    key: template.key,
    label: template.label,
    days: template.days,
    due: null,
    status: "todo",
    doneAt: null,
    note: "",
  }));
}

/** 連載の既定の決まり：毎日・書き溜め5話・第1話から */
export function defaultSerialRule(): SerialRule {
  return {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    time: null,
    bufferEpisodes: DEFAULT_BUFFER_EPISODES,
    firstEpisode: 1,
    endEpisode: null,
    endDate: null,
    charsPerEpisode: null,
    site: null,
  };
}

export interface NewScheduleInput {
  readonly kind: ScheduleKind;
  readonly name: string;
  readonly milestone: string | null;
  readonly followsGoals?: boolean;
  readonly targetChars?: number | null;
  readonly now: string;
}

/** 既定の段取りで新しいスケジュールを作る */
export function createSchedule(input: NewScheduleInput, makeId: IdMaker): Schedule {
  const followsGoals = input.kind === "contest" && input.followsGoals === true;
  return {
    id: makeId("sch"),
    kind: input.kind,
    name: followsGoals ? "" : input.name.trim(),
    followsGoals,
    milestone: followsGoals ? null : input.milestone,
    targetChars: input.targetChars ?? null,
    steps: templateSteps(input.kind, makeId),
    serial: input.kind === "webSerial" ? defaultSerialRule() : null,
    note: "",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * 作品目標設定の応募先に従う公募の、**画面の上だけの**スケジュール（設計書6.111.6）。
 *
 * ファイルにまだ公募の行が無いときに出す。IDは固定——作者が段を直したときに
 * この形のまま書けば、次に読んだときに同じ行として続く。
 */
export const GOALS_CONTEST_SCHEDULE_ID = "sch_goals";

export function goalsContestSchedule(now: string): Schedule {
  let seq = 0;
  // 段のIDも固定にする（読み直すたびに別の段に見えると、押した段が見つからない）
  const fixedIds: IdMaker = (prefix) => (prefix === "sch" ? GOALS_CONTEST_SCHEDULE_ID : `stp_goals_${++seq}`);
  return createSchedule({ kind: "contest", name: "", milestone: null, followsGoals: true, now }, fixedIds);
}
