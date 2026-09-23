import { addDays } from "./writingStats";
import { taskKeyOf, type LoadView, type PlannedSchedule } from "./schedulePlan";

/**
 * 作品をまたぐ重なり（設計書6.111.14）。
 *
 * 作者が手を動かす段が同じ日に重なる（同じ作品の並行も、別の作品どうしも）と、
 * 1日の作業量を分け合い、切り替えの損でさらに落ちる（`sharedSpeed`）。
 * 落ちると段が延び、逆算の始まりが早まる——すると**重なり方が変わる**。
 * そこで「並べる → 重なりを数える → その重なりで並べ直す」を、並びが変わらなくなるまで
 * くり返す（`settleLoad`）。
 *
 * ## 決まった順・必ず止まる
 *
 * - 1回目は重なりを数えずに並べる（0.83.0 までと同じ並び）。重なる日が1日も無ければ、そこで終わる
 * - 2回目からは、**前の回の並び**で数えた重なりを全員に同時に当てる（先に並べた作品だけが
 *   得をする、ということが無いように。作品の順番で結果が変わらない）
 * - 前の回と同じ並びになったら終わり（その並びは、自分の重なりで計算し直しても同じ
 *   ——つじつまが合っている）
 * - **くり返しの上限（64回）**を持つ。重なりの形によっては並びが行き来して決まらないことが
 *   ありうるので、上限に達したら最後の並びを使う（入力が同じなら結果も同じ）。
 *   決まるまでの回数は、重なりが深いほど増える（1回ごとに、見込みとのずれが
 *   「1 − 重なったときの速さ」倍に縮む）。5作品が60日の段で重なる形で34回・0.1秒ほど
 *   （2026-09-24 に測った）。12回では決まりきらなかったので64回にした
 *
 * VS Code API には依存しない。
 */

/** 作者が手を動かす作業1つ（重なりを数える単位） */
export interface LoadTask {
  readonly key: string;
  readonly start: string;
  readonly end: string;
}

export const MAX_LOAD_ROUNDS = 64;

/** 並びから数えた、日ごとの重なり */
export class SpanLoad implements LoadView {
  private readonly counts = new Map<string, number>();
  private readonly spans = new Map<string, LoadTask>();

  constructor(
    tasks: readonly LoadTask[],
    readonly penalty: number
  ) {
    for (const task of tasks) {
      this.spans.set(task.key, task);
      for (let date = task.start; date <= task.end; date = addDays(date, 1)) {
        this.counts.set(date, (this.counts.get(date) ?? 0) + 1);
      }
    }
  }

  /** その日に作者が手を動かしている作業の数 */
  countOn(date: string): number {
    return this.counts.get(date) ?? 0;
  }

  othersOn(taskKey: string, date: string): number {
    const own = this.spans.get(taskKey);
    const mine = own && own.start <= date && date <= own.end ? 1 : 0;
    return Math.max(0, this.countOn(date) - mine);
  }

  /** 2つ以上重なる日があるか */
  hasOverlap(): boolean {
    for (const count of this.counts.values()) if (count >= 2) return true;
    return false;
  }
}

/**
 * 並べた予定から、作者が手を動かす作業を拾う。**作業が発生している予定だけ**
 * （過ぎた・外れた予定の段は、もう作者の時間を取らない）。済んだ段・長さ0の段・
 * 人に頼む段は数えない。
 */
export function selfTasksOf(prefix: string, plan: PlannedSchedule): LoadTask[] {
  if (!plan.active) return [];
  return plan.steps
    .filter((step) => step.actor === "self" && step.step.status !== "done" && step.days > 0)
    .map((step) => ({
      key: taskKeyOf(prefix, plan.schedule.id, step.step.id),
      start: step.start,
      end: step.end,
    }));
}

export interface SettleResult<T> {
  readonly result: T;
  /** 並べた回数 */
  readonly rounds: number;
  /** 並びが決まったか（上限で打ち切ったら false） */
  readonly converged: boolean;
}

/**
 * 重なりが決まるまで並べ直す（冒頭の説明）。
 *
 * @param planAll 重なりを受けて全作品を並べ、結果と作業の一覧を返す（純粋な関数であること）
 */
export function settleLoad<T>(
  planAll: (load: LoadView | undefined) => { result: T; tasks: readonly LoadTask[] },
  penalty: number,
  maxRounds: number = MAX_LOAD_ROUNDS
): SettleResult<T> {
  let previous = planAll(undefined);
  if (!new SpanLoad(previous.tasks, penalty).hasOverlap()) {
    return { result: previous.result, rounds: 1, converged: true };
  }
  for (let round = 2; round <= maxRounds; round++) {
    const next = planAll(new SpanLoad(previous.tasks, penalty));
    if (sameTasks(next.tasks, previous.tasks)) {
      return { result: next.result, rounds: round, converged: true };
    }
    previous = next;
  }
  return { result: previous.result, rounds: maxRounds, converged: false };
}

function sameTasks(a: readonly LoadTask[], b: readonly LoadTask[]): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((task) => [task.key, task]));
  return a.every((task) => {
    const other = byKey.get(task.key);
    return other !== undefined && other.start === task.start && other.end === task.end;
  });
}
