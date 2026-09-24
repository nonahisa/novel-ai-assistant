import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { AIWRITER_DIR } from "../../models/types";
import { parseCharacter } from "../../models/character";
import {
  emptyCustomFieldSet,
  fieldsFor,
  parseCustomFieldSet,
  type CustomFieldSet,
} from "../../models/customField";
import type { FieldChange } from "../../core/characterDiff";
import {
  PENDING_DIR,
  pendingSourceLabel,
  type PendingUpdateSource,
} from "../../core/pendingUpdateFormat";
import {
  PENDING_KIND_SHORT_LABELS,
  PENDING_SETTINGS_DIR,
  PENDING_SETTINGS_KINDS,
  type PendingSettingsKind,
  type PendingSettingsRecord,
} from "../../core/pendingSettingsMerge";
import {
  STALE_REASON_LABELS,
  assembleCharacterReview,
  assembleSettingsReview,
  comparePendingCharacterUpdates,
  comparePendingSettingsUpdates,
  describeCharacterReviewItem,
  describeSettingsReviewItem,
  readPendingCharacterFile,
  readPendingSettingsFile,
  type PendingSettingsUpdate,
  type PendingUpdate,
  type StaleReason,
} from "../../core/pendingReview";
import type { SettingsKind } from "../../core/settingsSummary";
import {
  CUSTOM_FIELDS_FILE,
  FOLDER_INPUT,
  McpToolError,
  SETTINGS_SUBDIRS,
  readSettingsFile,
  readSettingsRecords,
} from "./shared";
import { PARSERS as RECORD_PARSERS, SUBDIRS as RECORD_SUBDIRS } from "./proposeRecord";

/**
 * 承認待ちの更新案を読む（`pending.list`。0.85.1、作者の承認 2026-09-24）。
 *
 * 実機確認で「提案パネルに何が並ぶか」を確かめたいが、パネルはスクロール
 * しないと見えない（人物の案18件の下にある場所の案2件を探しきれなかった）。
 * そこで、**パネルと同じ組み立て**で並ぶものを外から読めるようにする。
 *
 * **組み立ては製品と同じ関数を通す**（`core/pendingReview.ts`）。どれを
 * 見せ、どれを古い案として片付けるか、差分に何が並ぶかを、ここで書き直さない
 * ——写すと、画面と外から読めるものが片方だけ直ってずれる。ここが持つのは
 * Node の `fs` でファイルを読むところだけ（製品は `vscode.workspace.fs`）。
 *
 * **読むだけ。** 承認・却下・片付け（古い案の削除）はしない。作者が
 * VS Code の「設定資料更新分反映」で決める。
 */

/** 返す件数の既定。一覧は会話の材料なので、必要なら絞って読み直してもらう */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** `source` の「出どころ無し」の呼び名。製品では抽出が積んだ案がこれ */
const EXTRACTION = "extraction";
type SourceName = typeof EXTRACTION | PendingUpdateSource;

export const PENDING_LIST_INPUT = {
  ...FOLDER_INPUT,
  kind: z
    .enum(["character", "ability", "organization", "location", "world"])
    .optional()
    .describe(
      "種類で絞る（人物 character・能力 ability・組織 organization・場所 location・世界観 world）。省略すると全部"
    ),
  source: z
    .enum([EXTRACTION, "plot", "chat", "external"])
    .optional()
    .describe(
      "出どころで絞る（extraction＝抽出・plot＝プロットから・chat＝相談から・external＝外部AIから）。省略すると全部"
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(`返す件数の上限（既定 ${DEFAULT_LIMIT}）。数える件数（counts）は絞る前のまま`),
};

export interface PendingListInput {
  folder: string;
  kind?: SettingsKind;
  source?: SourceName;
  limit?: number;
}

/**
 * 1件の状態。
 *
 * - `pending`：提案パネルに並ぶ（作者が採るか見送るかを決める）
 * - `stale`：古い案。**パネルには並ばず**、「更新分反映」を押すと片付けられる
 * - `blocked`：台帳のファイルが読めないため、製品が組み立てを見合わせている。
 *   読めないファイルを直すまでパネルに並ばない（片付けもされない）
 */
export type PendingListStatus = "pending" | "stale" | "blocked";

export interface PendingListItem {
  /** 保留ファイル（作品フォルダーからの相対） */
  file: string;
  recordKind: SettingsKind;
  /** 種類の呼び名（人物・能力・組織・場所・世界観） */
  kindLabel: string;
  id: string;
  name: string;
  /** 新しく作る案か（人物だけ） */
  creation: boolean;
  source: SourceName;
  /** 出どころの呼び名（製品の画面と同じ言葉。抽出は「抽出」） */
  sourceLabel: string;
  /** 提案の理由。無ければ null */
  reason: string | null;
  status: PendingListStatus;
  /** 古い案の理由（`status: "stale"` のときだけ） */
  staleReason?: string;
  /** 提案パネルの出どころの欄と同じ一行（`status: "pending"` のときだけ） */
  panelLine?: string;
  /**
   * 変わる欄（前 → 後）。**提案パネルと同じ差分**で、いまの台帳と
   * 取り込んだあとを比べたもの。`pending` のときだけ入る
   */
  changes: Array<{ label: string; before: string; after: string }>;
  /** 作者が退けた関係に当たって、案から外される関係（人物だけ） */
  skippedRejectedRelations?: Array<{ name: string; relation: string }>;
}

export interface PendingListResult {
  /** 承認待ちのファイルの数（読めないものを含む。絞る前） */
  total: number;
  /** 状態ごとの件数（絞る前） */
  counts: Record<PendingListStatus | "unreadable", number>;
  /** 種類ごとの件数（読めた案だけ。絞る前） */
  byKind: Partial<Record<SettingsKind, number>>;
  /** 絞ったあとの件数 */
  matched: number;
  /** 上限で切ったか */
  truncated: boolean;
  /** 並びは提案パネルと同じ（人物 → 人物以外、それぞれID順）。古い案・見合わせは後ろ */
  items: PendingListItem[];
  /** 読めない案（壊れたJSON・知らない形）。**製品も直さず残す** */
  unreadable: Array<{ file: string; message: string }>;
  /** 台帳が読めず、その種類の案の組み立てを見合わせているもの */
  blocked: Array<{ recordKind: SettingsKind; ledgerFiles: string[] }>;
  nextStep: string;
  note: string;
}

export function pendingList(input: PendingListInput): PendingListResult {
  const root = nodePath.resolve(input.folder);
  if (!fs.existsSync(root)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${input.folder}`);
  }
  const limit = input.limit ?? DEFAULT_LIMIT;

  const unreadable: Array<{ file: string; message: string }> = [];
  const blocked: Array<{ recordKind: SettingsKind; ledgerFiles: string[] }> = [];
  const customFields = readCustomFields(input.folder);

  const characterItems = listCharacters(input.folder, customFields, unreadable, blocked);
  const settingsItems = listSettings(input.folder, customFields, unreadable, blocked);

  // 提案パネルは人物 → 人物以外の順に並べる。古い案・見合わせは画面に無いので後ろへ
  const all = [...characterItems, ...settingsItems];
  const ordered = [
    ...all.filter((item) => item.status === "pending"),
    ...all.filter((item) => item.status !== "pending"),
  ];

  const counts: PendingListResult["counts"] = {
    pending: 0,
    stale: 0,
    blocked: 0,
    unreadable: unreadable.length,
  };
  const byKind: Partial<Record<SettingsKind, number>> = {};
  for (const item of ordered) {
    counts[item.status] += 1;
    byKind[item.recordKind] = (byKind[item.recordKind] ?? 0) + 1;
  }

  const matching = ordered.filter(
    (item) =>
      (!input.kind || item.recordKind === input.kind) &&
      (!input.source || item.source === input.source)
  );

  return {
    total: ordered.length + unreadable.length,
    counts,
    byKind,
    matched: matching.length,
    truncated: matching.length > limit,
    items: matching.slice(0, limit),
    unreadable,
    blocked,
    nextStep:
      "採否は作者が VS Code の詳細メニュー「設定資料更新分反映」（または提案パネル）で決めます。",
    note:
      "読むだけです。承認・見送り・古い案の片付けはしていません。" +
      "組み立ては提案パネルと同じ関数を通しています（差分は、いまの台帳と取り込んだあとの比較）。",
  };
}

/** 追加項目の定義。**読めなければ空として扱う**（製品の表示用の読み方と同じ） */
function readCustomFields(folder: string): CustomFieldSet {
  const raw = readSettingsFile(folder, CUSTOM_FIELDS_FILE);
  if (raw === undefined) return emptyCustomFieldSet();
  try {
    return parseCustomFieldSet(raw);
  } catch {
    return emptyCustomFieldSet();
  }
}

/**
 * 置き場の `.json` を読む。**壊れたものは `unreadable` へ積み、消さない**
 * （製品の `loadAll` と同じ。直さず、残りだけを扱う）。
 */
function readPendingDir<T>(
  folder: string,
  subdir: string,
  read: (parsed: unknown, filePath: string) => T,
  unreadable: Array<{ file: string; message: string }>
): T[] {
  const directory = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, subdir);
  let names: string[];
  try {
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    // 置き場が無い＝承認待ちが無い
    return [];
  }
  const found: T[] = [];
  for (const name of names) {
    const relative = `${AIWRITER_DIR}/${subdir}/${name}`;
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(nodePath.join(directory, name), "utf8")
      );
      // 保留ファイルの場所は作品フォルダーからの相対で持つ（返事にそのまま出す）
      found.push(read(parsed, relative));
    } catch (error) {
      unreadable.push({
        file: relative,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}

function sourceOf(source: PendingUpdateSource | undefined): SourceName {
  return source ?? EXTRACTION;
}

function sourceLabelOf(source: PendingUpdateSource | undefined): string {
  return pendingSourceLabel(source) || "抽出";
}

function changesOf(changes: FieldChange[]): PendingListItem["changes"] {
  // `entries`（1つずつ落とせる葉）は画面の操作のためのもので、読む側には要らない
  return changes.map((change) => ({
    label: change.label,
    before: change.before,
    after: change.after,
  }));
}

function listCharacters(
  folder: string,
  customFields: CustomFieldSet,
  unreadable: Array<{ file: string; message: string }>,
  blocked: Array<{ recordKind: SettingsKind; ledgerFiles: string[] }>
): PendingListItem[] {
  const updates = readPendingDir<PendingUpdate>(
    folder,
    PENDING_DIR,
    readPendingCharacterFile,
    unreadable
  ).sort(comparePendingCharacterUpdates);
  if (updates.length === 0) return [];

  const base = (update: PendingUpdate): Omit<PendingListItem, "status" | "changes"> => ({
    file: update.filePath,
    recordKind: "character",
    kindLabel: PENDING_KIND_SHORT_LABELS.character,
    id: update.character.id,
    name: update.character.name,
    creation: update.kind === "creation",
    source: sourceOf(update.source),
    sourceLabel: sourceLabelOf(update.source),
    reason: update.reason ?? null,
  });

  const ledger = readSettingsRecords(folder, SETTINGS_SUBDIRS.characters, parseCharacter);
  /*
    **読めない人物ファイルが1つでもあれば組み立てない**（製品と同じ）。差分の
    相手が欠けたまま並べると、更新のはずの案が「新しく作る」に見える。
    案そのものは `blocked` として並べ、どのファイルが読めないかを返す
  */
  if (ledger.unreadableFiles.length > 0) {
    blocked.push({
      recordKind: "character",
      ledgerFiles: ledger.unreadableFiles.map(
        (name) => `設定/${SETTINGS_SUBDIRS.characters}/${name}`
      ),
    });
    return updates.map((update) => ({ ...base(update), status: "blocked", changes: [] }));
  }

  const assembled = assembleCharacterReview(
    updates,
    ledger.records,
    fieldsFor(customFields, "character")
  );
  return [
    ...assembled.items.map((item): PendingListItem => ({
      ...base(item.update),
      status: "pending",
      panelLine: describeCharacterReviewItem(item),
      changes: changesOf(item.diff.changes),
      ...(item.skippedRejected.length > 0
        ? { skippedRejectedRelations: item.skippedRejected }
        : {}),
    })),
    ...assembled.stale.map((update): PendingListItem => ({
      ...base(update),
      status: "stale",
      staleReason: staleLabel(assembled.staleReasons.get(update.filePath)),
      changes: [],
    })),
  ];
}

function listSettings(
  folder: string,
  customFields: CustomFieldSet,
  unreadable: Array<{ file: string; message: string }>,
  blocked: Array<{ recordKind: SettingsKind; ledgerFiles: string[] }>
): PendingListItem[] {
  const updates = readPendingDir<PendingSettingsUpdate>(
    folder,
    PENDING_SETTINGS_DIR,
    readPendingSettingsFile,
    unreadable
  ).sort(comparePendingSettingsUpdates);
  if (updates.length === 0) return [];

  const base = (
    update: PendingSettingsUpdate
  ): Omit<PendingListItem, "status" | "changes"> => ({
    file: update.filePath,
    recordKind: update.recordKind,
    kindLabel: PENDING_KIND_SHORT_LABELS[update.recordKind],
    id: update.record.id,
    name: update.record.name,
    creation: false,
    source: sourceOf(update.source),
    sourceLabel: sourceLabelOf(update.source),
    reason: update.reason ?? null,
  });

  // 案のある種類の台帳だけを開く（製品と同じ）。読めないファイルがある種類は入れない
  const recordsByKind = new Map<PendingSettingsKind, PendingSettingsRecord[]>();
  const blockedKinds = new Set<PendingSettingsKind>();
  const kinds = PENDING_SETTINGS_KINDS.filter((kind) =>
    updates.some((update) => update.recordKind === kind)
  );
  for (const kind of kinds) {
    const ledger = readSettingsRecords(folder, RECORD_SUBDIRS[kind], RECORD_PARSERS[kind]);
    if (ledger.unreadableFiles.length > 0) {
      blockedKinds.add(kind);
      blocked.push({
        recordKind: kind,
        ledgerFiles: ledger.unreadableFiles.map(
          (name) => `設定/${RECORD_SUBDIRS[kind]}/${name}`
        ),
      });
      continue;
    }
    recordsByKind.set(kind, ledger.records);
  }

  const assembled = assembleSettingsReview(updates, recordsByKind, customFields);
  return [
    ...assembled.items.map((item): PendingListItem => ({
      ...base(item.update),
      status: "pending",
      panelLine: describeSettingsReviewItem(item),
      changes: changesOf(item.diff.changes),
    })),
    ...assembled.stale.map((update): PendingListItem => ({
      ...base(update),
      status: "stale",
      staleReason: staleLabel(assembled.staleReasons.get(update.filePath)),
      changes: [],
    })),
    ...updates
      .filter((update) => blockedKinds.has(update.recordKind))
      .map((update): PendingListItem => ({ ...base(update), status: "blocked", changes: [] })),
  ];
}

function staleLabel(reason: StaleReason | undefined): string {
  return reason ? STALE_REASON_LABELS[reason] : "古い案です";
}
