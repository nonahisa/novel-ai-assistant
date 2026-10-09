import {
  describeLocationRelation,
  type Location,
  type LocationRelation,
} from "../models/location";
import {
  buildLocationResolver,
  DIRECTION_TOLERANCE_STEPS,
  findLocationInconsistencies,
  normalizeDirection,
  normalizeTravel,
  regionStatement,
  type LocationInconsistencyKind,
  type LocationStatement,
} from "./locationConsistency";

/**
 * 場所の略図——方角と距離で場所を置く（設計書6.93.10。作者の裁定 2026-10-09 夜）。
 *
 * **決まった位置と決まらない位置を見た目で分け、決めたふりをしない。**
 * 方角と距離が両方そろった組だけを「決まった位置」として置き、片方しか無い
 * 組は仮に置いたと分かる形（点線・「距離未定」「向き未定」）にする。
 * 手がかりの無い場所は図に置かず「位置未定」の棚へ並べる。
 *
 * - **推測で関係を補わない。** 使うのは資料にある関係だけ。相手の引き方・
 *   方角と距離の読み方は機械照合（`locationConsistency.ts`）と同じ1本を使う
 *   （照合で比べなかった関係を、略図だけが線で結ぶことが無いように）
 * - **作者が置いた位置（`sketchPosition`）は最後に重ねる。** 置き方の計算は
 *   作者の位置を見ずに行うので、作者が1つ動かしてもほかの点は動かない
 *   （「作者が動かした位置を自動で動かす」をしない）
 * - **同じ入力なら同じ図。** 並びはすべて台帳の順で決める。画面の座標と
 *   保存した位置がずれないため
 *
 * VS Code にも `node:` にも依存しない（ブラウザ版でも動く。実装ルール7）。
 * AI は使わない。
 */

/* ── 定数 ─────────────────────────────────────────── */

/**
 * 乗り物の速さ（km/h）。**乗り物が混ざる島でだけ**使う（設計書6.93.10）。
 * 凡例にこの表をそのまま出す——換算の前提を作者が見られるようにする。
 */
export const TRAVEL_SPEEDS_KMH: ReadonlyArray<{ mode: string; kmh: number }> = [
  { mode: "徒歩", kmh: 4 },
  { mode: "馬車", kmh: 8 },
  { mode: "馬", kmh: 12 },
  { mode: "船", kmh: 10 },
  { mode: "車", kmh: 40 },
];

/** 島の中の距離の真ん中の長さを、図の上で何画素にするか */
export const SKETCH_BASE_LENGTH = 160;
/**
 * 図に描く距離の上限と下限。島の真ん中の長さの4倍・0.3倍を超えるものは、
 * この長さで描いて線に「縮めて描画」「伸ばして描画」と書く（決まった位置とは言わない）
 */
export const SKETCH_MAX_LENGTH = SKETCH_BASE_LENGTH * 4;
export const SKETCH_MIN_LENGTH = SKETCH_BASE_LENGTH * 0.3;
/** 距離の分からない方角だけの関係を、仮に置く長さ */
const UNKNOWN_DISTANCE_LENGTH = SKETCH_BASE_LENGTH;
/** 隣接を寄せる長さ（短い線） */
const ADJACENT_LENGTH = 70;
/** 含む関係だけでつながる場所を、親の近くへ寄せる長さ */
const NEAR_LENGTH = 60;
/** 島どうしの間 */
const ISLAND_GAP = 160;
/** 枠の余白（入れ子の外側ほど広くして、内側の枠と重ならないようにする） */
const FRAME_PADDING = 24;
/**
 * 作者の置いた位置が関係の方角から外れたとみなす角度。照合と同じく隣り合う
 * 方位までは許し（`DIRECTION_TOLERANCE_STEPS`）、連続の角度なので半段を足す
 */
const MISMATCH_DEGREES = DIRECTION_TOLERANCE_STEPS * 45 + 22.5;

const DIRECTION_NAMES = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];

/* ── 形 ───────────────────────────────────────────── */

/**
 * 点の置き方。
 *
 * - origin：島の起点
 * - fixed：方角と距離がそろった関係で置いた
 * - directionOnly：方角だけ（距離は仮の長さ）
 * - distanceOnly：距離だけ（向きは空いている所を選んだ）
 * - near：隣接・含む関係で近くへ寄せただけ
 * - author：作者が置いた
 */
export type SketchPlacement =
  | "origin"
  | "fixed"
  | "directionOnly"
  | "distanceOnly"
  | "near"
  | "author";

export interface SketchPoint {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 島の番号（0から）。関係の無い場所を作者が置いたときは -1 */
  island: number;
  placement: SketchPlacement;
  /**
   * 決まった位置か。起点から方角と距離のそろった（換算していない）関係だけで
   * たどれる点だけが true。作者が置いた点は作者の位置なので true とは言わない
   */
  settled: boolean;
  /** 作者が置いた（`sketchPosition` がある） */
  authorPlaced: boolean;
}

export interface SketchLine {
  /** 台帳の並びで先の場所 */
  from: string;
  to: string;
  /** position＝方角か距離がある／adjacent＝隣接だけ */
  kind: "position" | "adjacent";
  /** 「北・徒歩10分」「北・距離未定」「徒歩10分・向き未定」「隣接」 */
  label: string;
  /** 方角と距離がそろって（換算もせずに）決まった線だけ実線 */
  dashed: boolean;
  /** 乗り物が混ざる島で、ほかの乗り物から換算して置いた */
  converted: boolean;
  /** かけ離れた距離を、図に収まる長さで描いた（比のままではない） */
  clamped: "shortened" | "lengthened" | null;
  /** 機械照合で挙がった食い違い（`LocationSketch.conflicts` の番号） */
  conflict?: { index: number; label: string };
  /** 作者が置いた点が、関係の方角と食い違う（注意の印だけ。止めない） */
  authorMismatch: boolean;
  /** 線を作った記述（画面の吹き出しに出す） */
  statements: string[];
}

/** 含む関係の枠（親の枠は子を囲む大きさ） */
export interface SketchFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 入れ子の深さ（いちばん外が0） */
  depth: number;
}

export interface SketchConflict {
  /** `findLocationInconsistencies` の並びでの番号（提案パネルの行と結ぶ鍵） */
  index: number;
  kind: LocationInconsistencyKind;
  summary: string;
  /** 「食い違い：第3話／第7話」 */
  label: string;
  locationIds: string[];
}

/** 略図に使えなかった関係（黙って捨てない） */
export interface SketchUnused {
  locationId: string;
  text: string;
  reason: string;
}

export interface LocationSketch {
  points: SketchPoint[];
  lines: SketchLine[];
  frames: SketchFrame[];
  /** 位置未定の棚（台帳の順） */
  shelf: Array<{ id: string; name: string }>;
  /** 関係でつながる島の数 */
  islands: number;
  /** 乗り物の換算をした島があるときだけ、換算の表。無ければ null */
  conversions: ReadonlyArray<{ mode: string; kmh: number }> | null;
  conflicts: SketchConflict[];
  unused: SketchUnused[];
  /** 点と枠をすべて囲む範囲（棚は含まない） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface LocationSketchOptions {
  /** 起点に選び直した場所。その場所の島でだけ効く */
  origin?: string | null;
}

/* ── 組み立て ─────────────────────────────────────── */

interface DirectionFact {
  /** 組の前（台帳で先）から見た、後ろの方位（0〜7） */
  bearing: number;
  /** 記述そのものの方位（線の言葉に使う） */
  ownStep: number;
  statement: LocationStatement;
  chapter: number;
  order: number;
}

interface DistanceFact {
  mode: string;
  minutes: number;
  statement: LocationStatement;
  chapter: number;
  order: number;
}

interface Pair {
  a: string;
  b: string;
  directions: DirectionFact[];
  distances: DistanceFact[];
  adjacent: LocationStatement[];
}

/** 置くときに使う辺（強い順に選ぶ） */
interface PlacementEdge {
  u: string;
  v: string;
  quality: number;
  /** u から見た v の方位（度。北0・時計回り）。無ければ向きは空いている所 */
  bearingDegrees: number | null;
  /** 長さ（画素）。null は仮の長さ */
  length: number | null;
  placement: Exclude<SketchPlacement, "origin" | "author">;
  /** この辺で置いた点を「決まった位置」と言ってよいか */
  settles: boolean;
}

export function buildLocationSketch(
  locations: readonly Location[],
  options: LocationSketchOptions = {}
): LocationSketch {
  const resolver = buildLocationResolver(locations);
  const order = new Map(locations.map((location, index) => [location.id, index]));
  const byId = new Map(locations.map((location) => [location.id, location]));
  const unused: SketchUnused[] = [];

  /* 1. 組ごとの手がかりを集める */
  const pairs = new Map<string, Pair>();
  const pairOf = (x: string, y: string): Pair => {
    const [a, b] = (order.get(x) ?? 0) < (order.get(y) ?? 0) ? [x, y] : [y, x];
    const key = JSON.stringify([a, b]);
    const found = pairs.get(key);
    if (found) return found;
    const created: Pair = { a, b, directions: [], distances: [], adjacent: [] };
    pairs.set(key, created);
    return created;
  };
  /** 含む関係（子 → 親） */
  const withins: Array<{ child: string; parent: string }> = [];
  let statementOrder = 0;

  for (const location of locations) {
    for (const relation of location.relations ?? []) {
      const text = `${location.name}は${describeLocationRelation(relation)}`;
      const target = resolver.resolve(relation.target, relation.targetId);
      if (!target) {
        unused.push({
          locationId: location.id,
          text,
          reason: "相手の場所が台帳に無いか、名前が2か所に当たるので置けません",
        });
        continue;
      }
      if (target === location.id) continue;
      const statement = statementOf(location, relation, text);
      statementOrder += 1;
      const chapter = relation.chapters.length > 0 ? Math.max(...relation.chapters) : -1;
      switch (relation.kind) {
        case "within":
          withins.push({ child: location.id, parent: target });
          break;
        case "adjacent":
          pairOf(location.id, target).adjacent.push(statement);
          break;
        case "direction": {
          const step = normalizeDirection(relation.value);
          if (step === null) {
            unused.push({
              locationId: location.id,
              text,
              reason: "方角が8方位で読めないので、向きを決められません",
            });
            break;
          }
          const pair = pairOf(location.id, target);
          // 記述は「この場所は相手から見て〈方角〉」。組の前から見た後ろの方位に揃える
          const bearing = pair.b === location.id ? step : (step + 4) % 8;
          pair.directions.push({ bearing, ownStep: step, statement, chapter, order: statementOrder });
          break;
        }
        case "distance": {
          const travel = normalizeTravel(relation.value);
          if (!travel) {
            unused.push({
              locationId: location.id,
              text,
              reason: "距離を数にできないので、長さを決められません",
            });
            break;
          }
          pairOf(location.id, target).distances.push({
            ...travel,
            statement,
            chapter,
            order: statementOrder,
          });
          break;
        }
      }
    }
    const region = regionStatement(location, resolver);
    if (region) withins.push({ child: location.id, parent: region.targetKey });
  }

  /* 2. 機械照合の食い違い（並びは照合と同じ。提案パネルの行と結ぶ鍵になる） */
  const conflicts: SketchConflict[] = findLocationInconsistencies(locations).map(
    (inconsistency, index) => ({
      index,
      kind: inconsistency.kind,
      summary: inconsistency.summary,
      label: conflictLabel(inconsistency.statements),
      locationIds: [...new Set(inconsistency.statements.map((statement) => statement.locationId))],
    })
  );
  /** 輪になった含む関係の場所（枠を描かない） */
  const inCycle = new Set(
    conflicts.filter((conflict) => conflict.kind === "cycle").flatMap((conflict) => conflict.locationIds)
  );

  /* 3. 島を分ける（関係でつながる塊） */
  const parent = new Map(locations.map((location) => [location.id, location.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (x: string, y: string): void => {
    const [rx, ry] = [find(x), find(y)];
    if (rx === ry) return;
    // 台帳で先の場所を根にする（島の並びを台帳の順に保つため）
    if ((order.get(rx) ?? 0) < (order.get(ry) ?? 0)) parent.set(ry, rx);
    else parent.set(rx, ry);
  };
  const connected = new Set<string>();
  const usablePairs = [...pairs.values()].filter(
    (pair) => pair.directions.length + pair.distances.length + pair.adjacent.length > 0
  );
  for (const pair of usablePairs) {
    union(pair.a, pair.b);
    connected.add(pair.a).add(pair.b);
  }
  for (const edge of withins) {
    union(edge.child, edge.parent);
    connected.add(edge.child).add(edge.parent);
  }
  const islandRoots: string[] = [];
  for (const location of locations) {
    if (!connected.has(location.id)) continue;
    const root = find(location.id);
    if (!islandRoots.includes(root)) islandRoots.push(root);
  }

  /* 4. 島ごとに置く */
  const points = new Map<string, SketchPoint>();
  const lines: SketchLine[] = [];
  let anyConversion = false;
  let cursorX = 0;

  islandRoots.forEach((root, islandIndex) => {
    const members = locations.filter(
      (location) => connected.has(location.id) && find(location.id) === root
    );
    const memberIds = new Set(members.map((location) => location.id));
    const islandPairs = usablePairs.filter((pair) => memberIds.has(pair.a));
    const islandWithins = withins.filter((edge) => memberIds.has(edge.child));

    // 乗り物：**混ざるときだけ換算する**。乗り物の書いていない距離（「三日の
    // 距離」）は、ほかの乗り物と混ざる島では何で行くのか決められないので使わない
    const knownModes = new Set(
      islandPairs.flatMap((pair) => pair.distances.map((fact) => fact.mode)).filter(Boolean)
    );
    const mixed = knownModes.size > 1;
    if (mixed) anyConversion = true;
    const usableDistance = (fact: DistanceFact): boolean =>
      fact.mode !== "" || knownModes.size === 0;
    const dominantMode = mixed ? dominantOf(islandPairs) : null;
    const unitsOf = (fact: DistanceFact): number => {
      if (!mixed) return fact.minutes;
      const speed = TRAVEL_SPEEDS_KMH.find((entry) => entry.mode === fact.mode)?.kmh ?? 0;
      return (fact.minutes / 60) * speed;
    };
    for (const pair of islandPairs) {
      for (const fact of pair.distances) {
        if (usableDistance(fact)) continue;
        unused.push({
          locationId: fact.statement.locationId,
          text: fact.statement.text,
          reason: "乗り物が書いていないので、乗り物の混ざる島では長さに直せません",
        });
      }
    }

    // 組ごとに使う記述を1つ選ぶ。**食い違う組でもどちらかを正しいとは言わない**——
    // あとの話の記述で仮に置き、線を赤くする（設計書6.93.10）
    const chosen = islandPairs.map((pair) => {
      const direction = latest(pair.directions);
      const distance = latest(pair.distances.filter(usableDistance));
      return { pair, direction, distance };
    });
    const lengths = chosen
      .map((entry) => (entry.distance ? unitsOf(entry.distance) : null))
      .filter((value): value is number => value !== null && value > 0);
    const scale = lengths.length > 0 ? SKETCH_BASE_LENGTH / median(lengths) : 1;

    // 置くための辺。強い順：方角＋距離 → 換算した方角＋距離 → 方角だけ → 距離だけ → 隣接 → 含む
    const edges: PlacementEdge[] = [];
    for (const { pair, direction, distance } of chosen) {
      const converted = Boolean(distance && mixed && distance.mode !== dominantMode);
      const raw = distance ? unitsOf(distance) * scale : null;
      // **かけ離れた距離は図に収まる長さで描き、そう書く**（比のまま描くと、
      // 「馬車で半日」の1本のせいでほかの場所が1点に潰れて読めない）
      const clamped: SketchLine["clamped"] =
        raw === null ? null : raw > SKETCH_MAX_LENGTH ? "shortened" : raw < SKETCH_MIN_LENGTH ? "lengthened" : null;
      const length =
        raw === null ? null : Math.min(SKETCH_MAX_LENGTH, Math.max(SKETCH_MIN_LENGTH, raw));
      const both = (u: string, v: string, flip: boolean) => {
        const bearingDegrees = direction
          ? (((flip ? (direction.bearing + 4) % 8 : direction.bearing) * 45) % 360)
          : null;
        if (direction && length !== null) {
          edges.push({
            u,
            v,
            quality: converted ? 4 : 5,
            bearingDegrees,
            length,
            placement: "fixed",
            settles: !converted && clamped === null,
          });
        } else if (direction) {
          edges.push({ u, v, quality: 3, bearingDegrees, length: null, placement: "directionOnly", settles: false });
        } else if (length !== null) {
          edges.push({ u, v, quality: 2, bearingDegrees: null, length, placement: "distanceOnly", settles: false });
        } else if (pair.adjacent.length > 0) {
          edges.push({ u, v, quality: 1, bearingDegrees: null, length: ADJACENT_LENGTH, placement: "near", settles: false });
        }
      };
      both(pair.a, pair.b, false);
      both(pair.b, pair.a, true);

      lines.push({
        from: pair.a,
        to: pair.b,
        kind: direction || distance ? "position" : "adjacent",
        label:
          lineLabel(direction, distance, pair.adjacent.length > 0) +
          (clamped === "shortened" ? "（縮めて描画）" : clamped === "lengthened" ? "（伸ばして描画）" : ""),
        dashed: !(direction && distance && !converted && clamped === null),
        converted,
        clamped,
        authorMismatch: false,
        statements: [
          ...pair.directions.map((fact) => fact.statement.text),
          ...pair.distances.map((fact) => fact.statement.text),
          ...pair.adjacent.map((statement) => statement.text),
        ],
      });
    }
    for (const edge of islandWithins) {
      edges.push({ u: edge.parent, v: edge.child, quality: 0, bearingDegrees: null, length: NEAR_LENGTH, placement: "near", settles: false });
      edges.push({ u: edge.child, v: edge.parent, quality: 0, bearingDegrees: null, length: NEAR_LENGTH, placement: "near", settles: false });
    }

    // 起点：作者が選んだ場所、無ければ関係のいちばん多い場所（同数なら台帳の順）
    const degree = (id: string): number =>
      islandPairs.filter((pair) => pair.a === id || pair.b === id).length +
      islandWithins.filter((edge) => edge.child === id || edge.parent === id).length;
    const origin =
      options.origin && memberIds.has(options.origin)
        ? options.origin
        : members.reduce((best, location) =>
            degree(location.id) > degree(best.id) ? location : best
          ).id;

    const local = new Map<string, { x: number; y: number; placement: SketchPlacement; settled: boolean }>();
    local.set(origin, { x: 0, y: 0, placement: "origin", settled: true });
    while (local.size < members.length) {
      // 置いた点から置いていない点への辺のうち、いちばん強いもの（同じ強さなら台帳の順）
      let best: PlacementEdge | null = null;
      for (const edge of edges) {
        if (!local.has(edge.u) || local.has(edge.v)) continue;
        if (
          !best ||
          edge.quality > best.quality ||
          (edge.quality === best.quality &&
            ((order.get(edge.v) ?? 0) < (order.get(best.v) ?? 0) ||
              ((order.get(edge.v) ?? 0) === (order.get(best.v) ?? 0) &&
                (order.get(edge.u) ?? 0) < (order.get(best.u) ?? 0))))
        ) {
          best = edge;
        }
      }
      if (!best) break; // 島の作りから起きないが、無限に回らないように
      const from = local.get(best.u)!;
      const length = best.length ?? UNKNOWN_DISTANCE_LENGTH;
      const degrees =
        best.bearingDegrees ?? freeBearing(from, length, [...local.values()]);
      const radians = (degrees * Math.PI) / 180;
      local.set(best.v, {
        x: from.x + Math.sin(radians) * length,
        y: from.y - Math.cos(radians) * length,
        placement: best.placement,
        settled: from.settled && best.settles,
      });
    }

    // 島を横に並べる（島どうしの距離には意味が無い。凡例に書く）
    const xs = [...local.values()].map((point) => point.x);
    const ys = [...local.values()].map((point) => point.y);
    const offsetX = cursorX - Math.min(...xs);
    const offsetY = -Math.min(...ys);
    cursorX = Math.max(...xs) + offsetX + ISLAND_GAP;
    for (const location of members) {
      const point = local.get(location.id);
      if (!point) continue;
      points.set(location.id, {
        id: location.id,
        name: location.name,
        x: point.x + offsetX,
        y: point.y + offsetY,
        island: islandIndex,
        placement: point.placement,
        settled: point.settled,
        authorPlaced: false,
      });
    }
  });

  /* 5. 作者が置いた位置を重ねる（計算は作者の位置を見ずに済ませてある） */
  const shelf: Array<{ id: string; name: string }> = [];
  for (const location of locations) {
    const position = location.sketchPosition;
    const point = points.get(location.id);
    if (position) {
      points.set(location.id, {
        id: location.id,
        name: location.name,
        x: position.x,
        y: position.y,
        island: point?.island ?? -1,
        placement: "author",
        settled: false,
        authorPlaced: true,
      });
    } else if (!point) {
      shelf.push({ id: location.id, name: location.name });
    }
  }

  /* 6. 線の仕上げ：食い違い・作者の位置との食い違い */
  for (const line of lines) {
    const conflict = conflicts.find(
      (entry) =>
        entry.kind !== "cycle" &&
        entry.locationIds.includes(line.from) &&
        entry.locationIds.includes(line.to)
    );
    if (conflict) line.conflict = { index: conflict.index, label: conflict.label };
    const from = points.get(line.from);
    const to = points.get(line.to);
    if (!from || !to || !(from.authorPlaced || to.authorPlaced)) continue;
    const pair = pairs.get(JSON.stringify([line.from, line.to]));
    const direction = pair ? latest(pair.directions) : null;
    if (!direction) continue;
    const actual = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
    line.authorMismatch = angleGap(actual, direction.bearing * 45) > MISMATCH_DEGREES;
  }

  /* 7. 含む関係の枠（輪になったものは描かない） */
  const frames = buildFrames(
    withins.filter((edge) => !(inCycle.has(edge.child) && inCycle.has(edge.parent))),
    points,
    byId,
    order
  );

  const orderedPoints = locations
    .map((location) => points.get(location.id))
    .filter((point): point is SketchPoint => point !== undefined);
  return {
    points: orderedPoints,
    lines,
    frames,
    shelf,
    islands: islandRoots.length,
    conversions: anyConversion ? TRAVEL_SPEEDS_KMH : null,
    conflicts,
    unused,
    bounds: boundsOf(orderedPoints, frames),
  };
}

/* ── 部品 ─────────────────────────────────────────── */

function statementOf(location: Location, relation: LocationRelation, text: string): LocationStatement {
  return { locationId: location.id, locationName: location.name, relation, text, fromRegion: false };
}

/** あとの話の記述（話数の無いものは先の話より前に数える。同じなら台帳で後ろ） */
function latest<T extends { chapter: number; order: number }>(facts: readonly T[]): T | null {
  return facts.reduce<T | null>(
    (best, fact) =>
      !best || fact.chapter > best.chapter || (fact.chapter === best.chapter && fact.order > best.order)
        ? fact
        : best,
    null
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 島でいちばん多く使われている乗り物（同数なら速さの表の順） */
function dominantOf(pairs: readonly Pair[]): string {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    for (const fact of pair.distances) {
      if (fact.mode) counts.set(fact.mode, (counts.get(fact.mode) ?? 0) + 1);
    }
  }
  let best = "";
  for (const { mode } of TRAVEL_SPEEDS_KMH) {
    if ((counts.get(mode) ?? 0) > (counts.get(best) ?? 0)) best = mode;
  }
  return best;
}

function lineLabel(
  direction: DirectionFact | null,
  distance: DistanceFact | null,
  adjacent: boolean
): string {
  const distanceText = distance?.statement.relation.value ?? null;
  if (direction && distanceText) return `${DIRECTION_NAMES[direction.ownStep]}・${distanceText}`;
  if (direction) return `${DIRECTION_NAMES[direction.ownStep]}・距離未定`;
  if (distanceText) return `${distanceText}・向き未定`;
  return adjacent ? "隣接" : "";
}

/** 「食い違い：第3話／第7話」。話数の無い記述は作者が書いた関係 */
function conflictLabel(statements: readonly LocationStatement[]): string {
  const chapters = statements.map((statement) =>
    statement.relation.chapters.length > 0 ? Math.min(...statement.relation.chapters) : null
  );
  if (chapters.every((chapter) => chapter === null)) return "食い違い：作者が書いた関係どうし";
  const named = [...new Set(chapters.filter((chapter): chapter is number => chapter !== null))]
    .sort((a, b) => a - b)
    .map((chapter) => `第${chapter}話`);
  if (chapters.some((chapter) => chapter === null)) named.push("作者が書いた関係");
  return `食い違い：${named.join("／")}`;
}

/** 向きの決まらない点を置く向き。**置いた点からいちばん離れる向き**（同じなら東から時計回り） */
function freeBearing(
  from: { x: number; y: number },
  length: number,
  placed: ReadonlyArray<{ x: number; y: number }>
): number {
  let bestDegrees = 90;
  let bestRoom = -1;
  for (let step = 0; step < 16; step += 1) {
    const degrees = (90 + step * 22.5) % 360;
    const radians = (degrees * Math.PI) / 180;
    const x = from.x + Math.sin(radians) * length;
    const y = from.y - Math.cos(radians) * length;
    const room = Math.min(...placed.map((point) => Math.hypot(point.x - x, point.y - y)));
    if (room > bestRoom + 1e-9) {
      bestRoom = room;
      bestDegrees = degrees;
    }
  }
  return bestDegrees;
}

function angleGap(left: number, right: number): number {
  const raw = Math.abs(((left - right) % 360) + 360) % 360;
  return Math.min(raw, 360 - raw);
}

/**
 * 含む関係の枠。親の枠は、親の点と中にある場所すべて（孫も）を囲む。
 * 外側の枠ほど余白を広げ、内側の枠と重ならないようにする。
 */
function buildFrames(
  withins: ReadonlyArray<{ child: string; parent: string }>,
  points: ReadonlyMap<string, SketchPoint>,
  byId: ReadonlyMap<string, Location>,
  order: ReadonlyMap<string, number>
): SketchFrame[] {
  const children = new Map<string, Set<string>>();
  for (const edge of withins) {
    const set = children.get(edge.parent) ?? new Set<string>();
    set.add(edge.child);
    children.set(edge.parent, set);
  }
  const descendants = (id: string, seen = new Set<string>()): Set<string> => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child) || child === id) continue;
      seen.add(child);
      descendants(child, seen);
    }
    return seen;
  };
  /** 中にある枠の段数（中に枠が無ければ0） */
  const height = (id: string, path = new Set<string>()): number => {
    if (path.has(id)) return 0;
    const next = new Set(path).add(id);
    let deepest = 0;
    for (const child of children.get(id) ?? []) {
      if (children.has(child)) deepest = Math.max(deepest, 1 + height(child, next));
    }
    return deepest;
  };
  const depthOf = (id: string, path = new Set<string>()): number => {
    let deepest = 0;
    for (const edge of withins) {
      if (edge.child !== id || path.has(edge.parent)) continue;
      deepest = Math.max(deepest, 1 + depthOf(edge.parent, new Set(path).add(id)));
    }
    return deepest;
  };

  const frames: SketchFrame[] = [];
  const parents = [...children.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const id of parents) {
    const members = [id, ...descendants(id)]
      .map((member) => points.get(member))
      .filter((point): point is SketchPoint => point !== undefined);
    if (members.length < 2) continue;
    const padding = FRAME_PADDING * (1 + height(id));
    const xs = members.map((point) => point.x);
    const ys = members.map((point) => point.y);
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    frames.push({
      id,
      name: byId.get(id)?.name ?? id,
      x: minX,
      y: minY,
      width: Math.max(...xs) + padding - minX,
      height: Math.max(...ys) + padding - minY,
      depth: depthOf(id),
    });
  }
  // 外側の枠を先に描く（内側の枠が上に重なる）
  return frames.sort((a, b) => a.depth - b.depth);
}

function boundsOf(
  points: readonly SketchPoint[],
  frames: readonly SketchFrame[]
): LocationSketch["bounds"] {
  const xs = [
    ...points.map((point) => point.x),
    ...frames.flatMap((frame) => [frame.x, frame.x + frame.width]),
  ];
  const ys = [
    ...points.map((point) => point.y),
    ...frames.flatMap((frame) => [frame.y, frame.y + frame.height]),
  ];
  if (xs.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

