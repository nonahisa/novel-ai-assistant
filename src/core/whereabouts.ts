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
 * **まず台帳の名前と別名の完全一致**（`buildLocationResolver`）。2か所に当たる
 * 名前・当たらない名前は照合しない。完全一致で引けなければ、**名前がちょうど
 * 1か所だけ含まれる値**をその場所とみなす（「港町の宿」→港町。作者の選択③、
 * 2026-10-25。最初は誤検出の元として含みでは引かなかった）。
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
  /*
    居場所の項目名なら、出来事でも値を読む。P-37 は「その頃、リナは港町にいた」を
    「所在＝港町（event）」で返した（2026-10-25、gemma4:26b。旅の台の仕込みの1件）。
    「王都を発った」のような値は、場所の引き当てが完全一致なので当たらない。
    **移動のような項目名の出来事は、着いた結びが無ければ読まない**——「移動＝港町」は
    向かった先か発った元か決められない
  */
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
  return resolveContainedPlace(text, resolver);
}

/**
 * 向かった・発った・目指した を言う語。**含みで引くときだけ**見る（完全一致の
 * 「〜へ着いた」は `placeTextOf` が着いた先だけを切り出してから来る）。
 * 「港町へ向かった」の港町は、その人がいる場所ではない
 */
const DEPARTURE_WORDS = /向か|発っ|発つ|発ち|出発|を出|目指|旅立|行っ|行く|行き/u;

/**
 * 完全一致で引けなかった値の退き先（作者の選択③、2026-10-25）：台帳の名前（別名）が
 * **値まるごとの中にちょうど1か所だけ**出てくるなら、その場所とみなす（「港町の宿」→港町）。
 *
 * 旅の台で、値は「港町の宿」「王都の城門」「灯台の上」のように場所の名前そのもので
 * ないことが多く、完全一致では26bの所在の事実15件のうち5件が引けなかった。
 * 2か所を含むもの・含まないものは引かない。入れ子の組（港と港町）は、長い名前の
 * 一部として出た短い名前を数えない（`LocationResolver.idsIn`）。所要時間の表での
 * 入れ子の扱い（1日に満たない組は比べない）はそのまま
 */
function resolveContainedPlace(
  text: string,
  resolver: LocationResolver
): string | null {
  if (DEPARTURE_WORDS.test(text)) return null;
  const ids = resolver.idsIn(text);
  return ids.length === 1 ? ids[0] : null;
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
