import {
  isCharacterTextField,
  type AddressForm,
  type Character,
  type CharacterRelation,
  type FirstPersonVariant,
  type PersonalityFacet,
  type RejectedValue,
} from "../models/character";
import type { RecordChange } from "../models/jsonValidation";
import { CHARACTER_FIELD_LABELS } from "./characterFieldLabels";
import { createNameResolver } from "./characterNameResolve";
import { normalizeForComparison } from "./groundedEvidence";
import { sha1Text } from "./hash";
import {
  addFacetTo,
  composePersonality,
  isBodyComposedOfFacets,
} from "./personalityFacets";
import { changeEntryKey, latestValueOfField } from "./recordChanges";
import { recordRemovedRelations } from "./rejectedRelations";
import {
  evidenceInNarratorScene,
  foreignNarrationScenes,
  isNarratorRecord,
  sceneCandidatesOf,
  sceneSpeakerOf,
  type NarrationSource,
  type WorkNarratorContext,
} from "./sceneNarrators";
import { countNarrationFirstPersons } from "./workStyleFacts";

/**
 * 語り手の取り違えで主人公の資料に入った値を、本来の人物の資料へ移す案
 * （作者の裁定、2026-10-10「殿下の資料へ移す案」。設計書6.5.12）。
 *
 * 「ハイエルフ未亡人」の主人公アジャーノの資料には、皇子の章（第12話。地の文
 * 「余」）から入った値が残っていた——役割「皇子」・所属「皇室」・第12話の
 * 性格・関係「皇帝=子」・呼称「殿下」・一人称の言い分け「余」。0.102.1 は
 * 一人称の言い分けだけを外す案にしたが、ほかの項目は再読込の【現在の設定】に
 * 載り続け、紹介に「第12話から皇子」が出続けた。
 *
 * ## 見つけ方（AIは使わない）
 *
 * 1. **ほかの語り手の場面だけの話**を先に決める（`foreignOnlyChapters`）：
 *    その話に主人公でない語り手の場面が1つ以上あり、地の文に主人公の一人称が
 *    1回も無く、主人公の名前・別名が本文のどこにも出ない話
 * 2. 値の話数（変化の記録・面・呼称の範囲・関係の話・言い分け・登場話）が
 *    **全部その集合に入る**値だけを疑う。主人公の場面のある話を1つでも含む
 *    値は対象外（主人公が本当にそうだったのかもしれない）
 * 3. 根拠の引用があれば、主人公の一人称で語られる場面に無いことも確かめる
 *
 * ## 移し先
 *
 * その場面の語り手を名指しできるとき（`sceneSpeakerOf`：その一人称を持つ
 * 人物のうち、場面の本文に出ている人物がちょうど1人）はその人物。名指し
 * できないときは、場面の本文に名前が出ている人物を候補に並べ、作者に選ばせる
 * （選ばなければ外すだけ）。
 *
 * **作者が承認したものだけを動かす**（`applyNarratorMoves`）。移し先の値は
 * 上書きせず足すだけ、主人公から外した値は退けた記録（`rejectedValues`・
 * `rejectedRelations`）へ残して、次の抽出が積み戻さないようにする。
 *
 * VS Code に依存しない（設定資料パネルと MCP の `settingsEnrich` が同じ関数を通る）。
 */

/** 移す案の種類（項目ごとに話数の持ち方が違う。`models/character.ts`） */
export type NarratorMoveKind =
  | "change"
  | "personalityFacet"
  | "speechStyleFacet"
  | "relation"
  | "address"
  | "firstPersonVariant"
  | "appearedChapters";

/** 移し先の候補1人 */
export interface MoveDestinationOption {
  id: string;
  name: string;
}

/**
 * 移し先。`named` は語り手を名指しできたとき（既定でその人を選ぶ）。
 * どちらも `candidates` に、作者が選び直せる人物を並べる（名指しした人を先頭に）
 */
export type NarratorMoveDestination =
  | { kind: "named"; id: string; name: string; candidates: MoveDestinationOption[] }
  | { kind: "choose"; candidates: MoveDestinationOption[] };

/** 移す案1件 */
export interface NarratorMoveItem {
  kind: NarratorMoveKind;
  /** 作者が読む項目名（「役割」「性格の面」「呼称」） */
  label: string;
  /** 作者が読む値（「皇子」「皇帝=子」） */
  value: string;
  /** 値の話数（全部がほかの語り手の場面だけの話） */
  chapters: number[];
  evidence: string | null;
  /** その話の、主人公でない語り手の場面の地の文の一人称（「余」） */
  firstPersons: string[];
  destination: NarratorMoveDestination;
  /** 照合用の中身。反映のときに、いまの資料から同じものを探す */
  change?: RecordChange;
  facet?: PersonalityFacet;
  relation?: CharacterRelation;
  address?: { targetName: string; form: AddressForm };
  variant?: FirstPersonVariant;
}

/** ほかの語り手の場面だけの話1つ分 */
export interface ForeignOnlyChapter {
  chapter: number;
  /** 主人公でない語り手の場面（地の文の一人称と場面の本文） */
  scenes: Array<{ firstPerson: string; text: string }>;
}

/**
 * ほかの語り手の場面だけの話を集める（見つけ方の1）。
 *
 * 同じ話数の出典が複数あれば、どれか1つでも主人公の話なら外す。
 */
export function foreignOnlyChapters(
  sources: readonly NarrationSource[],
  context: WorkNarratorContext
): Map<number, ForeignOnlyChapter> {
  const narratorFirstPerson = context.narrator.firstPerson;
  const names = context.narratorNames
    .map((name) => normalizeForComparison(name))
    .filter((name) => name.length >= 2);
  const found = new Map<number, ForeignOnlyChapter>();
  const blocked = new Set<number>();
  for (const source of sources) {
    const chapter = source.chapter;
    if (chapter === null || chapter === undefined) continue;
    const scenes = foreignNarrationScenes(source.text, narratorFirstPerson);
    const normalized = normalizeForComparison(source.text);
    const narratorTells =
      (countNarrationFirstPersons(source.text).get(narratorFirstPerson) ?? 0) > 0;
    // 主人公の名前が出る話は、三人称の場面に主人公が居るのかもしれない。疑わない
    const narratorNamed = names.some((name) => normalized.includes(name));
    if (scenes.length === 0 || narratorTells || narratorNamed) {
      blocked.add(chapter);
      found.delete(chapter);
      continue;
    }
    if (blocked.has(chapter)) continue;
    const entry = found.get(chapter) ?? { chapter, scenes: [] };
    for (const scene of scenes) {
      entry.scenes.push({
        firstPerson: scene.firstPerson,
        text: source.text.slice(scene.start, scene.end),
      });
    }
    found.set(chapter, entry);
  }
  return found;
}

/**
 * 主人公の資料のうち、語り手の取り違えで入った疑いのある値を、移す案として集める。
 * 主人公でない記録・ほかの語り手の場面だけの話が無い作品では空。
 *
 * @param sources 話ごとの本文（`chapter` が値の話数と突き合う）
 */
export function findNarratorMoves(
  character: Character,
  context: WorkNarratorContext,
  sources: readonly NarrationSource[]
): NarratorMoveItem[] {
  if (!isNarratorRecord([character.name, ...character.aliases], context)) return [];
  const foreign = foreignOnlyChapters(sources, context);
  if (foreign.size === 0) return [];

  const narratorFirstPerson = context.narrator.firstPerson;
  const sourcesOf = (chapter: number) =>
    sources.filter((source) => source.chapter === chapter);
  const onlyForeign = (chapters: readonly number[], evidence: string | null | undefined) =>
    chapters.length > 0 &&
    chapters.every((chapter) => foreign.has(chapter)) &&
    !(
      evidence &&
      chapters.some((chapter) =>
        sourcesOf(chapter).some((source) =>
          evidenceInNarratorScene(source.text, narratorFirstPerson, evidence)
        )
      )
    );

  const items: NarratorMoveItem[] = [];
  const add = (
    item: Omit<NarratorMoveItem, "destination" | "firstPersons" | "chapters"> & {
      chapters: readonly number[];
    }
  ) => {
    const chapters = sortedUnique(item.chapters);
    const where = destinationOf(chapters, foreign, context, character.id);
    items.push({ ...item, chapters, ...where });
  };

  // 変化の記録（役割・所属・紹介・性格など）。作者が書いた・認めた記録は動かさない
  for (const change of character.changes) {
    if (change.source === "author" || change.confirmed === true) continue;
    if (!onlyForeign(change.chapters, change.evidence)) continue;
    add({
      kind: "change",
      label: fieldLabel(change.field),
      value: change.value,
      chapters: change.chapters,
      evidence: change.evidence,
      change,
    });
  }

  // 性格・口調の面
  for (const facet of character.personalityFacets ?? []) {
    if (!onlyForeign(facet.chapters, facet.evidence)) continue;
    add({
      kind: "personalityFacet",
      label: "性格の面",
      value: facet.value,
      chapters: facet.chapters,
      evidence: facet.evidence,
      facet,
    });
  }
  for (const facet of character.speechStyleFacets ?? []) {
    if (!onlyForeign(facet.chapters, facet.evidence)) continue;
    add({
      kind: "speechStyleFacet",
      label: "口調の面",
      value: facet.value,
      chapters: facet.chapters,
      evidence: facet.evidence,
      facet,
    });
  }

  // 関係
  const resolve = createNameResolver(context.people);
  for (const relation of character.relations) {
    const chapters = relationChapters(relation, character, context.people, resolve);
    if (!onlyForeign(chapters, null)) continue;
    add({
      kind: "relation",
      label: "関係",
      value: `${relation.name}=${relation.relation}`,
      chapters,
      evidence: null,
      relation,
    });
  }

  // 呼称（作者が固定した呼称は動かさない。実装ルール2）
  for (const term of character.addressTerms) {
    if (term.authorLocked) continue;
    for (const form of term.forms) {
      const chapters = addressChapters(form);
      if (!onlyForeign(chapters, form.evidence)) continue;
      add({
        kind: "address",
        label: "呼称",
        value: `${form.term}（相手：${term.targetName}）`,
        chapters,
        evidence: form.evidence,
        address: { targetName: term.targetName, form },
      });
    }
  }

  // 一人称の言い分け
  for (const variant of character.firstPerson.variants) {
    const form = variant.form.trim();
    if (!form || form === narratorFirstPerson) continue;
    if (!onlyForeign(variant.chapters, variant.evidence)) continue;
    add({
      kind: "firstPersonVariant",
      label: "一人称の言い分け",
      value: form,
      chapters: variant.chapters,
      evidence: variant.evidence,
      variant,
    });
  }

  // 登場話
  const appeared = character.appearedChapters.filter((chapter) => foreign.has(chapter));
  if (appeared.length > 0) {
    add({
      kind: "appearedChapters",
      label: "登場話",
      value: appeared.map((chapter) => `第${chapter}話`).join("・"),
      chapters: appeared,
      evidence: null,
    });
  }

  return items;
}

/**
 * 関係の話数。抽出が拾った話（`firstChapter`）があればそれ。
 *
 * **無ければ、相手の登場話と主人公の登場話の重なり**（0.102.2）。抽出が関係に
 * 話数を付けるようになる前の資料（「皇帝=子」）は話数を持たない。相手が
 * 資料に見つからない・重なりが無ければ空（＝疑わない）
 */
function relationChapters(
  relation: CharacterRelation,
  character: Character,
  people: readonly Character[],
  resolve: ReturnType<typeof createNameResolver>
): number[] {
  if (typeof relation.firstChapter === "number") return [relation.firstChapter];
  const resolved = resolve(relation.name);
  const target = resolved.id ? people.find((person) => person.id === resolved.id) : undefined;
  if (!target || target.id === character.id) return [];
  const own = new Set(character.appearedChapters);
  return target.appearedChapters.filter((chapter) => own.has(chapter));
}

/** 呼称の話数（最初と最後の話の範囲）。どちらも無ければ空 */
function addressChapters(form: AddressForm): number[] {
  const first = form.firstChapter ?? form.lastChapter;
  const last = form.lastChapter ?? form.firstChapter;
  if (first === null || last === null) return [];
  const chapters: number[] = [];
  for (let chapter = Math.min(first, last); chapter <= Math.max(first, last); chapter++) {
    chapters.push(chapter);
  }
  return chapters;
}

/** 値の話数から、移し先（名指し・候補）を決める */
function destinationOf(
  chapters: readonly number[],
  foreign: ReadonlyMap<number, ForeignOnlyChapter>,
  context: WorkNarratorContext,
  sourceId: string
): Pick<NarratorMoveItem, "destination" | "firstPersons"> {
  const textsByForm = new Map<string, string[]>();
  for (const chapter of chapters) {
    for (const scene of foreign.get(chapter)?.scenes ?? []) {
      const texts = textsByForm.get(scene.firstPerson) ?? [];
      texts.push(scene.text);
      textsByForm.set(scene.firstPerson, texts);
    }
  }
  const firstPersons = [...textsByForm.keys()];
  const allTexts = [...textsByForm.values()].flat();

  // 一人称ごとに語り手を決め、全部が同じ1人に決まったときだけ名指しする
  const speakers = firstPersons.map((firstPerson) =>
    sceneSpeakerOf(firstPerson, textsByForm.get(firstPerson) ?? [], context)
  );
  const first = speakers[0];
  const named =
    first && first.id !== sourceId && speakers.every((speaker) => speaker?.id === first.id)
      ? first
      : null;

  const candidates: MoveDestinationOption[] = [];
  const push = (person: Character) => {
    if (person.id === sourceId) return;
    if (candidates.some((entry) => entry.id === person.id)) return;
    candidates.push({ id: person.id, name: person.name });
  };
  if (named) push(named);
  for (const person of sceneCandidatesOf(allTexts, context)) push(person);

  return {
    firstPersons,
    destination: named
      ? { kind: "named", id: named.id, name: named.name, candidates }
      : { kind: "choose", candidates },
  };
}

/**
 * 移す案を作者に見せる文（画面と MCP で同じもの）。
 * `before` はいまの値、`reason` はなぜ疑ったか
 */
export function describeNarratorMove(item: NarratorMoveItem): {
  label: string;
  before: string;
  reason: string;
} {
  const chapters = item.chapters.map((chapter) => `第${chapter}話`).join("・");
  const forms = item.firstPersons.map((form) => `「${form}」`).join("・");
  const destination =
    item.destination.kind === "named"
      ? `移し先は、その場面の語り手の「${item.destination.name}」です。`
      : item.destination.candidates.length > 0
        ? "その場面の語り手を決められなかったので、移し先を選んでください（選ばなければ外すだけです）。"
        : "その場面の語り手を決められず、場面に名前の出る人物もいないので、外すだけになります。";
  // 登場話は値そのものが話数なので、話数を二度書かない
  const appeared = item.kind === "appearedChapters";
  return {
    label: appeared
      ? `移す案：${item.label}（${chapters}）`
      : `移す案：${item.label}「${item.value}」（${chapters}）`,
    before: appeared
      ? chapters
      : `${item.value}（${chapters}）` + (item.evidence ? ` 根拠「${item.evidence}」` : ""),
    reason:
      `${chapters}は、地の文が${forms}で語られる、ほかの語り手の場面だけの話です。` +
      `語り手の取り違えで入った疑いがあります。${destination}`,
  };
}

/** 作者の選び（移し先の id。null は「外すだけ」） */
export interface NarratorMoveChoice {
  item: NarratorMoveItem;
  destinationId: string | null;
}

export interface NarratorMoveOutcome {
  /** 外したあとの主人公。**元のレコードは書き換えない** */
  source: Character;
  /** 足したあとの移し先（変わったものだけ） */
  destinations: Character[];
  /** 移した件数・外すだけにした件数・いまの資料に見つからなかった件数 */
  moved: number;
  removedOnly: number;
  missing: number;
  /** 移し先の値を上書きしなかったことの説明（黙って据え置いたことにしない） */
  notes: string[];
}

/**
 * 作者が選んだ移す案を反映する（**承認したときだけ呼ぶ**）。
 *
 * - 主人公から外す。外した文の値は `rejectedValues`、関係は `rejectedRelations`
 *   へ残す（次の抽出が積み戻さないように。黙って消さない）
 * - 本体の値が外した変化の値だったら、残った変化のいちばん後ろの話の値へ戻す
 *   （無ければ空）。面で組んだ本体は、残った面で組み直す
 * - 移し先には足すだけ。**移し先の本体に値があれば上書きしない**——変化の記録と
 *   面へ残し、そのことを `notes` に書く。作者が固定した呼称（`authorLocked`）には
 *   足さない。作者が確定させた人物（`autoGenerated: false`）の面の本体の文章は
 *   書き換えない
 *
 * 保存は呼び出し側（移し先を先に、主人公をあとに `saveOrUpdate`。主人公から
 * 外す分だけが先に着地して値が消える形にしない）。
 */
export function applyNarratorMoves(
  source: Character,
  people: readonly Character[],
  choices: readonly NarratorMoveChoice[],
  now: string
): NarratorMoveOutcome {
  const result: Character = structuredClone(source);
  const destinations = new Map<string, Character>();
  const notes: string[] = [];
  let moved = 0;
  let removedOnly = 0;
  let missing = 0;

  const personalityComposed = isBodyComposedOfFacets(source);
  const speechComposed = isBodyComposedOfFacets({
    personality: source.speechStyle,
    personalityFacets: source.speechStyleFacets,
  });
  const bodyFields = new Set<string>();
  const removedRelations: CharacterRelation[] = [];
  const rejected: RejectedValue[] = [];

  const destinationFor = (id: string | null): Character | null => {
    if (!id || id === source.id) return null;
    const existing = destinations.get(id);
    if (existing) return existing;
    const person = people.find((entry) => entry.id === id);
    if (!person) return null;
    const copy = structuredClone(person);
    destinations.set(id, copy);
    return copy;
  };

  for (const choice of choices) {
    const { item } = choice;
    const removed = removeFrom(result, item);
    if (!removed) {
      missing++;
      continue;
    }
    if (item.kind === "change" && item.change) {
      rejected.push(rejectedValueOf(item.change.field, item.change.value, item.change.chapters, item.change.evidence, now));
      if (bodyValue(source, item.change.field) === item.change.value) {
        bodyFields.add(item.change.field);
      }
    }
    if ((item.kind === "personalityFacet" || item.kind === "speechStyleFacet") && item.facet) {
      const field = item.kind === "personalityFacet" ? "personality" : "speechStyle";
      rejected.push(rejectedValueOf(field, item.facet.value, item.facet.chapters, item.facet.evidence, now));
    }
    if (item.kind === "relation" && item.relation) removedRelations.push(item.relation);

    const destination = destinationFor(choice.destinationId);
    if (!destination) {
      removedOnly++;
      continue;
    }
    addTo(destination, item, source, notes);
    moved++;
  }

  // 本体の巻き戻し
  for (const field of bodyFields) {
    const rest = latestValueOfField(result.changes, field) ?? null;
    setBodyValue(result, field, rest);
  }
  if (personalityComposed) {
    result.personality = composePersonality(result.personalityFacets);
  }
  if (speechComposed) {
    result.speechStyle = composePersonality(result.speechStyleFacets);
  }

  // 退けた記録（同じものは二重に残さない）
  for (const entry of rejected) {
    const list = result.rejectedValues ?? [];
    if (list.some((item) => item.field === entry.field && item.value === entry.value)) continue;
    result.rejectedValues = [...list, entry];
  }
  if (removedRelations.length > 0) {
    result.rejectedRelations = recordRemovedRelations({
      before: source.relations,
      after: result.relations,
      rejected: source.rejectedRelations,
      characters: people,
      via: "panel",
      now,
    });
  }

  return {
    source: result,
    destinations: [...destinations.values()],
    moved,
    removedOnly,
    missing,
    notes,
  };
}

/**
 * 移す案1件の鍵（提案パネルの承認待ち・見送りの記録。0.102.3）。
 *
 * **`removeFrom` が照合に使うのと同じ材料で組む**——同じ値・同じ話数の案は
 * 同じ鍵になり、承認待ちへ二重に積まない・見送った案を積み直さない。
 * 移し先・根拠・項目名は入れない（移し先の候補は資料が増えると変わる。
 * 根拠の引用は抽出のたびに揺れる）。主人公の id を含めるのは、別の人物の
 * 同じ値と取り違えないため。
 */
export function narratorMoveKey(sourceId: string, item: NarratorMoveItem): string {
  return sha1Text([sourceId, item.kind, ...narratorMoveIdentity(item)].join("\u0000")).slice(0, 24);
}

/** 鍵の材料（`removeFrom` の照合と同じ項目） */
function narratorMoveIdentity(item: NarratorMoveItem): string[] {
  switch (item.kind) {
    case "change":
      return item.change ? [changeEntryKey(item.change)] : [item.value];
    case "personalityFacet":
    case "speechStyleFacet":
      return item.facet
        ? [item.facet.value, item.facet.chapters.join(",")]
        : [item.value, item.chapters.join(",")];
    case "relation":
      return item.relation
        ? [item.relation.name, item.relation.relation, String(item.relation.firstChapter ?? "")]
        : [item.value];
    case "address":
      return item.address
        ? [
            item.address.targetName,
            item.address.form.term,
            String(item.address.form.firstChapter ?? ""),
            String(item.address.form.lastChapter ?? ""),
          ]
        : [item.value];
    case "firstPersonVariant":
      return item.variant
        ? [item.variant.form, item.variant.chapters.join(",")]
        : [item.value, item.chapters.join(",")];
    case "appearedChapters":
      return [item.chapters.join(",")];
  }
}

/** 主人公から1件外す。いまの資料に見つからなければ false */
function removeFrom(record: Character, item: NarratorMoveItem): boolean {
  switch (item.kind) {
    case "change": {
      if (!item.change) return false;
      const key = changeEntryKey(item.change);
      const index = record.changes.findIndex((change) => changeEntryKey(change) === key);
      if (index < 0) return false;
      record.changes.splice(index, 1);
      return true;
    }
    case "personalityFacet":
    case "speechStyleFacet": {
      if (!item.facet) return false;
      const list =
        item.kind === "personalityFacet" ? record.personalityFacets : record.speechStyleFacets;
      const index = (list ?? []).findIndex((facet) => sameFacet(facet, item.facet));
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    }
    case "relation": {
      const wanted = item.relation;
      if (!wanted) return false;
      const index = record.relations.findIndex(
        (relation) =>
          relation.name === wanted.name &&
          relation.relation === wanted.relation &&
          relation.firstChapter === wanted.firstChapter
      );
      if (index < 0) return false;
      record.relations.splice(index, 1);
      return true;
    }
    case "address": {
      const wanted = item.address;
      if (!wanted) return false;
      const term = record.addressTerms.find(
        (entry) => entry.targetName === wanted.targetName && !entry.authorLocked
      );
      if (!term) return false;
      const index = term.forms.findIndex((form) => sameAddressForm(form, wanted.form));
      if (index < 0) return false;
      term.forms.splice(index, 1);
      if (term.forms.length === 0) {
        record.addressTerms = record.addressTerms.filter((entry) => entry !== term);
      }
      return true;
    }
    case "firstPersonVariant": {
      const wanted = item.variant;
      if (!wanted) return false;
      const index = record.firstPerson.variants.findIndex(
        (variant) =>
          variant.form === wanted.form && sameNumbers(variant.chapters, wanted.chapters)
      );
      if (index < 0) return false;
      record.firstPerson.variants.splice(index, 1);
      return true;
    }
    case "appearedChapters": {
      const drop = new Set(item.chapters);
      const before = record.appearedChapters.length;
      record.appearedChapters = record.appearedChapters.filter((chapter) => !drop.has(chapter));
      return record.appearedChapters.length !== before;
    }
  }
}

/** 移し先へ1件足す。上書きはしない */
function addTo(
  destination: Character,
  item: NarratorMoveItem,
  source: Character,
  notes: string[]
): void {
  switch (item.kind) {
    case "change": {
      const change = item.change;
      if (!change) return;
      const same = destination.changes.find(
        (entry) => entry.field === change.field && entry.value === change.value
      );
      if (same) {
        same.chapters = sortedUnique([...same.chapters, ...change.chapters]);
      } else {
        destination.changes.push({ ...change, chapters: [...change.chapters] });
      }
      const current = bodyValue(destination, change.field);
      if (current === undefined) return;
      if (!current || !current.trim()) {
        setBodyValue(destination, change.field, change.value);
      } else if (current !== change.value) {
        notes.push(
          `「${destination.name}」の${fieldLabel(change.field)}には既に「${current}」があるので、` +
            `本体は変えずに変化の記録へ「${change.value}」を残しました。`
        );
      }
      return;
    }
    case "personalityFacet":
    case "speechStyleFacet": {
      const facet = item.facet;
      if (!facet) return;
      const personality = item.kind === "personalityFacet";
      const facets = personality
        ? (destination.personalityFacets ??= [])
        : (destination.speechStyleFacets ??= []);
      const body = personality ? destination.personality : destination.speechStyle;
      // 作者が確定させた人物の文章は書き換えない（面の一覧へ足すだけ）
      if (!destination.autoGenerated && body && body.trim()) {
        if (!facets.some((entry) => entry.value === facet.value)) {
          facets.push({ ...facet, chapters: [...facet.chapters] });
        }
        notes.push(
          `「${destination.name}」は作者が確定させた記録なので、${item.label}「${facet.value}」は` +
            "面の一覧へ足し、本体の文章は変えていません。"
        );
        return;
      }
      const holder = { facets, body };
      addFacetTo(holder, facet.value, facet.chapters, facet.evidence);
      if (personality) destination.personality = holder.body;
      else destination.speechStyle = holder.body;
      return;
    }
    case "relation": {
      const relation = item.relation;
      if (!relation) return;
      const self = [destination.name, ...destination.aliases].map(normalizeForComparison);
      if (self.includes(normalizeForComparison(relation.name))) {
        notes.push(
          `関係「${relation.name}=${relation.relation}」は相手が「${destination.name}」自身なので、足していません。`
        );
        return;
      }
      if (
        !destination.relations.some(
          (entry) => entry.name === relation.name && entry.relation === relation.relation
        )
      ) {
        destination.relations.push({ ...relation });
      }
      return;
    }
    case "address": {
      const address = item.address;
      if (!address) return;
      // 主人公自身を指す呼称の相手は、移し先自身に付け替える
      const sourceNames = [source.name, ...source.aliases].map(normalizeForComparison);
      const self = sourceNames.includes(normalizeForComparison(address.targetName));
      const targetName = self ? destination.name : address.targetName;
      const term = destination.addressTerms.find((entry) => entry.targetName === targetName);
      if (term?.authorLocked) {
        notes.push(
          `「${destination.name}」の「${targetName}」への呼称は作者が固定しているので、「${address.form.term}」は足していません。`
        );
        return;
      }
      if (term) {
        if (!term.forms.some((form) => form.term === address.form.term)) {
          term.forms.push({ ...address.form });
        }
        return;
      }
      destination.addressTerms.push({
        targetName,
        targetId: self ? destination.id : null,
        forms: [{ ...address.form }],
        authorLocked: false,
      });
      return;
    }
    case "firstPersonVariant": {
      const variant = item.variant;
      if (!variant) return;
      const form = variant.form.trim();
      if (!destination.firstPerson.default) {
        destination.firstPerson.default = form;
        return;
      }
      if (destination.firstPerson.default === form) return;
      if (destination.firstPerson.variants.some((entry) => entry.form === form)) return;
      destination.firstPerson.variants.push({ ...variant, chapters: [...variant.chapters] });
      return;
    }
    case "appearedChapters": {
      destination.appearedChapters = sortedUnique([
        ...destination.appearedChapters,
        ...item.chapters,
      ]);
      return;
    }
  }
}

/** 本体の値（文の欄と口調）。それ以外の項目は undefined */
function bodyValue(record: Character, field: string): string | null | undefined {
  if (isCharacterTextField(field)) return record[field];
  if (field === "speechStyle") return record.speechStyle;
  return undefined;
}

function setBodyValue(record: Character, field: string, value: string | null): void {
  if (isCharacterTextField(field)) record[field] = value;
  else if (field === "speechStyle") record.speechStyle = value;
}

function rejectedValueOf(
  field: string,
  value: string,
  chapters: readonly number[],
  evidence: string | null,
  rejectedAt: string
): RejectedValue {
  return {
    field,
    value,
    chapters: [...chapters],
    ...(evidence?.trim() ? { evidence: evidence.trim() } : {}),
    rejectedAt,
  };
}

function fieldLabel(field: string): string {
  return CHARACTER_FIELD_LABELS[field] ?? field;
}

function sameFacet(left: PersonalityFacet, right: PersonalityFacet | undefined): boolean {
  return Boolean(right) && left.value === right?.value && sameNumbers(left.chapters, right.chapters);
}

function sameAddressForm(left: AddressForm, right: AddressForm): boolean {
  return (
    left.term === right.term &&
    left.firstChapter === right.firstChapter &&
    left.lastChapter === right.lastChapter
  );
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(chapters: readonly number[]): number[] {
  return [...new Set(chapters.filter((chapter) => Number.isSafeInteger(chapter)))].sort(
    (a, b) => a - b
  );
}
