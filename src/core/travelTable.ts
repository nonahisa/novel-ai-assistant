import type { Location } from "../models/location";
import type { TravelTime } from "./contradictionMatch";
import {
  buildLocationResolver,
  normalizeTravel,
  regionStatement,
  type LocationResolver,
} from "./locationConsistency";

/**
 * 場所の記録から、移動の照合に使う所要時間の表を組む（設計書6.88。AIを使わない）。
 *
 * 材料は作者が設定資料に書いた（か、抽出が本文から写した）場所どうしの
 * 距離の関係（`relations` の `distance`。6.93.2）だけ。言い方は
 * `normalizeTravel`（6.93.4 の距離の照合と同じ1本）で分に直す。
 *
 * ## 決めごと（作者の裁定 2026-10-25 夜）
 *
 * - **書かれた中でいちばん速い値を使う。** 「徒歩で六日」と「馬で三日」が
 *   あれば三日。登場人物がどの手段で移ったかは読まない（推し量らない）
 * - **1日以上かかる組だけ**を表に載せる。それより短い道のりは、時刻を
 *   読まない時計（`sceneClock.ts`）では経過と比べようがない——徒歩10分の道を
 *   「同じ日のうちに移った」と比べると、同じ日の場所替わりが全部候補になる
 * - **読めない値は入れない**（「数日」「すぐそこ」「飛竜で一日」）
 * - **3か所以上をつないで推し量らない**（A→B と B→C から A→C を作らない）
 * - **片方がもう片方の中にある組は載せない**（港と港町）。中にある場所への
 *   出入りは移動ではない
 *
 * VS Code にも `node:` にも依存しない。
 */

/** 表に載せる下限（分）。これより短い道のりは照合しない */
export const TRAVEL_COMPARE_MIN_MINUTES = 24 * 60;

export interface TravelTableStats {
  /** 距離の関係の数（場所の記録に書かれていたもの） */
  distanceRelations: number;
  /** そのうち、相手が台帳で引けて、値も読めたもの */
  readable: number;
  /** 場所の組の数（向きは問わない。いちばん速い値に畳んだあと） */
  pairs: number;
  /** 表に載せた組（1日以上・入れ子でない） */
  comparedPairs: number;
}

export interface TravelTableResult {
  travelTimes: TravelTime[];
  stats: TravelTableStats;
}

/** 組の鍵。向きで変わらないよう、id を並べて作る */
function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

export function buildTravelTable(
  locations: readonly Location[]
): TravelTableResult {
  const resolver = buildLocationResolver(locations);
  const stats: TravelTableStats = {
    distanceRelations: 0,
    readable: 0,
    pairs: 0,
    comparedPairs: 0,
  };

  const fastest = new Map<string, { a: string; b: string; minutes: number }>();
  for (const location of locations) {
    for (const relation of location.relations ?? []) {
      if (relation.kind !== "distance") continue;
      stats.distanceRelations += 1;
      const target = resolver.resolve(relation.target, relation.targetId);
      if (!target || target === location.id) continue;
      const travel = normalizeTravel(relation.value);
      if (!travel) continue;
      stats.readable += 1;
      const key = pairKey(location.id, target);
      const known = fastest.get(key);
      if (!known || travel.minutes < known.minutes) {
        fastest.set(key, { a: location.id, b: target, minutes: travel.minutes });
      }
    }
  }
  stats.pairs = fastest.size;

  const contains = containmentOf(locations, resolver);
  const travelTimes: TravelTime[] = [];
  for (const key of [...fastest.keys()].sort()) {
    const entry = fastest.get(key);
    if (!entry || entry.minutes < TRAVEL_COMPARE_MIN_MINUTES) continue;
    if (contains(entry.a, entry.b) || contains(entry.b, entry.a)) continue;
    travelTimes.push({
      from: entry.a,
      to: entry.b,
      minDays: entry.minutes / TRAVEL_COMPARE_MIN_MINUTES,
    });
  }
  stats.comparedPairs = travelTimes.length;
  return { travelTimes, stats };
}

/**
 * 「inner は outer の中にあるか」を答える関数を作る。
 *
 * 材料は「中」の関係（`within`）と地域の欄（`region`。台帳に同じ名前の場所が
 * あるときだけ「中」と読む——6.93.2 と同じ）。**入れ子はたどる**（港→港町→南部）。
 * 記録が輪になっていても止まるよう、たどった場所は覚えておく。
 */
export function containmentOf(
  locations: readonly Location[],
  resolver: LocationResolver = buildLocationResolver(locations)
): (inner: string, outer: string) => boolean {
  const parents = new Map<string, Set<string>>();
  const add = (child: string, parent: string) => {
    if (child === parent) return;
    const set = parents.get(child) ?? new Set<string>();
    set.add(parent);
    parents.set(child, set);
  };
  for (const location of locations) {
    for (const relation of location.relations ?? []) {
      if (relation.kind !== "within") continue;
      const target = resolver.resolve(relation.target, relation.targetId);
      if (target) add(location.id, target);
    }
    const region = regionStatement(location, resolver);
    if (region) add(location.id, region.targetKey);
  }
  return (inner, outer) => {
    const seen = new Set<string>();
    const queue = [inner];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const parent of parents.get(current) ?? []) {
        if (parent === outer) return true;
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push(parent);
      }
    }
    return false;
  };
}
