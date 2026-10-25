import type { StoryFact } from "../models/storyFact";
import type { WhereaboutsEntry } from "./contradictionMatch";
import type { LocationResolver } from "./locationConsistency";
import { canonicalPredicate } from "./predicateArity";
import type { SceneClock } from "./sceneClock";

/**
 * 事実から「誰が・どの場所に・作中のいつ」を組む（設計書6.88。移動の照合の材料）。
 *
 * ## なぜ要るのか
 *
 * 移動の照合は項目名「所在」の事実だけを見ていたが、事実の抽出（P-37）は
 * **移動を出来事（`event`）で返すよう指示されている**（「AがBへ着いた」は event）。
 * 所在の事実がほとんど来ないので、照合が空振りしていた。ここは
 * 「〜へ着いた」「〜に到着」の出来事から、**その時点からの所在をコードで導く**
 * （`stateFromEvent.ts` と同じ考え方。AIにはさせない）。
 *
 * ## 場所の引き方（母艦の判断、2026-10-25）
 *
 * **台帳の名前と別名の完全一致だけ**（`buildLocationResolver`）。2か所に当たる
 * 名前・当たらない名前は照合しない。部分一致（「港町の宿」→港町）は
 * 誤検出の元なので、いまはしない。
 *
 * ## 地の文だけを使う
 *
 * 台詞・手紙・回想に出る地名は、その人がそこにいることを言っていない
 * （「王都に帰りたい」「北の砦より」）。**地の文（`narration`）の事実だけ**を
 * 所在にする。
 *
 * VS Code にも `node:` にも依存しない。
 */

/** 所在を表す項目名（`predicateArity.ts` の排他の項目のうち、居場所の4つ） */
export const WHEREABOUTS_PREDICATES: readonly string[] = [
  "所在",
  "居場所",
  "場所",
  "現在地",
];

/**
 * 「その場所に着いた」と言い切る結び。**値の末尾がこれで終わるときだけ**読む。
 *
 * 「向かった」「発った」は入れない——着いたかどうかを言っていない
 * （向かった先にその日のうちにいたとは限らない）。
 */
const ARRIVAL_ENDING =
  /(?:へ|に)(?:無事に?)?(?:着いた|着く|到着した|到着する|到着|たどり着いた|辿り着いた|帰り着いた|戻った|戻る|帰った|帰る|入った)$/u;

/**
 * 値の中で、場所の名前の手前に来うる切れ目（主語・起点・読点）。
 *
 * 「と」は入れない——「港町と王都」の「王都」だけを拾うと、2か所を言っている
 * 値を1か所の所在に読み替えることになる。
 */
const NAME_BOUNDARY = /から|まで|を経て|を通って|[はがをで、。,\s　]/gu;

export interface WhereaboutsStats {
  /** 所在の形をした事実（項目名が居場所／着いた出来事。語り方を問わない） */
  whereaboutsFacts: number;
  /** そのうち地の文で、台帳の場所に1か所で引けたもの */
  resolved: number;
  /** そのうち時計（作中のいつか）が付いたもの */
  clocked: number;
}

export interface WhereaboutsResult {
  entries: WhereaboutsEntry[];
  stats: WhereaboutsStats;
}

/**
 * 事実の値から、場所の名前として読むべき部分を取り出す。読めなければ null。
 *
 * - 項目名が居場所なら値そのもの（「港町」）
 * - 出来事なら「〜へ着いた」の「〜」（「王都から港町へ着いた」→「王都から港町」）
 */
export function placeTextOf(fact: StoryFact): string | null {
  if (fact.kind === "knowledge") return null;
  const value = fact.value.trim().replace(/[。.]+$/u, "");
  if (!value) return null;
  const isWhereabouts = WHEREABOUTS_PREDICATES.includes(
    canonicalPredicate(fact.predicate)
  );
  const arrival = value.match(ARRIVAL_ENDING);
  if (arrival) return value.slice(0, arrival.index);
  // 着いた出来事でない出来事は、居場所の項目名でも読まない（「王都を発った」）
  if (fact.kind === "event") return null;
  return isWhereabouts ? value : null;
}

/**
 * 名前を台帳で引く。
 *
 * **値まるごとから順に、切れ目のうしろを短くしながら試す**（「エドは港町」→「港町」）。
 * いちばん長く当たったものを採る——「はるか村」のように切れ目の字を含む名前を
 * 途中で割らないため。**当たり方は完全一致だけ**（`resolver.resolve`）。
 */
export function resolvePlace(
  text: string,
  resolver: LocationResolver
): string | null {
  const starts = new Set<number>([0]);
  for (const matched of text.matchAll(NAME_BOUNDARY)) {
    starts.add((matched.index ?? 0) + matched[0].length);
  }
  for (const start of [...starts].sort((a, b) => a - b)) {
    const candidate = text.slice(start).trim();
    if (!candidate) continue;
    const id = resolver.resolve(candidate, null);
    if (id) return id;
  }
  return null;
}

export function buildWhereabouts(input: {
  facts: readonly StoryFact[];
  /** 事実の id → 本文の場所（`collectFactsFromChunk` が返すもの） */
  places: ReadonlyMap<string, { filePath: string; line: number }>;
  resolver: LocationResolver;
  clock: SceneClock;
}): WhereaboutsResult {
  const stats: WhereaboutsStats = { whereaboutsFacts: 0, resolved: 0, clocked: 0 };
  const entries: WhereaboutsEntry[] = [];

  for (const fact of input.facts) {
    const text = placeTextOf(fact);
    if (text === null) continue;
    stats.whereaboutsFacts += 1;
    // 台詞・手紙・回想・伝聞の地名は、その人の居場所を言っていない
    if (fact.modality !== "narration") continue;
    const locationId = resolvePlace(text, input.resolver);
    if (!locationId) continue;
    stats.resolved += 1;

    const place = input.places.get(fact.id);
    const clock = place ? input.clock.readingAt(place.filePath, place.line) : null;
    if (clock) stats.clocked += 1;
    entries.push({
      factId: fact.id,
      subject: fact.subject,
      locationId,
      locationName: input.resolver.nameOf(locationId),
      clock,
    });
  }
  return { entries, stats };
}
