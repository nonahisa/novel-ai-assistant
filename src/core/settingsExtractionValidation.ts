import type { Chunk } from "./chunker";
import type {
  ExtractedAbility,
  ExtractedAbilitySystem,
  ExtractedLocation,
  ExtractedOrganization,
  ExtractedWorldItem,
} from "../prompts/characterExtract";
import {
  isGroundedInChunk,
  chaptersForChunk,
  evidenceSegments,
  normalizeForComparison,
} from "./groundedEvidence";
import { WORLD_CATEGORIES, type WorldCategory } from "../models/world";
// 「（記述なし）」のような不在を述べる文の判定は人物側と共有する。
// 片方だけ直しても、もう片方から同じ文言が入り込む
import { isMeaningfulValue } from "./characterExtractionValidation";

/**
 * 能力・組織・場所のAI出力を検証する。
 *
 * 人物と同じく「名前が本文に実在する」「根拠が本文に逐語で存在する」の
 * 2点を確認し、AIの捏造を保存前に弾く。
 */

export type SettingRejectionReason =
  | "invalid_shape"
  | "invalid_name"
  | "not_an_ability"
  | "not_a_place"
  | "not_worldview"
  | "ungrounded";

export interface RejectedSettingCandidate {
  name: string | null;
  reason: SettingRejectionReason;
}

export interface AcceptedAbilityCandidate {
  data: ExtractedAbility;
  chapters: number[];
}

export interface AcceptedLocationCandidate {
  data: ExtractedLocation;
  chapters: number[];
}

export interface AbilityValidationResult {
  accepted: AcceptedAbilityCandidate[];
  rejected: RejectedSettingCandidate[];
}

export interface LocationValidationResult {
  accepted: AcceptedLocationCandidate[];
  rejected: RejectedSettingCandidate[];
}

export interface AcceptedOrganizationCandidate {
  data: ExtractedOrganization;
  chapters: number[];
}

export interface OrganizationValidationResult {
  accepted: AcceptedOrganizationCandidate[];
  rejected: RejectedSettingCandidate[];
}

export interface AcceptedWorldCandidate {
  data: ExtractedWorldItem;
  /** 分類は文字列で来るので、ここで既定の7種へ寄せておく */
  category: WorldCategory;
  chapters: number[];
}

export interface WorldValidationResult {
  accepted: AcceptedWorldCandidate[];
  rejected: RejectedSettingCandidate[];
}

const MAX_NAME_LENGTH = 40;
/** 世界観の見出しの上限。プロンプトは15字、スキーマは20字で指示している */
const WORLD_NAME_MAX_LENGTH = 20;
/** 話数を名指しした記述。世界の有り様ではなく、その回の出来事である */
const EPISODE_REFERENCE_PATTERN = /第[0-9０-９]+話/u;
const SENTENCE_PUNCTUATION = /[、。，,.！？!?；;：:\r\n]/u;
const PLACEHOLDER_NAME_PATTERN =
  /^(null|undefined|不明|なし|n\/?a|none|その他|特になし)$/i;
/** 指示語だけの名前は特定の対象を指さないので採らない */
const DEMONSTRATIVE_PATTERN = /^(ここ|そこ|あそこ|どこ|この|その|あの)/u;

/**
 * 場所ではなく情景描写になっている名前を弾く。
 * 例：「石造りの建物」「背の高い塔」
 *
 * 「〜の建物」のような普通名詞で終わり、かつ固有名詞を含まないものだけを対象にする。
 * 「冒険者ギルドの二階の事務室」のように説明的でも特定の場所を指すものは残す。
 */
const DESCRIPTIVE_PLACE_SUFFIX =
  /(?:建物|家|部屋|小屋|扉|窓|壁|道|坂|階段|廊下|広場|空|地面|床)$/u;
/** 素材・形状・大小など、場所を限定しない修飾語 */
const DESCRIPTIVE_MODIFIER =
  /^(?:石造り|木造|古い|新しい|大きな|小さな|背の高い|背の低い|白い|黒い|赤い|青い|美しい|立派な|粗末な|small|large)/u;
/** 固有名詞に使われる文字。1つでも含めば描写ではなく名前とみなす */
const PROPER_NOUN_HINT = /[ァ-ヶー]|[Ａ-Ｚａ-ｚA-Za-z]/u;

/**
 * 能力の総称そのもの。個別の能力名ではないので採らない。
 *
 * 能力体系が無い作品でも、AIは「何か埋めよう」として
 * これらの語や説明文を返してくる（実データで確認）。
 * プロンプトで「無ければ空配列」と指示しても8Bモデルには効かないため、
 * コード側で弾く。
 */
const ABILITY_GENERIC_TERMS = new Set([
  "能力",
  "力",
  "スキル",
  "技能",
  "魔法",
  "魔力",
  "魔術",
  "超能力",
  "異能",
  "特殊能力",
  "戦闘能力",
  "身体能力",
  "才能",
]);

/**
 * 能力名ではなく説明文になっているものを弾く。
 * 例：「左手だけでなんとかできる」「左手一本で扱う短剣だけ」
 */
const DESCRIPTIVE_NAME_PATTERN =
  /(?:できる|できた|られる|される|している|していた|いる|ある|ない|だけ|など|ため|こと|ようだ|そうだ|らしい)$/u;

/**
 * 能力ではなく制度・組織を指す語。
 * 例：「冒険者ギルドの保険制度」
 */
const NON_ABILITY_SUFFIX_PATTERN =
  /(?:制度|機関|組織|協会|ギルド|商会|会社|法律|条例|規則|契約)$/u;

/**
 * 作品のジャンル名。能力の総称ではないので採らない。
 *
 * 「作品世界で能力がどう呼ばれているか」と尋ねると、
 * モデルは作品のジャンル（「ファンタジー」等）で答えることがある（実データで確認）。
 */
const GENRE_NAMES = new Set([
  "ファンタジー",
  "ハイファンタジー",
  "ローファンタジー",
  "伝奇",
  "sf",
  "現代",
  "現代もの",
  "異世界",
  "異世界ファンタジー",
  "ホラー",
  "ミステリー",
  "恋愛",
  "歴史",
  "時代小説",
  "バトル",
  "冒険",
]);

export function validateExtractedAbilities(
  raw: unknown,
  chunk: Chunk,
  /** 既に決まっている総称。総称そのものを能力名として採らないために使う */
  abilityTerm?: string | null
): AbilityValidationResult {
  const accepted: AcceptedAbilityCandidate[] = [];
  const rejected: RejectedSettingCandidate[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };

  const chapters = chaptersForChunk(chunk);

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      rejected.push({ name: null, reason: "invalid_shape" });
      continue;
    }
    const ability = normalizeExtractedAbility(entry);
    if (!isValidSettingName(ability.name)) {
      rejected.push({ name: ability.name, reason: "invalid_name" });
      continue;
    }
    if (!isSpecificAbilityName(ability.name, abilityTerm)) {
      rejected.push({ name: ability.name, reason: "not_an_ability" });
      continue;
    }
    if (
      !isGroundedInChunk(
        [ability.name, ...(ability.aliases ?? [])],
        ability.evidence,
        chunk.text
      )
    ) {
      rejected.push({ name: ability.name, reason: "ungrounded" });
      continue;
    }
    accepted.push({ data: ability, chapters: [...chapters] });
  }

  return { accepted, rejected };
}

export function validateExtractedLocations(
  raw: unknown,
  chunk: Chunk
): LocationValidationResult {
  const accepted: AcceptedLocationCandidate[] = [];
  const rejected: RejectedSettingCandidate[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };

  const chapters = chaptersForChunk(chunk);

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      rejected.push({ name: null, reason: "invalid_shape" });
      continue;
    }
    const location = normalizeExtractedLocation(entry);
    if (!isValidSettingName(location.name)) {
      rejected.push({ name: location.name, reason: "invalid_name" });
      continue;
    }
    // 「そこ」「あの街」のような指示語は特定の場所を指さない
    if (DEMONSTRATIVE_PATTERN.test(location.name)) {
      rejected.push({ name: location.name, reason: "invalid_name" });
      continue;
    }
    // 「石造りの建物」のような情景描写は特定の場所を指さない
    if (isDescriptivePlace(location.name)) {
      rejected.push({ name: location.name, reason: "not_a_place" });
      continue;
    }
    if (
      !isGroundedInChunk(
        [location.name, ...(location.aliases ?? [])],
        location.evidence,
        chunk.text
      )
    ) {
      rejected.push({ name: location.name, reason: "ungrounded" });
      continue;
    }
    accepted.push({ data: location, chapters: [...chapters] });
  }

  return { accepted, rejected };
}

/**
 * 組織の抽出結果を検証する。
 *
 * 場所と同じく、名前が本文に実在し、根拠が逐語で存在することを確かめる。
 * ただし「石造りの建物」のような情景描写の判定は使わない。
 * 組織名は普通名詞の連なり（「生活保護課」「衛兵隊」）が普通で、
 * 場所の判定を当てると正しい組織まで弾いてしまう。
 */
export function validateExtractedOrganizations(
  raw: unknown,
  chunk: Chunk
): OrganizationValidationResult {
  const accepted: AcceptedOrganizationCandidate[] = [];
  const rejected: RejectedSettingCandidate[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };

  const chapters = chaptersForChunk(chunk);

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      rejected.push({ name: null, reason: "invalid_shape" });
      continue;
    }
    const organization = normalizeExtractedOrganization(entry);
    if (!isValidSettingName(organization.name)) {
      rejected.push({ name: organization.name, reason: "invalid_name" });
      continue;
    }
    // 「そこ」「あの組織」のような指示語は特定の組織を指さない
    if (DEMONSTRATIVE_PATTERN.test(organization.name)) {
      rejected.push({ name: organization.name, reason: "invalid_name" });
      continue;
    }
    if (
      !isGroundedInChunk(
        [organization.name, ...(organization.aliases ?? [])],
        organization.evidence,
        chunk.text
      )
    ) {
      rejected.push({ name: organization.name, reason: "ungrounded" });
      continue;
    }
    accepted.push({ data: organization, chapters: [...chapters] });
  }

  return { accepted, rejected };
}

/**
 * 世界観の抽出結果を検証する。
 *
 * **他の種別と違い、名前が本文に実在するかは確かめない。**
 * 世界観の name は本文の語ではなく、こちらが付けさせた見出し
 * （「詠唱の制約」）である。名前の一致を求めると、正しく抽出できた
 * 項目まですべて落ちる。会話文を根拠にした人物が構造的に全滅した
 * 2026-08-07 の不具合と同じ形になるため、evidence の逐語一致だけを見る。
 */
export function validateExtractedWorldItems(
  raw: unknown,
  chunk: Chunk
): WorldValidationResult {
  const accepted: AcceptedWorldCandidate[] = [];
  const rejected: RejectedSettingCandidate[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };

  const chapters = chaptersForChunk(chunk);
  const normalizedChunk = normalizeForComparison(chunk.text);

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      rejected.push({ name: null, reason: "invalid_shape" });
      continue;
    }
    const item = normalizeExtractedWorldItem(entry);
    if (!isValidWorldName(item.name)) {
      rejected.push({ name: item.name, reason: "invalid_name" });
      continue;
    }
    // 中身の無い見出しだけを資料に並べても、作者には何も伝わらない
    if (!isMeaningfulValue(item.description)) {
      rejected.push({ name: item.name, reason: "not_worldview" });
      continue;
    }
    if (isEventDescription(item.name, item.description)) {
      rejected.push({ name: item.name, reason: "not_worldview" });
      continue;
    }
    if (
      !evidenceSegments(item.evidence).some((segment) =>
        normalizedChunk.includes(segment)
      )
    ) {
      rejected.push({ name: item.name, reason: "ungrounded" });
      continue;
    }
    accepted.push({
      data: item,
      category: toWorldCategory(item.category),
      chapters: [...chapters],
    });
  }

  return { accepted, rejected };
}

export function normalizeExtractedWorldItem(
  raw: Record<string, unknown>
): ExtractedWorldItem {
  return {
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    // プロンプトに項目を足したら、必ずここにも足すこと
    category: nullableString(raw.category),
    description: nullableString(raw.description),
    evidence: nullableString(raw.evidence),
  };
}

/**
 * 分類を既定の7種へ寄せる。
 *
 * **知らない値でも項目そのものは捨てない。** 分類は資料の見出しを
 * 決めるだけで、中身の正しさとは関係がない。捨てると本文から読み取れた
 * 内容まで失われるが、分類の取り違えは作者が画面から直せる。
 */
export function toWorldCategory(value: string | null | undefined): WorldCategory {
  const text = value?.trim().toLowerCase();
  const matched = WORLD_CATEGORIES.find((category) => category === text);
  // term（固有の用語）は分類の受け皿として使う
  return matched ?? "term";
}

/** 世界観の見出しとして通してよいか。見出しなので短いはず */
export function isValidWorldName(name: string): boolean {
  if (!isValidSettingName(name)) return false;
  if (name.length > WORLD_NAME_MAX_LENGTH) return false;
  if (DEMONSTRATIVE_PATTERN.test(name)) return false;
  return true;
}

/**
 * 世界観ではなく物語の出来事か。
 *
 * 「第3話で城が燃えた」は出来事であり、世界観ではない。
 * ただし判定は控えめにする。「〜が禁じられた」のように
 * 過去形でも世界の決まりを述べている文はいくらでもあるため、
 * **話数を名指ししている場合だけ**を出来事とみなす。
 */
export function isEventDescription(
  name: string,
  description: string | null | undefined
): boolean {
  return EPISODE_REFERENCE_PATTERN.test(`${name} ${description ?? ""}`);
}

export function normalizeExtractedOrganization(
  raw: Record<string, unknown>
): ExtractedOrganization {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return {
    name,
    aliases: cleanStringArray(raw.aliases).filter((alias) => alias !== name),
    reading: nullableString(raw.reading),
    // プロンプトに項目を足したら、必ずここにも足すこと
    summary: nullableString(raw.summary),
    parent: nullableString(raw.parent),
    category: nullableString(raw.category),
    description: nullableString(raw.description),
    evidence: nullableString(raw.evidence),
  };
}

/** 能力体系の総称。空文字や記号だけの値を弾く */
export function normalizeExtractedAbilitySystem(
  raw: unknown
): ExtractedAbilitySystem | undefined {
  if (!isRecord(raw)) return undefined;
  const abilityTerm =
    typeof raw.abilityTerm === "string" ? raw.abilityTerm.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  const rules = cleanStringArray(raw.rules);

  // 総称は短い名詞のはず。文・ジャンル名は読み取り失敗とみなす
  const usableLabel =
    abilityTerm.length > 0 &&
    abilityTerm.length <= 10 &&
    !SENTENCE_PUNCTUATION.test(abilityTerm) &&
    !PLACEHOLDER_NAME_PATTERN.test(abilityTerm) &&
    !isGenreName(abilityTerm)
      ? abilityTerm
      : null;

  if (!usableLabel && !description && rules.length === 0) return undefined;
  return {
    abilityTerm: usableLabel,
    description: description || null,
    rules,
  };
}

export function normalizeExtractedAbility(
  raw: Record<string, unknown>
): ExtractedAbility {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return {
    name,
    aliases: cleanStringArray(raw.aliases).filter((alias) => alias !== name),
    reading: nullableString(raw.reading),
    // プロンプトに項目を足したら、必ずここにも足すこと。
    // 足し忘れると、AIが正しく返していても後段へ届かない
    summary: nullableString(raw.summary),
    category: nullableString(raw.category),
    description: nullableString(raw.description),
    cost: nullableString(raw.cost),
    limitation: nullableString(raw.limitation),
    userNames: cleanStringArray(raw.userNames),
    evidence: nullableString(raw.evidence),
  };
}

export function normalizeExtractedLocation(
  raw: Record<string, unknown>
): ExtractedLocation {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return {
    name,
    aliases: cleanStringArray(raw.aliases).filter((alias) => alias !== name),
    reading: nullableString(raw.reading),
    summary: nullableString(raw.summary),
    region: nullableString(raw.region),
    description: nullableString(raw.description),
    evidence: nullableString(raw.evidence),
  };
}

/**
 * 個別の能力を指す名前か。
 *
 * 能力体系が無い作品では、AIが総称や説明文で埋めようとするため、
 * 「これは特定の能力の名前か」をコード側で判定する。
 */
export function isSpecificAbilityName(
  name: string,
  abilityTerm?: string | null
): boolean {
  if (ABILITY_GENERIC_TERMS.has(name)) return false;
  // 総称そのものを能力名として登録しない
  if (abilityTerm && name === abilityTerm.trim()) return false;
  if (DESCRIPTIVE_NAME_PATTERN.test(name)) return false;
  if (NON_ABILITY_SUFFIX_PATTERN.test(name)) return false;
  return true;
}

/**
 * 場所名ではなく情景描写か。
 *
 * 「〜の建物」のような普通名詞で終わり、修飾語が素材や形状しか示さず、
 * 固有名詞を含まないものだけを描写とみなす。
 * 判定を狭くしているのは、「冒険者ギルドの二階の事務室」のように
 * 説明的でも特定の場所を指す名前を巻き込まないため。
 */
export function isDescriptivePlace(name: string): boolean {
  if (!DESCRIPTIVE_PLACE_SUFFIX.test(name)) return false;
  if (PROPER_NOUN_HINT.test(name)) return false;
  return DESCRIPTIVE_MODIFIER.test(name);
}

/** 作品のジャンル名か。「/」区切りの併記にも備える */
export function isGenreName(value: string): boolean {
  const parts = value
    .split(/[\/／、,・]/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return false;
  // 一部でもジャンル名を含むなら総称の読み取りに失敗している
  return parts.some((part) => GENRE_NAMES.has(part));
}

/** 能力名・場所名として通してよいか */
export function isValidSettingName(name: string): boolean {
  if (!name) return false;
  if (name.length > MAX_NAME_LENGTH) return false;
  if (PLACEHOLDER_NAME_PATTERN.test(name)) return false;
  // 文がそのまま名前になっているものを弾く
  if (SENTENCE_PUNCTUATION.test(name)) return false;
  return true;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
