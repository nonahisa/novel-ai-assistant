import type { Character } from "../models/character";
import type { Foreshadow } from "../models/foreshadow";
import type { ChapterSynopsisSet } from "../models/synopsis";
import { findSynopsis } from "../models/synopsis";
import type { EpisodeFile } from "../models/types";
import type { Timeline, TimelineLineKind } from "../models/timeline";
import { findLine, lineOfEpisode, timepointOfEpisode } from "../models/timeline";
import { episodeTitle, formatChapterLabel } from "./episodeLabel";
import { toTimelineEpisodePath } from "./timelineEdit";
import type { WorkFormatKey } from "./workFormat";

/**
 * 年表の組み立て（設計書6.39.1）。
 *
 * **AIは使わない。** 材料はすべて既にある記録——走査した話、人物の
 * `changes`・能力・呼称、各話あらすじ、伏線台帳、作中の時間である。
 * ここがするのは「話ごとに束ね直す」ことだけで、新しい判断はしない。
 *
 * VS Code に依らない純粋関数にしてある（`core/relationGraph.ts` と同じ
 * 考え方）。画面は受け取った行を描くだけで、組み立てには関わらない。
 *
 * **キャッシュしない**（6.39.1）。材料はどれも手元のJSONで、
 * 読み直しても軽い。古い年表を見せるほうが害が大きい。
 */

/** 話数を読み取れない話の見出し。**想像で番号を振らない** */
export const UNKNOWN_CHAPTER_LABEL = "話数なし";

/** 時期を決めていない話をまとめる段の見出し */
export const UNASSIGNED_SECTION_LABEL = "時期未設定";

/** 本編の段の見出し。系統を作っていない作品でもこう出る */
export const CANONICAL_SECTION_LABEL = "本編";

/**
 * 出来事の種類。**画面の絞り込みの単位でもある。**
 *
 * 呼称の始まりと終わりを分けてあるのは、「いつからそう呼び始めたか」と
 * 「いつ呼ばなくなったか」が別の出来事だからである（同じ行に混ぜると、
 * 関係が変わった話を見つけられない）。
 */
export type ChronicleEventKind =
  | "change"
  | "ability"
  | "address_start"
  | "address_end"
  | "foreshadow_planted"
  | "foreshadow_resolved";

export const CHRONICLE_EVENT_KINDS: readonly ChronicleEventKind[] = [
  "change",
  "ability",
  "address_start",
  "address_end",
  "foreshadow_planted",
  "foreshadow_resolved",
];

export const CHRONICLE_EVENT_LABELS: Record<ChronicleEventKind, string> = {
  change: "変化",
  ability: "能力",
  address_start: "呼び始め",
  address_end: "呼び終わり",
  foreshadow_planted: "伏線を張る",
  foreshadow_resolved: "伏線の回収",
};

export interface ChronicleEvent {
  kind: ChronicleEventKind;
  /** 誰の出来事か。伏線のように人物に紐づかないものは持たない */
  characterId?: string;
  characterName?: string;
  /** 作者がそのまま読める日本語。画面もMarkdownもこれを出す */
  text: string;
}

export interface ChronicleAppearance {
  id: string;
  name: string;
}

export interface ChronicleTimepoint {
  id: string;
  label: string;
  absolute: string | null;
  lineId: string;
}

export interface ChronicleLine {
  id: string;
  label: string;
  kind: TimelineLineKind;
  canonical: boolean;
}

/** 年表の1行＝1話 */
export interface ChronicleRow {
  /** 開くときに使う場所（絶対パス、またはURIの文字列） */
  filePath: string;
  fileName: string;
  /**
   * 作品フォルダーからの相対パス（`/` 区切り）。
   * 時期の対応づけの鍵であり、時期を決める操作にもこれを渡す（6.18）。
   */
  workPath: string;
  chapter: number | null;
  /**
   * 終わりの話数。
   *
   * **合本（1ファイルに複数話）があるため範囲で持つ。** 開始話だけを見て
   * 出来事を配ると、219話ぶんが1つも載らないファイルができる。
   */
  chapterEnd: number | null;
  /** 「第3話」「プロローグ」。読み取れなければ `UNKNOWN_CHAPTER_LABEL` */
  chapterLabel: string;
  /** サブタイトル。見出しと重なる部分は落としてある */
  title: string | null;
  /** 純文字数 */
  chars: number;
  synopsis: string | null;
  appeared: ChronicleAppearance[];
  events: ChronicleEvent[];
  timepoint: ChronicleTimepoint | null;
  line: ChronicleLine | null;
}

/**
 * 年表の段。時系列順のときだけ複数になる。
 *
 * **`canonical: false` の系統を本編の段に混ぜない**（6.39.5）。
 * IF編で死んだ人物が本編の年表に載っていたら、資料として使えない。
 */
export interface ChronicleSection {
  label: string;
  /** その段の系統。「時期未設定」の段は持たない */
  line: ChronicleLine | null;
  kind: "canonical" | "alternate" | "unassigned";
  rows: ChronicleRow[];
}

/** 同じ時期の話をまとめたもの。見出しを立てる単位 */
export interface ChronicleGroup {
  /** 時期の見出し。時期が付いていなければ空 */
  label: string;
  timepointId: string | null;
  rows: ChronicleRow[];
}

/**
 * 走査した話のうち、年表が使うところ。
 *
 * `scanWork` の結果（`EpisodeFile[]`）をそのまま渡せる形にしてある。
 * 全部を要求しないのは、試験で作る話を軽くするためである。
 */
export type ChronicleEpisode = Pick<
  EpisodeFile,
  | "filePath"
  | "fileName"
  | "chapterStart"
  | "chapterEnd"
  | "subtitle"
  | "metaTitle"
  | "kind"
  | "counts"
  | "date"
  | "dateSeq"
>;

export interface ChronicleOptions {
  /** 作品フォルダー。時期の対応づけ（相対パス）を引くのに要る */
  workRoot?: string;
  /** SNS記事では「第3話」ではなく「投稿3」と並べる */
  format?: WorkFormatKey;
}

/**
 * 人物の項目名を、作者が読める言葉にする。
 *
 * **ここにしか無い表である。** `characterDiff.ts` にも似た一覧があるが、
 * あちらは「値の取り出し方」と組で持っており、項目のキーから引けない。
 * 知らないキー（作者が足した項目）はそのまま出す——推測で言い換えると、
 * 作者が付けた名前と画面の言葉が食い違う。
 */
const FIELD_LABELS: Record<string, string> = {
  name: "名前",
  summary: "紹介",
  gender: "性別",
  affiliation: "所属",
  reading: "読み",
  role: "役割",
  personality: "性格",
  appearance: "外見",
  age: "年齢",
  height: "身長",
  build: "体格",
  hair: "髪",
  eyes: "目",
  skin: "肌",
  distinctive: "特徴",
  clothing: "服装",
};

/**
 * 話ごとに材料を束ねる。並びは**話数順**（既定の並び）。
 *
 * @param synopses 各話あらすじ。無ければ null
 * @param timeline 作中の時間。無ければ null（時期の列は空になる）
 */
export function buildChronicle(
  episodes: readonly ChronicleEpisode[],
  characters: readonly Character[],
  synopses: ChapterSynopsisSet | null,
  foreshadows: readonly Foreshadow[],
  timeline: Timeline | null,
  options: ChronicleOptions = {}
): ChronicleRow[] {
  const rows = sortByChapter(episodes).map((episode) =>
    buildRow(episode, synopses, timeline, options)
  );

  // 話数から行を引く。**合本（1ファイルに複数話）は範囲で受ける**——
  // 開始話だけを見ると、219話ぶんの出来事が1つも載らない
  const place = (chapter: number | null): ChronicleRow | undefined => {
    if (chapter === null) return undefined;
    return rows.find((row) => containsChapter(row, chapter));
  };

  for (const character of characters) {
    addAppearances(place, character);
    addChangeEvents(place, character);
    addAbilityEvents(place, character);
    addAddressEvents(place, character);
  }
  for (const foreshadow of foreshadows) {
    addForeshadowEvents(place, foreshadow);
  }

  return rows;
}

/**
 * 時系列順に並べ替え、段に分ける（6.39.2）。
 *
 * 本編（`canonical: true` の系統）が主の段。IF・夢・劇中劇は系統ごとに
 * 別の段。**時期の付いていない話は「時期未設定」の段に集める**——
 * 黙って本編の末尾へ足すと、作者が決めていない順序を決めたことになる。
 *
 * 同じ時期の中は話数順にする。時期は幅のあるまとまりなので、
 * 中の順序は決めないでおける（6.18）。
 */
export function sortByTimeline(
  rows: readonly ChronicleRow[],
  timeline: Timeline | null
): ChronicleSection[] {
  const order = new Map<string, number>();
  timeline?.timepoints.forEach((point, index) => order.set(point.id, index));

  const canonical: ChronicleRow[] = [];
  const alternates = new Map<string, ChronicleRow[]>();
  const unassigned: ChronicleRow[] = [];

  for (const row of rows) {
    const point = row.timepoint;
    if (!point || !timeline) {
      unassigned.push(row);
      continue;
    }
    const line = findLine(timeline, point.lineId);
    // 系統を引けない時期は、**本編へ落とさず**時期未設定へ回す。
    // 行き先を見失ったものが黙って本編に混ざるのが、いちばん困る壊れ方
    if (!line) {
      unassigned.push(row);
      continue;
    }
    if (line.canonical) {
      canonical.push(row);
      continue;
    }
    const bucket = alternates.get(line.id);
    if (bucket) bucket.push(row);
    else alternates.set(line.id, [row]);
  }

  const byTime = (left: ChronicleRow, right: ChronicleRow): number => {
    const a = order.get(left.timepoint?.id ?? "") ?? Number.MAX_SAFE_INTEGER;
    const b = order.get(right.timepoint?.id ?? "") ?? Number.MAX_SAFE_INTEGER;
    if (a !== b) return a - b;
    return compareByChapter(left, right);
  };

  const sections: ChronicleSection[] = [];
  if (canonical.length > 0) {
    sections.push({
      label: CANONICAL_SECTION_LABEL,
      line: null,
      kind: "canonical",
      rows: [...canonical].sort(byTime),
    });
  }

  // 段の並びは `lines` 配列の順。作者が並べた順をそのまま出す
  for (const line of timeline?.lines ?? []) {
    if (line.canonical) continue;
    const bucket = alternates.get(line.id);
    if (!bucket || bucket.length === 0) continue;
    sections.push({
      label: line.label,
      line: toChronicleLine(line),
      kind: "alternate",
      rows: [...bucket].sort(byTime),
    });
  }

  if (unassigned.length > 0) {
    sections.push({
      label: UNASSIGNED_SECTION_LABEL,
      line: null,
      kind: "unassigned",
      rows: [...unassigned].sort(compareByChapter),
    });
  }

  return sections;
}

/**
 * 同じ時期の話を、続きのまとまりにする。見出しを立てる単位。
 *
 * **並べ替えはしない。** 渡された順のまま、時期が変わったところで切る。
 * ここで並べ替えると、`sortByTimeline` が決めた順と食い違う。
 */
export function groupByTimepoint(
  rows: readonly ChronicleRow[]
): ChronicleGroup[] {
  const groups: ChronicleGroup[] = [];
  for (const row of rows) {
    const id = row.timepoint?.id ?? null;
    const last = groups[groups.length - 1];
    if (last && last.timepointId === id) {
      last.rows.push(row);
      continue;
    }
    groups.push({
      label: row.timepoint ? timepointLabel(row.timepoint) : "",
      timepointId: id,
      rows: [row],
    });
  }
  return groups;
}

/** 時期の見出し。日付表記があれば添える（任意項目なので無いのがふつう） */
export function timepointLabel(timepoint: ChronicleTimepoint): string {
  return timepoint.absolute
    ? `${timepoint.label}（${timepoint.absolute}）`
    : timepoint.label;
}

export interface ChronicleFilter {
  /** その人物の登場・変化・能力・呼称だけにする（＝成長の年表） */
  characterId?: string;
  /** 出す出来事の種類。省略すると絞らない */
  kinds?: readonly ChronicleEventKind[];
}

/**
 * 年表を絞る（6.39.2）。
 *
 * **種類で絞ったときは、その出来事が無い話を落とす。** 絞る目的は
 * 「その出来事のある話だけを見ること」なので、全話が並んだままでは
 * 絞った意味がない。人物で絞ったときは登場しているだけの話も残す——
 * 成長の年表は「居た話」も含めて読むものである。
 */
export function filterChronicle(
  rows: readonly ChronicleRow[],
  filter: ChronicleFilter
): ChronicleRow[] {
  const { characterId, kinds } = filter;
  const kindSet = kinds ? new Set<ChronicleEventKind>(kinds) : null;

  const result: ChronicleRow[] = [];
  for (const row of rows) {
    let appeared = row.appeared;
    let events = row.events;

    if (characterId) {
      appeared = appeared.filter((entry) => entry.id === characterId);
      events = events.filter((event) => event.characterId === characterId);
      if (appeared.length === 0 && events.length === 0) continue;
    }
    if (kindSet) {
      events = events.filter((event) => kindSet.has(event.kind));
      if (events.length === 0) continue;
    }

    result.push({ ...row, appeared, events });
  }
  return result;
}

/**
 * 年表に載っている人物（絞り込みの選択肢）。
 *
 * **行から作る。** 資料の全員を並べると、まだ本文に出ていない人物まで
 * 選べてしまい、選んだ先が必ず空になる。
 */
export function chronicleCharacters(
  rows: readonly ChronicleRow[]
): ChronicleAppearance[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const entry of row.appeared) seen.set(entry.id, entry.name);
    for (const event of row.events) {
      if (event.characterId && event.characterName) {
        seen.set(event.characterId, event.characterName);
      }
    }
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, "ja"));
}

// ---------------------------------------------------------------------------
// 組み立ての細部
// ---------------------------------------------------------------------------

function buildRow(
  episode: ChronicleEpisode,
  synopses: ChapterSynopsisSet | null,
  timeline: Timeline | null,
  options: ChronicleOptions
): ChronicleRow {
  // 題から見出しと重なる部分を落とすため、素の見出しのまま渡す
  // （`episodeLabel.ts` の約束。通し忘れると「第1話　第1話　…」になる）
  const rawLabel = formatChapterLabel(episode, options.format);
  const workPath = toTimelineEpisodePath(options.workRoot, episode.filePath);
  const point = timeline ? timepointOfEpisode(timeline, workPath) : undefined;
  const line = timeline ? lineOfEpisode(timeline, workPath) : undefined;
  const synopsis = synopses
    ? findSynopsis(synopses, episode.fileName, episode.chapterStart)
    : undefined;

  return {
    filePath: episode.filePath,
    fileName: episode.fileName,
    workPath,
    chapter: episode.chapterStart,
    chapterEnd: episode.chapterEnd,
    chapterLabel: rawLabel || UNKNOWN_CHAPTER_LABEL,
    title: episodeTitle(episode, rawLabel),
    chars: episode.counts.net,
    synopsis: synopsis?.synopsis ?? null,
    appeared: [],
    events: [],
    timepoint: point
      ? {
          id: point.id,
          label: point.label,
          absolute: point.absolute,
          lineId: point.lineId,
        }
      : null,
    line: line ? toChronicleLine(line) : null,
  };
}

function toChronicleLine(line: {
  id: string;
  label: string;
  kind: TimelineLineKind;
  canonical: boolean;
}): ChronicleLine {
  return {
    id: line.id,
    label: line.label,
    kind: line.kind,
    canonical: line.canonical,
  };
}

/** その行が受け持つ話数の範囲に入っているか（合本は範囲で受ける） */
function containsChapter(row: ChronicleRow, chapter: number): boolean {
  if (row.chapter === null) return false;
  const end = row.chapterEnd ?? row.chapter;
  return chapter >= row.chapter && chapter <= end;
}

type Place = (chapter: number | null) => ChronicleRow | undefined;

function addAppearances(place: Place, character: Character): void {
  for (const chapter of character.appearedChapters) {
    const row = place(chapter);
    if (!row) continue;
    // 合本では複数の話数が同じ行を指す。同じ人を何度も並べない
    if (row.appeared.some((entry) => entry.id === character.id)) continue;
    row.appeared.push({ id: character.id, name: character.name });
  }
}

/**
 * 作中の変化（6.18の `changes`）。
 *
 * **`chapters` が複数なら、いちばん早い話に載せる。** その値が最初に
 * 書かれた話が、変わった話だからである。話数の無い変化（「それ以前」）は
 * 載せる先が無いので出さない——ただし、次の変化の「元の値」としては使う。
 */
function addChangeEvents(place: Place, character: Character): void {
  const byField = new Map<string, Character["changes"]>();
  for (const change of character.changes) {
    const bucket = byField.get(change.field);
    if (bucket) bucket.push(change);
    else byField.set(change.field, [change]);
  }

  for (const [field, changes] of byField) {
    const ordered = [...changes].sort(
      (left, right) => earliest(left.chapters) - earliest(right.chapters)
    );
    const label = FIELD_LABELS[field] ?? field;

    ordered.forEach((change, index) => {
      const chapter = change.chapters.length > 0 ? earliest(change.chapters) : null;
      const row = place(chapter);
      if (!row) return;
      const before = index > 0 ? ordered[index - 1].value : null;
      row.events.push({
        kind: "change",
        characterId: character.id,
        characterName: character.name,
        text: before
          ? `${label}：${before} → ${change.value}`
          : `${label}：${change.value}`,
      });
    });
  }
}

function addAbilityEvents(place: Place, character: Character): void {
  for (const ability of character.abilities) {
    const row = place(ability.firstChapter);
    if (!row) continue;
    row.events.push({
      kind: "ability",
      characterId: character.id,
      characterName: character.name,
      text: `能力『${ability.name}』を習得`,
    });
  }
}

/**
 * 呼称の始まりと終わり。
 *
 * **同じ相手への複数の呼び方は、まとめない**（この作品の決まり）。
 * 呼び方ごとに1つの出来事として出す。
 */
function addAddressEvents(place: Place, character: Character): void {
  for (const term of character.addressTerms) {
    for (const form of term.forms) {
      const started = place(form.firstChapter);
      if (started) {
        started.events.push({
          kind: "address_start",
          characterId: character.id,
          characterName: character.name,
          text: `${term.targetName}を『${form.term}』と呼び始める`,
        });
      }
      const ended = place(form.lastChapter);
      if (ended) {
        ended.events.push({
          kind: "address_end",
          characterId: character.id,
          characterName: character.name,
          text: `${term.targetName}を『${form.term}』と呼ばなくなる`,
        });
      }
    }
  }
}

/**
 * 伏線（6.35）。
 *
 * **回収は `status` が「回収済み」のときだけ出す。** 「意図して開けたまま」
 * にも話数が残っていることがあり、そのまま出すと閉じていない伏線を
 * 閉じたように見せてしまう。
 */
function addForeshadowEvents(place: Place, foreshadow: Foreshadow): void {
  const planted = place(foreshadow.plantedChapter);
  if (planted) {
    planted.events.push({
      kind: "foreshadow_planted",
      text: `伏線『${foreshadow.label}』を張る`,
    });
  }
  if (foreshadow.status !== "resolved") return;
  const resolved = place(foreshadow.resolvedChapter);
  if (resolved) {
    resolved.events.push({
      kind: "foreshadow_resolved",
      text: `伏線『${foreshadow.label}』を回収`,
    });
  }
}

/** 記録の中でいちばん早い話数。空なら「それ以前」として最古に置く */
function earliest(chapters: readonly number[]): number {
  if (chapters.length === 0) return Number.MIN_SAFE_INTEGER;
  return Math.min(...chapters);
}

/** 話数順。**話数を読み取れない話は末尾**（推測で番号を振らない） */
function sortByChapter(
  episodes: readonly ChronicleEpisode[]
): ChronicleEpisode[] {
  return [...episodes].sort((left, right) => {
    if (left.chapterStart === null && right.chapterStart === null) {
      return left.fileName.localeCompare(right.fileName, "ja");
    }
    if (left.chapterStart === null) return 1;
    if (right.chapterStart === null) return -1;
    if (left.chapterStart !== right.chapterStart) {
      return left.chapterStart - right.chapterStart;
    }
    return left.fileName.localeCompare(right.fileName, "ja");
  });
}

function compareByChapter(left: ChronicleRow, right: ChronicleRow): number {
  if (left.chapter === null && right.chapter === null) {
    return left.fileName.localeCompare(right.fileName, "ja");
  }
  if (left.chapter === null) return 1;
  if (right.chapter === null) return -1;
  if (left.chapter !== right.chapter) return left.chapter - right.chapter;
  return left.fileName.localeCompare(right.fileName, "ja");
}
