import { isValidDeviceId } from "./device";
import { DRIVE_SYNC_RECORD_PREFIX, isSafeSyncPath } from "./driveSyncPlan";

/**
 * Google ドライブで2台をそろえるときの、**この端末だけの控え（印）**
 * （設計書5.10.4。段階2、0.132.0）。
 *
 * 置き場は `.aiwriter/drive-sync/<端末ID>.json`（`driveSyncRecordPath`）。
 * `sessions/`・`stats/` と同じ「端末ごとに1本」の形にした。印は「この端末が
 * 前回そろえたとき何を見たか」なので、送らない（`driveSyncPlan.ts` の
 * `ALWAYS_IGNORED`）。Git の除外は使った作品にだけ足す（`workRegistry.ts` の
 * `DRIVE_SYNC_RECORD_IGNORE_RULE`）。
 *
 * **1ファイルにまとめた理由**：下の5つはどれも「そろえた1回」で一緒に変わる。
 * 別々のファイルにすると、途中で止まったときに印だけ進んで控えが古い、
 * という食い違いが起きうる。1本なら書けたか書けなかったかの2通りしかない。
 *
 * **書くのは呼び手**（core はファイルに触らない）。毎回書き換わる既存
 * ファイルなので `atomicWriteFile` の指定なし（①）で書く。`replace`＋
 * `expectedHash`（③ `replaceGuarded`）は必ず失敗する作りなので使わない。
 *
 * 読むときは**壊れていれば直さず「読めない」**（CLAUDE.md「壊れたJSONを
 * 勝手に修復しない」）。印を推して埋めると、3点比較が作者の書いた話を
 * 「変わっていない」と読んで、向こうの中身で上書きしうる。
 */

export const DRIVE_SYNC_RECORD_FORMAT = 1;

export interface DriveSyncRecord {
  formatVersion: typeof DRIVE_SYNC_RECORD_FORMAT;
  /** この控えを持つ端末（`core/device.ts`）。ファイル名と同じ */
  deviceId: string;
  /** 前回そろえたときの印：道 → 中身のハッシュ */
  marks: Map<string, string>;
  /**
   * 設定資料（`isSettingsJsonPath`）の、印の時点の中身（設計書5.10.2）。
   * 食い違いのとき `decideSettingsConflict` の base に使う。本文はハッシュだけ
   */
  settingsBases: Map<string, string>;
  /**
   * 印を置いてから、この端末が送った中身：道 → ハッシュの並び。
   * 向こうがそれを送り返してきたとき、食い違いと読まないため
   * （`planDriveReceive` の `ownSent`）。印が進んだ道は空にする
   */
  sentSinceMark: Map<string, string[]>;
  /**
   * 向こうの選択（選び終えた食い違い）を、どの回まで使ったか：
   * 送り手の端末ID → 道 → 回の番号（`DriveResolvedConflict.round`）
   */
  consumedResolutions: Map<string, Map<string, number>>;
  /**
   * 作者が選び終えたが、まだ送っていない食い違い：道 → 見比べた相手のハッシュ。
   * 次に送るとき目録へ載せ（`buildDriveManifest` の `resolvedConflicts`）、空にする
   */
  pendingResolutions: Map<string, string>;
  /**
   * この端末が最後に送った回の番号（0＝まだ送っていない）。ドライブの目録が
   * 消されても番号を戻さないため——戻すと、向こうの「使った回」の控えが
   * 新しい選択を古いものとして捨てる
   */
  lastRound: number;
}

export type DriveSyncRecordRead =
  | { ok: true; record: DriveSyncRecord }
  | { ok: false; reason: string };

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** この端末の控えの、作品フォルダーからの道 */
export function driveSyncRecordPath(deviceId: string): string {
  return `${DRIVE_SYNC_RECORD_PREFIX}${deviceId}.json`;
}

/** まだ一度もそろえていない端末の控え */
export function emptyDriveSyncRecord(deviceId: string): DriveSyncRecord {
  return {
    formatVersion: DRIVE_SYNC_RECORD_FORMAT,
    deviceId,
    marks: new Map(),
    settingsBases: new Map(),
    sentSinceMark: new Map(),
    consumedResolutions: new Map(),
    pendingResolutions: new Map(),
    lastRound: 0,
  };
}

/**
 * 控えを読む。`expectedDeviceId` と違う端末の控え（写し間違い・別の端末の
 * ファイルを持ってきた）は「読めない」——ほかの端末の印で3点比較すると、
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

  const marks = readPathMap(value.marks, "印", (item) =>
    typeof item === "string" && HASH_PATTERN.test(item) ? item : undefined
  );
  if (typeof marks === "string") return { ok: false, reason: marks };
  const settingsBases = readPathMap(value.settingsBases, "設定資料の控え", (item) =>
    typeof item === "string" ? item : undefined
  );
  if (typeof settingsBases === "string") return { ok: false, reason: settingsBases };
  const sentSinceMark = readPathMap(value.sentSinceMark, "送った中身", (item) =>
    Array.isArray(item) && item.every((hash) => typeof hash === "string" && HASH_PATTERN.test(hash))
      ? (item as string[]).slice()
      : undefined
  );
  if (typeof sentSinceMark === "string") return { ok: false, reason: sentSinceMark };
  const pendingResolutions = readPathMap(value.pendingResolutions, "送っていない選択", (item) =>
    typeof item === "string" && HASH_PATTERN.test(item) ? item : undefined
  );
  if (typeof pendingResolutions === "string") return { ok: false, reason: pendingResolutions };

  if (!isPlainObject(value.consumedResolutions)) {
    return { ok: false, reason: "使った選択の控えが読めません" };
  }
  const consumedResolutions = new Map<string, Map<string, number>>();
  for (const [deviceId, perPath] of Object.entries(value.consumedResolutions)) {
    if (!isValidDeviceId(deviceId)) {
      return { ok: false, reason: `使った選択の端末IDが読めません（${deviceId}）` };
    }
    const rounds = readPathMap(perPath, "使った選択", (item) =>
      typeof item === "number" && Number.isSafeInteger(item) && item >= 1 ? item : undefined
    );
    if (typeof rounds === "string") return { ok: false, reason: rounds };
    consumedResolutions.set(deviceId, rounds);
  }

  return {
    ok: true,
    record: {
      formatVersion: DRIVE_SYNC_RECORD_FORMAT,
      deviceId: expectedDeviceId,
      marks,
      settingsBases,
      sentSinceMark,
      consumedResolutions,
      pendingResolutions,
      lastRound,
    },
  };
}

/** 控えを文字にする。道の順に並べる（同じ中身なら同じ文字になる） */
export function serializeDriveSyncRecord(record: DriveSyncRecord): string {
  const sorted = <T>(map: ReadonlyMap<string, T>) => {
    const out: Record<string, T> = {};
    for (const key of [...map.keys()].sort()) out[key] = map.get(key) as T;
    return out;
  };
  const consumed: Record<string, Record<string, number>> = {};
  for (const deviceId of [...record.consumedResolutions.keys()].sort()) {
    consumed[deviceId] = sorted(record.consumedResolutions.get(deviceId) as Map<string, number>);
  }
  return (
    JSON.stringify(
      {
        formatVersion: record.formatVersion,
        deviceId: record.deviceId,
        lastRound: record.lastRound,
        marks: sorted(record.marks),
        settingsBases: sorted(record.settingsBases),
        sentSinceMark: sorted(record.sentSinceMark),
        consumedResolutions: consumed,
        pendingResolutions: sorted(record.pendingResolutions),
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
    marks: new Map(record.marks),
    settingsBases: new Map(record.settingsBases),
    sentSinceMark: new Map([...record.sentSinceMark].map(([key, list]) => [key, [...list]])),
    consumedResolutions: new Map(
      [...record.consumedResolutions].map(([key, rounds]) => [key, new Map(rounds)])
    ),
    pendingResolutions: new Map(record.pendingResolutions),
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
