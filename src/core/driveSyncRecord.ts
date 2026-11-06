import {
  DRIVE_SYNC_RECORD_PREFIX,
  isSafeSyncPath,
  lineageToJson,
  readDriveLineage,
  type DriveLineage,
} from "./driveSyncPlan";

/**
 * Google ドライブで作品をそろえるときの、**この端末だけの控え**
 * （設計書5.10.4・5.10.6。段階2、0.132.0。系譜へ置き換え 0.133.0）。
 *
 * 置き場は `.aiwriter/drive-sync/<端末ID>.json`（`driveSyncRecordPath`）。
 * `sessions/`・`stats/` と同じ「端末ごとに1本」の形にした。控えは「この端末が
 * 前回そろえたとき何を見たか」なので、送らない（`driveSyncPlan.ts` の
 * `ALWAYS_IGNORED`）。Git の除外は使った作品にだけ足す（`workRegistry.ts` の
 * `DRIVE_SYNC_RECORD_IGNORE_RULE`）。
 *
 * **1ファイルにまとめた理由**：下の3つはどれも「そろえた1回」で一緒に変わる。
 * 別々のファイルにすると、途中で止まったときに系譜だけ進んで控えが古い、
 * という食い違いが起きうる。1本なら書けたか書けなかったかの2通りしかない。
 *
 * **書くのは呼び手**（core はファイルに触らない）。毎回書き換わる既存
 * ファイルなので `atomicWriteFile` の指定なし（①）で書く。`replace`＋
 * `expectedHash`（③ `replaceGuarded`）は必ず失敗する作りなので使わない。
 *
 * 読むときは**壊れていれば直さず「読めない」**（CLAUDE.md「壊れたJSONを
 * 勝手に修復しない」）。系譜を推して埋めると、比べが作者の書いた話を
 * 「相手の祖先にある」と読んで、相手の中身で上書きしうる。
 */

/**
 * 控えの形の版。
 *
 * 2（0.133.0）：前回そろえたときの印（`marks`）・印のあとで送った中身・使った選択・
 * まだ送っていない選択を、ファイルごとの系譜（`lineage`）1つに置き換えた。
 * 版1を書いた製品は配っていないので、版1は読まない
 */
export const DRIVE_SYNC_RECORD_FORMAT = 2;

export interface DriveSyncRecord {
  formatVersion: typeof DRIVE_SYNC_RECORD_FORMAT;
  /** この控えを持つ端末（`core/device.ts`）。ファイル名と同じ */
  deviceId: string;
  /**
   * 道 → この端末の系譜の頭（設計書5.10.6）。送ったとき・受け取ったとき・
   * 食い違いを選んだときに進む。手元の今がこれと違えば「手元で書いた」
   */
  lineage: Map<string, DriveLineage>;
  /**
   * 設定資料（`isSettingsJsonPath`）の、系譜の頭の中身（設計書5.10.2）。
   * 食い違いのとき `decideSettingsConflict` の base に使う——頭の中身が
   * 相手の祖先にあるときだけ（共通の祖先だと言えるときだけ）。本文はハッシュだけ
   */
  settingsBases: Map<string, string>;
  /**
   * この端末が最後に送った回の番号（0＝まだ送っていない）。ドライブの目録が
   * 消されても番号を戻さないため（画面に「何回目」を見せる）
   */
  lastRound: number;
}

export type DriveSyncRecordRead =
  | { ok: true; record: DriveSyncRecord }
  | { ok: false; reason: string };

/** この端末の控えの、作品フォルダーからの道 */
export function driveSyncRecordPath(deviceId: string): string {
  return `${DRIVE_SYNC_RECORD_PREFIX}${deviceId}.json`;
}

/** まだ一度もそろえていない端末の控え */
export function emptyDriveSyncRecord(deviceId: string): DriveSyncRecord {
  return {
    formatVersion: DRIVE_SYNC_RECORD_FORMAT,
    deviceId,
    lineage: new Map(),
    settingsBases: new Map(),
    lastRound: 0,
  };
}

/**
 * 控えを読む。`expectedDeviceId` と違う端末の控え（写し間違い・別の端末の
 * ファイルを持ってきた）は「読めない」——ほかの端末の系譜で比べると、
 * その端末が見たものをこちらが見たことにしてしまう。
 */
export function parseDriveSyncRecord(
  text: string,
  expectedDeviceId: string
): DriveSyncRecordRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "JSONとして読めません" };
  }
  if (!isPlainObject(value)) return { ok: false, reason: "控えの形ではありません" };
  if (value.formatVersion !== DRIVE_SYNC_RECORD_FORMAT) {
    return { ok: false, reason: `控えの版が違います（${String(value.formatVersion)}）` };
  }
  if (value.deviceId !== expectedDeviceId) {
    return { ok: false, reason: "ほかの端末の控えです" };
  }
  const { lastRound } = value;
  if (typeof lastRound !== "number" || !Number.isSafeInteger(lastRound) || lastRound < 0) {
    return { ok: false, reason: "送った回の番号が読めません" };
  }

  const lineage = readPathMap(value.lineage, "系譜", (item) => {
    const read = readDriveLineage(item);
    return typeof read === "string" ? undefined : read;
  });
  if (typeof lineage === "string") return { ok: false, reason: lineage };
  const settingsBases = readPathMap(value.settingsBases, "設定資料の控え", (item) =>
    typeof item === "string" ? item : undefined
  );
  if (typeof settingsBases === "string") return { ok: false, reason: settingsBases };

  return {
    ok: true,
    record: {
      formatVersion: DRIVE_SYNC_RECORD_FORMAT,
      deviceId: expectedDeviceId,
      lineage,
      settingsBases,
      lastRound,
    },
  };
}

/** 控えを文字にする。道の順に並べる（同じ中身なら同じ文字になる） */
export function serializeDriveSyncRecord(record: DriveSyncRecord): string {
  const sorted = <T, U>(map: ReadonlyMap<string, T>, convert: (item: T) => U) => {
    const out: Record<string, U> = {};
    for (const key of [...map.keys()].sort()) out[key] = convert(map.get(key) as T);
    return out;
  };
  return (
    JSON.stringify(
      {
        formatVersion: record.formatVersion,
        deviceId: record.deviceId,
        lastRound: record.lastRound,
        lineage: sorted(record.lineage, lineageToJson),
        settingsBases: sorted(record.settingsBases, (text) => text),
      },
      null,
      2
    ) + "\n"
  );
}

/** 控えを写す（呼び手の手元の控えを書き換えずに、新しい控えを返すため） */
export function cloneDriveSyncRecord(record: DriveSyncRecord): DriveSyncRecord {
  return {
    formatVersion: record.formatVersion,
    deviceId: record.deviceId,
    lineage: new Map([...record.lineage].map(([key, item]) => [key, lineageToJson(item)])),
    settingsBases: new Map(record.settingsBases),
    lastRound: record.lastRound,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 道 → 値の表を読む。読めなければ理由の文字列を返す */
function readPathMap<T>(
  value: unknown,
  label: string,
  read: (item: unknown) => T | undefined
): Map<string, T> | string {
  if (!isPlainObject(value)) return `${label}が読めません`;
  const out = new Map<string, T>();
  for (const [entry, item] of Object.entries(value)) {
    if (!isSafeSyncPath(entry)) return `${label}の道が読めません（${entry}）`;
    const parsed = read(item);
    if (parsed === undefined) return `${label}の値が読めません（${entry}）`;
    out.set(entry, parsed);
  }
  return out;
}
