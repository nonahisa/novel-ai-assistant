import type { Character, FirstPersonVariant } from "../models/character";
import { segmentsOf, type Chunk } from "./chunker";
import { evidenceSegments, normalizeForComparison } from "./groundedEvidence";
import { detectNarrator, firstPersonOwners, type NarratorHint } from "./narrator";
import { sceneRanges } from "./sceneBreaks";
import { countNarrationFirstPersons, narrationFirstPersonOf } from "./workStyleFacts";

/**
 * 場面ごとに一人称の語り手が入れ替わる作品で、**主人公でない語り手の場面**を
 * 見分ける（作者の裁定、2026-10-10「控えめな直しから」。設計書6.5.12）。
 *
 * 「ハイエルフ未亡人」は、区切り（「◇◆◇◆」）ごとに語り手が入れ替わる。
 * 第12話は皇子の章で、地の文は「余」。抽出はこの場面を主人公アジャーノ
 * （地の文の「俺」）の場面と読み、「余」をアジャーノの一人称の揺れとして
 * 記録した。再読込でも、紹介に「第12話から皇子」が残った。
 *
 * **AIは使わない。** 数えるのは地の文の一人称だけで、数え方は推敲の視点
 * （`proofreadValidation.ts` の場面の関門）と同じ——区切りと話の境で場面を割り、
 * `narrationFirstPersonOf` が一人称を決めた場面だけを見る。一人称の無い場面・
 * 主人公と同じ一人称の場面は、これまでどおり何もしない。
 *
 * VS Code に依存しない（製品と MCP が同じ関数を通る）。
 */

/**
 * 1つの場面の地の文に、その一人称が最低これだけ出ていること。
 *
 * 推敲の視点の場面の関門（`VIEWPOINT_SCENE_MIN_FIRST_PERSON`）と同じ2回。
 * **1回では決めない**——主人公の場面の地の文にも、別の人物の一人称が
 * 引用の形で1つ混じることはある
 */
export const FOREIGN_SCENE_MIN_FIRST_PERSON = 2;

/** 主人公でない語り手の場面（本文の中の文字位置。`end` は含まない） */
export interface ForeignNarrationScene {
  start: number;
  end: number;
  /** その場面の地の文の一人称（「余」） */
  firstPerson: string;
}

/** 頼み方と検算に渡す、作品の語り手 */
export interface WorkNarratorContext {
  /** 作品全体で決まった語り手（`detectNarrator`） */
  narrator: NarratorHint;
  /** 語り手の記録の名前と別名（抽出の答えが主人公のものかを見分ける） */
  narratorNames: string[];
  /** 人物の資料（場面の一人称の持ち主を数える） */
  people: readonly Character[];
}

/**
 * 作品の語り手を決める。決め方は矛盾検知・推敲と同じ（`detectNarrator`。
 * 全話を繋いだ本文を渡すこと）。決まらない作品では null——頼み方も検算も
 * 今までと1文字も変わらない。
 */
export function workNarratorContextOf(
  workBodyText: string,
  people: readonly Character[]
): WorkNarratorContext | null {
  const narrator = detectNarrator({ narrationText: workBodyText, people });
  if (!narrator) return null;
  const narratorNames = people
    .filter((person) => person.name.trim() === narrator.name)
    .flatMap((person) => [person.name, ...person.aliases])
    .map((name) => name.trim())
    .filter(Boolean);
  return { narrator, narratorNames: [...new Set(narratorNames)], people };
}

/**
 * 本文の中で、地の文が主人公と違う一人称で語られている場面を集める。
 *
 * @param extraStarts 区切り行のほかに場面が始まる位置（文字位置）。まとめた
 *   チャンクの話の境を渡す——話をまたいで1つの場面と数えないため
 */
export function foreignNarrationScenes(
  text: string,
  narratorFirstPerson: string,
  extraStarts: readonly number[] = []
): ForeignNarrationScene[] {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }
  const startLines = extraStarts.map((offset) => lineIndexAt(lineStarts, offset));
  const scenes: ForeignNarrationScene[] = [];
  for (const range of sceneRanges(lines, startLines)) {
    const body = lines.slice(range.start, range.end).join("\n");
    const found = narrationFirstPersonOf(body, FOREIGN_SCENE_MIN_FIRST_PERSON);
    if (!found || found.word === narratorFirstPerson) continue;
    if (!isForeignNarration(body, found.word, narratorFirstPerson)) continue;
    const start = lineStarts[range.start];
    scenes.push({ start, end: start + body.length, firstPerson: found.word });
  }
  return scenes;
}

/** チャンク版。話の境（`segmentsOf`）でも場面を割る */
export function foreignNarrationScenesInChunk(
  chunk: Chunk,
  narratorFirstPerson: string
): ForeignNarrationScene[] {
  return foreignNarrationScenes(
    chunk.text,
    narratorFirstPerson,
    segmentsOf(chunk).map((segment) => segment.start)
  );
}

/**
 * いちばん多い一人称が主人公と違っても、主人公でない語り手の場面とは
 * 言えない形を除く（実データ、2026-10-10 の測定）。
 *
 * - **主人公の一人称が地の文に1回でも出る場面**：主人公の語りである。
 *   ハイエルフ未亡人の第6話は「自分2・俺1」で、「自分」が多いだけの「俺」の話
 * - **「自分」**：一人称の語りにも、再帰の「自分で」「自分の」にも使う。
 *   「俺」の語りの「自分で焼いた」を別の語り手と取り違える
 */
function isForeignNarration(
  body: string,
  firstPerson: string,
  narratorFirstPerson: string
): boolean {
  if (firstPerson === "自分") return false;
  return (countNarrationFirstPersons(body).get(narratorFirstPerson) ?? 0) === 0;
}

function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  let index = 0;
  while (index + 1 < lineStarts.length && lineStarts[index + 1] <= offset) index++;
  return index;
}

/**
 * 根拠の引用が、主人公でない語り手の場面に**だけ**あるか。あればその場面。
 *
 * 引用の断片（`evidenceSegments`。照合と同じ切り方）のうち、本文に見つかった
 * ものが1つ以上あり、それがすべて主人公でない場面の中にあるときだけ返す。
 * 主人公の場面にも同じ断片があるなら決めない（null）——どちらの場面の
 * 引用か分からないものを落とさない。見つからない引用も null。
 */
export function foreignSceneOfEvidence(
  text: string,
  scenes: readonly ForeignNarrationScene[],
  evidence: string | null | undefined
): ForeignNarrationScene | null {
  if (scenes.length === 0) return null;
  const fragments = evidenceSegments(evidence);
  if (fragments.length === 0) return null;

  // 主人公の側（主人公でない場面を除いた残り）。場面の継ぎ目で断片が
  // つながって見えないよう、改行を挟んでつなぐ
  const sorted = [...scenes].sort((left, right) => left.start - right.start);
  const outside: string[] = [];
  let cursor = 0;
  for (const scene of sorted) {
    outside.push(text.slice(cursor, scene.start));
    cursor = scene.end;
  }
  outside.push(text.slice(cursor));
  const outsideText = normalizeForComparison(outside.join("\n"));

  let hit: ForeignNarrationScene | null = null;
  for (const fragment of fragments) {
    if (outsideText.includes(fragment)) return null;
    const scene = sorted.find((candidate) =>
      normalizeForComparison(text.slice(candidate.start, candidate.end)).includes(fragment)
    );
    if (scene && !hit) hit = scene;
  }
  return hit;
}

/** 頼み方に書く、主人公でない語り手の一人称1つ分 */
export interface ForeignNarratorForm {
  /** 地の文の一人称（「余」） */
  firstPerson: string;
  /**
   * その場面の語り手を名指しできるときだけ、その人の名前。決められなければ
   * null（名指ししない）。決め方は `sceneSpeakerOf`
   */
  speaker: string | null;
}

/** 頼み方に書き添える断り（`formatForeignNarratorNote` へ渡す） */
export interface ForeignNarratorNote {
  /** 主人公の名前 */
  narratorName: string;
  /** 主人公の地の文の一人称（「俺」） */
  narratorFirstPerson: string;
  forms: ForeignNarratorForm[];
}

/** 名前の照合に使う最短の長さ。1字の名前は本文のどこにでも出てしまう */
const SCENE_NAME_MIN_LENGTH = 2;

/**
 * その人物が、場面の本文に出ているか（2026-10-10、0.102.2。設計書6.5.12）。
 *
 * 名前か別名（2字以上）が場面の本文にあるか、その一人称の言い分けの根拠が
 * 場面の本文にあれば出ているとみる。**話ではなく場面で見る**——皇帝は第12話に
 * 登場するが、出てくるのは後半の皇帝と側近の場面で、地の文が「余」の前半
 * （皇子の場面）には名前も根拠も無い。
 */
export function appearsInScenes(
  person: Character,
  firstPerson: string | null,
  sceneTexts: readonly string[]
): boolean {
  const joined = normalizeForComparison(sceneTexts.join("\n"));
  if (!joined) return false;
  const names = [person.name, ...person.aliases]
    .map((name) => normalizeForComparison(name ?? ""))
    .filter((name) => name.length >= SCENE_NAME_MIN_LENGTH);
  if (names.some((name) => joined.includes(name))) return true;
  if (!firstPerson) return false;
  return person.firstPerson.variants.some(
    (variant) =>
      variant.form.trim() === firstPerson &&
      evidenceSegments(variant.evidence).some((fragment) => joined.includes(fragment))
  );
}

/** その一人称を地の文に持つ人物（既定か言い分け。完全一致）。主人公は除く */
function firstPersonHolders(
  firstPerson: string,
  context: WorkNarratorContext
): Character[] {
  const owners = new Set(firstPersonOwners(context.people, firstPerson));
  const holders: Character[] = [];
  for (const person of context.people) {
    if (!owners.has(person.name)) continue;
    if (isNarratorRecord([person.name, ...person.aliases], context)) continue;
    if (holders.some((holder) => holder.name === person.name)) continue;
    holders.push(person);
  }
  return holders;
}

/**
 * 主人公でない語り手の場面の、語り手を名指しできるならその人物（0.102.2）。
 *
 * その一人称を持つ人物（主人公を除く）のうち、**その場面の本文に出ている
 * 人物がちょうど1人**のときだけ（`appearsInScenes`）。0.102.1 は「持ち主が
 * 資料にちょうど1人」だけで決めていたので、主人公の資料から取り違えの「余」を
 * 外すと持ち主が皇帝1人になり、皇子の場面を「語り手は皇帝」と誤って
 * 名指しするところだった（0.102.1 の懸念2）。場面の本文が渡らなければ
 * 名指ししない（迷ったら名指ししない側へ倒す）。
 */
export function sceneSpeakerOf(
  firstPerson: string,
  sceneTexts: readonly string[],
  context: WorkNarratorContext
): Character | null {
  if (sceneTexts.length === 0) return null;
  const present = firstPersonHolders(firstPerson, context).filter((person) =>
    appearsInScenes(person, firstPerson, sceneTexts)
  );
  return present.length === 1 ? present[0] : null;
}

/**
 * 場面の本文に名前（別名）が出ている人物（主人公を除く）。語り手を名指し
 * できないとき、移し先を作者に選ばせる候補にする
 */
export function sceneCandidatesOf(
  sceneTexts: readonly string[],
  context: WorkNarratorContext
): Character[] {
  const found: Character[] = [];
  for (const person of context.people) {
    if (isNarratorRecord([person.name, ...person.aliases], context)) continue;
    if (found.some((entry) => entry.id === person.id)) continue;
    if (appearsInScenes(person, null, sceneTexts)) found.push(person);
  }
  return found;
}

/** 頼み方の断りに渡す場面1つ分。`text` は場面の本文（名指しに使う） */
export interface ForeignSceneOfNote {
  firstPerson: string;
  text?: string;
}

/** 場面の一覧に、場面の本文を添える（`foreignNarratorNoteOf` へ渡す形） */
export function withSceneText(
  text: string,
  scenes: readonly ForeignNarrationScene[]
): ForeignSceneOfNote[] {
  return scenes.map((scene) => ({
    firstPerson: scene.firstPerson,
    text: text.slice(scene.start, scene.end),
  }));
}

/**
 * 場面の一覧から、頼み方に書き添える断りを組む。主人公でない場面が無ければ null。
 *
 * **名指しは `sceneSpeakerOf` が決める**——その一人称を持つ人物（主人公を除く）
 * のうち、場面の本文に出ている人物がちょうど1人のときだけ（0.102.2）。数え方は
 * `detectNarrator` と同じ（`firstPersonOwners`。既定と言い分けの完全一致・
 * 名前で畳む）。**主人公自身は名指ししない**——主人公の資料に取り違えで入った
 * 言い分け（アジャーノの「余」）を根拠に「語り手はアジャーノ」と書けば、
 * 断り書きが取り違えを裏書きしてしまう。
 */
export function foreignNarratorNoteOf(
  scenes: readonly ForeignSceneOfNote[],
  context: WorkNarratorContext
): ForeignNarratorNote | null {
  const order: string[] = [];
  const textsByForm = new Map<string, string[]>();
  for (const scene of scenes) {
    let texts = textsByForm.get(scene.firstPerson);
    if (!texts) {
      texts = [];
      order.push(scene.firstPerson);
      textsByForm.set(scene.firstPerson, texts);
    }
    if (scene.text) texts.push(scene.text);
  }
  if (order.length === 0) return null;
  const forms: ForeignNarratorForm[] = order.map((firstPerson) => ({
    firstPerson,
    speaker:
      sceneSpeakerOf(firstPerson, textsByForm.get(firstPerson) ?? [], context)?.name ??
      null,
  }));
  return {
    narratorName: context.narrator.name,
    narratorFirstPerson: context.narrator.firstPerson,
    forms,
  };
}

/**
 * 抽出の答え（または再読込の対象）が主人公のものか。名前・別名の
 * どれかが主人公の名前・別名と同じなら主人公とみる（空白の違いは同じとみる）。
 */
export function isNarratorRecord(
  names: ReadonlyArray<string | null | undefined>,
  context: WorkNarratorContext
): boolean {
  const own = new Set(context.narratorNames.map(normalizeForComparison));
  return names.some((name) => {
    const key = normalizeForComparison(name ?? "");
    return key.length > 0 && own.has(key);
  });
}

/** 本文の抜粋の出典（`ExcerptSource` のうち、ここで使う分） */
export interface NarrationSource {
  label: string;
  text: string;
  /** 最後の話数（読めなければ null） */
  chapter?: number | null;
}

/**
 * 本文の抜粋ごとに、その抜粋に入っている主人公でない場面の一人称を返す
 * （再読込の頼み方の印に使う）。見つからない抜粋は空。
 */
export function foreignFormsOfExcerpts(
  excerpts: ReadonlyArray<{ label: string; text: string }>,
  sources: readonly NarrationSource[],
  narratorFirstPerson: string
): string[][] {
  return foreignScenesOfExcerpts(excerpts, sources, narratorFirstPerson).map(
    (scenes) => [...new Set(scenes.map((scene) => scene.firstPerson))]
  );
}

/**
 * 本文の抜粋ごとに、その抜粋に重なる主人公でない場面（場面の本文つき）を返す。
 * 抜粋は出典の本文の一部をそのまま切ったものなので、出典の中で位置を探して
 * 場面と重ねる。見つからない抜粋は空。
 */
function foreignScenesOfExcerpts(
  excerpts: ReadonlyArray<{ label: string; text: string }>,
  sources: readonly NarrationSource[],
  narratorFirstPerson: string
): ForeignSceneOfNote[][] {
  const scenesByLabel = new Map<string, ForeignNarrationScene[]>();
  const textByLabel = new Map<string, string>();
  for (const source of sources) {
    textByLabel.set(source.label, source.text);
  }
  return excerpts.map((excerpt) => {
    const text = textByLabel.get(excerpt.label);
    if (text === undefined || !excerpt.text) return [];
    const start = text.indexOf(excerpt.text);
    if (start < 0) return [];
    const end = start + excerpt.text.length;
    let scenes = scenesByLabel.get(excerpt.label);
    if (!scenes) {
      scenes = foreignNarrationScenes(text, narratorFirstPerson);
      scenesByLabel.set(excerpt.label, scenes);
    }
    return withSceneText(
      text,
      scenes.filter((scene) => !(scene.end <= start || scene.start >= end))
    );
  });
}

/**
 * 再読込（P-20）の頼み方に渡す断り。対象が主人公で、抜粋のどれかに主人公でない
 * 語り手の場面が入るときだけ返す（それ以外は null＝頼み方は今までどおり）。
 * `excerptForms` は抜粋と同じ順。
 */
export function enrichForeignNarratorOf(
  target: { name: string; aliases: readonly string[] },
  excerpts: ReadonlyArray<{ label: string; text: string }>,
  sources: readonly NarrationSource[],
  context: WorkNarratorContext | null
): { note: ForeignNarratorNote; excerptForms: string[][] } | null {
  if (!context || !isNarratorRecord([target.name, ...target.aliases], context)) {
    return null;
  }
  const excerptScenes = foreignScenesOfExcerpts(
    excerpts,
    sources,
    context.narrator.firstPerson
  );
  const excerptForms = excerptScenes.map((scenes) => [
    ...new Set(scenes.map((scene) => scene.firstPerson)),
  ]);
  const note = foreignNarratorNoteOf(excerptScenes.flat(), context);
  return note ? { note, excerptForms } : null;
}

/** 語り手の取り違えで入った疑いのある、一人称の言い分け */
export interface SuspectFirstPersonVariant {
  variant: FirstPersonVariant;
  /** 主人公でない語り手の場面のある話 */
  chapters: number[];
}

/**
 * 主人公の資料にある一人称の言い分けのうち、**語り手の取り違えで入った疑い**の
 * あるもの（裁定4。外すかどうかは作者が承認して決める。自動では消さない）。
 *
 * 疑うのは次の全部が揃ったとき。
 * 1. 言い分けの形が主人公の地の文の一人称と違う
 * 2. 言い分けの話のどれかに、**その形を地の文の一人称とする**主人公でない場面がある
 * 3. 根拠の引用が、主人公の場面に見つからない（見つかれば主人公が本当に
 *    言い分けた所かもしれないので疑わない）
 *
 * @param sources 話ごとの本文（`chapter` が言い分けの話と突き合う）
 */
export function suspectForeignFirstPersonVariants(
  character: Character,
  context: WorkNarratorContext,
  sources: readonly NarrationSource[]
): SuspectFirstPersonVariant[] {
  if (!isNarratorRecord([character.name, ...character.aliases], context)) return [];
  const suspects: SuspectFirstPersonVariant[] = [];
  for (const variant of character.firstPerson.variants) {
    const form = variant.form.trim();
    if (!form || form === context.narrator.firstPerson) continue;
    const chapters: number[] = [];
    let groundedInNarratorScene = false;
    for (const source of sources) {
      if (source.chapter === null || source.chapter === undefined) continue;
      if (!variant.chapters.includes(source.chapter)) continue;
      const scenes = foreignNarrationScenes(source.text, context.narrator.firstPerson);
      const same = scenes.filter((scene) => scene.firstPerson === form);
      if (same.length === 0) continue;
      if (
        variant.evidence &&
        evidenceInNarratorScene(source.text, context.narrator.firstPerson, variant.evidence)
      ) {
        groundedInNarratorScene = true;
      }
      if (!chapters.includes(source.chapter)) chapters.push(source.chapter);
    }
    if (chapters.length === 0 || groundedInNarratorScene) continue;
    suspects.push({ variant, chapters: chapters.sort((a, b) => a - b) });
  }
  return suspects;
}

/**
 * 外す案として作者に見せる文（画面と MCP で同じもの）。
 * `before` は今の言い分け、`after` は選んだら起きること
 */
export function describeSuspectVariant(suspect: SuspectFirstPersonVariant): {
  label: string;
  before: string;
  after: string;
} {
  const { variant } = suspect;
  const chapters = variant.chapters.length > 0 ? `第${variant.chapters.join("・")}話` : "話数なし";
  return {
    label: `一人称の言い分け「${variant.form}」`,
    before:
      `${variant.form}（${chapters}）` +
      (variant.evidence ? ` 根拠「${variant.evidence}」` : ""),
    after:
      `外す（第${suspect.chapters.join("・")}話の地の文が「${variant.form}」で語られる場面は、` +
      "ほかの語り手の場面のため、取り違えで入った疑いがあります）",
  };
}

/**
 * 引用の断片が、**主人公の一人称で語られている場面**に見つかるか。
 *
 * 「主人公でない場面の外」では足りない（実データ、2026-10-10）。第12話の
 * 根拠「皇子殿下は、どの教科も優秀でございます」は、皇子の章の後半——
 * 一人称の無い、皇帝と側近の場面——の台詞で、そこを主人公の側と数えると
 * 取り違えの言い分けを疑えなかった
 */
export function evidenceInNarratorScene(
  text: string,
  narratorFirstPerson: string,
  evidence: string
): boolean {
  const fragments = evidenceSegments(evidence);
  if (fragments.length === 0) return false;
  const lines = text.split("\n");
  return sceneRanges(lines).some((range) => {
    const body = lines.slice(range.start, range.end).join("\n");
    const found = narrationFirstPersonOf(body, FOREIGN_SCENE_MIN_FIRST_PERSON);
    if (found?.word !== narratorFirstPerson) return false;
    const normalized = normalizeForComparison(body);
    return fragments.some((fragment) => normalized.includes(fragment));
  });
}
