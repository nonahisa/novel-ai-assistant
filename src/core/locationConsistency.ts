import {
  describeLocationRelation,
  normalizeLocationName,
  type Location,
  type LocationRelation,
} from "../models/location";
import { relocateQuote } from "./relocateQuote";

/**
 * 場所の位置関係の機械照合（設計書6.93.4）。
 *
 * **関係の矛盾は、LLM に訊くまでもなく機械で決まる。** 含む関係の循環、
 * 方角の非対称、距離の食い違いの3つだけを、設定資料の場所の記録
 * （`relations` と `region`）から照らす。AIは使わないので検算も通さない
 * （6.88.6 の「機械照合は確定的」と同じ）。
 *
 * **やらないこと**（6.93.9）：
 * - 推測で関係を補わない。台帳で相手が引けない関係、読めない方角・距離は比べない
 * - 隣接と距離を突き合わせない（隣接の粒度は作品で違い、誤検出になる）
 * - 地図を組まない。比べるのは「同じ2か所について書かれた記述どうし」だけ
 *
 * VS Code にも `node:` にも依存しない——拡張機能の画面（`checkContradictions`
 * の隣）と MCP の `novel.detect`（feature: contradiction）が**同じ判定を通る**
 * ように、ここ1か所に置く。
 */

/* ── 方角 ─────────────────────────────────────────── */

/**
 * 8方位（0＝北から時計回りに45°ずつ）。
 *
 * 言い換え（「東北」＝北東）もここで受ける。表に無い言い方（「上流」
 * 「山側」）は比べない——向きが決まらないものを決めたことにしない。
 */
const DIRECTION_STEPS: Readonly<Record<string, number>> = {
  北: 0,
  北東: 1,
  東北: 1,
  東: 2,
  南東: 3,
  東南: 3,
  南: 4,
  南西: 5,
  西南: 5,
  西: 6,
  北西: 7,
  西北: 7,
};

/**
 * 方角の食い違いとして許す幅（8方位の段数）。
 *
 * **隣り合う方位（45°）は矛盾にしない**（設計書6.93.4）。「東」と「北東」は
 * 書き手の大づかみの差で、どちらも正しく読める。90°以上ずれたら挙げる。
 */
export const DIRECTION_TOLERANCE_STEPS = 1;

/**
 * 方角を8方位の段（0〜7）にする。読めなければ null（比べない）。
 *
 * 「真北」の「真」、「南側」「西の方」の添えは落とす。それ以外の
 * 自由文は読まない。
 */
export function normalizeDirection(value: string | null): number | null {
  if (!value) return null;
  const compact = value.replace(/[\s　]/gu, "");
  const matched = compact.match(
    /^真?(北東|東北|南東|東南|南西|西南|北西|西北|北|東|南|西)(?:側|の方|の方角|方|方角|方面)?$/u
  );
  if (!matched) return null;
  return DIRECTION_STEPS[matched[1]] ?? null;
}

/** 2つの方位の差（段数。0〜4） */
function directionGap(left: number, right: number): number {
  const raw = Math.abs(left - right) % 8;
  return Math.min(raw, 8 - raw);
}

const DIRECTION_NAMES = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];

/* ── 距離 ─────────────────────────────────────────── */

/**
 * 距離の食い違いとして挙げる倍率。
 *
 * **大づかみの言い方どうしを、細かく比べない。** 「徒歩10分」と「徒歩15分」、
 * 「八時間」と「一日」は書き手の幅の内である。5倍以上離れたら
 * （「徒歩10分」と「徒歩1時間」）、同じ道の話としては読めない。
 */
export const DISTANCE_RATIO_THRESHOLD = 5;

/**
 * 乗り物の言い方と、比べるときの種別。
 *
 * **乗り物が違えば比べない**（設計書6.93.4）。馬車と馬も分ける——速さが違う。
 * 乗り物の書かれていない距離（「三日の距離」）は種別 `""` で、徒歩とも
 * 比べない（何で行くのかを推測で決めない）。
 */
const TRAVEL_MODES: ReadonlyArray<{ pattern: RegExp; mode: string }> = [
  { pattern: /^(?:徒歩で?|歩いて|歩きで)/u, mode: "徒歩" },
  { pattern: /^馬車で/u, mode: "馬車" },
  { pattern: /^馬で/u, mode: "馬" },
  { pattern: /^船で/u, mode: "船" },
  { pattern: /^車で/u, mode: "車" },
];

const UNIT_MINUTES: Readonly<Record<string, number>> = {
  分: 1,
  時間: 60,
  日: 24 * 60,
};

/**
 * 距離・所要時間を「種別と分」にする。読めなければ null（比べない）。
 *
 * **記録は本文の言い方のまま**で、正規化はここ（照合の直前）でだけ行う
 * （設計書6.93.2）。読むのは「〈乗り物〉〈約〉N〈分／時間／日〉〈半〉〈ほど〉
 * 〈の距離〉」の形と「半日」だけ。「数日」「すぐそこ」、知らない乗り物
 * （「飛竜で一日」）は読まない——数にできないものを数にしない。
 */
export function normalizeTravel(
  value: string | null
): { mode: string; minutes: number } | null {
  if (!value) return null;
  let rest = value
    .replace(/[\s　]/gu, "")
    .replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/gu, ".");

  let mode = "";
  for (const candidate of TRAVEL_MODES) {
    const matched = rest.match(candidate.pattern);
    if (matched) {
      mode = candidate.mode;
      rest = rest.slice(matched[0].length);
      break;
    }
  }

  const matched = rest.match(
    /^(?:約|およそ|だいたい|ほぼ)?(\d+(?:\.\d+)?|[〇一二三四五六七八九十百]+|半)(分|時間|日)(半)?(?:ほど|くらい|ぐらい|程度|ばかり|余り|あまり)?(?:の距離|の道のり|の道程|かかる|のところ|の所)?$/u
  );
  if (!matched) return null;
  const amount = matched[1] === "半" ? 0.5 : parseAmount(matched[1]);
  if (amount === null || amount <= 0) return null;
  // 「半分」は量ではなく割合なので読まない
  if (matched[1] === "半" && matched[2] === "分") return null;
  const half = matched[3] ? 0.5 : 0;
  // 「半日半」のような重ねは読まない
  if (matched[1] === "半" && half > 0) return null;
  return { mode, minutes: (amount + half) * UNIT_MINUTES[matched[2]] };
}

const KANJI_DIGITS: Readonly<Record<string, number>> = {
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 算用数字か漢数字（百まで）を数にする。読めなければ null */
function parseAmount(text: string): number | null {
  if (/^\d/u.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  // 位取りの無い並び（「二〇」）
  if (!/[十百]/u.test(text)) {
    let value = 0;
    for (const char of text) value = value * 10 + KANJI_DIGITS[char];
    return value;
  }
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char === "百" || char === "十") {
      const unit = char === "百" ? 100 : 10;
      total += (current === 0 ? 1 : current) * unit;
      current = 0;
    } else {
      current = current * 10 + KANJI_DIGITS[char];
    }
  }
  return total + current;
}

/* ── 照合 ─────────────────────────────────────────── */

export type LocationInconsistencyKind = "cycle" | "direction" | "distance";

/** 食い違いを作っている記述の1つ */
export interface LocationStatement {
  locationId: string;
  locationName: string;
  relation: LocationRelation;
  /** 「学校は港の北」「港は港町の中（地域の欄）」 */
  text: string;
  /**
   * 地域の欄（`region`）を「中」として読み替えたもの。**記録は変えていない**
   * ——作者が直す先が関係の欄ではなく地域の欄だと分かるように印を付ける
   */
  fromRegion: boolean;
}

export interface LocationInconsistency {
  kind: LocationInconsistencyKind;
  /** 作者に見せる1行（何と何が食い違っているか） */
  summary: string;
  /** 食い違いを作っている記述（循環は輪の全部、方角・距離は2つ） */
  statements: LocationStatement[];
}

/**
 * 台帳で相手を引く。引けなければ null（推測で補わない）。
 *
 * **略図（`locationSketch.ts`）も同じ1本を使う。** 照合と略図で相手の引き方が
 * 違うと、照合では比べなかった関係を略図だけが線で結ぶことになる。
 */
export interface LocationResolver {
  resolve(name: string, targetId: string | null): string | null;
  nameOf(key: string): string;
}

export function buildLocationResolver(locations: readonly Location[]): LocationResolver {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const byName = new Map<string, Set<string>>();
  for (const location of locations) {
    for (const name of [location.name, ...location.aliases]) {
      const key = normalizeLocationName(name);
      if (!key) continue;
      const ids = byName.get(key) ?? new Set<string>();
      ids.add(location.id);
      byName.set(key, ids);
    }
  }
  return {
    resolve(name, targetId) {
      if (targetId && byId.has(targetId)) return targetId;
      const ids = byName.get(normalizeLocationName(name));
      // **2か所に当たる名前は引かない。** どちらの話か決められない
      if (!ids || ids.size !== 1) return null;
      return [...ids][0];
    },
    nameOf(key) {
      return byId.get(key)?.name ?? key;
    },
  };
}

function statementOf(location: Location, relation: LocationRelation): LocationStatement {
  return {
    locationId: location.id,
    locationName: location.name,
    relation,
    text: `${location.name}は${describeLocationRelation(relation)}`,
    fromRegion: false,
  };
}

/**
 * 地域の欄を「中」の関係として読む。**台帳に同じ名前の場所があるときだけ**
 * （設計書6.93.2）。無ければ読まない——地域の欄は自由文で、場所の名前とは
 * 限らない。
 */
export function regionStatement(
  location: Location,
  resolver: LocationResolver
): { statement: LocationStatement; targetKey: string } | null {
  const region = location.region?.trim();
  if (!region) return null;
  const targetKey = resolver.resolve(region, null);
  if (!targetKey || targetKey === location.id) return null;
  const relation: LocationRelation = {
    kind: "within",
    target: region,
    targetId: targetKey,
    value: null,
    chapters: [],
    evidence: null,
    authorLocked: true,
  };
  return {
    statement: {
      locationId: location.id,
      locationName: location.name,
      relation,
      text: `${location.name}は${describeLocationRelation(relation)}（地域の欄）`,
      fromRegion: true,
    },
    targetKey,
  };
}

/**
 * 台帳の場所の関係から、機械で決まる食い違いを挙げる。
 *
 * 並びは循環 → 方角 → 距離、その中は台帳の並び。同じ入力なら同じ順で返す
 * （画面の番号と置き場の番号がずれないように）。
 */
export function findLocationInconsistencies(
  locations: readonly Location[]
): LocationInconsistency[] {
  const resolver = buildLocationResolver(locations);
  return [
    ...findCycles(locations, resolver),
    ...findPairConflicts(locations, resolver),
  ];
}

/** 含む関係の輪。強く繋がった塊（2か所以上）を1件にまとめる */
function findCycles(
  locations: readonly Location[],
  resolver: LocationResolver
): LocationInconsistency[] {
  /** 辺（from→to）ごとに、最初に見つけた記述。関係の欄を地域の欄より先に採る */
  const edges = new Map<string, Map<string, LocationStatement>>();
  const addEdge = (from: string, to: string, statement: LocationStatement) => {
    const out = edges.get(from) ?? new Map<string, LocationStatement>();
    if (!out.has(to)) out.set(to, statement);
    edges.set(from, out);
  };
  for (const location of locations) {
    for (const relation of location.relations ?? []) {
      if (relation.kind !== "within") continue;
      const to = resolver.resolve(relation.target, relation.targetId);
      if (!to || to === location.id) continue;
      addEdge(location.id, to, statementOf(location, relation));
    }
  }
  for (const location of locations) {
    const region = regionStatement(location, resolver);
    if (region) addEdge(location.id, region.targetKey, region.statement);
  }

  const order = locations.map((location) => location.id);
  const components = stronglyConnected(order, (id) => [...(edges.get(id)?.keys() ?? [])]);
  const found: LocationInconsistency[] = [];
  for (const component of components) {
    if (component.length < 2) continue;
    const members = new Set(component);
    const statements: LocationStatement[] = [];
    for (const from of order) {
      if (!members.has(from)) continue;
      for (const [to, statement] of edges.get(from) ?? []) {
        if (members.has(to)) statements.push(statement);
      }
    }
    const names = order.filter((id) => members.has(id)).map((id) => resolver.nameOf(id));
    found.push({
      kind: "cycle",
      summary: `含む関係が輪になっています（${names.join("・")}が互いの中にあることになります）`,
      statements,
    });
  }
  return found;
}

/** Tarjan の強連結成分。並びは `order` の出てくる順に揃える */
function stronglyConnected(
  order: readonly string[],
  next: (id: string) => string[]
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];

  const visit = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const to of next(id)) {
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id)!, index.get(to)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      result.push(component);
    }
  };
  for (const id of order) if (!index.has(id)) visit(id);
  const position = new Map(order.map((id, i) => [id, i]));
  return result
    .map((component) =>
      [...component].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
    )
    .sort((a, b) => (position.get(a[0]) ?? 0) - (position.get(b[0]) ?? 0));
}

/**
 * 同じ2か所について書かれた方角・距離の記述を突き合わせる。
 *
 * **往復を同じ組として扱う。** 「学校は港の北」（学校の記録）と
 * 「港は学校の北」（港の記録）は、同じ2か所の位置を別々の側から
 * 書いたものである。方角は向きを揃えて（港の記録の側を反転して）比べ、
 * 距離はそのまま比べる。
 */
function findPairConflicts(
  locations: readonly Location[],
  resolver: LocationResolver
): LocationInconsistency[] {
  interface Entry {
    statement: LocationStatement;
    /** 組の前（並びの早いほう）から見た、後ろの方位。方角のときだけ */
    bearing?: number;
    travel?: { mode: string; minutes: number };
  }
  const pairs = new Map<string, { first: string; second: string; direction: Entry[]; distance: Entry[] }>();
  const position = new Map(locations.map((location, i) => [location.id, i]));

  for (const location of locations) {
    for (const relation of location.relations ?? []) {
      if (relation.kind !== "direction" && relation.kind !== "distance") continue;
      const target = resolver.resolve(relation.target, relation.targetId);
      // 台帳に無い相手には、相手側の記述も無い。比べるものが無い
      if (!target || target === location.id) continue;
      const selfFirst = (position.get(location.id) ?? 0) < (position.get(target) ?? 0);
      const first = selfFirst ? location.id : target;
      const second = selfFirst ? target : location.id;
      const key = JSON.stringify([first, second]);
      const pair = pairs.get(key) ?? { first, second, direction: [], distance: [] };
      pairs.set(key, pair);
      const statement = statementOf(location, relation);

      if (relation.kind === "direction") {
        const step = normalizeDirection(relation.value);
        if (step === null) continue;
        // 記述は「この場所は相手から見て〈方角〉」。組の前から見た後ろの方位に揃える
        const bearing = selfFirst ? (step + 4) % 8 : step;
        pair.direction.push({ statement, bearing });
      } else {
        const travel = normalizeTravel(relation.value);
        if (!travel) continue;
        pair.distance.push({ statement, travel });
      }
    }
  }

  const directionFound: LocationInconsistency[] = [];
  const distanceFound: LocationInconsistency[] = [];
  for (const pair of pairs.values()) {
    const firstName = resolver.nameOf(pair.first);
    const secondName = resolver.nameOf(pair.second);
    eachPair(pair.direction, (left, right) => {
      if (directionGap(left.bearing!, right.bearing!) <= DIRECTION_TOLERANCE_STEPS) return;
      directionFound.push({
        kind: "direction",
        summary:
          `${firstName}と${secondName}の方角が食い違っています` +
          `（${firstName}から見て${secondName}が${DIRECTION_NAMES[left.bearing!]}／` +
          `${DIRECTION_NAMES[right.bearing!]}）`,
        statements: [left.statement, right.statement],
      });
    });
    eachPair(pair.distance, (left, right) => {
      if (left.travel!.mode !== right.travel!.mode) return;
      const longer = Math.max(left.travel!.minutes, right.travel!.minutes);
      const shorter = Math.min(left.travel!.minutes, right.travel!.minutes);
      if (longer < shorter * DISTANCE_RATIO_THRESHOLD) return;
      distanceFound.push({
        kind: "distance",
        summary:
          `${firstName}と${secondName}の距離が食い違っています` +
          `（${left.statement.relation.value}／${right.statement.relation.value}）`,
        statements: [left.statement, right.statement],
      });
    });
  }
  return [...directionFound, ...distanceFound];
}

function eachPair<T>(items: readonly T[], visit: (left: T, right: T) => void): void {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) visit(items[i], items[j]);
  }
}

/* ── 本文の行へ置く ───────────────────────────────── */

/** 置き場所を探す本文の1ファイル（合本でもファイルの全文を渡す） */
export interface EpisodeText {
  filePath: string;
  text: string;
  chapterStart: number | null;
  chapterEnd: number | null;
}

/**
 * 提案パネルの「矛盾」へ渡す1件（区分「場所」）。
 *
 * **修正案を持たない。** どちらの記述が正しいかは作者にしか決められず、
 * 本文は書き換えない（実装ルール1）。
 */
export interface LocationContradictionIssue {
  kind: LocationInconsistencyKind;
  filePath: string;
  /** 飛ぶ先（1始まり） */
  line: number;
  /** 飛ぶ先の引用。本文に見つからなかったときは記述の1行 */
  excerpt: string;
  category: "場所";
  /** もう一方の記述（話数と引用つき。循環は残り全部を「／」で） */
  settingSays: string;
  /** 飛ぶ先の記述（話数と引用つき） */
  textSays: string;
  note: string;
  /** 機械で決めたものなので常に high */
  confidence: "high";
}

export interface PlacedLocationInconsistencies {
  issues: LocationContradictionIssue[];
  /**
   * 本文のどこにも置けなかったもの（根拠も話数も無い、作者が書いた関係どうし）。
   * **黙って捨てない。** 呼び出し側が件数を知らせ、中身をログへ残す
   */
  unplaced: LocationInconsistency[];
}

interface StatementPlace {
  filePath: string;
  line: number;
  chapter: number | null;
  /** 引用が本文に見つかったか（false は話の頭に置いただけ） */
  exact: boolean;
  /** 範囲で絞ったときの、範囲の中か */
  inScope: boolean;
}

/**
 * 食い違いを本文の行へ置く。
 *
 * **飛び先は、引用が本文に見つかった記述のうち、あとの話のもの。**
 * 先に書いた設定に、あとの話が食い違った形として見せる。範囲で絞ったとき
 * （`scopeFiles`）は範囲の中の記述を先に選び、範囲に1つも触れない食い違いは
 * 出さない（その話を見ていない作者に、別の話の食い違いを出さない）。
 *
 * 引用が本文から消えていても話数が分かれば、その話の頭へ置く
 * （単話プロットの照合の「話の頭へ飛ばす」と同じ）。どちらも無ければ
 * `unplaced` に返す。
 */
export function placeLocationInconsistencies(
  found: readonly LocationInconsistency[],
  episodes: readonly EpisodeText[],
  options: { scopeFiles?: ReadonlySet<string> } = {}
): PlacedLocationInconsistencies {
  const issues: LocationContradictionIssue[] = [];
  const unplaced: LocationInconsistency[] = [];
  const scope = options.scopeFiles;

  for (const inconsistency of found) {
    const placed = inconsistency.statements.map((statement) => ({
      statement,
      place: placeStatement(statement, episodes, scope),
    }));
    const candidates = placed
      .filter((entry) => entry.place !== null)
      .filter((entry) => !scope || entry.place!.inScope);
    if (candidates.length === 0) {
      // **範囲の外の話にだけ置けるものは出さない**（「置けなかった」とも言わない）。
      // どの話にも置けないもの（作者が書いた関係どうし）は、範囲にかかわらず返す
      if (placed.every((entry) => entry.place === null)) {
        unplaced.push(inconsistency);
      }
      continue;
    }
    const anchor = candidates.reduce((best, entry) => {
      const a = best.place!;
      const b = entry.place!;
      if (a.exact !== b.exact) return b.exact ? entry : best;
      return (b.chapter ?? -1) > (a.chapter ?? -1) ? entry : best;
    });
    const others = placed.filter((entry) => entry !== anchor);
    issues.push({
      kind: inconsistency.kind,
      filePath: anchor.place!.filePath,
      line: anchor.place!.line,
      excerpt:
        anchor.place!.exact && anchor.statement.relation.evidence
          ? cleanQuote(anchor.statement.relation.evidence)
          : anchor.statement.text,
      category: "場所",
      settingSays: others.map((entry) => describeStatement(entry.statement)).join("／"),
      textSays: describeStatement(anchor.statement),
      note: `${inconsistency.summary}。AIを使わず、設定資料の位置関係を照らしました。`,
      confidence: "high",
    });
  }
  return { issues, unplaced };
}

function placeStatement(
  statement: LocationStatement,
  episodes: readonly EpisodeText[],
  scope: ReadonlySet<string> | undefined
): StatementPlace | null {
  const chapters = statement.relation.chapters;
  const covers = (episode: EpisodeText, chapter: number) =>
    episode.chapterStart !== null &&
    chapter >= episode.chapterStart &&
    chapter <= (episode.chapterEnd ?? episode.chapterStart);
  const inScope = (filePath: string) => !scope || scope.has(filePath);

  const evidence = statement.relation.evidence;
  if (evidence) {
    const quote = cleanQuote(evidence);
    // 話数の合う話から探し、無ければ全話から探す（話数の付け違いで見失わない）
    const preferred = episodes.filter((episode) =>
      chapters.some((chapter) => covers(episode, chapter))
    );
    for (const pool of [preferred, episodes]) {
      for (const episode of pool) {
        const line = relocateQuote(episode.text, quote, 1);
        if (line !== undefined) {
          return {
            filePath: episode.filePath,
            line,
            chapter: chapterAt(episode, chapters),
            exact: true,
            inScope: inScope(episode.filePath),
          };
        }
      }
    }
  }
  for (const chapter of chapters) {
    const episode = episodes.find((candidate) => covers(candidate, chapter));
    if (episode) {
      return {
        filePath: episode.filePath,
        line: 1,
        chapter,
        exact: false,
        inScope: inScope(episode.filePath),
      };
    }
  }
  return null;
}

function chapterAt(episode: EpisodeText, chapters: readonly number[]): number | null {
  const inside = chapters.filter(
    (chapter) =>
      episode.chapterStart !== null &&
      chapter >= episode.chapterStart &&
      chapter <= (episode.chapterEnd ?? episode.chapterStart)
  );
  if (inside.length > 0) return Math.min(...inside);
  return episode.chapterStart;
}

/** 前後の括弧と末尾の句点を落とす（抽出の検算 `contiguousQuote` と同じ扱い） */
function cleanQuote(evidence: string): string {
  return evidence
    .trim()
    .replace(/^[「『"'“”‘’（(\s…]+/u, "")
    .replace(/[」』"'“”‘’）)\s…。．.！？!?]+$/u, "");
}

/** 「第3話：学校は港の北（「学校は港の北の高台にある」）」 */
export function describeStatement(statement: LocationStatement): string {
  const chapters = statement.relation.chapters;
  const head = chapters.length > 0 ? `第${Math.min(...chapters)}話：` : "";
  const quote = statement.relation.evidence
    ? `（「${cleanQuote(statement.relation.evidence)}」）`
    : statement.fromRegion
      ? ""
      : "（作者が書いた関係）";
  return `${head}${statement.text}${quote}`;
}

/* ── 本文に置けない食い違い ───────────────────────── */

/**
 * 根拠も話数も無い食い違い（作者が書いた関係どうし）を、提案パネルの
 * 「場所の資料を開く」行にするための1件（設計書6.93.9 の順6）。
 *
 * **本文の行を持たない。** 飛ぶ先の本文が無いので、押すとその場所の資料が開く。
 * 以前は件数を通知に出して中身をログへ残すだけで、作者は資料のどこを見れば
 * よいのか探す必要があった。
 */
export interface LocationRecordIssue {
  kind: LocationInconsistencyKind;
  /** 開く資料（食い違いを作っている記述のうち、先頭の記述を持つ場所） */
  locationId: string;
  locationName: string;
  /** その場所の資料のファイル。呼ぶ側（台帳の置き場を知っている側）が入れる */
  filePath: string;
  summary: string;
  /** もう一方の記述（循環は残り全部を「／」で） */
  settingSays: string;
  /** 開く資料の記述 */
  textSays: string;
}

/**
 * 置けなかった食い違いを、資料を開く1件にする。
 *
 * 開くのは**先頭の記述を持つ場所**（並びは台帳の順なので、毎回同じ場所になる）。
 * 地域の欄から読んだ記述しか無いとき（循環が地域の欄だけで閉じている）も、
 * 直す先はその場所の資料なので同じ扱いでよい。
 */
export function recordIssueOf(
  inconsistency: LocationInconsistency,
  filePathOf: (locationId: string) => string
): LocationRecordIssue {
  const [anchor, ...others] = inconsistency.statements;
  return {
    kind: inconsistency.kind,
    locationId: anchor.locationId,
    locationName: anchor.locationName,
    filePath: filePathOf(anchor.locationId),
    summary: inconsistency.summary,
    settingSays: others.map(describeStatement).join("／"),
    textSays: describeStatement(anchor),
  };
}
