import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { parseCharacter, type Character } from "../../models/character";
import {
  emptyAbilitySystem,
  parseAbility,
  parseAbilitySystem,
  type AbilitySystem,
} from "../../models/ability";
import { parseOrganization } from "../../models/organization";
import { parseLocation } from "../../models/location";
import { parseWorldItem } from "../../models/world";
import {
  emptyCustomFieldSet,
  fieldsFor,
  parseCustomFieldSet,
  type CustomFieldDefinition,
} from "../../models/customField";
import {
  MISATTRIBUTED_KEY,
  SETTINGS_ENRICH_TEMPERATURE,
  SETTINGS_ENRICH_VERSION,
  buildEnrichPrompt,
  buildEnrichSchema,
  enrichableFields,
} from "../../prompts/settingsEnrich";
import { SETTINGS_ASSISTANT_SYSTEM_PROMPT } from "../../prompts/settingsChat";
import { KIND_LABELS, type SettingsKind } from "../../core/settingsSummary";
import {
  checkEnrichProposals,
  describeEnrichTarget,
  misattributedAllowedFields,
  parseEnrichResult,
  searchTermsFor,
  type EnrichRecord,
} from "../../core/settingsEnrichCheck";
import {
  collectMentionExcerpts,
  type MentionExcerpt,
} from "../../core/mentionExcerpts";
import {
  droppedTotal,
  parseMisattributedValues,
  resolveMisattributedDestination,
} from "../../core/misattributedValues";
import { knownChaptersOf } from "../../core/chapterCitations";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { episodeBodySources } from "../../core/episodeChunks";
import { isWorkInfoFile } from "../../core/workInfoFile";
import { EXTERNAL_PROPOSE_FIELDS } from "../../core/pendingSettingsMerge";
import {
  CUSTOM_FIELDS_FILE,
  McpToolError,
  SETTINGS_SUBDIRS,
  listBodyFiles,
  readBody,
  readSettingsFile,
  readSettingsRecords,
  settingsDirOf,
  workTitleOf,
} from "./shared";
import { pastSceneSourcesOf } from "./contradiction";
import { CHARACTER_PROPOSE_FIELDS } from "./propose";
import { runOnce, validateWith, type RunnerInput } from "./run";

/**
 * 「AIで再読込」（P-20、設計書6.31.1）を外から呼ぶ（作者の裁定、2026-10-01）。
 *
 * 発端は実機確認——口調の出来の3項目が、画面でしか確かめられずに残った。
 * 設定資料パネルの1記録について、各項目に入れる値を本文から読み直させる。
 *
 * ## 製品と同じもの
 *
 * - プロンプト：`buildEnrichPrompt`／`buildEnrichSchema`、指示は
 *   `SETTINGS_ASSISTANT_SYSTEM_PROMPT`、温度は `SETTINGS_ENRICH_TEMPERATURE`
 * - 【現在の設定】：`describeEnrichTarget`（画面の `describe` と同じ関数）
 * - 検算：`checkEnrichProposals`（無い話の引用・口調の指示の写し・「不明」・
 *   いまと同じ値を落とす）と `parseMisattributedValues`（はじいた記述を本文と照合）
 *
 * ## 製品と違うところ（正直に書く）
 *
 * **本文の抜粋は、画面が検索を使えないときの選び方である**
 * （`collectMentionExcerpts`。名前と別名が出る場面を作品全体から均等に間引く）。
 * 画面はまず意味検索（索引は作品の外、検索語づくりにもう1回AIを呼ぶ）で
 * 項目名に近い場面を探し、組めなければこちらへ落ちる。MCP の相談
 * （`chat.ts`）と同じく意味検索は使わない——索引が作品の外にあり、検索語の
 * ためにAIを1回余分に呼ぶことになるため。
 *
 * ## 書かない
 *
 * **`novel.run` は読む・測る・提案するだけ**（設計書6.87.8）。結果は返すだけで、
 * 承認待ちへ置くのは呼び手が `novel.propose` で行う——そのために、そのまま
 * 渡せる形（`proposeArgs`）を返す。`novel.run` の中で置くと、作者が
 * `novel.propose` に掛けている許可（6.87.14。読む許可とは別）を素通りする。
 */

const FEATURE = "settingsEnrich";
const VALIDATE_WITH = validateWith(FEATURE);

/** どの台帳か（省略すると人物） */
export const ENRICH_RECORD_KIND_SCHEMA = z.enum([
  "character",
  "ability",
  "organization",
  "location",
  "world",
]);

export interface SettingsEnrichInput {
  folder: string;
  recordKind?: SettingsKind;
  /** 記録の名前（完全一致）。`id` とどちらかが要る */
  name?: string;
  id?: string;
  /** 作者の留意点（設計書6.31.1）。原文のまま渡す */
  notes?: string;
}

const SUBDIR_OF: Record<SettingsKind, string> = {
  character: SETTINGS_SUBDIRS.characters,
  ability: SETTINGS_SUBDIRS.abilities,
  organization: SETTINGS_SUBDIRS.organizations,
  location: SETTINGS_SUBDIRS.locations,
  world: SETTINGS_SUBDIRS.world,
};

function readRecords(folder: string, kind: SettingsKind): EnrichRecord[] {
  const subdir = SUBDIR_OF[kind];
  if (kind === "character") {
    return readSettingsRecords(folder, subdir, parseCharacter).records;
  }
  if (kind === "ability") return readSettingsRecords(folder, subdir, parseAbility).records;
  if (kind === "organization") {
    return readSettingsRecords(folder, subdir, parseOrganization).records;
  }
  if (kind === "world") return readSettingsRecords(folder, subdir, parseWorldItem).records;
  return readSettingsRecords(folder, subdir, parseLocation).records;
}

/** 追加項目の定義。**読めなければ空**（製品の表示用の読み方と同じ） */
function readCustomFields(folder: string): CustomFieldDefinition[] {
  const raw = readSettingsFile(folder, CUSTOM_FIELDS_FILE);
  if (raw === undefined) return fieldsFor(emptyCustomFieldSet(), "character");
  try {
    return fieldsFor(parseCustomFieldSet(raw), "character");
  } catch {
    return fieldsFor(emptyCustomFieldSet(), "character");
  }
}

/**
 * 能力の体系。製品（`AbilitySystemStore.load`）と同じく、**無ければ既定値、
 * 壊れていれば undefined**（体系の欄を添えずに続ける）。
 */
function readAbilitySystem(folder: string): AbilitySystem | undefined {
  const settings = settingsDirOf(folder);
  const file = settings ? nodePath.join(settings, "ability_system.json") : undefined;
  if (!file || !fs.existsSync(file)) return emptyAbilitySystem();
  const raw = readSettingsFile(folder, "ability_system.json");
  if (raw === undefined) return undefined;
  try {
    return parseAbilitySystem(raw);
  } catch {
    return undefined;
  }
}

/**
 * 作品の話数（無い話の引用を落とすのに使う）。製品は走査（`scanWork`）の
 * 話の一覧から取る。ここはファイル名の話数を読み、合本は中の話へ割る。
 */
function knownChaptersOfWork(folder: string): Set<number> {
  const episodes: Array<{
    kind: ReturnType<typeof parseEpisodeFileName>["kind"];
    chapterStart: number | null;
    chapterEnd: number | null;
  }> = [];
  for (const filePath of listBodyFiles(folder)) {
    let text: string;
    try {
      text = readBody(folder, filePath);
    } catch {
      continue;
    }
    const fileName = nodePath.basename(filePath);
    if (isWorkInfoFile(fileName, text)) continue;
    const parsed = parseEpisodeFileName(fileName);
    for (const source of episodeBodySources(filePath, text, {
      chapterStart: parsed.chapterStart,
      chapterEnd: parsed.chapterEnd,
    })) {
      episodes.push({
        kind: parsed.kind,
        chapterStart: source.chapterStart ?? null,
        chapterEnd: source.chapterEnd ?? source.chapterStart ?? null,
      });
    }
  }
  return knownChaptersOf(episodes);
}

interface EnrichTarget {
  kind: SettingsKind;
  record: EnrichRecord;
  customFields: CustomFieldDefinition[];
  characters: Character[];
  excerpts: MentionExcerpt[];
}

/**
 * 対象の記録と、その材料を揃える。
 *
 * **名前は完全一致だけ**で引く（別名では引かない）。`novel.propose` と同じ
 * 考えで、取り違えたまま承認されると別人の資料が書き換わる。
 */
function loadTarget(input: SettingsEnrichInput): EnrichTarget {
  const kind = input.recordKind ?? "character";
  const name = input.name?.trim();
  const id = input.id?.trim();
  if (!name && !id) {
    throw new McpToolError(
      "AIで再読込（feature: settingsEnrich）には options.name（記録の名前）か options.id が要ります。"
    );
  }
  const records = readRecords(input.folder, kind);
  const record = id
    ? records.find((item) => item.id === id)
    : records.find((item) => item.name === name);
  if (!record) {
    throw new McpToolError(
      `${KIND_LABELS[kind]}の台帳に「${id ?? name}」が見つかりません` +
        "（名前は別名ではなく、台帳の名前と完全に同じものを渡してください）。"
    );
  }
  const characters =
    kind === "character"
      ? (records as Character[])
      : (readRecords(input.folder, "character") as Character[]);
  const customFields = readCustomFields(input.folder);
  // 本文の割り方は製品の `loadExcerptSources` と同じ（`excerptSourcesOfEpisode`）
  const excerpts = collectMentionExcerpts(
    pastSceneSourcesOf(input.folder),
    searchTermsFor(kind, record)
  );
  return { kind, record, customFields, characters, excerpts };
}

export function settingsEnrichPrompt(input: SettingsEnrichInput) {
  const target = loadTarget(input);
  const { kind, record, customFields, excerpts } = target;
  const userPrompt = buildEnrichPrompt({
    workTitle: workTitleOf(input.folder),
    kind,
    target: {
      kindLabel: KIND_LABELS[kind],
      name: record.name,
      currentSettings: describeEnrichTarget(kind, record, {
        customFields,
        abilitySystem: kind === "ability" ? readAbilitySystem(input.folder) : undefined,
        characters: target.characters,
      }),
    },
    excerpts,
    customFields,
    notes: input.notes,
  });
  return {
    promptVersion: `P-20 ${SETTINGS_ENRICH_VERSION}`,
    recordKind: kind,
    id: record.id,
    name: record.name,
    autoGenerated: record.autoGenerated,
    systemPrompt: SETTINGS_ASSISTANT_SYSTEM_PROMPT,
    schema: buildEnrichSchema(kind, customFields),
    temperature: SETTINGS_ENRICH_TEMPERATURE,
    validateWith: VALIDATE_WITH,
    /** 渡した本文の抜粋の数と字数（材料の前提を返り値に残す） */
    excerptCount: excerpts.length,
    excerptChars: excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0),
    userPrompt,
    note:
      "本文の抜粋は、名前と別名が出る場面を作品全体から均等に選んだものです" +
      "（画面は意味検索を先に試します。MCP では使いません）。",
  };
}

/** 承認待ちへ置かない提案と、その理由 */
interface NotProposed {
  field: string;
  label: string;
  after: string;
  reason: string;
}

/** 作者が確定させた記録で、作者の値を置き換える提案を置かない理由 */
const AUTHOR_VALUE_REASON =
  "作者が確定させた記録で、作者の値がある欄です。承認待ちの案には入れません（画面でも既定では選ばれない欄です。採るかは作者が画面で決めます）";

const CUSTOM_FIELD_REASON =
  "作者が足した項目は承認待ちへ置けません（設定資料パネルの「AIで再読込」から反映してください）";

const NOT_PROPOSABLE_REASON = "この台帳の承認待ちが受け付けない欄です";

export function settingsEnrichValidate(
  input: SettingsEnrichInput & { response: string }
) {
  const target = loadTarget(input);
  const { kind, record, customFields, excerpts } = target;
  const parsed = parseEnrichResult(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（AIで再読込のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  const excerptText = excerpts.map((excerpt) => excerpt.text).join("\n");

  // **検算は製品と同じ関数**（`settingsPanel.ts` の `handleEnrich` も通る）
  const checked = checkEnrichProposals({
    kind,
    record,
    customFields,
    parsed,
    excerptText,
    knownChapters: knownChaptersOfWork(input.folder),
  });

  const proposeFields: readonly string[] =
    kind === "character" ? CHARACTER_PROPOSE_FIELDS : EXTERNAL_PROPOSE_FIELDS[kind];
  const changes: Record<string, string> = {};
  const notProposed: NotProposed[] = [];
  for (const proposal of checked.proposals) {
    const { field, before, after } = proposal;
    const skip = (reason: string) =>
      notProposed.push({ field: field.key, label: field.label, after, reason });
    if (field.custom) {
      skip(CUSTOM_FIELD_REASON);
      continue;
    }
    if (!proposeFields.includes(field.key)) {
      skip(NOT_PROPOSABLE_REASON);
      continue;
    }
    /*
      **作者が確定させた記録の、作者の値は置き換えさせない**（実装ルール2）。
      画面は提案として並べるが既定では選ばない（作者が自分で選ぶ）。外から
      承認待ちへ積むと、確定した記録へ外部AIの案が入る道になる——作者の
      裁定（2026-10-01）で、再読込の結果は作者の項目を対象にしない
    */
    if (!record.autoGenerated && before.length > 0) {
      skip(AUTHOR_VALUE_REASON);
      continue;
    }
    changes[field.key] = after;
  }

  const misattributed = parseMisattributedValues(
    parsed[MISATTRIBUTED_KEY],
    excerptText,
    misattributedAllowedFields(kind, customFields)
  );
  const labels = new Map(
    enrichableFields(kind, customFields).map((field) => [field.key, field.label])
  );

  const notes = input.notes?.trim();
  const proposeArgs =
    Object.keys(changes).length === 0
      ? null
      : {
          kind: "settings" as const,
          folder: input.folder,
          recordKind: kind,
          name: record.name,
          changes,
          // 理由はコードが組む（AIの文を作者の判断材料に直結させない）
          reason:
            `AIで再読込（P-20 ${SETTINGS_ENRICH_VERSION}）の提案。` +
            `本文の抜粋${excerpts.length}件から読み直した値です。` +
            (notes ? `作者の留意点：${notes}` : ""),
        };

  return {
    recordKind: kind,
    id: record.id,
    name: record.name,
    autoGenerated: record.autoGenerated,
    /** 画面に並ぶのと同じ提案（いまの値と並べて、作者が選ぶもの） */
    proposals: checked.proposals.map(({ field, before, after, fillsBlank }) => ({
      field: field.key,
      label: field.label,
      before,
      after,
      /** 空欄を埋める提案か。画面はこれだけを既定で選ぶ */
      fillsBlank,
    })),
    /**
     * `novel.propose` へそのまま渡せる引数。置くかどうかは呼び手が決める
     * （ここは置かない）。置ける欄が無ければ null
     */
    proposeArgs,
    notProposed,
    /** はじいた記述（本文と照合できたものだけ）。行き先の照合はコードが行う */
    misattributed: misattributed.entries.map((entry) => ({
      ...entry,
      fieldLabel: labels.get(entry.field) ?? entry.field,
      destination:
        kind === "character"
          ? resolveMisattributedDestination(entry.belongsTo, target.characters)
          : null,
    })),
    dropped: {
      unknownCitations: checked.unknownCitations,
      speechEchoes: checked.speechEchoes,
      misattributed: droppedTotal(misattributed.dropped),
    },
    nextStep: proposeArgs
      ? "作者に見せてよければ、proposeArgs を novel.propose へ渡すと承認待ちへ置けます（作者が「設定資料更新分反映」で採否を決めます）。"
      : "承認待ちへ置ける提案はありません。",
    note:
      "台帳（設定/）にも承認待ちにも書いていません。はじいた記述の行き先（挿入・新規）は、設定資料パネルの「AIで再読込」でだけ選べます。",
  };
}

export async function settingsEnrichRun(input: SettingsEnrichInput & RunnerInput) {
  return runOnce(input, settingsEnrichPrompt(input), (response) =>
    settingsEnrichValidate({ ...input, response })
  );
}
