import type { Chunk } from "./chunker";
import type {
  CharacterExtractResult,
  ExtractedCharacter,
} from "../prompts/characterExtract";

export type CharacterRejectionReason =
  | "invalid_shape"
  | "invalid_name"
  | "non_person"
  | "collective"
  | "ungrounded";

export interface RejectedCharacterCandidate {
  name: string | null;
  reason: CharacterRejectionReason;
}

export interface AcceptedCharacterCandidate {
  data: ExtractedCharacter;
  chapters: number[];
}

export interface CharacterValidationResult {
  accepted: AcceptedCharacterCandidate[];
  rejected: RejectedCharacterCandidate[];
}

const MAX_NAME_LENGTH = 30;
const SENTENCE_PUNCTUATION = /[、。，,.！？!?；;：:\r\n]/u;
const WRAPPING_PUNCTUATION =
  /^(?:[「『“‘"（(【《〈])|(?:[」』”’"）)】》〉])$/u;
// 助詞だけでは「こはる」のような名前も巻き込むため、文末の活用形まで限定する。
const SENTENCE_LIKE_NAME_PATTERN =
  /[はがをにへでとも][^、。！？!?\r\n]{1,20}(?:った|いた|した|された|ていた|ている|している|なかった|だった|でした|ました|ません)$/u;
const PLACEHOLDER_NAME_PATTERN =
  /^(null|undefined|不明|なし|誰か|n\/?a|none|[（(]?主[）)]?|主人公)$/i;
const COLLECTIVE_SUFFIX_PATTERN = /(?:たち|一同|一行|一団|人々|一族)$/u;
const PRONOUNS = new Set([
  "私",
  "わたし",
  "わたくし",
  "僕",
  "ぼく",
  "俺",
  "おれ",
  "あたし",
  "あたい",
  "自分",
  "我",
  "我輩",
  "吾輩",
  "わし",
  "儂",
  "余",
  "拙者",
  "小生",
  "あなた",
  "君",
  "お前",
  "彼",
  "彼女",
  "彼ら",
  "彼女ら",
  "我々",
]);
const GENERIC_ROLES = new Set([
  "先生",
  "教師",
  "医師",
  "医者",
  "看護師",
  "警官",
  "店員",
  "店主",
  "主人",
  "夫",
  "妻",
  "母",
  "母親",
  "父",
  "父親",
  "姉",
  "兄",
  "妹",
  "弟",
  "少年",
  "少女",
  "男",
  "女",
  "老人",
  "客",
  "門番",
  "衛兵",
  "兵士",
  "騎士",
  "冒険者",
  "取調官",
  "村人",
]);
const ENTITY_TYPES = new Set(["person", "group", "location", "unknown"]);

/**
 * AI応答を人物マージへ渡せる形に正規化し、受理・除外理由を分ける。
 * AIが返した候補は信頼せず、各候補を必ず1つの結果にだけ分類する。
 */
export function validateCharacterExtractResult(
  result: CharacterExtractResult,
  chunk: Chunk
): CharacterValidationResult {
  const accepted: AcceptedCharacterCandidate[] = [];
  const rejected: RejectedCharacterCandidate[] = [];
  const rawCharacters: unknown = result.characters;

  if (!Array.isArray(rawCharacters)) {
    return {
      accepted,
      rejected: [{ name: null, reason: "invalid_shape" }],
    };
  }

  const chapters = chaptersForChunk(chunk);
  for (const raw of rawCharacters) {
    if (!isRecord(raw) || typeof raw.name !== "string") {
      rejected.push({ name: candidateName(raw), reason: "invalid_shape" });
      continue;
    }
    if (
      "entityType" in raw &&
      raw.entityType !== undefined &&
      (typeof raw.entityType !== "string" || !ENTITY_TYPES.has(raw.entityType))
    ) {
      rejected.push({ name: raw.name.trim() || null, reason: "invalid_shape" });
      continue;
    }

    const character = normalizeExtractedCharacter(raw);
    if (!isValidName(character.name)) {
      rejected.push({ name: character.name, reason: "invalid_name" });
      continue;
    }
    // 「兵士たち」のような集団名詞はモブとして残す。
    // 本文に出ている以上、消すと情報が失われるため、
    // ネームドキャラと区別できる印を付けたうえで保持する。
    //
    // 対象を集団名詞に限るのは、entityType: "group" が
    // 「星環評議会」（組織）や「銀翼族」（種族）にも使われるためである。
    // 組織や種族はモブキャラではないので、これまでどおり除外する。
    // 「姉」「先生」のような関係語・汎用役職も、特定個人を指す参照であり
    // 群衆ではないため対象にしない。
    if (isCollectiveName(character.name)) {
      character.isMob = true;
    } else if (
      (character.entityType !== undefined &&
        character.entityType !== "person") ||
      GENERIC_ROLES.has(character.name)
    ) {
      rejected.push({ name: character.name, reason: "non_person" });
      continue;
    }

    if (!isGrounded(character, chunk.text)) {
      rejected.push({ name: character.name, reason: "ungrounded" });
      continue;
    }

    accepted.push({ data: character, chapters: [...chapters] });
  }

  return { accepted, rejected };
}

/** AI応答を後段が安全に扱える形へ正規化する。 */
export function normalizeExtractedCharacter(
  raw: Record<string, unknown>
): ExtractedCharacter {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const character: ExtractedCharacter = {
    name,
    aliases: cleanStringArray(raw.aliases).filter(
      (alias) => alias !== name && isValidAlias(alias)
    ),
  };

  if (
    typeof raw.entityType === "string" &&
    ENTITY_TYPES.has(raw.entityType)
  ) {
    character.entityType = raw.entityType as NonNullable<
      ExtractedCharacter["entityType"]
    >;
  }
  if (typeof raw.isMob === "boolean") {
    character.isMob = raw.isMob;
  }

  copyNullableString(character, raw, "role");
  copyNullableString(character, raw, "personality");
  copyNullableString(character, raw, "appearance");
  copyNullableString(character, raw, "firstPerson");
  copyNullableString(character, raw, "defaultSecondPerson");
  copyNullableString(character, raw, "evidence");

  if ("addressTerms" in raw) {
    character.addressTerms = Array.isArray(raw.addressTerms)
      ? raw.addressTerms.flatMap((item) => {
          if (!isRecord(item)) return [];
          const targetName = cleanRequiredString(item.targetName);
          const term = cleanRequiredString(item.term);
          if (!targetName || !term) return [];
          return [
            {
              targetName,
              term,
              category: cleanNullableString(item.category),
              context: cleanNullableString(item.context),
              evidence: cleanNullableString(item.evidence),
            },
          ];
        })
      : [];
  }

  if ("relations" in raw) {
    character.relations = Array.isArray(raw.relations)
      ? raw.relations.flatMap((item) => {
          if (!isRecord(item)) return [];
          const relationName = cleanRequiredString(item.name);
          const relation = cleanRequiredString(item.relation);
          return relationName && relation
            ? [{ name: relationName, relation }]
            : [];
        })
      : [];
  }

  return character;
}

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する。
 */
export function parseResult(text: string): CharacterExtractResult | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.characters)) {
        // キャッシュには正規化前の値を残し、検証ルール変更時に再評価できるようにする。
        return parsed as unknown as CharacterExtractResult;
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

function candidateName(raw: unknown): string | null {
  if (!isRecord(raw) || typeof raw.name !== "string") return null;
  return raw.name.trim() || null;
}

function isValidName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    !PLACEHOLDER_NAME_PATTERN.test(name) &&
    !PRONOUNS.has(name) &&
    !SENTENCE_PUNCTUATION.test(name) &&
    !WRAPPING_PUNCTUATION.test(name) &&
    !SENTENCE_LIKE_NAME_PATTERN.test(name)
  );
}

function isValidAlias(alias: string): boolean {
  return (
    isValidName(alias) &&
    !GENERIC_ROLES.has(alias) &&
    !isCollectiveName(alias)
  );
}

function isCollectiveName(name: string): boolean {
  if (COLLECTIVE_SUFFIX_PATTERN.test(name)) return true;
  if (!name.endsWith("達") && !name.endsWith("ら")) return false;
  const singular = name.slice(0, -1);
  return GENERIC_ROLES.has(singular) || PRONOUNS.has(singular);
}

/**
 * AIが人物と根拠を捏造していないかを本文と照合する。
 *
 * 次の2つを別々に確認する。
 *   1. 呼称が本文に実在すること（名前の捏造を防ぐ）
 *   2. evidenceの断片が本文に逐語で存在すること（引用の捏造を防ぐ）
 *
 * かつて「1つの断片が本文に存在し、かつその断片が呼称を含むこと」を
 * 求めていたが、会話文が根拠の場合、話者は自分の名前を台詞で言わないため
 * 構造的に必ず落ちていた（実データで主要人物が11件除外された）。
 * 引用が「その人物についてのものか」はコードでは判定できないため、
 * 捏造でないことの確認までに留める。
 */
function isGrounded(
  character: ExtractedCharacter,
  chunkText: string
): boolean {
  const appellations = [character.name, ...(character.aliases ?? [])]
    .map((appellation) => normalizeForComparison(appellation ?? ""))
    .filter((appellation) => appellation.length > 0);
  if (appellations.length === 0) return false;

  const normalizedChunk = normalizeForComparison(chunkText);

  if (!appellations.some((appellation) => normalizedChunk.includes(appellation))) {
    return false;
  }

  return evidenceSegments(character.evidence).some((segment) =>
    normalizedChunk.includes(segment)
  );
}

/**
 * 照合用に表記の揺れを落とす。
 *
 * gemma系は全角スペースを `<0xE3><0x80><0x80>` のようなバイト表記のまま
 * 出力することがあり、そのままでは逐語一致に失敗する。
 * 空白の全角・半角差も同じ理由で無視する。
 */
function normalizeForComparison(text: string): string {
  return text.replace(/<0x[0-9A-Fa-f]{2}>/gu, "").replace(/[\s　]/gu, "");
}

/** 照合に使える長さの断片だけを、正規化した形で返す */
function evidenceSegments(evidence: string | null | undefined): string[] {
  if (!evidence) return [];
  return evidence
    .split(/[\r\n。！？!?]+/u)
    .map((segment) =>
      segment.replace(
        /^[「『"'“”‘’（(\s…]+|[」』"'“”‘’）)\s…]+$/gu,
        ""
      )
    )
    .filter((segment) => segment.length >= 4)
    .map(normalizeForComparison)
    // 空白や記号だけの断片は、正規化後に短くなり誤一致の元になる
    .filter((segment) => segment.length >= 4);
}

function chaptersForChunk(chunk: Chunk): number[] {
  const start = chunk.chapterStart;
  if (!Number.isSafeInteger(start) || start === null || start < 0) return [];
  const end = chunk.chapterEnd ?? start;
  if (!Number.isSafeInteger(end) || end < start) return [];

  const chapters: number[] = [];
  for (let chapter = start; chapter <= end; chapter++) {
    chapters.push(chapter);
  }
  return chapters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function cleanNullableString(value: unknown): string | null {
  return cleanRequiredString(value);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value
    .map(cleanRequiredString)
    .filter((item): item is string => item !== null);
  return [...new Set(strings)];
}

function copyNullableString<K extends keyof ExtractedCharacter>(
  target: ExtractedCharacter,
  source: Record<string, unknown>,
  key: K
): void {
  if (!(key in source)) return;
  target[key] = cleanNullableString(source[key]) as ExtractedCharacter[K];
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
