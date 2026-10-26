import type { Character } from "../models/character";
import type { SceneIdentity } from "../models/identity";
import {
  IDENTITY_TRANSITION_KINDS,
  type IdentityTransition,
  type IdentityTransitionKind,
  type StoryFact,
} from "../models/storyFact";
import { dwellingLinks, ownAppellations } from "./characterDwelling";
import { withLineNumbers, type Chunk } from "./chunker";
import { dwellingSceneVerdicts, type DwellingSpan } from "./contradictionMatch";
import type { IdentityCueStats, MindReassignment } from "./factContradiction";
import type { FactPlace } from "./factContradictionFlow";
import { normalizeForComparison } from "./groundedEvidence";
import { hashText } from "./hash";
import { canonicalPredicate } from "./predicateArity";
import { isSceneBreakLine, type SceneClockEpisode } from "./sceneClock";
import { locateQuote, quoteCore } from "./travelCues";
import {
  SCENE_MIND_EVIDENCE_MAX_CHARS,
  SCENE_MIND_EXAMPLE,
  SCENE_MIND_EXTRACT_SYSTEM_PROMPT,
  SCENE_MIND_EXTRACT_TEMPERATURE,
  SCENE_MIND_EXTRACT_VERSION,
  SCENE_MIND_MAX_MINDS,
  SCENE_MIND_MAX_TRANSITIONS,
  SCENE_MIND_UNKNOWN,
  buildSceneMindExtractPrompt,
  buildSceneMindExtractSchema,
  type SceneMindPairForPrompt,
} from "../prompts/sceneMindExtract";

/**
 * 体と心の組（憑依・入れ替わり）を、矛盾検知（事実の照合）で照らす（設計書6.88.14）。
 *
 * 照合器（`findDwellingDrift`・`findPostDeathAppearances` の遷移の除外）はあったが、
 * 製品の道は場面の組も遷移も空で呼んでいた。ここはその材料を作る段——
 *
 * - **AIを使わない**：作者の心と体の記録（宿り。`Character.dwellings`）を体と心の id に
 *   結び（`buildIdentityLedger`）、記録の範囲と、範囲の頭・終わりの遷移を組む
 * - **AI（P-53）**：組の名前を含むチャンクだけを送り、場面ごとに体を動かしている心と、
 *   本文に描かれた遷移を書き写させる。検算（`validateSceneMinds`）を通ったものだけを使う
 * - **心の項目の付け替え（作者の判断⑥）**：憑依の場面で体の持ち主の名で抜かれた
 *   一人称・口調・性格は、その場面の心が1人に決まるときだけ心の側へ付け替え、
 *   決まらなければ照合から外す（`reassignMindFacts`）
 *
 * 照合そのものはコードが行う（実装ルール3）。**作者のデータ（人物の記録）は書き換えない**
 * ——付け替えは照合のための写しの上だけ。
 *
 * **拡張機能と MCP は `runIdentityCues` を呼ぶだけ**（`runTravelCues` と同じ形。写しを
 * 作ると製品と測定がずれる。6.88.10）。VS Code にも `node:` にも依存しない。
 */

/** 控えの鍵（P-53）。**内容ハッシュ＋プロバイダ＋モデル＋版**（実装ルール4） */
export function sceneMindCacheKey(input: { providerId: string; model: string }) {
  return {
    feature: "scene_mind_extract",
    promptVersion: SCENE_MIND_EXTRACT_VERSION,
    providerId: input.providerId,
    model: input.model,
  };
}

/** 付け替えの対象にする心の項目（`canonicalPredicate` で寄せたあとの名前） */
export const MIND_PREDICATES: ReadonlySet<string> = new Set(["一人称", "口調", "話し方", "性格"]);

/** 完了の知らせに並べる「記録に無い読み」の件数 */
const UNRECORDED_SHOWN = 3;

/**
 * 遷移の引用が含むべき語（心が入る・出る・戻る・入れ替わる・生まれ変わる・幽霊として現れる）。
 *
 * 実接続の測定（2026-10-26）で、26b・e4b は場面の描写の1文（「太志がもう一度名乗った」
 * 「文佳の体を動かしていたのは…千早だった」）を遷移としても返し、その遷移が同じ場面を
 * 「描写あり」で許して仕込みを消した。P-52 の検算と同じく、**出来事の語が引用に無ければ
 * 遷移として受け取らない**。足りなくて落とした本物の遷移は、候補として出て確かめの段
 * （identity 1.0：入る・戻る描写があれば両立）が見る——読み違えが黙って仕込みを消すより害が小さい。
 * 「宿」は入れない（「灯に宿っているはずの千早」のように、いまいる体を言う語でもある）
 */
export const IDENTITY_TRANSITION_CUE_WORDS: readonly string[] = [
  "乗り移",
  "憑",
  "入り込",
  "入っ",
  "入る",
  "入れ替わ",
  "入れかわ",
  "戻っ",
  "戻る",
  "戻り",
  "代わっ",
  "替わっ",
  "交代",
  "目を覚ま",
  "目覚め",
  "顔を出",
  "生まれ変わ",
  "転生",
  "幽霊",
  "亡霊",
];

/** 内訳に載せる引用の頭の字数（作者の原稿の本文を長く出さない） */
const DETAIL_EVIDENCE_CHARS = 20;

/* ── 記録（AIを使わない段） ─────────────────────────────── */

/** 心と体の記録を、照合に使える形にしたもの */
export interface IdentityLedger {
  spans: DwellingSpan[];
  /** 体の持ち主が人物の記録に見つからず、結べなかった記録 */
  unlinked: number;
  /** 組に出てくる人物（体の持ち主と宿る心） */
  people: Map<string, Character>;
  /** 体の持ち主の id */
  bodies: Set<string>;
  /** 呼び名（空白を落とした形）→ 人物の id。2人に当たる呼び名は入れない */
  names: Map<string, string>;
  /** 人物の id → 作者が読む名前 */
  displayNames: Map<string, string>;
}

/**
 * 宿りを体と心の id に結ぶ（`dwellingLinks`）。**結べない宿りは捨てる**——どの体か
 * 分からない記録で照合すると、別の人物の場面を矛盾にする。
 *
 * 呼び名は本人のものと確かめられる形だけ（`ownAppellations`）。文佳の別名に汚染で
 * 入った「太志」を文佳の呼び名にすると、太志の心が引けなくなる。
 */
export function buildIdentityLedger(characters: readonly Character[]): IdentityLedger {
  const spans: DwellingSpan[] = [];
  const people = new Map<string, Character>();
  const bodies = new Set<string>();
  let unlinked = 0;
  for (const link of dwellingLinks(characters)) {
    if (!link.body || link.body.id === link.dweller.id) {
      unlinked += 1;
      continue;
    }
    spans.push({
      bodyId: link.body.id,
      mindId: link.dweller.id,
      ...(link.dwelling.fromChapter !== undefined ? { fromChapter: link.dwelling.fromChapter } : {}),
      ...(link.dwelling.untilChapter !== undefined ? { untilChapter: link.dwelling.untilChapter } : {}),
    });
    people.set(link.body.id, link.body);
    people.set(link.dweller.id, link.dweller);
    bodies.add(link.body.id);
  }
  const claims = new Map<string, Set<string>>();
  for (const person of people.values()) {
    for (const name of ownAppellations(person)) {
      const owners = claims.get(name) ?? new Set<string>();
      owners.add(person.id);
      claims.set(name, owners);
    }
  }
  const names = new Map<string, string>();
  for (const [name, owners] of claims) {
    if (owners.size === 1) names.set(name, [...owners][0]);
  }
  const displayNames = new Map([...people.values()].map((person) => [person.id, person.name]));
  return { spans, unlinked, people, bodies, names, displayNames };
}

/**
 * 記録から遷移を組む（6.88.14）。範囲の頭の話に憑依（possession。前へ出るのは心）、
 * 終わりの次の話に交代（switch。前へ出るのは体の持ち主）。行は 0（その話の頭）。
 *
 * 体と心の照合は範囲そのものを見るので、これは死亡後の登場の除外にだけ効く
 * （`fromDwelling` の印。範囲の頭の憑依1つで範囲の外まで許さないように）
 */
export function transitionsFromDwellings(spans: readonly DwellingSpan[]): IdentityTransition[] {
  const transitions: IdentityTransition[] = [];
  for (const span of spans) {
    if (span.fromChapter !== undefined) {
      transitions.push({
        subject: span.mindId,
        kind: "possession",
        at: { storyTime: null, chapter: span.fromChapter, line: 0 },
        body: span.bodyId,
        toPersona: span.mindId,
        fromDwelling: true,
      });
    }
    if (span.untilChapter !== undefined) {
      transitions.push({
        subject: span.bodyId,
        kind: "switch",
        at: { storyTime: null, chapter: span.untilChapter + 1, line: 0 },
        body: span.bodyId,
        toPersona: span.bodyId,
        fromDwelling: true,
      });
    }
  }
  return transitions;
}

/** 呼び名を人物の id に引く（空白を落として完全一致） */
function resolveName(ledger: IdentityLedger, name: string): string | undefined {
  return ledger.names.get(name.replace(/[\s　]/gu, ""));
}

/** その人物の呼び名（プロンプトとスキーマに並べる。本人のものと確かめられる形だけ） */
function appellationsOf(ledger: IdentityLedger, id: string): string[] {
  return [...ledger.names].filter(([, owner]) => owner === id).map(([name]) => name);
}

/** プロンプトに並べる組（体ごとに、宿ることがある心） */
export function pairsForPrompt(ledger: IdentityLedger): SceneMindPairForPrompt[] {
  const label = (id: string) => {
    // スキーマの列挙と同じ形（空白を落とした形）で並べる。違う形で見せると、写し間違える
    const name = (ledger.people.get(id)?.name ?? id).replace(/[\s　]/gu, "");
    const others = appellationsOf(ledger, id).filter((alias) => alias !== name);
    return others.length > 0 ? `${name}（別名: ${others.join("、")}）` : name;
  };
  return [...ledger.bodies].sort().map((bodyId) => ({
    body: label(bodyId),
    minds: [...new Set(ledger.spans.filter((span) => span.bodyId === bodyId).map((span) => span.mindId))]
      .sort()
      .map(label),
  }));
}

/** スキーマの列挙に入れる名前 */
export function schemaNamesOf(ledger: IdentityLedger): { bodyNames: string[]; mindNames: string[] } {
  const all = [...ledger.names.keys()].sort();
  return {
    bodyNames: all.filter((name) => ledger.bodies.has(ledger.names.get(name) as string)),
    mindNames: all,
  };
}

/**
 * P-53 を送るチャンクか。組に出てくる人物の名前か別名を含むもの（6.88.14）。
 * 名前の無いチャンクを送っても、組の場面の読みは返らない
 */
export function isIdentityChunk(chunk: Pick<Chunk, "text">, ledger: IdentityLedger): boolean {
  if (ledger.spans.length === 0) return false;
  const text = chunk.text.replace(/[\s　]/gu, "");
  return [...ledger.names.keys()].some((name) => name && text.includes(name));
}

/**
 * P-53 の控えに使うチャンクの指紋。**組の一覧も混ぜる**——一覧はプロンプトとスキーマに
 * 入るので、記録を足すと同じ本文でも答えが変わりうる
 */
export function identityChunkId(chunk: Pick<Chunk, "hash">, ledger: IdentityLedger): string {
  const pairs = pairsForPrompt(ledger).map((pair) => `${pair.body}>${pair.minds.join(",")}`);
  return hashText(`${chunk.hash}\u0000${pairs.join("\u0000")}`);
}

/* ── P-53 の検算 ─────────────────────────────────────── */

/** 検算を通った場面の読み1件 */
export interface AcceptedMindReading {
  bodyId: string;
  /** 心の id。「分からない」なら null */
  mindId: string | null;
  evidence: string;
  filePath: string;
  line: number;
  chapter: number | null;
}

/** 検算を通った本文の遷移1件 */
export interface AcceptedIdentityTransition {
  kind: IdentityTransitionKind;
  /** 体の id。幽霊・転生で体が書かれていなければ undefined（照合は体を問わない） */
  bodyId?: string;
  toMindId: string;
  evidence: string;
  filePath: string;
  line: number;
  chapter: number | null;
}

/** 読みや遷移を捨てた理由 */
export type SceneMindRejection =
  /** 形が崩れている（欄が無い・文字列でない） */
  | "malformed"
  /** 見本の名前・引用がそのまま返ってきた */
  | "example_echo"
  /** 名前が組の人物に引けない・体が組の体でない */
  | "unknown_name"
  /** 憑依・入れ替わりなのに、入る心が体の持ち主と同じ */
  | "same_person"
  /** 引用が本文に一続きで無い・長すぎる */
  | "ungrounded"
  /** 遷移の引用が台詞（「」の中）にある（「まるで別人」で除外が効かないように） */
  | "dialogue"
  /** 遷移の引用に、前へ出る心の名前が無い */
  | "unnamed"
  /** 遷移の引用に、心が入る・戻るなどの出来事の語が無い（場面の描写を遷移と読んだ） */
  | "no_transition_word";

export interface SceneMindValidation {
  readings: AcceptedMindReading[];
  transitions: AcceptedIdentityTransition[];
  rejected: Array<{ reason: SceneMindRejection; what: "mind" | "transition" }>;
}

/** 引用がチャンクに一続きにあるか（空白の揺れと前後の括弧は問わない） */
function isGrounded(evidence: string, chunk: Chunk): boolean {
  if ([...evidence].length > SCENE_MIND_EVIDENCE_MAX_CHARS) return false;
  const core = normalizeForComparison(quoteCore(evidence));
  if (!core) return false;
  return normalizeForComparison(chunk.text).includes(core);
}

function textField(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * P-53 の答えを検算する（実装ルール3）。
 *
 * - 引用がチャンクにそのまま在る（行は答えの番号を信用せず、引用で探す）
 * - 名前が組の人物に引け、体は組の体である（閉じた選択肢の外は捨てる）
 * - 「分からない」は読みとして数えるが、場面の心には使わない
 * - 見本と同じ名前・引用は捨てる（見本は本文に出ない名前）
 * - 遷移は引用が「」の外のときだけ（台詞の「まるで別人」で除外が効かないように）。
 *   憑依・入れ替わりで、入る心が体の持ち主と同じものは捨てる
 * - 遷移の引用は、前へ出る心の名前と、出来事の語（`IDENTITY_TRANSITION_CUE_WORDS`）を
 *   含むこと（場面の描写の1文を遷移と読んだ答えで、仕込みが消えないように）
 */
export function validateSceneMinds(
  raw: unknown,
  chunk: Chunk,
  ledger: IdentityLedger
): SceneMindValidation {
  const readings: AcceptedMindReading[] = [];
  const transitions: AcceptedIdentityTransition[] = [];
  const rejected: SceneMindValidation["rejected"] = [];
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const minds = value && Array.isArray(value.minds) ? (value.minds as unknown[]) : null;
  const moves = value && Array.isArray(value.transitions) ? (value.transitions as unknown[]) : null;
  if (!minds || !moves) {
    rejected.push({ reason: "malformed", what: "mind" });
    return { readings, transitions, rejected };
  }
  const example = SCENE_MIND_EXAMPLE;
  const echoes = (...values: string[]) =>
    values.some(
      (text) => text === example.body || text === example.mind || text === example.evidence
    );

  for (const item of minds.slice(0, SCENE_MIND_MAX_MINDS)) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const body = textField(entry, "body");
    const mind = textField(entry, "mind");
    const evidence = textField(entry, "evidence");
    if (!body || !mind || !evidence) {
      rejected.push({ reason: "malformed", what: "mind" });
      continue;
    }
    if (echoes(body, mind, evidence)) {
      rejected.push({ reason: "example_echo", what: "mind" });
      continue;
    }
    const bodyId = resolveName(ledger, body);
    const unknown = mind === SCENE_MIND_UNKNOWN;
    const mindId = unknown ? null : resolveName(ledger, mind);
    if (!bodyId || !ledger.bodies.has(bodyId) || (!unknown && !mindId)) {
      rejected.push({ reason: "unknown_name", what: "mind" });
      continue;
    }
    if (!isGrounded(evidence, chunk)) {
      rejected.push({ reason: "ungrounded", what: "mind" });
      continue;
    }
    const place = locateQuote(chunk, evidence, typeof entry.line === "number" ? entry.line : null);
    readings.push({
      bodyId,
      mindId: mindId ?? null,
      evidence,
      filePath: place.filePath,
      line: place.line,
      chapter: place.chapter,
    });
  }

  for (const item of moves.slice(0, SCENE_MIND_MAX_TRANSITIONS)) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const kind = textField(entry, "kind");
    const body = textField(entry, "body");
    const toMind = textField(entry, "toMind");
    const evidence = textField(entry, "evidence");
    if (
      !(IDENTITY_TRANSITION_KINDS as readonly string[]).includes(kind) ||
      !toMind ||
      !evidence
    ) {
      rejected.push({ reason: "malformed", what: "transition" });
      continue;
    }
    if (echoes(body, toMind, evidence)) {
      rejected.push({ reason: "example_echo", what: "transition" });
      continue;
    }
    const toMindId = resolveName(ledger, toMind);
    const bodyId = body ? resolveName(ledger, body) : undefined;
    // 憑依・交代・入れ替わりは体のある出来事。幽霊・転生は体が書かれないことがある
    const needsBody = kind === "possession" || kind === "switch" || kind === "swap";
    if (!toMindId || (body && (!bodyId || !ledger.bodies.has(bodyId))) || (needsBody && !bodyId)) {
      rejected.push({ reason: "unknown_name", what: "transition" });
      continue;
    }
    if ((kind === "possession" || kind === "swap") && bodyId === toMindId) {
      rejected.push({ reason: "same_person", what: "transition" });
      continue;
    }
    if (!isGrounded(evidence, chunk)) {
      rejected.push({ reason: "ungrounded", what: "transition" });
      continue;
    }
    const place = locateQuote(chunk, evidence, typeof entry.line === "number" ? entry.line : null);
    if (place.dialogue) {
      rejected.push({ reason: "dialogue", what: "transition" });
      continue;
    }
    const flat = evidence.replace(/[\s　]/gu, "");
    if (!appellationsOf(ledger, toMindId).some((name) => flat.includes(name))) {
      rejected.push({ reason: "unnamed", what: "transition" });
      continue;
    }
    if (!IDENTITY_TRANSITION_CUE_WORDS.some((word) => flat.includes(word))) {
      rejected.push({ reason: "no_transition_word", what: "transition" });
      continue;
    }
    transitions.push({
      kind: kind as IdentityTransitionKind,
      ...(bodyId ? { bodyId } : {}),
      toMindId,
      evidence,
      filePath: place.filePath,
      line: place.line,
      chapter: place.chapter,
    });
  }
  return { readings, transitions, rejected };
}

/* ── 場面の事実の登録 ────────────────────────────────── */

/** 場面の読み1件（`registerIdentitySceneFacts` へ渡す形） */
export interface SceneReadingForMatch {
  bodyId: string;
  mindId: string;
  /** 事実の値に入れる心の名前（作者に見せる） */
  mindName: string;
  filePath: string;
  line: number;
  chapter: number | null;
}

/**
 * 場面の読みを、照合器へ渡す場面の組（`SceneIdentity`）と、表示用の事実にする。
 *
 * **表示用の事実は `factById`・`places` にだけ登録し、`facts` には入れない。**
 * 入れると「人格」の区間が区間の照合にも出て、同じ食い違いが二重に出る。
 * 場面の `source` には表示用の事実の id（`scene:<話>:<行>:<n>`）を入れる——
 * `candidateSidesOf` は `factById` でしか引かないので、事実の id でない source の候補は
 * 黙って消えていた（6.88.14 で直した穴）。身分は扱わない（母艦の判断⑤）ので、
 * 身分の id は体の id と同じにする。
 */
export function registerIdentitySceneFacts(readings: readonly SceneReadingForMatch[]): {
  scenes: SceneIdentity[];
  sceneFacts: StoryFact[];
  places: Map<string, FactPlace>;
} {
  const scenes: SceneIdentity[] = [];
  const sceneFacts: StoryFact[] = [];
  const places = new Map<string, FactPlace>();
  const counts = new Map<string, number>();
  for (const reading of readings) {
    const base = `scene:${reading.chapter ?? 0}:${reading.line}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const id = `${base}:${n}`;
    scenes.push({
      chapter: reading.chapter,
      lineRange: [reading.line, reading.line],
      storyTime: null,
      triple: { bodyId: reading.bodyId, personaId: reading.mindId, identityId: reading.bodyId },
      source: id,
    });
    sceneFacts.push({
      id,
      chapter: reading.chapter,
      lineRange: [reading.line, reading.line],
      subject: reading.bodyId,
      predicate: "人格",
      value: reading.mindName,
      kind: "state",
      storyTime: null,
      modality: "narration",
      pov: null,
      speaker: null,
      topic: null,
    });
    places.set(id, { filePath: reading.filePath, line: reading.line });
  }
  return { scenes, sceneFacts, places };
}

/* ── 心の項目の付け替え（作者の判断⑥） ──────────────────── */

/** 本文の行がどの場面にあるかを引く（区切りの行で場面を分ける） */
function sceneIndexOf(episodes: readonly SceneClockEpisode[]) {
  const breaks = new Map<string, number[]>();
  for (const episode of episodes) {
    const lines: number[] = [];
    episode.text.split("\n").forEach((raw, index) => {
      if (isSceneBreakLine(raw.replace(/\r$/u, ""))) lines.push(index + 1);
    });
    breaks.set(episode.filePath, lines);
  }
  return (filePath: string, line: number): string =>
    `${filePath}\u0000${(breaks.get(filePath) ?? []).filter((at) => at < line).length}`;
}

function spanCoversChapter(span: DwellingSpan, chapter: number | null): boolean {
  if (span.fromChapter === undefined && span.untilChapter === undefined) return true;
  if (chapter === null) return false;
  if (span.fromChapter !== undefined && chapter < span.fromChapter) return false;
  if (span.untilChapter !== undefined && chapter > span.untilChapter) return false;
  return true;
}

/**
 * 憑依の場面で体の持ち主の名で抜かれた心の項目（一人称・口調・性格）を、
 * 心の側の人物へ付け替える（作者の判断⑥。設計担当の推奨「外す」ではない）。
 *
 * - 対象：本文から抜いた事実のうち、主語が組の体で、項目が心の項目で、話が
 *   記録の範囲の中のもの。範囲の外は本人の事実のまま
 * - 場面（区切りの行から次の区切りの行まで）の読みが、その体について**心を1人に
 *   決める**ときだけ付け替える。体の持ち主に決まれば、そのまま
 * - 決まらない（読みが無い・「分からない」・同居で2人）ときは、付け替えずに照合から外す
 *
 * 事実の id と行はそのまま（飛び先を変えない）。返すのは照合のための写しで、作者の
 * 人物の記録には書かない
 */
export function reassignMindFacts(input: {
  facts: readonly StoryFact[];
  places: ReadonlyMap<string, FactPlace>;
  episodes: readonly SceneClockEpisode[];
  readings: readonly AcceptedMindReading[];
  ledger: IdentityLedger;
}): {
  facts: StoryFact[];
  reassigned: Map<string, MindReassignment>;
  excluded: string[];
  /** 心の項目ごとの扱い（測定の内訳。組の体の名で抜かれたものだけ） */
  outcomes: Array<{ fact: StoryFact; outcome: "reassigned" | "excluded" | "owner" | "out_of_range" }>;
} {
  const { ledger } = input;
  const sceneOf = sceneIndexOf(input.episodes);
  const mindsByScene = new Map<string, Set<string>>();
  for (const reading of input.readings) {
    const key = `${reading.bodyId}\u0000${sceneOf(reading.filePath, reading.line)}`;
    const set = mindsByScene.get(key) ?? new Set<string>();
    // 「分からない」も1つの答えとして数える（混ざれば決まらない）
    set.add(reading.mindId ?? SCENE_MIND_UNKNOWN);
    mindsByScene.set(key, set);
  }

  const facts: StoryFact[] = [];
  const reassigned = new Map<string, MindReassignment>();
  const excluded: string[] = [];
  const outcomes: Array<{ fact: StoryFact; outcome: "reassigned" | "excluded" | "owner" | "out_of_range" }> = [];
  for (const fact of input.facts) {
    const mindItem = ledger.bodies.has(fact.subject) && MIND_PREDICATES.has(canonicalPredicate(fact.predicate));
    const target =
      mindItem &&
      ledger.spans.some((span) => span.bodyId === fact.subject && spanCoversChapter(span, fact.chapter));
    if (!target) {
      if (mindItem) outcomes.push({ fact, outcome: "out_of_range" });
      facts.push(fact);
      continue;
    }
    const place = input.places.get(fact.id);
    const minds = place
      ? mindsByScene.get(`${fact.subject}\u0000${sceneOf(place.filePath, place.line)}`)
      : undefined;
    const only = minds && minds.size === 1 ? [...minds][0] : undefined;
    if (!only || only === SCENE_MIND_UNKNOWN) {
      excluded.push(fact.id);
      outcomes.push({ fact, outcome: "excluded" });
      continue;
    }
    if (only === fact.subject) {
      facts.push(fact);
      outcomes.push({ fact, outcome: "owner" });
      continue;
    }
    outcomes.push({ fact, outcome: "reassigned" });
    facts.push({ ...fact, subject: only });
    reassigned.set(fact.id, {
      bodyId: fact.subject,
      bodyName: ledger.displayNames.get(fact.subject) ?? fact.subject,
      mindId: only,
      mindName: ledger.displayNames.get(only) ?? only,
    });
  }
  return { facts, reassigned, excluded, outcomes };
}

/* ── 通し ───────────────────────────────────────────────── */

/** AIへの1回の頼み。プロバイダ・控え・中止は呼ぶ側が持つ */
export interface IdentityCueAskRequest {
  stage: "sceneMind";
  systemPrompt: string;
  userPrompt: string;
  schema: unknown;
  temperature: number;
  /** 控えの指紋（チャンク＋組の一覧） */
  cacheId: string;
  /** 送る本文の字数（ログ用） */
  inputChars: number;
}

/** AIを呼ぶ口。JSONとして読めた答えを返す。送れなかった・読めなかったら undefined */
export type IdentityCueAsk = (request: IdentityCueAskRequest) => Promise<unknown | undefined>;

export interface IdentityCuesResult {
  /** 照合へ渡す本文の事実（心の項目を付け替え・外したあとの写し） */
  facts: StoryFact[];
  /** 表示用の場面の事実（`factById` にだけ入れる。`facts` には入れない） */
  sceneFacts: StoryFact[];
  /** 表示用の場面の事実の本文の場所（`places` へ足す） */
  scenePlaces: Map<string, FactPlace>;
  scenes: SceneIdentity[];
  /** 記録から組んだ遷移と、検算を通った本文の遷移 */
  transitions: IdentityTransition[];
  dwellings: DwellingSpan[];
  /** 人物の id → 名前（候補の理由の文に使う） */
  names: Map<string, string>;
  /** 心の側へ付け替えた事実（印。完了の知らせと候補の根拠に出す） */
  reassigned: Map<string, MindReassignment>;
  stats: IdentityCueStats;
}

/** 実行前の確認に出す、AIを呼ぶ回数（P-53 の送り先のチャンク数） */
export function plannedIdentityCueCalls(
  chunks: readonly Pick<Chunk, "text">[],
  characters: readonly Character[]
): number {
  const ledger = buildIdentityLedger(characters);
  if (ledger.spans.length === 0) return 0;
  return chunks.filter((chunk) => isIdentityChunk(chunk, ledger)).length;
}

/** 空の数え（記録が無い回・数え始め） */
function emptyStats(): IdentityCueStats {
  return {
    noDwellings: false,
    pairs: 0,
    unlinkedDwellings: 0,
    chunks: 0,
    readings: 0,
    unknownReadings: 0,
    rejected: 0,
    transitions: 0,
    reassignedFacts: 0,
    excludedFacts: 0,
    unrecorded: [],
    unrecordedTotal: 0,
    failures: 0,
    details: { readings: [], transitions: [], rejectedByReason: {}, scenes: [], mindFacts: [] },
  };
}

/** 内訳に載せる引用（頭だけ） */
function evidenceHead(evidence: string): string {
  return [...evidence].slice(0, DETAIL_EVIDENCE_CHARS).join("");
}

/**
 * P-37 のあと、照合の前に回す（設計書6.88.14 の流れ）：
 * 記録を結ぶ → 記録から遷移 → P-53（組の名前を含むチャンクだけ）→ 検算 →
 * 場面の事実の登録 → 心の項目の付け替え。
 *
 * 心と体の記録が無い作品は対象外（作者の判断①）——AIを呼ばず、案内だけ出す。
 */
export async function runIdentityCues(input: {
  characters: readonly Character[];
  /** 本文から抜いた事実（P-37）。設定資料から組んだ事実は渡さない */
  facts: readonly StoryFact[];
  places: ReadonlyMap<string, FactPlace>;
  /** 本文（場面の区切りを引く）。`filePath` は事実の置き場所と同じ書き方 */
  episodes: readonly SceneClockEpisode[];
  /** P-37 と同じチャンク（ここから P-53 の送り先を選ぶ） */
  chunks: readonly Chunk[];
  ask: IdentityCueAsk;
  /** 中止されたら true。訊く前に毎回見る */
  isCancelled?: () => boolean;
}): Promise<IdentityCuesResult> {
  const stats = emptyStats();
  const ledger = buildIdentityLedger(input.characters);
  stats.pairs = ledger.spans.length;
  stats.unlinkedDwellings = ledger.unlinked;
  if (ledger.spans.length === 0) {
    stats.noDwellings = true;
    return {
      facts: [...input.facts],
      sceneFacts: [],
      scenePlaces: new Map(),
      scenes: [],
      transitions: [],
      dwellings: [],
      names: ledger.displayNames,
      reassigned: new Map(),
      stats,
    };
  }
  const cancelled = () => input.isCancelled?.() === true;
  const pairs = pairsForPrompt(ledger);
  const schema = buildSceneMindExtractSchema(schemaNamesOf(ledger));

  const readings: AcceptedMindReading[] = [];
  const moves: AcceptedIdentityTransition[] = [];
  const seenReadings = new Set<string>();
  const seenMoves = new Set<string>();
  for (const chunk of input.chunks) {
    if (cancelled()) break;
    if (!isIdentityChunk(chunk, ledger)) continue;
    stats.chunks += 1;
    const chunkText = withLineNumbers(chunk);
    const raw = await input.ask({
      stage: "sceneMind",
      systemPrompt: SCENE_MIND_EXTRACT_SYSTEM_PROMPT,
      userPrompt: buildSceneMindExtractPrompt({ chunkTextWithLines: chunkText, pairs }),
      schema,
      temperature: SCENE_MIND_EXTRACT_TEMPERATURE,
      cacheId: identityChunkId(chunk, ledger),
      inputChars: chunkText.length,
    });
    if (raw === undefined) {
      stats.failures += 1;
      continue;
    }
    const checked = validateSceneMinds(raw, chunk, ledger);
    stats.rejected += checked.rejected.length;
    for (const entry of checked.rejected) {
      stats.details.rejectedByReason[entry.reason] = (stats.details.rejectedByReason[entry.reason] ?? 0) + 1;
    }
    for (const reading of checked.readings) {
      // まとめたチャンクの重なりで同じ読みが2度来ても、1件に数える
      const key = [reading.bodyId, reading.mindId ?? "", reading.filePath, reading.line].join("\u0000");
      if (seenReadings.has(key)) continue;
      seenReadings.add(key);
      readings.push(reading);
    }
    for (const move of checked.transitions) {
      const key = [move.kind, move.bodyId ?? "", move.toMindId, move.filePath, move.line].join("\u0000");
      if (seenMoves.has(key)) continue;
      seenMoves.add(key);
      moves.push(move);
    }
  }

  const named = readings.filter(
    (reading): reading is AcceptedMindReading & { mindId: string } => reading.mindId !== null
  );
  stats.readings = named.length;
  stats.unknownReadings = readings.length - named.length;
  stats.transitions = moves.length;

  const registered = registerIdentitySceneFacts(
    named.map((reading) => ({
      bodyId: reading.bodyId,
      mindId: reading.mindId,
      mindName: ledger.displayNames.get(reading.mindId) ?? reading.mindId,
      filePath: reading.filePath,
      line: reading.line,
      chapter: reading.chapter,
    }))
  );
  const moved = reassignMindFacts({
    facts: input.facts,
    places: input.places,
    episodes: input.episodes,
    readings,
    ledger,
  });
  stats.reassignedFacts = moved.reassigned.size;
  stats.excludedFacts = moved.excluded.length;

  const textTransitions: IdentityTransition[] = moves.map((move) => ({
    subject: move.toMindId,
    kind: move.kind,
    at: { storyTime: null, chapter: move.chapter, line: move.line },
    ...(move.bodyId ? { body: move.bodyId } : {}),
    toPersona: move.toMindId,
  }));

  // 記録に無い読み（作者の判断③：宿りは提案せず、完了の知らせで案内する）
  const recorded = (bodyId: string, mindId: string, chapter: number | null) =>
    mindId === bodyId ||
    ledger.spans.some(
      (span) => span.bodyId === bodyId && span.mindId === mindId && spanCoversChapter(span, chapter)
    );
  // 場面の読みと遷移が同じ1文を返すことがあるので、（体・心・話・引用）で1件にまとめる
  // （26b の実測で第6話の同じ読みが二重に並んだ）。幽霊・転生は体に宿る記録の話ではないので並べない
  const seenUnrecorded = new Set<string>();
  const unrecorded = [
    ...named.map((reading) => ({ bodyId: reading.bodyId, mindId: reading.mindId, chapter: reading.chapter, evidence: reading.evidence })),
    ...moves
      .filter((move) => move.bodyId !== undefined && move.kind !== "ghost" && move.kind !== "reincarnation")
      .map((move) => ({ bodyId: move.bodyId as string, mindId: move.toMindId, chapter: move.chapter, evidence: move.evidence })),
  ].filter((entry) => {
    if (recorded(entry.bodyId, entry.mindId, entry.chapter)) return false;
    const key = [entry.bodyId, entry.mindId, entry.chapter ?? "", normalizeForComparison(quoteCore(entry.evidence))].join("\u0000");
    if (seenUnrecorded.has(key)) return false;
    seenUnrecorded.add(key);
    return true;
  });
  stats.unrecordedTotal = unrecorded.length;
  stats.unrecorded = unrecorded.slice(0, UNRECORDED_SHOWN).map((entry) => ({
    chapter: entry.chapter,
    evidence: entry.evidence,
    bodyName: ledger.displayNames.get(entry.bodyId) ?? entry.bodyId,
    mindName: ledger.displayNames.get(entry.mindId) ?? entry.mindId,
  }));

  // 測定で原因を追うための内訳（MCP の stages.identity に出る）
  const nameOf = (id: string) => ledger.displayNames.get(id) ?? id;
  stats.details.readings = readings.map((reading) => ({
    chapter: reading.chapter,
    line: reading.line,
    body: nameOf(reading.bodyId),
    mind: reading.mindId === null ? SCENE_MIND_UNKNOWN : nameOf(reading.mindId),
    evidence: evidenceHead(reading.evidence),
  }));
  stats.details.transitions = moves.map((move) => ({
    chapter: move.chapter,
    line: move.line,
    kind: move.kind,
    body: move.bodyId ? nameOf(move.bodyId) : null,
    mind: nameOf(move.toMindId),
    evidence: evidenceHead(move.evidence),
  }));
  const allTransitions = [...transitionsFromDwellings(ledger.spans), ...textTransitions];
  stats.details.scenes = dwellingSceneVerdicts(registered.scenes, allTransitions, ledger.spans).map(
    (verdict) => ({
      chapter: verdict.current.chapter,
      line: verdict.current.lineRange[0],
      body: nameOf(verdict.body),
      mind: nameOf(verdict.mind),
      verdict: verdict.verdict,
    })
  );
  stats.details.mindFacts = moved.outcomes.map(({ fact, outcome }) => ({
    chapter: fact.chapter,
    line: fact.lineRange[0],
    subject: nameOf(fact.subject),
    predicate: fact.predicate,
    outcome,
  }));

  return {
    facts: moved.facts,
    sceneFacts: registered.sceneFacts,
    scenePlaces: registered.places,
    scenes: registered.scenes,
    transitions: allTransitions,
    dwellings: ledger.spans,
    names: ledger.displayNames,
    reassigned: moved.reassigned,
    stats,
  };
}
