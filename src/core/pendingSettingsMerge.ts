import { parseAbility, type Ability } from "../models/ability";
import { parseLocation, type Location } from "../models/location";
import { parseOrganization, type Organization } from "../models/organization";
import {
  parseWorldItem,
  WORLD_CATEGORY_LABELS,
  type WorldItem,
} from "../models/world";
import {
  withOptionalCustomFields,
  type CustomFieldDefinition,
} from "../models/customField";
import { invalid, objectValue } from "../models/jsonValidation";
import type { RecordConflict } from "../models/jsonValidation";
import type { CharacterDiff, FieldChange } from "./characterDiff";
import {
  readReason,
  readSource,
  type PendingUpdateSource,
} from "./pendingUpdateFormat";
import { clampSummary } from "./summaryLimit";
import type { SettingsKind } from "./settingsSummary";

/**
 * 人物以外（能力・組織・場所・世界観）の承認待ちの更新案（作者の裁定、
 * 2026-09-23 問11 B）。**形・取り込み・差分の純粋な部分**だけを持つ。
 * 置き場（`.aiwriter/pending-settings/`）の読み書きは `pendingSettingsUpdates.ts`。
 *
 * ## 人物の承認待ちと分けたわけ
 *
 * 人物の承認待ち（`.aiwriter/pending-characters/`）は、中身が人物のJSON
 * そのもので、古いファイルは包みすら持たない。そこへ場所を混ぜると、
 * 古い版の拡張機能やMCPの束（`pendingUpdateFormat.ts` を読む）が
 * 場所の案を人物として読もうとして壊れたファイル扱いにする。
 * 置き場を分ければ、人物の道には1文字も触らずに済む。
 *
 * ## 取り込みはコードが行う（規則3）
 *
 * 更新案はレコード丸ごとの写しだが、**そのまま保存しない。** 積んでから
 * 承認までのあいだに作者がパネルで書いたものを、古い写しで巻き戻さないため、
 * いまの台帳のレコードを土台にして、更新案から入れてよいものだけを足す
 * （`mergePendingSettingsRecord`）。
 */

export type PendingSettingsKind = Exclude<SettingsKind, "character">;

export const PENDING_SETTINGS_KINDS: readonly PendingSettingsKind[] = [
  "ability",
  "organization",
  "location",
  "world",
];

export type PendingSettingsRecord = Ability | Organization | Location | WorldItem;

/** 置き場（`.aiwriter/` の下） */
export const PENDING_SETTINGS_DIR = "pending-settings";

/** 画面に出す種類の短い呼び名。**文言はここだけが持つ** */
export const PENDING_KIND_SHORT_LABELS: Record<SettingsKind, string> = {
  character: "人物",
  ability: "能力",
  organization: "組織",
  location: "場所",
  world: "世界観",
};

const PARSERS: Record<PendingSettingsKind, (raw: unknown) => PendingSettingsRecord> = {
  ability: parseAbility,
  organization: parseOrganization,
  location: parseLocation,
  world: parseWorldItem,
};

export interface PendingSettingsPayload {
  recordKind: PendingSettingsKind;
  source?: PendingUpdateSource;
  reason?: string;
  record: PendingSettingsRecord;
}

/**
 * 保留ファイルへ書く中身。
 *
 * 人物と違って**いつも包む**——どの台帳のレコードかを中身から決められる
 * ようにする（IDの頭でも分かるが、種類を明記しておけば読み違えない）。
 */
export function buildPendingSettingsPayload(
  recordKind: PendingSettingsKind,
  record: PendingSettingsRecord,
  options: { source?: PendingUpdateSource; reason?: string } = {}
): PendingSettingsPayload {
  const reason = options.reason?.trim();
  return {
    recordKind,
    ...(options.source ? { source: options.source } : {}),
    ...(reason ? { reason } : {}),
    record,
  };
}

/**
 * 保留ファイルの中身を読む。**壊れていたら例外を投げ、直さない。**
 *
 * - 種類が分からない案は読まない（どの台帳へ入れるか決められない）
 * - 種類とIDの形が食い違う案は読まない（各種類の検証がIDの形を見る）
 * - 新しく作る案（`kind: "creation"`）は**まだ扱わない**。黙って既存の
 *   更新として入れると、居ないレコードを探して片付けられ、案が消える
 */
export function parsePendingSettingsPayload(raw: unknown): PendingSettingsPayload {
  const value = objectValue(raw, "pendingSettings");
  const recordKind = value.recordKind;
  if (
    typeof recordKind !== "string" ||
    !(PENDING_SETTINGS_KINDS as readonly string[]).includes(recordKind)
  ) {
    invalid("recordKind");
  }
  if (value.kind !== undefined) {
    invalid("kind（新しく作る案は、人物のほかはまだ扱えません）");
  }
  const kind = recordKind as PendingSettingsKind;
  const record = PARSERS[kind](value.record);
  const source = readSource(value);
  const reason = readReason(value);
  return {
    recordKind: kind,
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    record,
  };
}

/** 保留ファイルの名前。IDの頭（loc_ など）が種類をまたいで重ならないので、IDだけでよい */
export function pendingSettingsFileName(record: { id: string }): string {
  return `${record.id}.json`;
}

/** 種類ごとの「書き足してよい文の項目」。名前・IDはここに入れない（改名は作者の操作） */
const TEXT_FIELDS: Record<PendingSettingsKind, readonly string[]> = {
  ability: ["reading", "summary", "category", "description", "cost", "limitation"],
  organization: ["reading", "summary", "category", "parent", "description"],
  location: ["reading", "summary", "region", "description"],
  world: ["reading", "category", "description"],
};

/**
 * 外部AIの提案（MCP `novel.propose`）で受け付ける欄＝白名簿（設計書6.87.16）。
 *
 * **ここに置くのは、入口と出口で同じ表を見るため。** 入口
 * （`mcp/tools/proposeRecord.ts`）はこれで欄を振り分け、出口
 * （`mergePendingSettingsRecord`）は作者が確定させた記録へ入れてよい欄を
 * これで決める。表が2つあると、片方に欄を足したとき、入口は受けたのに
 * 出口が黙って入れない（作者の画面に何も並ばない）ずれが起きる。
 *
 * 選び方は人物の白名簿と同じ——作者が読んで採否を決められる文の欄と、
 * 足すだけの一覧（別名・使い手）。**読み仮名（`reading`）は入れない**。
 * 人物の道が「作中で変わらない項目なので、違う値は読み違いである」として
 * 受けないのと揃える（実装ルール2「読み仮名は畳まない」）。
 */
export const EXTERNAL_PROPOSE_FIELDS: Record<PendingSettingsKind, readonly string[]> = {
  ability: [
    "summary",
    "category",
    "description",
    "cost",
    "limitation",
    "aliases",
    "userNames",
  ],
  organization: ["summary", "category", "parent", "description", "aliases"],
  location: ["summary", "region", "description", "aliases"],
  world: ["category", "description", "aliases"],
};

/**
 * 足すだけの欄。差し替えを許すと、作者が手で足した別名や使い手が
 * 外からの提案1回で消える（人物の `aliases` と同じ考え）。
 */
export const ADD_ONLY_PROPOSE_FIELDS: ReadonlySet<string> = new Set([
  "aliases",
  "userNames",
]);

export interface MergePendingSettingsOptions {
  /** 案の出どころ。省略は「出どころ無し」（抽出など、自動で積まれた案） */
  source?: PendingUpdateSource;
}

/**
 * 更新案を、いまの台帳のレコードへ取り込む（CLAUDE.md 規則2・3）。
 *
 * - **作者メモ・資料用の補足・AIメモは取り込まない**（作者のデータ・作者が承認したもの）
 * - **作者が確定させた記録（`autoGenerated: false`）は、出どころで分ける**
 *   （作者の裁定、2026-09-24「３ＯＫ」）：
 *   - 外部AIの案（`source: "external"`）は、白名簿の欄（`EXTERNAL_PROPOSE_FIELDS`）
 *     だけを入れる。人物の道が確定した人物にも外部AIの案を置け、承認で
 *     そのまま入るのと揃えた
 *   - それ以外（出どころ無し・相談・プロット）は**登場話数の追記だけ**
 * - 名前・ID・`autoGenerated` は変えない（改名は作者の操作。確定の印は作者のもの。
 *   確定した記録へ反映したあとも `false` のまま）
 * - 更新案で空の項目は、いまの値を消さない（写しに欠けがあっても作者の値は残る）
 * - 別名・能力の使い手・食い違いの記録・登場話数は**足すだけ**（消さない）
 * - 紹介文の長さはコードで揃える
 *
 * 食い違いを「作中の変化」と読むか作者に訊くかの振り分け（設計書6.18）は、
 * 更新案を**作る側**（抽出のマージ）の仕事である。ここへ来た値は、作者が
 * 差分を見て採るかどうかを決める。
 *
 * ## 確定した記録を出どころで切るわけ
 *
 * 人物の承認（`applyPendingUpdates.ts` の `applyItem`）は、案の写しを
 * そのまま保存し、確定の印を見ない。確定した人物を守るのは**案を作る側**
 * ——抽出のマージ（`characterMerge.ts`）が確定した人物には登場話数しか
 * 足さない——で、外部AIの道（`propose.ts`）は確定した人物にも白名簿の欄を
 * 入れて置く。どちらも作者が差分を見て採ったときだけ入る。
 *
 * 人物以外は、この取り込みが**出口で**守りを兼ねている。いま
 * `pending-settings/` へ積むのは外部AIだけだが、将来ほかの道（抽出など
 * 自動）がここへ積んだとき、作る側が確定の記録を守り忘れても、ここで
 * 登場話数しか入らないようにしておく。外部AIの案だけを通すのは、入口
 * （`proposeRecord.ts`）が白名簿で欄を絞り、理由を必ず添えさせた案で、
 * 作者がそれを読んで採る前提で作った道だから（出口でも同じ白名簿で絞る）。
 */
export function mergePendingSettingsRecord(
  kind: PendingSettingsKind,
  current: PendingSettingsRecord,
  proposal: PendingSettingsRecord,
  options: MergePendingSettingsOptions = {}
): PendingSettingsRecord {
  const next = structuredClone(current) as PendingSettingsRecord &
    Record<string, unknown>;
  next.appearedChapters = unionNumbers(
    current.appearedChapters,
    proposal.appearedChapters
  );
  if (!current.autoGenerated) {
    if (options.source !== "external") return next;
    return mergeIntoConfirmedRecord(kind, current, proposal, next);
  }

  const incoming = proposal as PendingSettingsRecord & Record<string, unknown>;
  for (const field of TEXT_FIELDS[kind]) {
    const value = incoming[field];
    if (typeof value !== "string" || !value.trim()) continue;
    next[field] = field === "summary" ? clampSummary(value) : value;
  }

  next.aliases = unionStrings(current.aliases, proposal.aliases).filter(
    // 名前そのものを別名に入れない（一覧で同じ名前が2度出る）
    (alias) => alias !== current.name
  );
  if (!current.evidence && proposal.evidence) next.evidence = proposal.evidence;
  next.conflicts = unionConflicts(current.conflicts, proposal.conflicts);

  if (kind === "ability") {
    const ability = next as Ability;
    const incomingAbility = proposal as Ability;
    ability.userNames = unionStrings(ability.userNames, incomingAbility.userNames);
    ability.userIds = unionStrings(ability.userIds, incomingAbility.userIds);
  }

  // 追加項目は、更新案に入っているものだけを上書きし、いまの値は消さない
  const values = { ...(current.customFields ?? {}) };
  for (const [key, value] of Object.entries(proposal.customFields ?? {})) {
    if (value.trim()) values[key] = value;
  }
  return withOptionalCustomFields(next, values);
}

/**
 * 作者が確定させた記録へ、外部AIの案を取り込む。
 *
 * **入れるのは白名簿の欄だけ**——入口が絞っていても、`pending-settings/` の
 * ファイルは手でも書けるので、出口でも同じ表で絞る。読み仮名・食い違いの
 * 記録・根拠・追加項目・使い手の番号は、確定した記録では作者のものとして
 * 残す（自動の記録なら足してよいものも、確定した記録には入れない）。
 * 確定の印（`autoGenerated: false`）は `next`（いまの写し）のまま変えない。
 */
function mergeIntoConfirmedRecord(
  kind: PendingSettingsKind,
  current: PendingSettingsRecord,
  proposal: PendingSettingsRecord,
  next: PendingSettingsRecord & Record<string, unknown>
): PendingSettingsRecord {
  const incoming = proposal as PendingSettingsRecord & Record<string, unknown>;
  const existing = current as PendingSettingsRecord & Record<string, unknown>;
  for (const field of EXTERNAL_PROPOSE_FIELDS[kind]) {
    const value = incoming[field];
    if (ADD_ONLY_PROPOSE_FIELDS.has(field)) {
      if (!Array.isArray(value)) continue;
      const merged = unionStrings(
        Array.isArray(existing[field]) ? (existing[field] as string[]) : [],
        value.filter((item): item is string => typeof item === "string")
      );
      next[field] =
        field === "aliases"
          ? // 名前そのものを別名に入れない（一覧で同じ名前が2度出る）
            merged.filter((alias) => alias !== current.name)
          : merged;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    next[field] = field === "summary" ? clampSummary(value) : value;
  }
  return next;
}

function unionNumbers(left: number[], right: number[]): number[] {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function unionStrings(left: string[], right: string[]): string[] {
  const out = [...left];
  for (const value of right) {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function unionConflicts(
  left: RecordConflict[],
  right: RecordConflict[]
): RecordConflict[] {
  const seen = new Set(left.map((conflict) => JSON.stringify(conflict)));
  const out = [...left];
  for (const conflict of right) {
    const key = JSON.stringify(conflict);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(conflict);
  }
  return out;
}

/** 差分に並べる項目。画面の見出しは設定資料パネルと同じ言葉にする */
const DIFF_FIELDS: Record<
  PendingSettingsKind,
  ReadonlyArray<{ label: string; read: (record: PendingSettingsRecord) => string }>
> = {
  ability: [
    { label: "別名", read: (r) => r.aliases.join("、") },
    { label: "紹介", read: (r) => (r as Ability).summary ?? "" },
    { label: "読み", read: (r) => r.reading ?? "" },
    { label: "分類", read: (r) => (r as Ability).category ?? "" },
    { label: "説明", read: (r) => r.description ?? "" },
    { label: "代償", read: (r) => (r as Ability).cost ?? "" },
    { label: "制約", read: (r) => (r as Ability).limitation ?? "" },
    { label: "使い手", read: (r) => (r as Ability).userNames.join("、") },
  ],
  organization: [
    { label: "別名", read: (r) => r.aliases.join("、") },
    { label: "紹介", read: (r) => (r as Organization).summary ?? "" },
    { label: "読み", read: (r) => r.reading ?? "" },
    { label: "種別", read: (r) => (r as Organization).category ?? "" },
    { label: "上位組織", read: (r) => (r as Organization).parent ?? "" },
    { label: "説明", read: (r) => r.description ?? "" },
  ],
  location: [
    { label: "別名", read: (r) => r.aliases.join("、") },
    { label: "紹介", read: (r) => (r as Location).summary ?? "" },
    { label: "読み", read: (r) => r.reading ?? "" },
    { label: "地域", read: (r) => (r as Location).region ?? "" },
    { label: "説明", read: (r) => r.description ?? "" },
  ],
  world: [
    { label: "別の言い方", read: (r) => r.aliases.join("、") },
    {
      label: "分類",
      read: (r) => WORLD_CATEGORY_LABELS[(r as WorldItem).category] ?? "",
    },
    { label: "読み", read: (r) => r.reading ?? "" },
    { label: "内容", read: (r) => r.description ?? "" },
  ],
};

/**
 * 何が変わるかを並べる（人物の `diffCharacter` と同じ形で返す）。
 *
 * 比べるのは**いまの台帳と、取り込んだあとのレコード**である。更新案と
 * 直に比べると、取り込まない項目（作者メモなど）の違いまで「変わる」と出て、
 * 押しても入らない変更を見せることになる。
 */
export function diffSettingsRecord(
  kind: PendingSettingsKind,
  before: PendingSettingsRecord,
  after: PendingSettingsRecord,
  customFields: CustomFieldDefinition[]
): CharacterDiff {
  const changes: FieldChange[] = [];
  for (const field of DIFF_FIELDS[kind]) {
    const left = field.read(before);
    const right = field.read(after);
    if (left !== right) changes.push({ label: field.label, before: left, after: right });
  }

  // 追加項目。定義に無いキーも見る（外したあとも値は残るので、書き換わるなら見せる）
  const labels = new Map(customFields.map((field) => [field.key, field.label]));
  const beforeValues = before.customFields ?? {};
  const afterValues = after.customFields ?? {};
  const keys = new Set([
    ...customFields.map((field) => field.key),
    ...Object.keys(beforeValues),
    ...Object.keys(afterValues),
  ]);
  for (const key of keys) {
    const left = beforeValues[key] ?? "";
    const right = afterValues[key] ?? "";
    if (left !== right) {
      changes.push({ label: labels.get(key) ?? key, before: left, after: right });
    }
  }

  const beforeChapters = before.appearedChapters.join("、");
  const afterChapters = after.appearedChapters.join("、");
  if (beforeChapters !== afterChapters) {
    changes.push({ label: "登場話", before: beforeChapters, after: afterChapters });
  }

  // 作者メモ・資料用の補足は取り込まない約束だが、万一変わるなら必ず見せる
  for (const field of [
    { label: "作者メモ", read: (r: PendingSettingsRecord) => r.authorNotes },
    { label: "資料用の補足", read: (r: PendingSettingsRecord) => r.exportNote },
  ]) {
    const left = field.read(before);
    const right = field.read(after);
    if (left !== right) changes.push({ label: field.label, before: left, after: right });
  }

  return { id: after.id, name: after.name, changes };
}

/**
 * 「反映待ちの更新が N 件あります（人物 3・場所 1）」（作者の依頼、2026-09-23 ⑥）。
 *
 * **0件なら空文字**——設定資料パネルは空なら入口ごと隠す。
 * 並びは設定資料パネルのタブと同じにする。
 */
export function describePendingUpdateCounts(
  counts: Partial<Record<SettingsKind, number>>
): string {
  const order: SettingsKind[] = [
    "character",
    "ability",
    "organization",
    "location",
    "world",
  ];
  const parts = order
    .map((kind) => ({ kind, count: counts[kind] ?? 0 }))
    .filter((entry) => entry.count > 0);
  const total = parts.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return "";
  return (
    `反映待ちの更新が ${total} 件あります（` +
    parts
      .map((entry) => `${PENDING_KIND_SHORT_LABELS[entry.kind]} ${entry.count}`)
      .join("・") +
    "）"
  );
}
