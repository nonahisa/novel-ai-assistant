import { isCharacterTextField, type Character } from "../models/character";
import type { Ability, AbilitySystem } from "../models/ability";
import { membersOf, type Organization } from "../models/organization";
import type { Location } from "../models/location";
import type { WorldItem } from "../models/world";
import type { CustomFieldDefinition } from "../models/customField";
import {
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
import { clampSummary } from "./summaryLimit";
import { isSpeechStyleEcho } from "./speechStyle";
import { unknownCitedChapters } from "./chapterCitations";
import { expandNameVariants } from "./termIndex";
import { evidencePhrases } from "./groundedEvidence";

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
 */
export function searchTermsFor(
  kind: SettingsKind,
  record: { name: string; aliases: string[]; evidence?: string | null }
): string[] {
  const names = expandNameVariants([record.name, ...record.aliases]);
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
}

/** プロンプトの【現在の設定】に渡す文章（製品の `describe` と同じ） */
export function describeEnrichTarget(
  kind: SettingsKind,
  record: EnrichRecord,
  context: EnrichDescribeContext
): string {
  if (kind === "character") {
    return describeCharacter(record as Character, context.customFields);
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
  return field.maxChars ? (clampSummary(body, field.maxChars) ?? "") : body;
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
}): EnrichCheckResult {
  const current = input.record as unknown as Record<string, unknown>;
  const proposals: EnrichProposal[] = [];
  const unknownCitations: EnrichCheckResult["unknownCitations"] = [];
  let speechEchoes = 0;

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
    // **無い話を根拠にした値は出さない**（2026-09-25 精査 F5）。作者の実機で、
    // 2話しかない作品に「第17話を根拠に文佳の祖母」と返ってきた
    const unknown = unknownCitedChapters(proposed, input.knownChapters);
    if (unknown.length > 0) {
      unknownCitations.push({ label: field.label, chapters: unknown });
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

  return { proposals, unknownCitations, speechEchoes };
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
