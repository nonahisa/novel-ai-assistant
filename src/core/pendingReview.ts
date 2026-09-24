import {
  emptyCharacter,
  parseCharacter,
  type Character,
} from "../models/character";
import {
  fieldsFor,
  type CustomFieldDefinition,
  type CustomFieldSet,
} from "../models/customField";
import { findCharactersByAppellation } from "./plotCharacterSync";
import { diffCharacter, summarizeDiff, type CharacterDiff } from "./characterDiff";
import { settlePendingRelations } from "./rejectedRelations";
import {
  pendingSourceLabel,
  readKind,
  readReason,
  readSource,
  unwrapPendingCharacter,
  type PendingUpdateKind,
  type PendingUpdateSource,
} from "./pendingUpdateFormat";
import {
  PENDING_KIND_SHORT_LABELS,
  diffSettingsRecord,
  mergePendingSettingsRecord,
  parsePendingSettingsPayload,
  type PendingSettingsKind,
  type PendingSettingsRecord,
} from "./pendingSettingsMerge";

/**
 * 承認待ちの更新案を「作者に見せる形」へ組む（設計書6.32・6.87.16）。
 *
 * **提案パネルと MCP の `pending.list` が、ここを同じように通る**（0.85.1）。
 * 以前は組み立てが `features/applyPendingUpdates.ts` の中にしか無く、
 * `vscode` を持てない MCP の束からは呼べなかった。写しを作ると、画面に並ぶ
 * ものと外から読めるものが片方だけ直ってずれる——「古い案として片付けられる
 * もの」の判定がずれると、外から見て「ある」はずの案が画面に無い、が起きる。
 *
 * **ここは読むだけ。** ファイルの読み書き（`PendingUpdateStore` など）は
 * 呼ぶ側が持ち、ここには読んだ中身と台帳のレコードを渡す。片付け
 * （古い案の削除）も呼ぶ側が決める——開いただけで消してはいけない。
 *
 * `vscode` に依存しない（`test/unit/cross/mcpReach.test.ts` が見張る）。
 */

/** 人物の承認待ち1件（`.aiwriter/pending-characters/`） */
export interface PendingUpdate {
  /** 更新案。既存レコードと同じID（新規案では仮のID） */
  character: Character;
  /** 保留ファイルのパス。反映後に片付ける */
  filePath: string;
  /** どこから来た提案か。古いファイルには無い（＝抽出） */
  source?: PendingUpdateSource;
  /** 何の案か。古いファイルには無い（＝既存レコードの更新） */
  kind?: PendingUpdateKind;
  /**
   * なぜそう提案するか（設計書6.87.16）。
   *
   * いまのところ外部AIの案だけが持つ。**作者が採否を決める材料**なので、
   * 承認の画面へそのまま出す。製品の抽出は根拠を `evidence` に入れるので、
   * ここは空のままでよい。
   */
  reason?: string;
}

/** 人物以外（能力・組織・場所・世界観）の承認待ち1件（`.aiwriter/pending-settings/`） */
export interface PendingSettingsUpdate {
  recordKind: PendingSettingsKind;
  /** 更新案。既存レコードと同じID */
  record: PendingSettingsRecord;
  /** 保留ファイルのパス。反映後に片付ける */
  filePath: string;
  source?: PendingUpdateSource;
  reason?: string;
}

/**
 * 人物の保留ファイルの中身を読む。**壊れていたら例外を投げ、直さない。**
 *
 * 製品（`PendingUpdateStore.loadAll`）と MCP の両方が通る。
 */
export function readPendingCharacterFile(
  parsed: unknown,
  filePath: string
): PendingUpdate {
  return {
    character: parseCharacter(unwrapPendingCharacter(parsed)),
    filePath,
    source: readSource(parsed),
    kind: readKind(parsed),
    reason: readReason(parsed),
  };
}

/** 人物以外の保留ファイルの中身を読む。**壊れていたら例外を投げ、直さない。** */
export function readPendingSettingsFile(
  parsed: unknown,
  filePath: string
): PendingSettingsUpdate {
  return { ...parsePendingSettingsPayload(parsed), filePath };
}

/** 並び順（人物はID順）。画面と MCP で同じ順に並べるため */
export function comparePendingCharacterUpdates(
  left: PendingUpdate,
  right: PendingUpdate
): number {
  return left.character.id.localeCompare(right.character.id);
}

/** 並び順（人物以外はID順） */
export function comparePendingSettingsUpdates(
  left: PendingSettingsUpdate,
  right: PendingSettingsUpdate
): number {
  return left.record.id.localeCompare(right.record.id);
}

/**
 * 古い案として片付けられる理由。
 *
 * **製品の画面は理由を出さずに片付ける**（「更新分反映」を押すと消える）。
 * 外から読む側（MCP `pending.list`）は、「ある」はずの案が画面に並ばない
 * わけを知りたいので、理由を名前で返す。文言は `STALE_REASON_LABELS`。
 */
export type StaleReason = "duplicateName" | "missing" | "noChange";

export const STALE_REASON_LABELS: Record<StaleReason, string> = {
  duplicateName: "同じ名前の人物が、もう台帳に居ます（新しく作る案は要りません）",
  missing: "対象の記録が台帳にありません（まとめた・消した）",
  noChange: "取り込んでも、いまの記録から何も変わりません",
};

/** 人物の案1件を、確認できる形に組んだもの */
export interface CharacterReviewItem {
  update: PendingUpdate;
  /** 更新前のレコード。**新規案には無い**（まだ台帳に居ない） */
  current: Character | undefined;
  diff: CharacterDiff;
  /**
   * 積んだあとに作者が退けた関係に当たったため、更新案から外した関係
   * （作者の裁定、2026-09-23）。**黙って外さない**——承認の説明に件数を出す
   */
  skippedRejected: Array<{ name: string; relation: string }>;
}

/**
 * 人物の承認待ちを、確認できる形と「もう要らない案」へ分ける。
 *
 * @param characters 台帳の全員。**読めない人物ファイルがあるときは呼ばない**
 *   ——差分の相手が欠けたまま並べると、更新のはずの案が「新しく作る」に見える
 * @param customFields 人物の追加項目の定義。作者が足した項目の変化も差分に出す
 */
export function assembleCharacterReview(
  updates: readonly PendingUpdate[],
  characters: readonly Character[],
  customFields: CustomFieldDefinition[]
): {
  items: CharacterReviewItem[];
  stale: PendingUpdate[];
  /** 片付ける理由（保留ファイルのパスごと）。画面は使わず、MCP が返す */
  staleReasons: Map<string, StaleReason>;
} {
  const items: CharacterReviewItem[] = [];
  const stale: PendingUpdate[] = [];
  const staleReasons = new Map<string, StaleReason>();
  const drop = (update: PendingUpdate, reason: StaleReason): void => {
    stale.push(update);
    staleReasons.set(update.filePath, reason);
  };
  const byId = new Map(characters.map((c) => [c.id, c]));

  for (const update of updates) {
    // **新規案は、居ないことの判定より先に分ける**（設計書6.4.9）。
    // 台帳に居ないのが当たり前なので、更新案の規則（居なければ片付ける）を
    // そのまま当てると、確認される前に必ず消える
    if (update.kind === "creation") {
      // 積んだあとに同じ名前の人物が資料へ増えていたら、作らない。
      // 二重に作ると、次の抽出で「同じかもしれません」と言われ続ける
      if (
        findCharactersByAppellation(characters, update.character.name).length > 0
      ) {
        drop(update, "duplicateName");
        continue;
      }
      items.push({
        update,
        current: undefined,
        skippedRejected: [],
        // 何が入るのかを、更新案と同じ並びで見せる。
        // 比べる相手は空のレコード（すべてが「追加」になる）
        diff: diffCharacter(
          emptyCharacter(update.character.id, ""),
          update.character,
          customFields
        ),
      });
      continue;
    }

    const current = byId.get(update.character.id);
    if (!current) {
      // 対象が消えている（まとめた・削除した）。反映しても復活させるだけ
      drop(update, "missing");
      continue;
    }
    // 更新案は積んだ時点の写し。**積んだあとに作者が退けた関係**を外し、
    // 退けた記録そのものは台帳の側に合わせる（作者の裁定、2026-09-23）。
    // 外さないと、写しの中で「足される関係」に見え、承認すると戻ってしまう
    const settled = settlePendingRelations(current, update.character, characters);
    const diff = diffCharacter(current, settled.character, customFields);
    if (diff.changes.length === 0) {
      drop(update, "noChange");
      continue;
    }
    items.push({
      update: { ...update, character: settled.character },
      current,
      diff,
      skippedRejected: settled.skipped,
    });
  }

  return { items, stale, staleReasons };
}

/**
 * 人物以外の案1件。`merged` は**いまの台帳のレコードへ、コードで取り込んだ結果**
 * （`mergePendingSettingsRecord`）。更新案をそのまま保存すると、積んでから
 * 承認までに作者が書いたものを古い写しで巻き戻すため。
 */
export interface SettingsReviewItem {
  update: PendingSettingsUpdate;
  current: PendingSettingsRecord;
  merged: PendingSettingsRecord;
  diff: CharacterDiff;
}

/**
 * 人物以外の承認待ちを、確認できる形と「もう要らない案」へ分ける。
 *
 * @param recordsByKind 種類ごとの台帳。**読めなかった種類は入れない**——
 *   その種類の案は組み立てず、片付けもしない（居るはずの場所が「消えた」と
 *   読まれて案が捨てられるため）
 * @param customFields 追加項目の定義（全種類ぶん。種類ごとに引き分ける）
 */
export function assembleSettingsReview(
  updates: readonly PendingSettingsUpdate[],
  recordsByKind: ReadonlyMap<PendingSettingsKind, readonly PendingSettingsRecord[]>,
  customFields: CustomFieldSet
): {
  items: SettingsReviewItem[];
  stale: PendingSettingsUpdate[];
  /** 片付ける理由（保留ファイルのパスごと）。画面は使わず、MCP が返す */
  staleReasons: Map<string, StaleReason>;
} {
  const items: SettingsReviewItem[] = [];
  const stale: PendingSettingsUpdate[] = [];
  const staleReasons = new Map<string, StaleReason>();
  const drop = (update: PendingSettingsUpdate, reason: StaleReason): void => {
    stale.push(update);
    staleReasons.set(update.filePath, reason);
  };
  const byKind = new Map<PendingSettingsKind, Map<string, PendingSettingsRecord>>();
  for (const [kind, records] of recordsByKind) {
    byKind.set(kind, new Map(records.map((record) => [record.id, record])));
  }

  for (const update of updates) {
    const records = byKind.get(update.recordKind);
    // 台帳が読めなかった種類は、組み立てず片付けもしない
    if (!records) continue;
    const current = records.get(update.record.id);
    if (!current) {
      // 対象が消えている（取り下げた・まとめた）。反映しても復活させるだけ
      drop(update, "missing");
      continue;
    }
    // 出どころを渡す——作者が確定させた記録へ白名簿の欄を入れてよいのは
    // 外部AIの案だけ（作者の裁定、2026-09-24。`mergePendingSettingsRecord`）
    const merged = mergePendingSettingsRecord(
      update.recordKind,
      current,
      update.record,
      { source: update.source }
    );
    const diff = diffSettingsRecord(
      update.recordKind,
      current,
      merged,
      fieldsFor(customFields, update.recordKind)
    );
    if (diff.changes.length === 0) {
      drop(update, "noChange");
      continue;
    }
    items.push({ update, current, merged, diff });
  }

  return { items, stale, staleReasons };
}

/** 確認文へ入れる理由の長さ。長いと一覧が読めなくなる */
const REASON_PREVIEW_MAX = 40;

export function clampReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > REASON_PREVIEW_MAX
    ? `${oneLine.slice(0, REASON_PREVIEW_MAX)}…`
    : oneLine;
}

/**
 * 人物の案の一行（提案パネルの出どころの欄・確認文）。
 *
 * **理由があれば、出どころの隣に出す**（設計書6.87.16）。外部AIの案は
 * 本文の根拠（`evidence`）を持たないことがあるので、**なぜそう提案したか
 * だけが作者の判断材料**になる。1行なので、ここは短く切る
 * （長い理由は差分の文書側に全部出る）。
 */
export function describeCharacterReviewItem(item: CharacterReviewItem): string {
  const label = pendingSourceLabel(item.update.source);
  const summary =
    item.update.kind === "creation" ? "新規の人物" : summarizeDiff(item.diff);
  const base = label ? `${label}：${summary}` : summary;
  const reason = item.update.reason?.trim();
  const withReason = reason ? `${base}（理由：${clampReason(reason)}）` : base;
  // 退けた関係を外したことを黙らない（`settlePendingRelations`）
  return item.skippedRejected.length > 0
    ? `${withReason}（作者が退けた関係 ${item.skippedRejected.length}件は入れません）`
    : withReason;
}

/** 人物以外の案の一行。種類を先に出す（人物と取り違えないため） */
export function describeSettingsReviewItem(item: SettingsReviewItem): string {
  const kind = PENDING_KIND_SHORT_LABELS[item.update.recordKind];
  const label = pendingSourceLabel(item.update.source);
  const base = `${label ? `${kind}・${label}` : kind}：${summarizeDiff(item.diff)}`;
  const reason = item.update.reason?.trim();
  return reason ? `${base}（理由：${clampReason(reason)}）` : base;
}
