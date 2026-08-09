import type { Chunk } from "./chunker";
import { chaptersForChunk, isGroundedInChunk } from "./groundedEvidence";
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

/**
 * それ自体が「値が無い」ことしか言っていない語。
 *
 * 名前用の `PLACEHOLDER_NAME_PATTERN` は使い回せない。あちらは「主人公」
 * 「誰か」を含むが、これらは役割の値としては正しい（role: "主人公"）。
 */
const EMPTY_VALUE_PATTERN =
  /^[（(]?(?:null|undefined|n\/?a|none|なし|無し|不明|未詳|記述なし|記載なし|描写なし|該当なし|特になし|読み取れない|判断できない|見当たらない|[-—―ー・?？])[）)]?$/i;

/**
 * 「〜の記述はなし」と、値の代わりに不在を述べている文。
 *
 * AIは null にする代わりに「（本文から読み取れる性格に関する記述なし）」と
 * 書いてくることがあり、そのまま設定資料へ載っていた（実データで発生）。
 * プロンプトでも禁じているが、指示だけでは守られないのでコード側でも弾く。
 *
 * **不在を述べたあとに中身が続く文は残す。**
 * 「（生前の記述は本文中になし。憑依後は手足がスラリとしている）」のように、
 * 後半に本当の情報が入っていることがある。
 * 同じ理由で「記述は少ない」も残す（無いとは言っていない）。
 */
const ABSENCE_SENTENCE_PATTERN =
  /^[（(]?[^)）]{0,30}(?:記述|描写|言及|記載|情報)(?:は)?(?:なし|無し|ありません|ない)[。.]?[）)]?$/u;

/**
 * 中身のある値か。空欄と同じ扱いにするものを弾く。
 *
 * 名前ではなく説明系の項目（性格・外見・説明など）に使う。
 */
export function isMeaningfulValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const text = value.trim();
  if (!text) return false;
  if (EMPTY_VALUE_PATTERN.test(text)) return false;
  return !ABSENCE_SENTENCE_PATTERN.test(text);
}
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

/**
 * AI応答から受け取る、単純な文字列の項目。
 *
 * 名前・別名・呼称・関係のように構造を持つものは個別に扱うのでここには入れない。
 * プロンプトのスキーマと突き合わせるテストがこの配列を参照している。
 */
export const EXTRACTED_TEXT_FIELDS = [
  "reading",
  "summary",
  "affiliation",
  "gender",
  "role",
  "personality",
  "appearance",
  "firstPerson",
  "defaultSecondPerson",
  "evidence",
] as const;

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

  // ここは受け取る項目の白紙リストである。
  // **プロンプトに項目を足したら、必ずここにも足すこと。**
  // 足し忘れると、AIが正しく返していても後段へ届かず、
  // 画面には「AIが埋められなかった」ようにしか見えない。
  // 実際に reading / summary / affiliation / gender の4つで起きた。
  // `EXTRACTED_TEXT_FIELDS` はスキーマとの照合テストが参照している。
  for (const key of EXTRACTED_TEXT_FIELDS) {
    copyNullableString(character, raw, key);
  }

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

/** 共通の根拠照合を人物向けに包む */
function isGrounded(
  character: ExtractedCharacter,
  chunkText: string
): boolean {
  return isGroundedInChunk(
    [character.name, ...(character.aliases ?? [])],
    character.evidence,
    chunkText
  );
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
