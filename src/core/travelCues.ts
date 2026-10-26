import type { StoryFact } from "../models/storyFact";
import {
  normalizeLocationName,
  type Location,
  type LocationRelation,
} from "../models/location";
import { orderFacts } from "./attributeIntervals";
import {
  locateChunkLine,
  segmentAtLine,
  withLineNumbers,
  type Chunk,
} from "./chunker";
import type { TravelCueStats } from "./factContradiction";
import {
  buildTravelMaterial,
  type FactPlace,
  type TravelMaterial,
} from "./factContradictionFlow";
import { normalizeForComparison } from "./groundedEvidence";
import { hashText } from "./hash";
import { buildLocationResolver, normalizeTravel } from "./locationConsistency";
import {
  isQuotedParagraph,
  isSceneBreakLine,
  orderSceneClockEpisodes,
  parseSmallNumber,
  sceneTimeMarkerKey,
  type SceneClockEpisode,
  type SceneTimeMarker,
} from "./sceneClock";
import { validateLocationRelations } from "./settingsExtractionValidation";
import { containmentOf, type PendingTravelDistance } from "./travelTable";
import {
  TRAVEL_DISTANCE_CUE_WORDS,
  TRAVEL_DISTANCE_EVIDENCE_MAX_CHARS,
  TRAVEL_DISTANCE_EXAMPLE,
  TRAVEL_DISTANCE_EXTRACT_SCHEMA,
  TRAVEL_DISTANCE_EXTRACT_SYSTEM_PROMPT,
  TRAVEL_DISTANCE_EXTRACT_TEMPERATURE,
  TRAVEL_DISTANCE_EXTRACT_VERSION,
  TRAVEL_DISTANCE_MAX_ITEMS,
  buildTravelDistanceExtractPrompt,
} from "../prompts/travelDistanceExtract";
import {
  SCENE_TIME_CUE_EVIDENCE_MAX_CHARS,
  SCENE_TIME_CUE_EXAMPLE,
  SCENE_TIME_CUE_HEAD_PARAGRAPHS,
  SCENE_TIME_CUE_KINDS,
  SCENE_TIME_CUE_PREVIOUS_PARAGRAPHS,
  SCENE_TIME_CUE_SCHEMA,
  SCENE_TIME_CUE_SYSTEM_PROMPT,
  SCENE_TIME_CUE_TEMPERATURE,
  SCENE_TIME_CUE_VERSION,
  buildSceneTimeCuePrompt,
  type SceneTimeCueKind,
} from "../prompts/sceneTimeCue";
import { LOCATION_RELATION_VALUE_MAX_CHARS } from "../models/location";

/**
 * 移動の照合で、時の手がかり（P-52）と本文の距離（P-51）を AI で抜く（設計書6.88.13）。
 *
 * 第1段（AIを使わない段。`factContradictionFlow.ts` の `buildTravelMaterial`）は、
 * 場所の記録に距離が無い作品・段落の頭に決まった語の無い作品では何も比べられない
 * （作者の19話では所要時間の表が0組）。ここは、その穴を AI の**書き写し**で埋める段。
 *
 * - **P-51**：場所の名前と道のりの語を含むチャンクだけを送り、場所どうしの所要時間を
 *   書き写させる。検算を通ったものは、**承認待ちのまま**その回の照合に使い
 *   （作者の判断②。根拠に「承認待ち」と出す）、設定資料へは**提案**として置く
 * - **P-52**：時計で比べられない所在の組（同じ人物・別の場所・表に1日以上）の
 *   あいだで、時の鎖が切れた場面の頭だけを訊く（母艦の判断⑤：上限30回）
 *
 * 照合そのもの・どれが速いかの選び方・時計の数え方は、すべてコードが行う（実装ルール3）。
 *
 * **拡張機能（`features/checkFactContradictions.ts`）と MCP
 * （`mcp/tools/factContradiction.ts`）は、ここの `runTravelCues` を呼ぶだけ。**
 * AIの呼び方（プロバイダ・控え・中止）だけを `ask` で受け取る。写しを作ると
 * 製品と測定がずれる（6.88.10）。VS Code にも `node:` にも依存しない。
 */

/** P-52 を回す上限（母艦の判断⑤。処理量を抑えるため） */
export const SCENE_TIME_CUE_LIMIT = 30;

/** 控えの鍵（P-51）。**内容ハッシュ＋プロバイダ＋モデル＋版**（実装ルール4） */
export function travelDistanceCacheKey(input: { providerId: string; model: string }) {
  return {
    feature: "travel_distance_extract",
    promptVersion: TRAVEL_DISTANCE_EXTRACT_VERSION,
    providerId: input.providerId,
    model: input.model,
  };
}

/** 控えの鍵（P-52） */
export function sceneTimeCueCacheKey(input: { providerId: string; model: string }) {
  return {
    feature: "scene_time_cue",
    promptVersion: SCENE_TIME_CUE_VERSION,
    providerId: input.providerId,
    model: input.model,
  };
}

/* ── P-51 本文の距離 ─────────────────────────────────────── */

/** プロンプトへ渡す場所の一覧（「王都（別名: リヴェルス）」） */
export function locationNamesForPrompt(locations: readonly Location[]): string[] {
  return locations.map((location) =>
    location.aliases.length > 0
      ? `${location.name}（別名: ${location.aliases.join("、")}）`
      : location.name
  );
}

/**
 * P-51 を送るチャンクか。台帳の場所の名前か別名を含み、道のりの語のどれかを含むもの
 * （設計書6.88.13）。名前の無いチャンクを送っても、一覧の場所どうしの距離は返らない
 */
export function isTravelDistanceChunk(
  chunk: Pick<Chunk, "text">,
  locations: readonly Location[]
): boolean {
  const text = chunk.text;
  const named = locations.some((location) =>
    [location.name, ...location.aliases].some((name) => name.trim() && text.includes(name))
  );
  if (!named) return false;
  return TRAVEL_DISTANCE_CUE_WORDS.some((word) => text.includes(word));
}

/**
 * P-51 の控えに使うチャンクの指紋。**場所の一覧も混ぜる**——一覧はプロンプトに
 * 入るので、場所を足すと同じ本文でも答えが変わりうる
 */
export function travelDistanceChunkId(chunk: Pick<Chunk, "hash">, locations: readonly Location[]): string {
  return hashText(`${chunk.hash}\u0000${locationNamesForPrompt(locations).join("\u0000")}`);
}

/** 検算を通った距離1件 */
export interface AcceptedTravelDistance {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  /** 本文の言い方のまま（「馬で三日」） */
  value: string;
  evidence: string;
  /** 本文の場所（元のファイルの行） */
  filePath: string;
  line: number;
  chapter: number | null;
  /** 台詞（「」の中）に書かれた距離か（作者の判断④：提案はするが理由に「台詞」と書く） */
  dialogue: boolean;
}

/** 距離を捨てた理由（検算の6種＋形の崩れ） */
export type TravelDistanceRejection =
  /** 形が崩れている（欄が無い・文字列でない） */
  | "malformed"
  /** 見本の値がそのまま返ってきた */
  | "example_echo"
  /** 端のどちらかが台帳の場所に引けない */
  | "unknown_place"
  /** 両端が同じ場所 */
  | "same_place"
  /** 片方がもう片方の中にある（港と港町） */
  | "nested"
  /** 値が所要時間として読めない（「数日」「すぐそこ」） */
  | "unreadable_value"
  /** 引用が本文に一続きで無い・両端と値を含まない・長すぎる */
  | "ungrounded";

export interface TravelDistanceValidation {
  accepted: AcceptedTravelDistance[];
  rejected: Array<{ reason: TravelDistanceRejection; from?: string; to?: string }>;
}

/**
 * P-51 の答えを検算する（実装ルール3）。
 *
 * 引用・相手・値の確かめは、設定資料の抽出の位置関係と同じ関数
 * （`validateLocationRelations`）に通す——別に書くと、抽出では落ちる引用がここだけ通る。
 * そのうえで、両端が台帳の別々の場所に引けること・入れ子でないこと・値が
 * `normalizeTravel` で読めること・引用が出発の場所も名指ししていることを見る。
 */
export function validateTravelDistances(
  raw: unknown,
  chunk: Chunk,
  locations: readonly Location[]
): TravelDistanceValidation {
  const accepted: AcceptedTravelDistance[] = [];
  const rejected: TravelDistanceValidation["rejected"] = [];
  const items =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { distances?: unknown }).distances)
      ? ((raw as { distances: unknown[] }).distances)
      : null;
  if (!items) {
    rejected.push({ reason: "malformed" });
    return { accepted, rejected };
  }

  const resolver = buildLocationResolver(locations);
  const contains = containmentOf(locations, resolver);
  const byId = new Map(locations.map((location) => [location.id, location]));
  const seen = new Set<string>();

  for (const item of items.slice(0, TRAVEL_DISTANCE_MAX_ITEMS)) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const from = typeof entry.from === "string" ? entry.from.trim() : "";
    const to = typeof entry.to === "string" ? entry.to.trim() : "";
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
    if (!from || !to || !value || !evidence) {
      rejected.push({ reason: "malformed", from, to });
      continue;
    }
    const example = TRAVEL_DISTANCE_EXAMPLE;
    if (
      from === example.from ||
      to === example.to ||
      value === example.value ||
      evidence === example.evidence
    ) {
      rejected.push({ reason: "example_echo", from, to });
      continue;
    }
    const fromId = resolver.resolve(from, null);
    const toId = resolver.resolve(to, null);
    if (!fromId || !toId) {
      rejected.push({ reason: "unknown_place", from, to });
      continue;
    }
    if (fromId === toId) {
      rejected.push({ reason: "same_place", from, to });
      continue;
    }
    if (contains(fromId, toId) || contains(toId, fromId)) {
      rejected.push({ reason: "nested", from, to });
      continue;
    }
    if (!normalizeTravel(value)) {
      rejected.push({ reason: "unreadable_value", from, to });
      continue;
    }
    const fromRecord = byId.get(fromId) as Location;
    const grounded =
      [...evidence].length <= TRAVEL_DISTANCE_EVIDENCE_MAX_CHARS &&
      [...value].length <= LOCATION_RELATION_VALUE_MAX_CHARS &&
      // 出発の場所も引用の中に名指しされていること（相手だけを見ると、別の場所の距離を付け替えられる）
      normalizeForComparison(evidence).includes(normalizeForComparison(from)) &&
      validateLocationRelations(
        {
          name: fromRecord.name,
          aliases: fromRecord.aliases,
          relations: [{ target: to, kind: "distance", value, evidence }],
        },
        chunk
      ).kept.length === 1;
    if (!grounded) {
      rejected.push({ reason: "ungrounded", from, to });
      continue;
    }

    const key = [
      fromId < toId ? fromId : toId,
      fromId < toId ? toId : fromId,
      normalizeLocationName(value),
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);

    const place = locateQuote(chunk, evidence, typeof entry.line === "number" ? entry.line : null);
    accepted.push({
      fromId,
      fromName: fromRecord.name,
      toId,
      toName: (byId.get(toId) as Location).name,
      value,
      evidence,
      filePath: place.filePath,
      line: place.line,
      chapter: place.chapter,
      dialogue: place.dialogue,
    });
  }
  return { accepted, rejected };
}

/** 引用の前後の括弧・句点を落とす（引用の写し方の揺れ） */
function quoteCore(evidence: string): string {
  return evidence
    .replace(/^[「『"'“”‘’（(\s…]+/u, "")
    .replace(/[」』"'“”‘’）)\s…。．.]+$/u, "");
}

/**
 * 引用が本文のどの行にあり、台詞の中かを決める。
 *
 * 行は AI の答えた番号を信用せず、引用の入っている行を探す（見つからなければ
 * 答えの番号、それも外れていればチャンクの頭）。
 */
function locateQuote(
  chunk: Chunk,
  evidence: string,
  answeredLine: number | null
): { filePath: string; line: number; chapter: number | null; dialogue: boolean } {
  const core = quoteCore(evidence);
  const normalizedCore = normalizeForComparison(core);
  const lines = chunk.text.split("\n");
  let index = lines.findIndex((line) => normalizeForComparison(line).includes(normalizedCore));
  let chunkLine = index >= 0 ? chunk.startLine + index + 1 : answeredLine ?? chunk.startLine + 1;
  let located = locateChunkLine(chunk, chunkLine);
  if (!located) {
    chunkLine = chunk.startLine + 1;
    located = locateChunkLine(chunk, chunkLine) ?? { filePath: chunk.filePath, line: chunkLine };
    index = 0;
  } else if (index < 0) {
    index = chunkLine - chunk.startLine - 1;
  }
  const rawLine = (lines[index] ?? "").replace(/\r$/u, "");
  return {
    filePath: located.filePath,
    line: located.line,
    chapter: segmentAtLine(chunk, chunkLine)?.chapterStart ?? chunk.chapterStart,
    dialogue: insideQuotation(rawLine, core),
  };
}

/**
 * 段落の中で、その引用が「」『』の中にあるか。見つからなければ、段落が
 * 台詞で始まるかで決める
 */
function insideQuotation(paragraph: string, quote: string): boolean {
  const at = paragraph.indexOf(quote);
  if (at < 0) return isQuotedParagraph(paragraph.replace(/^[\s　]+/u, ""));
  const before = paragraph.slice(0, at);
  const open = (before.match(/[「『]/gu) ?? []).length;
  const close = (before.match(/[」』]/gu) ?? []).length;
  return open > close;
}

/** 承認待ちの距離として照合へ渡す形（`buildTravelTable` の `pendingDistances`） */
export function pendingDistancesOf(
  distances: readonly AcceptedTravelDistance[]
): PendingTravelDistance[] {
  return distances.map((distance) => ({
    fromId: distance.fromId,
    toId: distance.toId,
    value: distance.value,
    evidence: distance.evidence,
  }));
}

/** 承認待ちへ置く場所の案1つ（`PendingSettingsUpdateStore.stage` に `source: "fact"` で渡す） */
export interface TravelDistanceProposal {
  /** 場所の記録の写し。**位置関係は今回足すものだけ**（`proposeRecord.ts` の `applyLocationRelations` と同じ作り） */
  record: Location;
  reason: string;
}

/**
 * 検算を通った距離を、出発の場所の記録への「関係を足す案」にまとめる（設計書6.88.13）。
 *
 * - 写しに入れる位置関係は**今回足すものだけ**。いまの関係まで写すと、承認までの
 *   あいだに作者が消した関係を、古い写しが復活させる
 * - 同じ（距離, 相手, 値）がもう記録にあれば足さない
 * - 理由は「事実の照合で本文「…」（第N話）から読んだ所要時間」。台詞なら「台詞」と明記する
 *   （作者の判断④）
 * - 作者の関係・`authorLocked` に触れないのは取り込みの側（`mergePendingSettingsRecord`）
 */
export function buildTravelDistanceProposals(
  distances: readonly AcceptedTravelDistance[],
  locations: readonly Location[]
): TravelDistanceProposal[] {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const grouped = new Map<string, AcceptedTravelDistance[]>();
  for (const distance of distances) {
    const list = grouped.get(distance.fromId) ?? [];
    list.push(distance);
    grouped.set(distance.fromId, list);
  }

  const proposals: TravelDistanceProposal[] = [];
  for (const [fromId, list] of grouped) {
    const location = byId.get(fromId);
    if (!location) continue;
    const known = new Set(
      (location.relations ?? []).map((relation) => relationKey(relation.kind, relation.target, relation.value))
    );
    const fresh: LocationRelation[] = [];
    const reasons: string[] = [];
    for (const distance of list) {
      const key = relationKey("distance", distance.toName, distance.value);
      if (known.has(key)) continue;
      known.add(key);
      fresh.push({
        kind: "distance",
        target: distance.toName,
        targetId: distance.toId,
        value: distance.value,
        chapters: distance.chapter !== null ? [distance.chapter] : [],
        evidence: distance.evidence,
        authorLocked: false,
      });
      reasons.push(
        `事実の照合で本文「${distance.evidence}」` +
          (distance.chapter !== null ? `（第${distance.chapter}話）` : "") +
          `から読んだ所要時間（${distance.toName}まで${distance.value}）` +
          (distance.dialogue ? "。台詞の中の言葉です" : "")
      );
    }
    if (fresh.length === 0) continue;
    const record = structuredClone(location);
    record.relations = fresh;
    proposals.push({ record, reason: reasons.join("\n") });
  }
  return proposals;
}

function relationKey(kind: string, target: string, value: string | null): string {
  return [kind, normalizeLocationName(target), normalizeLocationName(value ?? "")].join("\u0000");
}

/* ── P-52 場面の頭の時の経過 ──────────────────────────────── */

/** P-52 へ訊く1件 */
export interface TimeCueRequest {
  /** 時計の鍵（`sceneTimeMarkerKey`） */
  key: string;
  filePath: string;
  /** 場面の最初の段落の行 */
  line: number;
  previousParagraphs: string[];
  headParagraphs: string[];
  /** 控えの指紋（送る本文から作る） */
  cacheId: string;
}

export interface TimeCuePlan {
  requests: TimeCueRequest[];
  /** 上限を超えて訊かなかった場面の頭 */
  skipped: number;
}

/**
 * P-52 へ何を訊くかを決める（設計書6.88.13）。
 *
 * **時計で比べられない所在の組だけ**——同じ人物が続けて別の場所におり、
 * その2か所が所要時間の表に1日以上で載っているのに、時の鎖が切れていて比べられない組。
 * 訊くのは、その2つのあいだで**新しい鎖が始まった場面の頭**（話の頭・区切りのあとに
 * 印が無い・前の場面の終わりが読めない）だけ。照合器と同じく、回想・伝聞・嘘の疑いの
 * 中の所在は数えない。
 */
export function planTimeCueRequests(input: {
  material: TravelMaterial;
  facts: readonly StoryFact[];
  episodes: readonly SceneClockEpisode[];
  limit?: number;
}): TimeCuePlan {
  const { material } = input;
  const limit = input.limit ?? SCENE_TIME_CUE_LIMIT;
  const table = new Set(
    material.travelTimes
      .filter((entry) => entry.minDays >= 1)
      .map((entry) => pairKey(entry.from, entry.to))
  );
  if (table.size === 0) return { requests: [], skipped: 0 };

  const heads = material.clock.heads;
  const headIndex = new Map(heads.map((head, index) => [head.segment, index]));
  const entryByFact = new Map(material.whereabouts.map((entry) => [entry.factId, entry]));
  const bySubject = new Map<string, Array<{ locationId: string; segment: string; chain: string }>>();
  for (const fact of orderFacts(input.facts)) {
    const entry = entryByFact.get(fact.id);
    if (!entry || !entry.clock) continue;
    if (fact.modality !== "narration" && fact.modality !== "dialogue") continue;
    const list = bySubject.get(entry.subject) ?? [];
    list.push({ locationId: entry.locationId, segment: entry.clock.segment, chain: entry.clock.chain });
    bySubject.set(entry.subject, list);
  }

  const wanted = new Set<number>();
  for (const list of bySubject.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1];
      const to = list[i];
      if (from.locationId === to.locationId) continue;
      if (from.chain === to.chain) continue;
      if (!table.has(pairKey(from.locationId, to.locationId))) continue;
      const start = headIndex.get(from.segment);
      const end = headIndex.get(to.segment);
      if (start === undefined || end === undefined || end <= start) continue;
      for (let h = start + 1; h <= end; h += 1) {
        if (heads[h].chainStart) wanted.add(h);
      }
    }
  }

  const paragraphs = paragraphIndex(input.episodes);
  const ordered = [...wanted].sort((a, b) => a - b);
  const requests: TimeCueRequest[] = [];
  for (const h of ordered.slice(0, limit)) {
    const head = heads[h];
    const window = paragraphs.windowAt(head.filePath, head.line);
    if (!window) continue;
    requests.push({
      key: sceneTimeMarkerKey(head.filePath, head.line),
      filePath: head.filePath,
      line: head.line,
      previousParagraphs: window.previous,
      headParagraphs: window.head,
      cacheId: hashText(`${window.previous.join("\n")}\u0000${window.head.join("\n")}`),
    });
  }
  return { requests, skipped: Math.max(0, ordered.length - limit) };
}

function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

/**
 * 本文の段落を時計と同じ順に並べ、場面の頭の前後を引けるようにする。
 * 前の場面は話をまたいで引く（話の頭の場面の「前」は前の話の終わり）
 */
function paragraphIndex(episodes: readonly SceneClockEpisode[]) {
  const list: Array<{ filePath: string; line: number; text: string; breakAfter: boolean }> = [];
  for (const episode of orderSceneClockEpisodes(episodes)) {
    episode.text.split("\n").forEach((raw, index) => {
      const line = raw.replace(/\r$/u, "");
      if (!line.replace(/[\s　]/gu, "")) return;
      if (isSceneBreakLine(line)) {
        if (list.length > 0) list[list.length - 1].breakAfter = true;
        return;
      }
      list.push({ filePath: episode.filePath, line: index + 1, text: line, breakAfter: false });
    });
    if (list.length > 0) list[list.length - 1].breakAfter = true;
  }
  const at = new Map(list.map((entry, index) => [sceneTimeMarkerKey(entry.filePath, entry.line), index]));
  return {
    windowAt(filePath: string, line: number): { previous: string[]; head: string[] } | undefined {
      const index = at.get(sceneTimeMarkerKey(filePath, line));
      if (index === undefined) return undefined;
      const head: string[] = [];
      for (let j = index; j < list.length && head.length < SCENE_TIME_CUE_HEAD_PARAGRAPHS; j += 1) {
        head.push(list[j].text);
        if (list[j].breakAfter) break;
      }
      const previous = list
        .slice(Math.max(0, index - SCENE_TIME_CUE_PREVIOUS_PARAGRAPHS), index)
        .map((entry) => entry.text);
      return { previous, head };
    },
  };
}

/** P-52 の検算の結果 */
export interface SceneTimeCueValidation {
  /** 時計に入れる印。手がかりが無いと答えたら undefined */
  marker?: SceneTimeMarker;
  /** accepted＝読みを採った／none＝手がかりなし／cut＝検算に通らず「分からない」とした */
  outcome: "accepted" | "none" | "cut";
}

/** 「三日後」「二日目」「三晩ぶり」——数が経過を言い切る形だけ（「三日三晩」「馬で三日」は通さない） */
const ELAPSED_COUNT =
  /([0-9０-９一二三四五六七八九十]{1,3})(?:日|晩)(?:後|目|が経|が過ぎ|がたっ|経っ|たっ|ぶり)/u;
/** 数の無い「次の日」の言い方 */
const NEXT_DAY_WORDS: ReadonlyArray<{ pattern: RegExp; days: number }> = [
  { pattern: /翌々|明後日/u, days: 2 },
  { pattern: /翌|明くる|あくる|次の日|次の朝|夜が明け|明け方/u, days: 1 },
];
/** 同じ時を言う小さな語の一覧 */
const SIMULTANEOUS_WORDS = /頃|ころ|同じ時|同時|その時/u;
/** 同じ日を言う小さな語の一覧 */
const SAME_DAY_WORDS =
  /同じ日|その日|同日|当日|その夜|その晩|その朝|その夕|その昼|夕方|夕刻|昼過ぎ|夜になって|日が暮れ/u;

/**
 * P-52 の答えを検算する（実装ルール3）。
 *
 * - 引用は**この場面の最初の段落**の地の文（「」の外）にそのままあること
 * - 経過が進んだ（advance）なら、引用に書かれた日数（漢数字も）が days と同じこと。
 *   数の無い「翌朝」は1日、「翌々日」は2日
 * - 同じ時・同じ日なら、引用が小さな語の一覧（頃・同じ日・その日 など）を含むこと
 * - 見本と同じ引用は捨てる（指示の言葉はそのまま返ってくる）
 *
 * 合わなければ「分からない」（cut）——時計は鎖を切ったままにし、比べない側へ倒れる。
 */
export function validateSceneTimeCue(
  raw: unknown,
  request: Pick<TimeCueRequest, "headParagraphs">
): SceneTimeCueValidation {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const kind = value.kind;
  if (kind === null) return { outcome: "none" };
  const evidence = typeof value.evidence === "string" ? value.evidence.trim() : "";
  const cut = (): SceneTimeCueValidation => ({
    marker: { kind: "cut", days: 0, evidence },
    outcome: "cut",
  });
  if (typeof kind !== "string" || !(SCENE_TIME_CUE_KINDS as readonly string[]).includes(kind)) {
    return cut();
  }
  const cueKind = kind as SceneTimeCueKind;
  if (cueKind === "cut") return cut();

  if (
    !evidence ||
    [...evidence].length > SCENE_TIME_CUE_EVIDENCE_MAX_CHARS ||
    evidence === SCENE_TIME_CUE_EXAMPLE.evidence
  ) {
    return cut();
  }
  const paragraph = (request.headParagraphs[0] ?? "").replace(/^[\s　]+/u, "");
  const at = paragraph.indexOf(evidence);
  if (at < 0 || insideQuotation(paragraph, evidence)) return cut();

  if (cueKind === "advance") {
    const days = typeof value.days === "number" && Number.isInteger(value.days) ? value.days : NaN;
    if (!(days >= 1 && days <= 60)) return cut();
    const counted = evidence.match(ELAPSED_COUNT);
    const expected = counted
      ? parseSmallNumber(counted[1])
      : (NEXT_DAY_WORDS.find((rule) => rule.pattern.test(evidence))?.days ?? null);
    if (expected === null || expected !== days) return cut();
    return { marker: { kind: "advance", days, evidence }, outcome: "accepted" };
  }
  const words = cueKind === "simultaneous" ? SIMULTANEOUS_WORDS : SAME_DAY_WORDS;
  if (!words.test(evidence)) return cut();
  return { marker: { kind: cueKind, days: 0, evidence }, outcome: "accepted" };
}

/* ── 通し ───────────────────────────────────────────────── */

/** AIへの1回の頼み。プロバイダ・控え・中止は呼ぶ側が持つ */
export interface TravelCueAskRequest {
  stage: "distance" | "timeCue";
  systemPrompt: string;
  userPrompt: string;
  schema: unknown;
  temperature: number;
  /** 控えの指紋（P-51 はチャンク＋場所の一覧、P-52 は送る本文） */
  cacheId: string;
  /** 送る本文の字数（処理時間の見込み・ログ用） */
  inputChars: number;
}

/**
 * AIを呼ぶ口。JSONとして読めた答えを返す。送れなかった・読めなかったら undefined
 * （**1回の失敗で全体を止めない**。数えて最後に報告する）
 */
export type TravelCueAsk = (request: TravelCueAskRequest) => Promise<unknown | undefined>;

export interface TravelCuesResult {
  /** AIの手がかりを入れて組み直した材料（照合へ渡す） */
  material: TravelMaterial;
  /** 承認待ちへ置く案（呼ぶ側が `source: "fact"` で積む） */
  proposals: TravelDistanceProposal[];
  distances: AcceptedTravelDistance[];
  stats: TravelCueStats;
}

/** 実行前の確認に出す、AIを呼ぶ回数の上限（P-51 の送り先のチャンク数＋P-52 の上限） */
export function plannedTravelCueCalls(
  chunks: readonly Pick<Chunk, "text">[],
  locations: readonly Location[]
): { distance: number; timeCue: number } {
  if (locations.length < 2) return { distance: 0, timeCue: 0 };
  return {
    distance: chunks.filter((chunk) => isTravelDistanceChunk(chunk, locations)).length,
    timeCue: SCENE_TIME_CUE_LIMIT,
  };
}

/**
 * P-37 のあと、照合の前に回す（設計書6.88.13 の流れ）：
 * `buildTravelMaterial` → P-51（承認待ちの距離）→ 比べられない組があれば P-52（上限あり）
 * → AIの印を入れて `buildTravelMaterial` をもう一度。
 *
 * 場所の記録が2つ未満の作品は対象外（作者の判断③）——距離を置く先が無い。
 */
export async function runTravelCues(input: {
  locations: readonly Location[];
  facts: readonly StoryFact[];
  places: ReadonlyMap<string, FactPlace>;
  episodes: readonly SceneClockEpisode[];
  /** P-37 と同じチャンク（ここから P-51 の送り先を選ぶ） */
  chunks: readonly Chunk[];
  ask: TravelCueAsk;
  /** 中止されたら true。訊く前に毎回見る */
  isCancelled?: () => boolean;
  timeCueLimit?: number;
}): Promise<TravelCuesResult> {
  const stats: TravelCueStats = {
    noLocations: false,
    distanceChunks: 0,
    distancesAccepted: 0,
    distancesRejected: 0,
    proposedLocations: 0,
    timeCueRequests: 0,
    timeCueSkipped: 0,
    timeCuesApplied: 0,
    timeCuesCut: 0,
    failures: 0,
  };
  const base = { locations: input.locations, facts: input.facts, places: input.places, episodes: input.episodes };
  const cancelled = () => input.isCancelled?.() === true;

  if (input.locations.length < 2) {
    stats.noLocations = true;
    const material = buildTravelMaterial(base);
    return { material: withCueStats(material, stats), proposals: [], distances: [], stats };
  }

  // ── P-51 本文の距離 ──
  const names = locationNamesForPrompt(input.locations);
  const distances: AcceptedTravelDistance[] = [];
  const seen = new Set<string>();
  for (const chunk of input.chunks) {
    if (cancelled()) break;
    if (!isTravelDistanceChunk(chunk, input.locations)) continue;
    stats.distanceChunks += 1;
    const chunkText = withLineNumbers(chunk);
    const raw = await input.ask({
      stage: "distance",
      systemPrompt: TRAVEL_DISTANCE_EXTRACT_SYSTEM_PROMPT,
      userPrompt: buildTravelDistanceExtractPrompt({ chunkTextWithLines: chunkText, locationNames: names }),
      schema: TRAVEL_DISTANCE_EXTRACT_SCHEMA,
      temperature: TRAVEL_DISTANCE_EXTRACT_TEMPERATURE,
      cacheId: travelDistanceChunkId(chunk, input.locations),
      inputChars: chunkText.length,
    });
    if (raw === undefined) {
      stats.failures += 1;
      continue;
    }
    const checked = validateTravelDistances(raw, chunk, input.locations);
    stats.distancesRejected += checked.rejected.length;
    for (const distance of checked.accepted) {
      const key = [distance.fromId, distance.toId, normalizeLocationName(distance.value)].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      distances.push(distance);
    }
  }
  stats.distancesAccepted = distances.length;
  const proposals = buildTravelDistanceProposals(distances, input.locations);
  stats.proposedLocations = proposals.length;
  const pendingDistances = pendingDistancesOf(distances);

  // ── P-52 場面の頭の時の経過 ──
  let material = buildTravelMaterial({ ...base, pendingDistances });
  const plan = planTimeCueRequests({
    material,
    facts: input.facts,
    episodes: input.episodes,
    limit: input.timeCueLimit,
  });
  stats.timeCueSkipped = plan.skipped;
  const markers = new Map<string, SceneTimeMarker>();
  for (const request of plan.requests) {
    if (cancelled()) break;
    stats.timeCueRequests += 1;
    const userPrompt = buildSceneTimeCuePrompt({
      previousParagraphs: request.previousParagraphs,
      headParagraphs: request.headParagraphs,
    });
    const raw = await input.ask({
      stage: "timeCue",
      systemPrompt: SCENE_TIME_CUE_SYSTEM_PROMPT,
      userPrompt,
      schema: SCENE_TIME_CUE_SCHEMA,
      temperature: SCENE_TIME_CUE_TEMPERATURE,
      cacheId: request.cacheId,
      inputChars: userPrompt.length,
    });
    if (raw === undefined) {
      stats.failures += 1;
      continue;
    }
    const checked = validateSceneTimeCue(raw, request);
    if (checked.outcome === "cut") stats.timeCuesCut += 1;
    if (checked.outcome === "accepted") stats.timeCuesApplied += 1;
    if (checked.marker) markers.set(request.key, checked.marker);
  }
  if (markers.size > 0) {
    material = buildTravelMaterial({ ...base, pendingDistances, aiMarkers: markers });
  }
  return { material: withCueStats(material, stats), proposals, distances, stats };
}

function withCueStats(material: TravelMaterial, stats: TravelCueStats): TravelMaterial {
  return { ...material, stats: { ...material.stats, aiCues: stats } };
}
