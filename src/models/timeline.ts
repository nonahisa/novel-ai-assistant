import {
  invalid,
  objectValue,
  optionalBoolean,
  optionalEnum,
  optionalNullableString,
  optionalObjectArray,
  optionalString,
  requireNonEmptyString,
} from "./jsonValidation";

/**
 * 作中の時間の記録。
 *
 * **話数（書かれた順）と時系列（作中の順）は別物である。** 回想が挟まれば
 * 第3話が第1話より前の出来事になる。この2つを1本の軸で持つと、
 * 「第10話まで読んだ読者が知っていること」と「作中のこの時点での姿」の
 * どちらかが必ず狂う。そこで話数はファイル側（`appearedChapters` 等）に
 * 残したまま、作中の時間だけをここで持つ。
 *
 * ---
 *
 * ## なぜ「系統」が要るのか
 *
 * 群像劇のように視点が複数あるだけなら、系統は1本で足りる。同時に起きた
 * 出来事は「並びで隣り合わせる」のではなく **同じ時期を共有させる** ことで
 * 表せるからである（`episodes` から `timepoints` へは多対一）。
 * A視点の第3話とB視点の第8話が同じ出来事の裏表なら、両方を同じ時期に置く。
 *
 * 系統を分ける必要があるのは、**時間そのものが枝分かれする場合**だけである。
 *   - 並行する世界（流れる速さが違う異世界など）
 *   - 夢・幻（見た内容は本編で実際には起きていない）
 *   - IF編・分岐（ある時点から別の筋へ分かれる。本編とは両立しない）
 *   - 劇中劇（作中で語られる別の物語）
 *
 * このうち夢・IF編・劇中劇は「もう1つの時計」ではなく **本編ではない筋** で
 * ある。区別が要るのは `canonical` のためで、これが false の系統の出来事を
 * 本編の人物一覧や年表へ混ぜてはならない。IF編で死んだ人物が本編の資料で
 * 死んでいたら資料として使えない。
 *
 * ---
 *
 * ## 何も設定しなければ、すべてが本編1本
 *
 * `lines` が空の作品では、すべての話が本編・実在として扱われる
 * （`isCanonicalEpisode` を参照）。系統を使わない作品に設定を強いない。
 */

/** 系統の種別 */
export type TimelineLineKind =
  | "main"
  | "parallel"
  | "branch"
  | "dream"
  | "inner";

export const TIMELINE_LINE_KINDS: readonly TimelineLineKind[] = [
  "main",
  "parallel",
  "branch",
  "dream",
  "inner",
];

export const LINE_KIND_LABELS: Record<TimelineLineKind, string> = {
  main: "本編",
  parallel: "並行する時間",
  branch: "IF・分岐",
  dream: "夢・幻",
  inner: "劇中劇",
};

/**
 * 種別ごとの既定の「本編の事実か」。
 *
 * 並行世界は流れる時間こそ別だが、その世界で実際に起きたことなので実在とする。
 * 夢・IF編・劇中劇は実際には起きていない。
 *
 * **ただし作者が上書きできる。** 夢だと思わせて実は本当にあった記憶、という
 * 作品はいくらでもある。決め打ちにすると、そういう作品で使えなくなる。
 */
const CANONICAL_BY_KIND: Record<TimelineLineKind, boolean> = {
  main: true,
  parallel: true,
  branch: false,
  dream: false,
  inner: false,
};

export interface TimelineLine {
  /** `ln_001` の形式 */
  id: string;
  /** 作者が付ける名前（「本編」「IF・もし文佳が生きていたら」「太志の夢」） */
  label: string;
  kind: TimelineLineKind;
  /**
   * 本編の事実として扱うか。
   * false の系統の出来事は、本編の人物一覧・年表・設定資料に混ぜない。
   */
  canonical: boolean;
  /**
   * 分岐元の時期ID。**別の系統の時期を指す。**
   *
   * 種別によって意味が変わる。
   *   - branch（IF編）: ここまでの人物の状態を引き継ぐ分かれ目
   *   - dream / inner: その夢を見た（その話が語られた）位置を示すだけで、
   *     状態は引き継がない
   *   - main: 常に null（本編はどこからも分岐しない）
   *
   * 分からない・決めていない場合は null でよい。
   */
  branchFrom: string | null;
  note: string;
}

/**
 * 作中の時期。
 *
 * **点ではなく幅のあるまとまり**として扱う。群像劇では「Aが港を出たのと
 * Bが手紙を受け取ったの、どちらが先か」を決めていないことが普通にある。
 * 点にすると、そこで作者へ順序の決断を迫ることになる。
 * 同じ時期に複数の話をぶら下げれば、**中の順序は決めないでおける。**
 * 順序が要るのは時期どうしの間だけである。
 *
 * 並び順は `timepoints` 配列の順そのものとする。番号を振ると、
 * 間に1つ挿し込むたびに振り直しになり、手で直すときに面倒になる。
 */
export interface Timepoint {
  /** `tp_001` の形式 */
  id: string;
  /** どの系統に属するか */
  lineId: string;
  /** 作者が付ける名前（「十年前・火事の夜」「王都陥落からの三日間」） */
  label: string;
  /**
   * 作中の日時（「王暦312年春」）。**任意。**
   * 暦を持たない作品も多く、必須にすると大半の作品で埋まらない。
   * 年表に必要なのは順序だけなので、書ける作品だけが書けばよい。
   */
  absolute: string | null;
  note: string;
}

/** 話（ファイル）と時期の対応 */
export interface TimelineEpisode {
  /**
   * 作品フォルダからの相対パス。
   *
   * 話数ではなくファイルで結ぶのは、話数を付けられないファイル
   * （`chapterStart` が null になるもの）があるためである。
   * 区切りは `/` に揃える。GitHubを介して別の端末と行き来するため
   * （設計書5.5）、`\` のまま保存すると環境をまたいで一致しなくなる。
   */
  filePath: string;
  timepointId: string;
  note: string;
}

export interface Timeline {
  schemaVersion: string;
  lines: TimelineLine[];
  timepoints: Timepoint[];
  episodes: TimelineEpisode[];
}

export const TIMELINE_SCHEMA_VERSION = "0.1";

export function emptyTimeline(): Timeline {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    lines: [],
    timepoints: [],
    episodes: [],
  };
}

/** 種別に対する既定の実在扱い。作者が明示していない場合に使う */
export function defaultCanonical(kind: TimelineLineKind): boolean {
  return CANONICAL_BY_KIND[kind];
}

export function nextLineId(existing: TimelineLine[]): string {
  return `ln_${String(maxSuffix(existing.map((line) => line.id), "ln") + 1).padStart(3, "0")}`;
}

export function nextTimepointId(existing: Timepoint[]): string {
  return `tp_${String(maxSuffix(existing.map((point) => point.id), "tp") + 1).padStart(3, "0")}`;
}

function maxSuffix(ids: string[], prefix: string): number {
  let max = 0;
  const pattern = new RegExp(`^${prefix}_(\\d+)$`);
  for (const id of ids) {
    const matched = id.match(pattern);
    if (!matched) continue;
    const value = parseInt(matched[1], 10);
    if (value > max) max = value;
  }
  return max;
}

/**
 * 話のパスを比較用に揃える。
 *
 * Windowsでは `\` で渡ってくるが、保存してあるのは `/` 区切りである。
 * 揃えないと、同じ話が「設定されていない」と判定されて本編に落ちる。
 */
export function normalizeEpisodePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function mainLine(timeline: Timeline): TimelineLine | undefined {
  return timeline.lines.find((line) => line.kind === "main");
}

export function findLine(
  timeline: Timeline,
  lineId: string
): TimelineLine | undefined {
  return timeline.lines.find((line) => line.id === lineId);
}

export function findTimepoint(
  timeline: Timeline,
  timepointId: string
): Timepoint | undefined {
  return timeline.timepoints.find((point) => point.id === timepointId);
}

/** その系統の時期を、並び順のまま返す */
export function timepointsOfLine(
  timeline: Timeline,
  lineId: string
): Timepoint[] {
  return timeline.timepoints.filter((point) => point.lineId === lineId);
}

/** 同じ時期に置かれた話をすべて返す。群像劇で同じ出来事の裏表を辿るのに使う */
export function episodesOfTimepoint(
  timeline: Timeline,
  timepointId: string
): TimelineEpisode[] {
  return timeline.episodes.filter(
    (episode) => episode.timepointId === timepointId
  );
}

export function timepointOfEpisode(
  timeline: Timeline,
  filePath: string
): Timepoint | undefined {
  const key = normalizeEpisodePath(filePath);
  const episode = timeline.episodes.find(
    (entry) => normalizeEpisodePath(entry.filePath) === key
  );
  if (!episode) return undefined;
  return findTimepoint(timeline, episode.timepointId);
}

/**
 * その話がどの系統のものか。
 *
 * **対応づけが無い話は本編とみなす。** 作者は例外（夢・IF編）だけを
 * 設定すればよく、大多数を占める本編の話を1つずつ登録しなくて済む。
 */
export function lineOfEpisode(
  timeline: Timeline,
  filePath: string
): TimelineLine | undefined {
  const point = timepointOfEpisode(timeline, filePath);
  if (!point) return mainLine(timeline);
  return findLine(timeline, point.lineId) ?? mainLine(timeline);
}

/**
 * その話の出来事を本編の事実として扱ってよいか。
 *
 * 「第N話時点の人物一覧」や年表は、これが false の話を除いて組み立てる。
 * 系統をまだ作っていない作品では常に true になり、これまでどおり動く。
 */
export function isCanonicalEpisode(
  timeline: Timeline,
  filePath: string
): boolean {
  const line = lineOfEpisode(timeline, filePath);
  return line ? line.canonical : true;
}

/**
 * 作者が編集できるJSONを検証する。
 * 壊れていれば例外を投げ、勝手に直さない（設計書の方針）。
 */
export function parseTimeline(raw: unknown): Timeline {
  const value = objectValue(raw, "timeline");
  optionalString(value.schemaVersion, "schemaVersion");

  const lines =
    optionalObjectArray(value.lines, "lines", (entry, path) => {
      requireNonEmptyString(entry.id, `${path}.id`);
      if (!/^ln_\d+$/.test(entry.id as string)) invalid(`${path}.id`);
      requireNonEmptyString(entry.label, `${path}.label`);
      optionalEnum(entry.kind, `${path}.kind`, TIMELINE_LINE_KINDS);
      optionalBoolean(entry.canonical, `${path}.canonical`);
      optionalNullableString(entry.branchFrom, `${path}.branchFrom`);
      optionalString(entry.note, `${path}.note`);

      const kind = (entry.kind as TimelineLineKind | undefined) ?? "main";
      const branchFrom =
        (entry.branchFrom as string | null | undefined) ?? null;
      // 本編はどこからも分岐しない。指定されていたら、系統の種別と
      // 分岐元のどちらが作者の意図か決められないので止める
      if (kind === "main" && branchFrom !== null) {
        invalid(`${path}.branchFrom（本編は分岐元を持てません）`);
      }
      return {
        id: entry.id as string,
        label: entry.label as string,
        kind,
        canonical: (entry.canonical as boolean | undefined) ?? defaultCanonical(kind),
        branchFrom,
        note: (entry.note as string | undefined) ?? "",
      };
    }) ?? [];

  const timepoints =
    optionalObjectArray(value.timepoints, "timepoints", (entry, path) => {
      requireNonEmptyString(entry.id, `${path}.id`);
      if (!/^tp_\d+$/.test(entry.id as string)) invalid(`${path}.id`);
      requireNonEmptyString(entry.lineId, `${path}.lineId`);
      requireNonEmptyString(entry.label, `${path}.label`);
      optionalNullableString(entry.absolute, `${path}.absolute`);
      optionalString(entry.note, `${path}.note`);
      return {
        id: entry.id as string,
        lineId: entry.lineId as string,
        label: entry.label as string,
        absolute: (entry.absolute as string | null | undefined) ?? null,
        note: (entry.note as string | undefined) ?? "",
      };
    }) ?? [];

  const episodes =
    optionalObjectArray(value.episodes, "episodes", (entry, path) => {
      requireNonEmptyString(entry.filePath, `${path}.filePath`);
      requireNonEmptyString(entry.timepointId, `${path}.timepointId`);
      optionalString(entry.note, `${path}.note`);
      return {
        filePath: normalizeEpisodePath(entry.filePath as string),
        timepointId: entry.timepointId as string,
        note: (entry.note as string | undefined) ?? "",
      };
    }) ?? [];

  const timeline: Timeline = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    lines,
    timepoints,
    episodes,
  };
  validateReferences(timeline);
  return timeline;
}

/**
 * IDの重複と参照切れを確かめる。
 *
 * ここで止めるのは、参照が壊れたまま読み込むと **黙って本編扱いになる**
 * ためである（`lineOfEpisode` は行き先を見失うと本編を返す）。
 * IF編の話が本編に混ざるのは、資料としていちばん困る壊れ方なので、
 * 気づかないまま進ませない。
 */
function validateReferences(timeline: Timeline): void {
  const lineIds = new Set<string>();
  for (const line of timeline.lines) {
    if (lineIds.has(line.id)) invalid(`lines（id「${line.id}」が重複）`);
    lineIds.add(line.id);
  }

  const mains = timeline.lines.filter((line) => line.kind === "main");
  if (mains.length > 1) {
    invalid(
      `lines（本編が${mains.length}本あります。本編は1本にしてください）`
    );
  }

  const pointIds = new Set<string>();
  for (const point of timeline.timepoints) {
    if (pointIds.has(point.id)) invalid(`timepoints（id「${point.id}」が重複）`);
    pointIds.add(point.id);
    if (!lineIds.has(point.lineId)) {
      invalid(`timepoints（「${point.id}」の系統「${point.lineId}」がありません）`);
    }
  }

  const paths = new Set<string>();
  for (const episode of timeline.episodes) {
    if (paths.has(episode.filePath)) {
      invalid(`episodes（「${episode.filePath}」が2回出てきます）`);
    }
    paths.add(episode.filePath);
    if (!pointIds.has(episode.timepointId)) {
      invalid(
        `episodes（「${episode.filePath}」の時期「${episode.timepointId}」がありません）`
      );
    }
  }

  validateBranches(timeline);
}

/** 分岐元が実在し、自分自身へ戻ってこないことを確かめる */
function validateBranches(timeline: Timeline): void {
  const pointById = new Map(timeline.timepoints.map((p) => [p.id, p]));

  for (const line of timeline.lines) {
    if (line.branchFrom === null) continue;
    const origin = pointById.get(line.branchFrom);
    if (!origin) {
      invalid(`lines（「${line.id}」の分岐元「${line.branchFrom}」がありません）`);
    }
    // 自分の系統の時期から分岐すると、その系統の始まりが自分自身になる
    if (origin.lineId === line.id) {
      invalid(`lines（「${line.id}」が自分自身から分岐しています）`);
    }
  }

  // 分岐元をたどって元の系統へ戻ってくると、年表を組むとき無限に回る
  for (const line of timeline.lines) {
    const visited = new Set<string>([line.id]);
    let current: TimelineLine | undefined = line;
    while (current?.branchFrom) {
      const origin = pointById.get(current.branchFrom);
      if (!origin) break;
      if (visited.has(origin.lineId)) {
        invalid(`lines（分岐が輪になっています: 「${origin.lineId}」）`);
      }
      visited.add(origin.lineId);
      current = timeline.lines.find((entry) => entry.id === origin.lineId);
    }
  }
}
