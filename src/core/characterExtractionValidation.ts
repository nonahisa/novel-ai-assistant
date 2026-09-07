import type { Chunk } from "./chunker";
import { chaptersForCandidate, isGroundedInChunk } from "./groundedEvidence";
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

/** 別名を落としたことの記録。**黙って消さない**ので、報告に出すために持つ */
export interface DroppedAliasRecord {
  /** 落とした先の人物 */
  characterName: string;
  /** 落とした別名 */
  alias: string;
  /** 落とした理由になった相手（体の共有のときだけ） */
  partner?: string;
}

/** 向きが逆だった関係を直した記録（設計書6.18） */
export interface CorrectedRelationRecord {
  characterName: string;
  /** 相手の名前（「お母さん」など、親族語を含んだ呼び名） */
  partner: string;
  /** AIが書いてきた関係（この人物側から見た語＝逆向き） */
  from: string;
  /** 直したあとの関係（相手側から見た語） */
  to: string;
}

export interface CharacterValidationResult {
  accepted: AcceptedCharacterCandidate[];
  rejected: RejectedCharacterCandidate[];
  /**
   * 憑依・転生などで体を共有している相手の呼び名を、別名から落としたもの。
   * AIは「体を共有＝同一人物が別の呼称で登場」と読むため、コードで検算する。
   */
  droppedSharedBodyAliases: DroppedAliasRecord[];
  /** 敬称の途中で切れた別名として落としたもの（「母親さ」） */
  droppedTruncatedAliases: DroppedAliasRecord[];
  /** 向きが逆だった親族関係を直したもの（相手「お母さん」に「息子」） */
  correctedRelations: CorrectedRelationRecord[];
}

export interface CharacterValidationOptions {
  /**
   * 既存レコードの名前・別名。
   *
   * 途中で切れた別名（「母親さ」）を弾くには、**完全な形が実在する裏付け**が要る。
   * 同じ抽出結果の中だけでは足りない——切れた形だけが返ってきた話もあるため。
   */
  knownNames?: readonly string[];
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
 * 「本文から読み取れない」型の不在文。
 *
 * 上の2つでは**実データを取りこぼしていた**（2026-08-15に発見）。
 * 「（本文から読み取れない）」は語の前に「本文から」が付くため
 * `EMPTY_VALUE_PATTERN` に一致せず、「記述は確認できない」は
 * 「記述」と「ない」の間に動詞が挟まるため `ABSENCE_SENTENCE_PATTERN` にも
 * 一致しなかった。結果、主人公の性格欄に「（本文から読み取れない）」が
 * そのまま載っていた。
 *
 * 誤って消さないための条件を2つ置く。
 * 1. **本文・記述・描写などの語を含むこと。** 「感情の起伏がない」のように
 *    それ自体が性格である値を消さないため
 * 2. **文の途中に句点が無いこと。** 「（生前の記述は本文中になし。憑依後は
 *    手足がスラリとしている）」のように、不在を述べたあと中身が続く値を残すため
 *
 * 「記述は少ない」を消さないよう、打ち消しの語も限定して並べる（「少ない」は入れない）。
 */
const ABSENCE_NEGATION_PATTERN =
  /^[（(]?[^)）。]{0,50}(?:本文|記述|描写|言及|記載|情報)[^)）。]{0,20}(?:読み取れない|確認できない|見当たらない|判断できない|特定できない|わからない|分からない|ありません|存在しない)[。.]?[）)]?$/u;

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
  if (ABSENCE_SENTENCE_PATTERN.test(text)) return false;
  return !ABSENCE_NEGATION_PATTERN.test(text);
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
  chunk: Chunk,
  options: CharacterValidationOptions = {}
): CharacterValidationResult {
  const accepted: AcceptedCharacterCandidate[] = [];
  const rejected: RejectedCharacterCandidate[] = [];
  const droppedSharedBodyAliases: DroppedAliasRecord[] = [];
  const droppedTruncatedAliases: DroppedAliasRecord[] = [];
  const correctedRelations: CorrectedRelationRecord[] = [];
  const rawCharacters: unknown = result.characters;

  if (!Array.isArray(rawCharacters)) {
    return {
      accepted,
      rejected: [{ name: null, reason: "invalid_shape" }],
      droppedSharedBodyAliases,
      droppedTruncatedAliases,
      correctedRelations,
    };
  }

  // **根拠の照合より前に、別名の掃除を済ませる。**
  // 別名は話数の割り当てにも使われるので、別人の呼び名が混ざったままだと、
  // その人物が出ていない話まで「登場」として付いてしまう。
  //
  // ただし**根拠の照合には掃除前の呼び名を使う**（`groundingNames`）。
  // AIは「母親さん」と書かれた場面から圭織のレコードを作り、引用にも
  // その呼び名しか入れてこないことがある。掃除後の名前で照合すると、
  // 本文に実在する人物が「根拠なし」で消える。
  const survived: ExtractedCharacter[] = [];
  const groundingNames = new Map<ExtractedCharacter, string[]>();
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

    survived.push(character);
    groundingNames.set(character, [
      character.name,
      ...(character.aliases ?? []),
    ]);
  }

  // 別人の呼び名・切れた呼び名を別名から落とし、関係の向きを直す。
  // どれも**AIの読みをコードで検算する**もので、落とした分は結果に載せる
  cleanSharedBodyAliases(survived, droppedSharedBodyAliases);
  cleanTruncatedAliases(
    survived,
    options.knownNames ?? [],
    droppedTruncatedAliases
  );
  fixRelationDirections(survived, correctedRelations);

  for (const character of survived) {
    const names = groundingNames.get(character) ?? [character.name];
    if (!isGroundedInChunk(names, character.evidence, chunk.text)) {
      rejected.push({ name: character.name, reason: "ungrounded" });
      continue;
    }

    // 話数は、引用が本文のどの位置にあるかで決める。
    // 複数の話をまとめて送っているとき、チャンク全体の話数を付けると
    // 「第3話にしか出ない人物が第1〜4話に登場」になってしまう
    accepted.push({
      data: character,
      chapters: chaptersForCandidate(
        chunk,
        [character.name, ...(character.aliases ?? [])],
        character.evidence
      ),
    });
  }

  return {
    accepted,
    rejected,
    droppedSharedBodyAliases,
    droppedTruncatedAliases,
    correctedRelations,
  };
}

/**
 * 体を共有していても人格が別なら別人である、という検算（設計書6.5.9）。
 *
 * **AIは「憑依で体を共有＝同一人物が別の呼称で登場」と読む。**
 * プロンプトの【登場人物の抽出ルール】に禁止を足したが、指示だけでは守られない
 * （実データで `char_006_文佳` の別名に別人の「太志」「三門太志」が入った）。
 * 関係にそう書いてある以上、**その2人は別人である**と読めるので、
 * 相手の呼び名を自分の別名から落とす。
 *
 * **両方向に効かせる。** 「太志が文佳に憑依している」と書かれるのは
 * 片方のレコードだけのことが多く、汚染されるのはもう片方（文佳）の別名だった。
 * 片側からしか掃除しないと、実データで起きた汚染がそのまま残る。
 */
function cleanSharedBodyAliases(
  characters: ExtractedCharacter[],
  dropped: DroppedAliasRecord[]
): void {
  const byKey = new Map<string, ExtractedCharacter>();
  for (const character of characters) {
    byKey.set(normalizeForCompare(character.name), character);
    for (const alias of character.aliases ?? []) {
      if (!byKey.has(normalizeForCompare(alias))) {
        byKey.set(normalizeForCompare(alias), character);
      }
    }
  }

  // この人物の別名から落とすべき呼び名（正規化済み）→ 理由になった相手。
  // 相手の名前まで持つのは、報告で「誰と混ざったのか」を出すためである
  const blocked = new Map<ExtractedCharacter, Map<string, string>>();
  const block = (
    owner: ExtractedCharacter,
    names: readonly string[],
    partner: string
  ): void => {
    const keys = blocked.get(owner) ?? new Map<string, string>();
    const ownKey = normalizeForCompare(owner.name);
    for (const name of names) {
      const key = normalizeForCompare(name);
      // 自分自身の名前は落とさない。落とすと本人が引けなくなる
      if (!key || key === ownKey || keys.has(key)) continue;
      keys.set(key, partner);
    }
    blocked.set(owner, keys);
  };

  for (const character of characters) {
    for (const relation of character.relations ?? []) {
      if (!SHARED_BODY_RELATION.test(relation.relation)) continue;
      const other = byKey.get(normalizeForCompare(relation.name));
      if (other === character) continue;

      // 相手のレコードが同じ抽出結果にあれば、その name・aliases も落とす。
      // 無ければ関係に書かれた名前だけを落とす（レコードが後の話で作られる）
      const otherNames = other
        ? [other.name, ...(other.aliases ?? [])]
        : [relation.name];
      block(character, [relation.name, ...otherNames], relation.name);
      if (other) {
        block(other, [character.name, ...(character.aliases ?? [])], character.name);
      }
    }
  }

  for (const [character, keys] of blocked) {
    const kept: string[] = [];
    for (const alias of character.aliases ?? []) {
      const partner = keys.get(normalizeForCompare(alias));
      if (partner !== undefined) {
        dropped.push({ characterName: character.name, alias, partner });
        continue;
      }
      kept.push(alias);
    }
    character.aliases = kept;
  }
}

/**
 * 敬称の途中で切れた別名を落とす（「母親さ」＝「母親さん」の切れた形）。
 *
 * **裏付けのあるときだけ弾く。** 語尾だけで判定すると「つかさ」「おじいさま」
 * のような正しい呼び名まで落ちる。「ん」を足した形が、同じ抽出結果か
 * 既存レコードのどこかに実在するときに限る。
 */
function cleanTruncatedAliases(
  characters: ExtractedCharacter[],
  knownNames: readonly string[],
  dropped: DroppedAliasRecord[]
): void {
  const known = new Set<string>();
  for (const name of knownNames) known.add(normalizeSpacingOnly(name));
  for (const character of characters) {
    known.add(normalizeSpacingOnly(character.name));
    for (const alias of character.aliases ?? []) {
      known.add(normalizeSpacingOnly(alias));
    }
  }

  for (const character of characters) {
    const kept: string[] = [];
    for (const alias of character.aliases ?? []) {
      if (isTruncatedAlias(alias, known)) {
        dropped.push({ characterName: character.name, alias });
        continue;
      }
      kept.push(alias);
    }
    character.aliases = kept;
  }
}

/** 敬称の途中で切れた形になりうる語尾。「ん」が落ちた形だけを見る */
const TRUNCATED_ALIAS_TAILS = ["ちゃ", "さ", "く"] as const;

/**
 * その別名は「ん」が落ちた形か。
 *
 * `known` には、同じ抽出結果と既存レコードの名前・別名を
 * `normalizeSpacingOnly` 済みで入れる。**敬称は落とさない**——
 * 落とすと「太志く」の裏付けが「太志」で取れてしまい、判定にならない。
 */
export function isTruncatedAlias(
  alias: string,
  known: ReadonlySet<string>
): boolean {
  const text = alias.trim();
  // 1字だけの「さ」「く」は別名として意味を成さないが、
  // ここで弾くと語尾だけの判定になるので、裏付けの条件は同じにする
  if (text.length < 2) return false;
  if (!TRUNCATED_ALIAS_TAILS.some((tail) => text.endsWith(tail))) return false;
  return known.has(normalizeSpacingOnly(`${text}ん`));
}

/**
 * 親族関係の向きを直す（設計書6.18）。
 *
 * relations は**その人物のレコードから見た**相手との関係だが、
 * AIは自分の側の語を書いてくることがある（実データの `char_001_三門太志` に
 * `{"name":"お母さん","relation":"息子"}`）。相手の名前そのものに親族語が
 * 入っていれば、どちらから見た語かはコードで決められる。
 */
function fixRelationDirections(
  characters: ExtractedCharacter[],
  corrected: CorrectedRelationRecord[]
): void {
  for (const character of characters) {
    for (const relation of character.relations ?? []) {
      const fixed = correctRelationDirection(relation.name, relation.relation);
      if (fixed === null || fixed === relation.relation) continue;
      corrected.push({
        characterName: character.name,
        partner: relation.name,
        from: relation.relation,
        to: fixed,
      });
      relation.relation = fixed;
    }
  }
}

/**
 * 親族語の対。**相手の名前に入っている語**から、正しい関係語を決める。
 *
 * ひらがなの言い方（「おじいさま」「かあさん」）は頭に固定する。
 * 途中の一致まで拾うと「ふじいさん」のような人名を巻き込む。
 * 漢字の語は「三門の母」のように名前の途中にも出るので位置を縛らない。
 *
 * 並び順に意味がある。「祖母」は「母」を含むため、先に見ないと
 * 「祖母」の相手を「母」へ直してしまう。
 */
const KINSHIP_RULES: ReadonlyArray<{
  /** 相手の名前に現れる語 */
  inName: RegExp;
  /** その人物の側から見た語。これが relation に来ていたら向きが逆 */
  reverse: RegExp;
  /** 直したあとの関係 */
  corrected: string;
}> = [
  { inName: /祖母|^お?ばあ/u, reverse: /^孫/u, corrected: "祖母" },
  { inName: /祖父|^お?じい/u, reverse: /^孫/u, corrected: "祖父" },
  { inName: /母|^お?かあ/u, reverse: /^(?:息子|娘)/u, corrected: "母" },
  { inName: /父|^お?とう/u, reverse: /^(?:息子|娘)/u, corrected: "父" },
  { inName: /姉|^お?ねえ/u, reverse: /^(?:弟|妹)/u, corrected: "姉" },
  { inName: /兄|^お?にい/u, reverse: /^(?:弟|妹)/u, corrected: "兄" },
  { inName: /弟/u, reverse: /^(?:兄|姉)/u, corrected: "弟" },
  { inName: /妹/u, reverse: /^(?:兄|姉)/u, corrected: "妹" },
];

/**
 * 関係の向きを直す。直す必要が無ければ元の値、判断できなければ null。
 *
 * 純粋関数にしてあるのは、境界（どこまで直すか）をテストで固定するためである。
 */
export function correctRelationDirection(
  partnerName: string,
  relation: string
): string | null {
  const name = partnerName.trim();
  const value = relation.trim();
  if (!name || !value) return null;

  const matched = KINSHIP_RULES.filter((rule) => rule.inName.test(name));
  // 「兄妹」のように2つの親族語が入った呼び名は、どちら側か決められない
  if (matched.length !== 1) return null;

  const rule = matched[0];
  // 既に相手側の語が書かれているなら触らない（「母の再婚相手」など）
  if (rule.inName.test(value)) return value;
  if (!rule.reverse.test(value)) return value;
  return rule.corrected;
}

/**
 * 体を共有していても人格は別、と読める関係の言い方。
 *
 * プロンプトの【関係の抽出ルール】4番が書かせている語をそのまま拾う。
 * 「騙」は「その名を騙っている」（成り代わり）を拾うためである。
 */
const SHARED_BODY_RELATION =
  /憑依|入れ替わ|入れ替え|転生|身体を共有|体を共有|成り代わ|騙|変装|偽名/u;

/** 空白だけを落とす。敬称は落とさない（「文佳ちゃん」を「文佳」にしない） */
function normalizeSpacingOnly(name: string): string {
  return name.replace(/[\s　]/gu, "");
}

/**
 * 呼び名どうしの照合用。空白・中黒を落とし、末尾の敬称も落とす。
 *
 * 別人の呼び名を落とす判定では、**強めに寄せてよい**。
 * 「文佳ちゃん」を残しても、それは別人（憑依された側）の呼び名だからである。
 */
function normalizeForCompare(name: string): string {
  const base = normalizeSpacingOnly(name)
    .replace(/[・･]/gu, "")
    .toLowerCase();
  for (const suffix of COMPARE_HONORIFICS) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      return base.slice(0, -suffix.length);
    }
  }
  return base;
}

/**
 * 照合でだけ落とす敬称。
 *
 * `characterMerge.normalizeName` を呼ばないのは、`core` の中で
 * 検証がマージへ依存する向きを作らないためである（依存は models へ向ける）。
 * ここは別人判定の網なので、よく使う形だけで足りる。
 */
const COMPARE_HONORIFICS = [
  "ちゃん",
  "さん",
  "くん",
  "君",
  "さま",
  "様",
  "殿",
  "先輩",
];

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
