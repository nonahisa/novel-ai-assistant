import fs from "node:fs";
import nodePath from "node:path";
import {
  AI_ASSIGNMENTS_SNAPSHOT_PATH,
  parseAiAssignmentsSnapshot,
  type AiAssignmentRow,
  type AiAssignmentsSnapshot,
  type AiChoice,
} from "../../core/aiAssignmentsSnapshot";
import { TUNING_STORE_FILE } from "../../core/tuningStoreNames";
import { summarizeTuningTable, type TuningRecordSummary } from "../../core/tuningRecordSummary";
import { mcpGlobalStorageRoot } from "../globalStorage";
import { mcpMachineName } from "./windows";

/**
 * AIの設定を読む（MCP の道具 `ai.settings`。作者の裁定、2026-10-01）。
 *
 * 実機確認で、AIチューニングの記録と機能ごとの割り当てを確かめるのに
 * ファイルを直に開いていた。**1本の道具にまとめて返す**（道具を増やすと
 * 一覧が太り、繋ぐたびの費用になる）。
 *
 * - **AIチューニングの記録**は保管庫の `model-tuning.json` にあり、MCP から
 *   直に読める（`core/modelTuningStore.ts`。機械ごとに別のファイル）
 * - **機能ごとの割り当て・いま既定の AI** は `globalState` にあって外から
 *   読めないので、拡張機能が保管庫へ書いた写し（`core/aiAssignmentsSnapshot.ts`）
 *   を読む。写しの時刻 `writtenAt` と経過分を必ず添える
 *
 * **読むだけ。** 割り当ても記録も書き換えない——割り当ては作者が拡張機能の
 * 画面（機能別AI割当）で、記録はAIチューニングで変える。
 *
 * **鍵・トークンは返さない（そもそも読まない）。** 鍵は OS の資格情報ストア
 * （`SecretStorage`）にあり、この道具はそこにも VS Code の設定にも手を
 * 伸ばさない。読む2つのファイルからも、返す欄を名指しで拾う（余分な欄は
 * 見ない）。
 *
 * **作品の中身は1文字も読まない**ので、許可（6.87.10）の対象外で、原稿の
 * 出方は `none`（`works.list` と同じ）。
 */

export interface AiAssignmentsPart {
  /** 写しを探した場所 */
  storage: string | null;
  /** 写しを書いた時刻。写しが無い・読めないときは `null` */
  writtenAt: string | null;
  /** 写しを書いてからの経過（分、切り捨て）。読めない時刻は `null` */
  minutesSinceWritten: number | null;
  writtenBy: AiAssignmentsSnapshot["writtenBy"] | null;
  /** いま既定の AI（未設定・写しが無いときは `null`） */
  defaultAi: AiChoice | null;
  /** 機能ごとの割り当てと、実際に動くAI。写しが無い・読めないときは `null` */
  features: AiAssignmentRow[] | null;
  note: string;
}

export interface AiTuningPart {
  /** 記録を探した場所 */
  storage: string | null;
  /**
   * モデルごとの記録（作者の機械で測った値だけ。同梱の初期値は入らない）。
   * まだ記録が無ければ空、記録が読めなければ `null`
   */
  records: TuningRecordSummary[] | null;
  /** 機能ごとの出力見込みの行の数（モデルの記録ではないので `records` に混ぜない） */
  featureOutputRows: number;
  /** 形が崩れて読めなかった行の鍵 */
  unreadableKeys: string[];
  note: string;
}

export interface AiSettingsResult {
  /** このサーバーが走っている機械の名前（どちらのファイルも機械ごとの保管庫にある） */
  machineName: string | null;
  assignments: AiAssignmentsPart;
  tuning: AiTuningPart;
}

const ASSIGNMENTS_NOTE =
  "機能ごとのAIの割り当ては VS Code の中にあるので、拡張機能が書いた写しを読んでいます。" +
  "書き直すのは起動したときと、既定のAIか割り当てを変えたときだけです。" +
  "writtenAt が古ければ、そのあとに別の窓で変えているかもしれません（窓を開き直すと書き直されます）。" +
  "assigned が null の機能は、既定のAI（effective）で動きます。";

const TUNING_NOTE =
  "AIチューニングの記録（この機械で測った値）です。同梱の初期値は入っていません。" +
  "cautions は数字を読むときの断り（古い結果・下限値など）です。";

function unknownStorage(): string {
  return (
    "保管庫の場所が分かりませんでした（束の居場所が読めず、" +
    "NOVELAI_GLOBAL_STORAGE も指定されていません）。"
  );
}

function readAssignments(root: string | undefined, now: Date): AiAssignmentsPart {
  const empty = {
    writtenAt: null,
    minutesSinceWritten: null,
    writtenBy: null,
    defaultAi: null,
    features: null,
  };
  if (!root) {
    return { storage: null, ...empty, note: unknownStorage() + ASSIGNMENTS_NOTE };
  }
  const file = nodePath.join(root, ...AI_ASSIGNMENTS_SNAPSHOT_PATH);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {
      storage: file,
      ...empty,
      note:
        "写しがありません（この機械で拡張機能がまだ起動していないか、" +
        "写しを書かない古い版が動いています）。" +
        ASSIGNMENTS_NOTE,
    };
  }
  const snapshot = parseAiAssignmentsSnapshot(text);
  if (!snapshot) {
    return {
      storage: file,
      ...empty,
      note:
        "写しの形になっていません（直さずに止めました。窓を開き直すと書き直されます）。" +
        ASSIGNMENTS_NOTE,
    };
  }
  const at = Date.parse(snapshot.writtenAt);
  return {
    storage: file,
    writtenAt: snapshot.writtenAt,
    // 先の時刻（機械の時計のずれ）は「いま書いた」とみなす（登録簿の写しと同じ）
    minutesSinceWritten: Number.isNaN(at)
      ? null
      : Math.floor(Math.max(0, now.getTime() - at) / 60_000),
    writtenBy: snapshot.writtenBy,
    defaultAi: snapshot.defaultAi,
    features: snapshot.features,
    note: ASSIGNMENTS_NOTE,
  };
}

function readTuning(root: string | undefined): AiTuningPart {
  const empty = { featureOutputRows: 0, unreadableKeys: [] };
  if (!root) {
    return { storage: null, records: null, ...empty, note: unknownStorage() + TUNING_NOTE };
  }
  const file = nodePath.join(root, TUNING_STORE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // ファイルが無いのは「まだ一度も測っていない」（拡張機能は測ったときに作る）
    return {
      storage: file,
      records: [],
      ...empty,
      note: "記録はまだありません（この機械でAIチューニングをまだ一度も測っていません）。" + TUNING_NOTE,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // **直さない**（規則2）。拡張機能も壊れた台帳への書き込みは断る
    return {
      storage: file,
      records: null,
      ...empty,
      note: "記録のファイルが壊れていて読めません（直さずに止めました）。" + TUNING_NOTE,
    };
  }
  const summary = summarizeTuningTable(raw as Record<string, unknown>);
  return {
    storage: file,
    records: summary.records,
    featureOutputRows: summary.featureOutputRows,
    unreadableKeys: summary.unreadableKeys,
    note: TUNING_NOTE,
  };
}

export function aiSettings(now: Date = new Date()): AiSettingsResult {
  const root = mcpGlobalStorageRoot();
  return {
    machineName: mcpMachineName(),
    assignments: readAssignments(root, now),
    tuning: readTuning(root),
  };
}
