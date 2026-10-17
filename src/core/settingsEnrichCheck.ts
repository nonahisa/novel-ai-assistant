import { isCharacterTextField, type Character } from "../models/character";
import type { Ability, AbilitySystem } from "../models/ability";
import { membersOf, type Organization } from "../models/organization";
import type { Location } from "../models/location";
import type { WorldItem } from "../models/world";
import type { CustomFieldDefinition } from "../models/customField";
import {
  enrichOmitsChanges,
  enrichableFields,
  type EnrichableField,
} from "../prompts/settingsEnrich";
import {
  describeAbility,
  describeCharacter,
  describeLocation,
  describeOrganization,
  describeWorldItem,
  type SettingsKind,
} from "./settingsSummary";
import { isMeaningfulValue } from "./characterExtractionValidation";
import { stripInvolvementNote } from "./changeSignificance";
import { clampAtSentenceEnd, clampSummary } from "./summaryLimit";
import { firstPersonsUnspokenInDialogue, isSpeechStyleEcho } from "./speechStyle";
import { unknownCitedChapters } from "./chapterCitations";
import { expandNameVariants } from "./termIndex";
import { normalizeName, sharedNameParts } from "./characterMerge";
import { evidencePhrases } from "./groundedEvidence";
import type { ExcerptSource } from "./mentionExcerpts";

/**
 * 「AIで再読込」（P-20、設計書6.31.1）の材料と検算の、`vscode` の要らない部分
 * （2026-10-01、作者の裁定で MCP の feature `settingsEnrich` を足すときに切り出した）。
 *
 * **製品（`features/settingsPanel.ts` の `handleEnrich`）と MCP
 * （`mcp/tools/settingsEnrich.ts`）が、ここを通る。** 0.94.12 までは検算が
 * 画面の中に書かれていて、外から測ろうとすると写しを作るしかなかった——
 * 写しは片方だけが直る（CLAUDE.md の失敗5「実接続の測定は、製品と同じ検証を通す」）。
 */

/** 再読込の対象になる記録 */
export type EnrichRecord = Character | Ability | Organization | Location | WorldItem;

/**
 * 本文から場面を集めるときの検索語（`features/settingsPanel.ts` から移した）。
 *
 * フルネームで登録されていても、本文には片方しか出てこないことが多い。
 * 広げないと、その人物の場面がほとんど集まらない。
 *
 * **世界観だけは名前で引けない。** 見出し（「詠唱の制約」）は
 * こちらが付けた言葉で、本文には出てこない。名前だけで引くと
 * 場面が1つも集まらず、相談も項目の充実も材料なしで動くことになる。
 * 逐語引用である evidence を手掛かりにする。
 *
 * **人物は、切り出した部分のうち家名は引かない**（`characters` を渡したとき。
 * 2026-10-02）。教科書チートで「フォー・シーゲン」の「シーゲン」が一家の別人も
 * 含めて294回当たり、本人の「フォー」（3回）の場面が均等に間引く中で落ちた。
 * 家名の見分け方は抽出のマージと同じ（`sharedNameParts`。2種類以上の名と組む部分、
 * 爵位だけで呼ばれる名前の家名）。**作者が名前・別名に書いた呼び方はそのまま残す。**
 * 家名でしか呼ばれない人物は抜粋が減るが、家名の場面へ戻すと別人の値が混ざる
 */
export function searchTermsFor(
  kind: SettingsKind,
  record: { name: string; aliases: string[]; evidence?: string | null },
  characters?: readonly Character[]
): string[] {
  const written = [record.name, ...record.aliases];
  let names = expandNameVariants(written);
  if (kind === "character" && characters) {
    const family = sharedNameParts(characters, written);
    const kept = new Set(written.map((name) => name.trim()));
    names = names.filter((name) => kept.has(name) || !family.has(normalizeName(name)));
  }
  if (kind !== "world") return names;
  return [...names, ...evidencePhrases(record.evidence)];
}

/**
 * 場面を集めるときに「その名前の中の一致は除く」ための、ほかの記録の名前
 * （`collectMentionExcerpts` の `otherNames`。2026-10-02）。
 *
 * 「教皇」が「教皇庁」に、「ルド」が「ルド王国」に当たると、抜粋が別の記録の
 * 場面で埋まる。人物・場所・組織・能力の名前と別名を、本文での呼び方へ広げて渡す。
 * **世界観は入れない。** 見出しはこちらが付けた言葉で、本文の語ではない。
 * 対象の記録自身は除く（同じ id。自分の別名で自分の場面を隠さない）。
 */
export function otherRecordNamesFor(
  target: { id: string },
  records: ReadonlyArray<{ id: string; name: string; aliases: string[] }>
): string[] {
  return expandNameVariants(
    records
      .filter((record) => record.id !== target.id)
      .flatMap((record) => [record.name, ...record.aliases])
  );
}

/** 「現在の設定」の欄に渡す文章を組むのに要るもの */
export interface EnrichDescribeContext {
  /** 作者が足した項目（人物のときだけ効く） */
  customFields: CustomFieldDefinition[];
  /** 能力の体系。読めなければ undefined（製品と同じ） */
  abilitySystem?: AbilitySystem;
  /** 組織の構成員を引くための人物の一覧 */
  characters: ReadonlyArray<{ name: string; affiliation: string | null }>;
  /**
   * 作者の留意点（6.31.1）。空でなければ、人物の**変化の記録を渡さない**
   * （作者の裁定 2026-10-15 の6）。変化はこれまでのAIの読み取りの履歴で、
   * 混入がそのまま残っている——アジャーノの第12話「帝国の皇子」を、26b も
   * 31b も根拠として紹介へ持ち越した。再読込は本文の抜粋から組み直す機能なので、
   * 疑いのある履歴は材料から外す。**記録そのものは書き換えない**（実装ルール2）
   */
  notes?: string;
  /**
   * 各話あらすじの本文（人物のときだけ効く）。変化の関与度の
   * 「あらすじの半分以上に名前が出る +5」に使う（2026-10-17）。画面と MCP で
   * 同じ点になるよう、どちらも渡す
   */
  synopses?: readonly string[];
}

/** プロンプトの【現在の設定】に渡す文章（製品の `describe` と同じ） */
export function describeEnrichTarget(
  kind: SettingsKind,
  record: EnrichRecord,
  context: EnrichDescribeContext
): string {
  if (kind === "character") {
    return describeCharacter(record as Character, context.customFields, {
      omitChanges: enrichOmitsChanges(context.notes),
      synopses: context.synopses,
    });
  }
  if (kind === "ability") {
    return describeAbility(record as Ability, context.abilitySystem);
  }
  if (kind === "organization") {
    const organization = record as Organization;
    return describeOrganization(
      organization,
      membersOf(organization, [...context.characters])
    );
  }
  if (kind === "world") return describeWorldItem(record as WorldItem);
  return describeLocation(record as Location);
}

/** AIの応答をJSONとして読む。前後に余計な文字が付くことがある */
export function parseEnrichResult(
  text: string
): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 提案された値を、長さの制限まで含めて整える。使えなければ空文字 */
export function clampEnrichField(field: EnrichableField, value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  // AIは「不明」「なし」「（本文から読み取れる記述なし）」を値として返してくる。
  // 判定は抽出側と共有する（片方だけ直しても、もう片方から入り込む）
  if (!isMeaningfulValue(text)) return "";
  // 材料に付けた［関与度 …］を、そのまま値へ書き写してくることがある。
  // 指示語が答えの中身として返るのは、この作品で繰り返し起きている
  // （`placeholderText.ts`）。資料へ載る手前で落とす
  const body = stripInvolvementNote(text);
  if (!body) return "";
  if (!field.maxChars) return body;
  // **口調は文の切れ目で切る**（作者の裁定 2026-10-17。A22）。紹介は途中まででも
  // 情報が残るので読点まで戻してよいが、口調は「語尾は…と、」で切れると読めない
  if (!field.custom && field.key === "speechStyle") {
    return clampAtSentenceEnd(body, field.maxChars) ?? "";
  }
  return clampSummary(body, field.maxChars) ?? "";
}

/** 項目ごとの提案（いまの値と並べて作者に見せる1行） */
export interface EnrichProposal {
  field: EnrichableField;
  /** いまの値。空なら空文字 */
  before: string;
  after: string;
  /**
   * 空欄を埋める提案か。**製品はこれだけを既定で選ぶ**——作者が書いた
   * 内容の置き換えは、必ず作者が自分で選ぶ
   */
  fillsBlank: boolean;
}

export interface EnrichCheckResult {
  proposals: EnrichProposal[];
  /** 作品に無い話を挙げていたので落とした項目（設計書6.31.2 の F5） */
  unknownCitations: Array<{ label: string; chapters: number[] }>;
  /** 口調の提案が指示の言葉の写しだったので落とした数（設計書6.5.11） */
  speechEchoes: number;
  /**
   * 口調の提案に書かれていたが、抜粋の台詞に1度も出てこなかった一人称
   * （作者の裁定 2026-10-17。A22）。空でなければ口調の提案ごと落としている
   */
  speechUnspokenFirstPersons: string[];
  /**
   * 名前の出ない話の変化の記録から持ち越した語を含んでいたので落とした項目
   * （作者の裁定 2026-10-17「製品で弾く」。A27）
   */
  foreignChanges: Array<{ label: string; phrases: string[]; chapters: number[] }>;
}

/**
 * 応答の各項目を検算して、作者に見せる提案へ直す（設計書6.31.1）。
 *
 * **落としたものは数と項目で返す。** 黙って消すと、作者にも外から測る側にも
 * 「AIが何も言わなかった」と見分けが付かない。
 */
export function checkEnrichProposals(input: {
  kind: SettingsKind;
  record: EnrichRecord;
  customFields: CustomFieldDefinition[];
  parsed: Record<string, unknown>;
  /** 渡した本文の抜粋をつないだもの（口調の写しの見張りに使う） */
  excerptText: string;
  /** 作品の話数。空なら照合しない（`unknownCitedChapters`） */
  knownChapters: ReadonlySet<number>;
  /**
   * 作品の本文（話ごと）。人物のとき、名前の出ない話の変化を根拠にした案を
   * 見分けるのに使う（`foreignChangePhrases`）。渡さなければ見ない
   */
  sources?: readonly ExcerptSource[];
}): EnrichCheckResult {
  const current = input.record as unknown as Record<string, unknown>;
  const proposals: EnrichProposal[] = [];
  const unknownCitations: EnrichCheckResult["unknownCitations"] = [];
  let speechEchoes = 0;
  const speechUnspokenFirstPersons: string[] = [];
  const foreignChanges: EnrichCheckResult["foreignChanges"] = [];
  const foreign =
    input.kind === "character" && input.sources
      ? foreignChangePhrases(input.record as Character, input.sources)
      : [];

  for (const field of enrichableFields(input.kind, input.customFields)) {
    const proposed = clampEnrichField(field, input.parsed[field.key]);
    if (!proposed) continue;
    /*
      **口調は、抽出と同じ見張りで指示の写しを落とす**（2026-09-26。
      設計書6.5.11）。説明の語の並び（「一人称、語尾、口癖」）がそのまま
      返ってくる形は、抽出で実際に起きている（CLAUDE.md の失敗3番）。
      本文の抜粋を渡すので、例の口癖が本文に無いのに入った形も見る
    */
    if (
      input.kind === "character" &&
      !field.custom &&
      field.key === "speechStyle" &&
      isSpeechStyleEcho(proposed, input.excerptText)
    ) {
      speechEchoes += 1;
      continue;
    }
    /*
      **口調の案に書いた一人称が、抜粋の台詞にあるか**（作者の裁定 2026-10-17。A22）。
      26b がある冒険者の案に「一人称は俺、場面により余」と書いた。「余」は第12話の
      皇子の語り（地の文）にしか無い。**一人称の節だけを外さず、案ごと落とす**——
      「場面により余。」のように並べて書かれると、節を外した残りが読めない文になる
    */
    if (input.kind === "character" && !field.custom && field.key === "speechStyle") {
      const unspoken = firstPersonsUnspokenInDialogue(proposed, input.excerptText);
      if (unspoken.length > 0) {
        speechUnspokenFirstPersons.push(...unspoken);
        continue;
      }
    }
    // **無い話を根拠にした値は出さない**（2026-09-25 精査 F5）。作者の実機で、
    // 2話しかない作品に「第17話を根拠に文佳の祖母」と返ってきた
    const unknown = unknownCitedChapters(proposed, input.knownChapters);
    if (unknown.length > 0) {
      unknownCitations.push({ label: field.label, chapters: unknown });
      continue;
    }
    /*
      **名前の出ない話の変化を根拠にした案は出さない**（作者の裁定 2026-10-17
      「製品で弾く」。A27）。ある冒険者の記録に第12話の抽出で入った「帝国の皇子」を、
      26b・31b が「第12話から皇子」と紹介へ持ち越した（4回中4回）。第12話の本文に
      その冒険者の名前は1度も出ない。留意点で変化を材料から外しても（2.3）、
      所属・性格など本体の欄に同じ語が残るので、コードでも見る
    */
    const carried = foreign.filter((item) => proposed.includes(item.phrase));
    if (carried.length > 0) {
      foreignChanges.push({
        label: field.label,
        phrases: [...new Set(carried.map((item) => item.phrase))],
        chapters: [...new Set(carried.flatMap((item) => item.chapters))].sort((a, b) => a - b),
      });
      continue;
    }
    // 追加項目の値は customFields の中にある
    const before = field.custom
      ? (input.record as Character).customFields?.[field.key] ?? ""
      : asText(current[field.key]);
    if (before === proposed) continue;
    proposals.push({
      field,
      before,
      after: proposed,
      fillsBlank: before.length === 0,
    });
  }

  return {
    proposals,
    unknownCitations,
    speechEchoes,
    speechUnspokenFirstPersons,
    foreignChanges,
  };
}

/** 変化の値を語句へ割る区切り（句読点・括弧・中黒・空白） */
const PHRASE_SEPARATOR = /[。、，,．.（）()「」『』【】・\s]+/u;

/**
 * 名前の出ない話の変化から取った語句（A27）。
 *
 * - 対象は AI が抽出した変化だけ（`source` が "author" のものは作者の値なので信じる。
 *   実装ルール2）
 * - 変化の**どの話の本文にも、名前・別名が1度も出ない**ものだけ。話の本文が
 *   手元に無い話が1つでもあれば判定しない（決められないものは通す）。
 *   記録の登場話（`appearedChapters`）は見ない——混入した抽出が書いたものだから
 * - 変化の値を句読点で割った2字以上の語句。**名前の出る話の変化にも同じ語句が
 *   あれば除く**（「冒険者」が第10話にも第12話にもある、など）
 */
export function foreignChangePhrases(
  character: Character,
  sources: readonly ExcerptSource[]
): Array<{ phrase: string; chapters: number[] }> {
  const names = expandNameVariants([character.name, ...character.aliases]).filter(
    (name) => name.length > 0
  );
  if (names.length === 0) return [];
  const textsOf = new Map<number, string[]>();
  for (const source of sources) {
    if (typeof source.chapter !== "number") continue;
    textsOf.set(source.chapter, [...(textsOf.get(source.chapter) ?? []), source.text]);
  }
  const named = (chapter: number): boolean | undefined => {
    const texts = textsOf.get(chapter);
    if (!texts) return undefined;
    return texts.some((text) => names.some((name) => text.includes(name)));
  };

  const phrasesOf = (value: string): string[] =>
    value
      .split(PHRASE_SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => [...part].length >= 2);

  const suspect: Array<{ phrase: string; chapters: number[] }> = [];
  const grounded = new Set<string>();
  for (const item of character.changes ?? []) {
    const chapters = item.chapters.filter((chapter) => Number.isSafeInteger(chapter));
    const seen = chapters.map(named);
    const isForeign =
      item.source !== "author" &&
      chapters.length > 0 &&
      seen.every((value) => value === false);
    for (const phrase of phrasesOf(item.value)) {
      if (isForeign) suspect.push({ phrase, chapters });
      else grounded.add(phrase);
    }
  }
  return suspect.filter((item) => !grounded.has(item.phrase));
}

/**
 * はじいた記述（`misattributed`）で受け付ける項目名（設計書6.31.2）。
 *
 * 行き先は人物レコードなので、人物が持たない項目は置けない。
 * 場所の「地域」を人物へ入れる道を作らない。
 */
export function misattributedAllowedFields(
  kind: SettingsKind,
  customFields: CustomFieldDefinition[]
): string[] {
  return enrichableFields(kind, customFields)
    .map((field) => field.key)
    .filter((key) => kind !== "character" || isCharacterTextField(key));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
