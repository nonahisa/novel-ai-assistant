import { isValidDeviceId } from "./device";
import { isSettingsJsonPath } from "./settingsConflictRule";

/**
 * Google ドライブで2台をそろえる（設計書5.10）の計画の関数。段階1。
 *
 * **ここは計画を返すだけで、何も書かない。** 読み書き・Drive API・画面は
 * 段階2の仕事である。中身（目録・3点比較・規則）をここへ集めるのは、
 * モバイル版へそのまま持っていくため（作者の決定、2026-11-06 昼）。
 * そのため `vscode`・`node:`・`./paths`（vscode を読む）を import しない
 * （`test/unit/core/driveSyncPlan.test.ts` の最後のテストが見張る）。
 *
 * ハッシュは呼び手が `core/hash.ts` の `hashBytes` で作って渡す。
 * 道は作品フォルダーからの相対で、区切りは「/」にそろえたもの。
 */

/**
 * 目録の形の版。形を変えたら上げる。読む側は知らない版を「読めない」にする。
 *
 * 2（0.132.0）：選び終えた食い違いを「相手のハッシュ」だけから
 * `{ against, round }` の組にした。受け取った側が「この選択はもう使った」と
 * 覚えるための番号が要ったため（`DriveResolvedConflict`）。送った端末の印
 * （`bases`）も足した。版1を書いた製品は配っていない（段階1は画面から
 * 使えなかった）ので、版1は読まない
 */
export const DRIVE_MANIFEST_FORMAT = 2;

/**
 * 選び終えた食い違い1件（設計書5.10.4）。
 *
 * - `against`：作者が見比べたときの**相手のハッシュ**。受け取る側は、手元の今が
 *   これと同じなら選び直させずに受け取る
 * - `round`：この選択を最初に載せた目録の回の番号。受け取った側は道ごとに
 *   「どの回の選択まで使ったか」を控え（`DriveSyncRecord.consumedResolutions`）、
 *   **同じ選択を2度使わない**——使ったあとで手元が偶然 `against` と同じ中身へ
 *   戻っても（元に戻す・履歴から戻す）、古い選択が作者の書き直しを押し流さない
 */
export interface DriveResolvedConflict {
  against: string;
  round: number;
}

/**
 * 送る側が最後に書く目録（`manifest.json`。設計書5.10.3）。
 *
 * 道を鍵にする所は Map にしてある。JSON の素のオブジェクトのままだと、
 * `__proto__` のような道が来たときに中身と取り違える。
 */
export interface DriveManifest {
  formatVersion: typeof DRIVE_MANIFEST_FORMAT;
  /** 送った時刻（ISO 8601）。「もう1台が最後に送ったのは いつ」を見せるため */
  sentAt: string;
  /** 送った回の番号（1から）。同じく「何回目」を見せるため */
  round: number;
  /** 送った端末のID（`core/device.ts`） */
  deviceId: string;
  /** 送った端末の名前（画面に出す。空でもよい） */
  deviceName: string;
  /** 送ったファイルの道 → 中身のハッシュ。その端末の作品の全部（変わったものだけではない） */
  files: ReadonlyMap<string, string>;
  /**
   * 送った端末の印：道 → その端末が前回そろえたときのハッシュ（0.132.0）。
   * `files` にある道だけ。受け取る側は「向こうは、こちらが送ったどの中身の上に
   * 書いたか」をこれで知る（`planDriveReceive` の説明）。無ければ載せない
   */
  bases: ReadonlyMap<string, string>;
  /**
   * その端末で消えたファイル。**一度消えたものは積んだまま載せる**——
   * 受け取る側は最新の目録しか読まないので、間の回を読み逃しても
   * 消えたことが分かるようにする
   */
  deleted: readonly string[];
  /**
   * 選び終えた食い違い：道 → そのとき見比べた**相手のハッシュ**と、載せ始めた回
   * （設計書5.10.4。`DriveResolvedConflict`）
   */
  resolvedConflicts: ReadonlyMap<string, DriveResolvedConflict>;
}

export type DriveManifestRead =
  | { ok: true; manifest: DriveManifest }
  | { ok: false; reason: string };

/** `hashBytes`（SHA-256）の16進。形の違うハッシュは壊れた目録として扱う */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 円記号。符号で書くのは、文字のまま書くと読み違えやすく、書く道具に潰されるため */
const BACKSLASH = String.fromCharCode(0x5c);

/**
 * 目録に書いてある道が、作品フォルダーの中を指すか。
 *
 * **段階2ではこの道へ手元の原稿を書く。** ここで止めないと、壊れた目録や
 * 書き換えられた目録が作品の外（`../`・根・別のドライブ）を指したとき、
 * そのまま書きに行く口になる。
 */
export function isSafeSyncPath(syncPath: string): boolean {
  if (syncPath.length === 0) return false;
  for (let i = 0; i < syncPath.length; i++) {
    // 制御文字はファイル名に使えない（使える環境でも、2台で同じ名前にならない）
    if (syncPath.charCodeAt(i) < 0x20) return false;
  }
  // 円記号は Windows では区切りになるので、道の形が端末で変わる。
  // 「:」はドライブ文字と NTFS の別ストリームの印
  if (syncPath.includes(BACKSLASH) || syncPath.includes(":")) return false;
  const segments = syncPath.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".."
  );
}

/**
 * 目録を読む。**壊れた・形の違う目録は直さず「読めない」で返す**
 * （CLAUDE.md「壊れたJSONを勝手に修復しない」）。足りない項目を推して
 * 埋めると、届ききっていない目録を届いたものとして扱うことになる。
 */
export function parseDriveManifest(text: string): DriveManifestRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable("JSONとして読めません");
  }
  if (!isPlainObject(value)) return unreadable("目録の形ではありません");

  if (value.formatVersion !== DRIVE_MANIFEST_FORMAT) {
    // 新しい版の製品が書いた目録を、古い読み方で読まない
    return unreadable(`目録の版が違います（${String(value.formatVersion)}）`);
  }
  const { sentAt, round, deviceId, deviceName } = value;
  if (typeof sentAt !== "string" || Number.isNaN(Date.parse(sentAt))) {
    return unreadable("送った時刻が読めません");
  }
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
    return unreadable("送った回の番号が読めません");
  }
  if (typeof deviceId !== "string" || deviceId.trim() === "") {
    return unreadable("端末のIDがありません");
  }
  if (typeof deviceName !== "string") {
    return unreadable("端末の名前がありません");
  }

  const files = readHashMap(value.files, "ファイルの一覧");
  if (typeof files === "string") return unreadable(files);
  const bases = readHashMap(value.bases, "送った端末の印");
  if (typeof bases === "string") return unreadable(bases);
  for (const entry of bases.keys()) {
    // 送っていないファイルの印は、何の上に書いたかの手がかりにならない
    if (!files.has(entry)) return unreadable(`送っていないファイルの印があります（${entry}）`);
  }
  const resolvedConflicts = readResolvedConflicts(value.resolvedConflicts);
  if (typeof resolvedConflicts === "string") return unreadable(resolvedConflicts);
  for (const [entry, resolved] of resolvedConflicts) {
    // 載せ始めた回は、いま読んでいる目録の回より後にはならない
    if (resolved.round > round) {
      return unreadable(`選び終えた食い違いの回の番号が読めません（${entry}）`);
    }
  }

  if (!Array.isArray(value.deleted)) return unreadable("消えたファイルの一覧が読めません");
  const deleted: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.deleted) {
    if (typeof entry !== "string" || !isSafeSyncPath(entry)) {
      return unreadable("消えたファイルの道が読めません");
    }
    // 同じ道が2度ある・在ると消えたの両方にある目録は、どれが本当か決められない
    if (seen.has(entry)) return unreadable(`消えたファイルが重なっています（${entry}）`);
    if (files.has(entry)) return unreadable(`在るのに消えたことになっています（${entry}）`);
    seen.add(entry);
    deleted.push(entry);
  }

  return {
    ok: true,
    manifest: {
      formatVersion: DRIVE_MANIFEST_FORMAT,
      sentAt,
      round,
      deviceId,
      deviceName,
      files,
      bases,
      deleted,
      resolvedConflicts,
    },
  };
}

/**
 * 目録を文字にする。道の順に並べる——同じ中身なら同じ文字になり、
 * ドライブの画面で作者が見比べたときに順番の違いが変更に見えない。
 */
export function serializeDriveManifest(manifest: DriveManifest): string {
  const sorted = <T>(map: ReadonlyMap<string, T>) => {
    const out: Record<string, T> = {};
    for (const key of [...map.keys()].sort()) out[key] = map.get(key) as T;
    return out;
  };
  return (
    JSON.stringify(
      {
        formatVersion: manifest.formatVersion,
        sentAt: manifest.sentAt,
        round: manifest.round,
        deviceId: manifest.deviceId,
        deviceName: manifest.deviceName,
        files: sorted(manifest.files),
        bases: sorted(manifest.bases),
        deleted: [...manifest.deleted].sort(),
        resolvedConflicts: sorted(manifest.resolvedConflicts),
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * 送る側が目録を組む。
 *
 * - 消えたファイル：前の回の `files` と `deleted` にあって、今は無いもの。
 *   **前の回の `deleted` も積み続ける**（`DriveManifest.deleted` の説明）。
 *   戻ってきたファイルは外す
 * - 選び終えた食い違い：前の回のものを、そのファイルがある間は持ち越す。
 *   相手が受け取る前に2回送っても、選んだことが消えないようにする。
 *   今回選んだもの（`resolvedConflicts`：道 → 見比べた相手のハッシュ）が
 *   前の回のものより優先し、回の番号は今回の `round` になる
 * - **持ち越しを外す**（0.132.0）：相手の目録（`peerManifest`）のその道の
 *   ハッシュが、**こちらが前の回に送った中身**（`previous.files`）と同じなら、
 *   相手はこちらの選んだ結果を受け取っている。もう要らないので外す。
 *   外さないと、相手がそのあと偶然 `against` と同じ中身へ戻したときに、
 *   古い選択が効いて相手の書き直しを押し流す（受け取る側にも同じ守りを
 *   置いてある：`planDriveReceive` の `consumedResolutions`）。
 *   **前の回に送った中身で比べる**のは、相手が受け取れたのはそれだけだから
 *   ——今回の中身（`files`）で比べると、相手がまだ受け取っていない中身との
 *   偶然の一致で外れうる。相手の目録は**届ききったものだけ**を渡すこと
 */
export function buildDriveManifest(input: {
  deviceId: string;
  deviceName: string;
  round: number;
  sentAt: string;
  files: ReadonlyMap<string, string>;
  previous?: DriveManifest;
  resolvedConflicts?: ReadonlyMap<string, string>;
  peerManifest?: DriveManifest;
  /** 送る端末の印（`DriveSyncRecord.marks`）。`files` にある道だけ載せる */
  marks?: ReadonlyMap<string, string>;
}): DriveManifest {
  const bases = new Map<string, string>();
  for (const [entry, hash] of input.marks ?? []) {
    if (input.files.has(entry)) bases.set(entry, hash);
  }
  const deleted = new Set<string>();
  if (input.previous) {
    for (const entry of input.previous.deleted) deleted.add(entry);
    for (const entry of input.previous.files.keys()) deleted.add(entry);
  }
  for (const entry of input.files.keys()) deleted.delete(entry);

  // 自分の目録を相手のものとして渡されたら、受け取った印にはならない
  const peer =
    input.peerManifest && input.peerManifest.deviceId !== input.deviceId
      ? input.peerManifest
      : undefined;

  const resolvedConflicts = new Map<string, DriveResolvedConflict>();
  for (const [entry, resolved] of input.previous?.resolvedConflicts ?? []) {
    if (!input.files.has(entry)) continue;
    const sentBefore = input.previous?.files.get(entry);
    if (peer && sentBefore !== undefined && peer.files.get(entry) === sentBefore) continue;
    resolvedConflicts.set(entry, resolved);
  }
  for (const [entry, against] of input.resolvedConflicts ?? []) {
    if (input.files.has(entry)) {
      resolvedConflicts.set(entry, { against, round: input.round });
    }
  }

  return {
    formatVersion: DRIVE_MANIFEST_FORMAT,
    sentAt: input.sentAt,
    round: input.round,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    files: new Map(input.files),
    bases,
    deleted: [...deleted].sort(),
    resolvedConflicts,
  };
}

export type DriveArrival =
  | { arrived: true }
  | {
      arrived: false;
      /** 目録にあるのに、向こうのフォルダーで読めなかったもの */
      missing: string[];
      /** 読めたが、中身のハッシュが目録と違うもの（書いている途中・古い写し） */
      mismatched: string[];
    };

/**
 * 目録が届ききったか（設計書5.10.3）。目録は最後に書くので、目録のハッシュと
 * 実際に読めた中身が全部合えば、その回の送りは届ききっている。
 *
 * 向こうのフォルダーに目録に無いファイルがあるのは問わない（消えたファイルの
 * 写しを向こうに残してよい作りのため）。
 */
export function checkManifestArrival(
  manifest: DriveManifest,
  actualRemoteHashes: ReadonlyMap<string, string>
): DriveArrival {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [entry, hash] of manifest.files) {
    const actual = actualRemoteHashes.get(entry);
    if (actual === undefined) missing.push(entry);
    else if (actual !== hash) mismatched.push(entry);
  }
  if (missing.length === 0 && mismatched.length === 0) return { arrived: true };
  return { arrived: false, missing: missing.sort(), mismatched: mismatched.sort() };
}

/**
 * ドライブで2台をそろえるときの、この端末だけの控え（印）の置き場
 * （`.aiwriter/` の下。中身は `core/driveSyncRecord.ts`）。
 *
 * `sessions/`・`stats/` と同じく `<端末ID>.json` の1本にする。印は
 * 「この端末が前回そろえたとき何を見たか」なので、**ほかの端末へ送ると
 * 意味が壊れる**（向こうの3点比較の基準が、こちらの印に置き換わる）。
 */
export const DRIVE_SYNC_RECORD_DIR = "drive-sync";

/** 印の置き場の、作品フォルダーからの道（「/」で終わる＝その下の全部） */
export const DRIVE_SYNC_RECORD_PREFIX = `.aiwriter/${DRIVE_SYNC_RECORD_DIR}/`;

/**
 * どの一覧に書かれていても送らないもの。
 *
 * - `.git/`：`IGNORED_PATHS` は Git の除外として書かれているので、Git が自分で
 *   持つ `.git/` を含まない。ドライブでは製品が自分で一覧を作るので、ここで外す
 * - 印の置き場：**`IGNORED_PATHS` へは足さない**（0.132.0）。あちらは起動の
 *   たびに全作品の .gitignore へ足されるので、ドライブを使っていない作品まで
 *   「記録待ち」になる（0.111.16 の失敗。`workRegistry.ts` の `IGNORED_PATHS`
 *   の説明）。Git 側は使った作品にだけ足す行（`ON_USE_IGNORED_PATHS`）に置いた
 */
const ALWAYS_IGNORED: readonly string[] = [".git/", DRIVE_SYNC_RECORD_PREFIX];

/**
 * 端末ごとに1本ずつ置くファイルの置き場（設計書5.5.2・5.5.6）。どれも
 * `<端末ID>.json` で、**書くのはその端末だけ**。
 */
const DEVICE_SCOPED_DIRS = ["sessions", "stats"] as const;

export type DeviceScopedDir = (typeof DEVICE_SCOPED_DIRS)[number];

/**
 * 端末ごとのファイルなら、その持ち主の端末ID。ちがえば undefined。
 *
 * ドライブでの扱い（0.132.0。5.5.6 と同じ考え）：
 * - **自分の端末のファイルは、向こうから受け取らない・食い違いにしない**。
 *   書くのは自分だけなので、向こうにあるのは前に送った写しでしかない
 * - **送るのは自分の端末の分だけ**。受け取ったほかの端末の写しを送り返すと、
 *   持ち主の端末で「自分のファイルが向こうで変わった」に見える
 */
export function deviceScopedPath(
  syncPath: string
): { dir: DeviceScopedDir; deviceId: string } | undefined {
  const segments = syncPath.split("/");
  if (segments.length !== 3 || segments[0] !== ".aiwriter") return undefined;
  const dir = DEVICE_SCOPED_DIRS.find((name) => name === segments[1]);
  if (!dir || !segments[2].endsWith(".json")) return undefined;
  const deviceId = segments[2].slice(0, -".json".length);
  // 端末IDの形でない名前（作者が置いた別のファイル）は、ふつうのファイルとして扱う
  return isValidDeviceId(deviceId) ? { dir, deviceId } : undefined;
}

/**
 * この端末が送ってよいファイルか（送らないもの・ほかの端末のファイルを除く）。
 * 送る側の一覧づくりで使う。
 */
export function isSendableSyncPath(
  syncPath: string,
  input: { ownDeviceId: string; ignoredPaths: readonly string[] }
): boolean {
  if (!isSafeSyncPath(syncPath)) return false;
  if (isIgnoredSyncPath(syncPath, input.ignoredPaths)) return false;
  const owner = deviceScopedPath(syncPath);
  return owner === undefined || owner.deviceId === input.ownDeviceId;
}

/**
 * 送らないものか。`ignoredPaths` は `core/workRegistry.ts` の `IGNORED_PATHS`
 * を呼び手が渡す（あちらは vscode を読むので、ここからは import しない）。
 *
 * 当て方：「/」で終わる項目はその下の全部、そうでない項目はその道だけ。
 * **Git の「どの深さでも当たる」規則とは違う**——一覧の項目はどれも作品の
 * 根からの道として書かれているので、根から当てる。
 */
export function isIgnoredSyncPath(
  syncPath: string,
  ignoredPaths: readonly string[]
): boolean {
  for (const rule of [...ALWAYS_IGNORED, ...ignoredPaths]) {
    if (rule.endsWith("/") ? syncPath.startsWith(rule) : syncPath === rule) {
      return true;
    }
  }
  return false;
}

/** 何もしない理由。画面の文言ではなく、ログと試験のための印 */
export type DriveNoneReason =
  /** 手元も向こうも印と同じ */
  | "unchanged"
  /** 手元だけが変わった（次に送る） */
  | "local_changed"
  /** 手元だけが消した（次に送る） */
  | "local_deleted"
  /** 手元にだけある・向こうの目録にまだ載っていない（次に送る） */
  | "local_only"
  /** 手元にも無く、向こうでも消えている（印も無い） */
  | "absent"
  /** この端末のファイル（`deviceScopedPath`）。向こうにあるのは写しなので受け取らない */
  | "own_device";

export type DriveSyncDecision =
  | { kind: "none"; path: string; reason: DriveNoneReason }
  /**
   * 向こうの中身を受け取る。書くときの期待ハッシュは `expectedLocalHash`
   * （3点比較の直前に読んだ手元の今。設計書5.10.2）。
   * `viaResolution` は、もう1台で選び終えた食い違いの結果として受け取るとき。
   * そのときは `resolutionRound`（使った選択の回）を受け取った側が控える
   */
  | {
      kind: "receive";
      path: string;
      expectedLocalHash: string;
      remoteHash: string;
      viaResolution: boolean;
      resolutionRound?: number;
      settings: boolean;
    }
  /**
   * 中身は書かず、印だけを進める。`hash` が null なら印を外す（両方で消えた）。
   * `echo` は「向こうの中身は、こちらが前に送ったもの」（`ownSent`）のとき
   */
  | { kind: "advance"; path: string; hash: string | null; settings: boolean; echo?: boolean }
  /** 手元に無い新しいファイルを置く（`atomicWriteFile` の `create`） */
  | { kind: "create"; path: string; remoteHash: string; settings: boolean }
  /**
   * 食い違い。**機械は選ばない。** `localHash` が null なら「手元で消した・
   * 向こうで書き換えた」。`settings` が true なら `decideSettingsConflict` へ
   * 回す——base には `markHash` の中身の控えを使う（無ければ base なし）
   */
  | {
      kind: "conflict";
      path: string;
      markHash: string | null;
      localHash: string | null;
      remoteHash: string;
      settings: boolean;
    }
  /** 向こうで消えた。**手元では消さない。知らせるだけ**（設計書5.4.5） */
  | { kind: "remote_deleted"; path: string; localHash: string; localChanged: boolean };

/**
 * 受け取りの3点比較（設計書5.10.4）。ファイルごとに決定を1つ返す。道の順。
 *
 * @param input.marks 前回そろえたときの印（道 → ハッシュ。手元の端末別の控え）
 * @param input.local 手元の今（道 → ハッシュ）
 * @param input.manifest 向こうの目録。**届ききったかは呼び手が先に確かめる**
 *   （`planDriveReceiveChecked` を使えば一緒に確かめる）
 * @param input.ownDeviceId この端末のID。渡すと、この端末のファイル
 *   （`deviceScopedPath`）は受け取らない（`own_device`）
 * @param input.consumedResolutions この目録の送り手の選択を、道ごとに
 *   どの回まで使ったか（`DriveSyncRecord.consumedResolutions` の送り手の分）。
 *   使った回より前の選択は、もう効かせない
 * @param input.ownSent 印を置いてから、この端末が送った中身（道 → ハッシュ）。
 *   向こうの中身がこのどれかなら、向こうはこちらの写しを持っているだけ
 *   （`advance` の `echo`）
 */
export function planDriveReceive(input: {
  marks: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
  manifest: DriveManifest;
  ignoredPaths: readonly string[];
  ownDeviceId?: string;
  consumedResolutions?: ReadonlyMap<string, number>;
  ownSent?: ReadonlyMap<string, readonly string[]>;
}): DriveSyncDecision[] {
  const { marks, local, manifest } = input;
  const deleted = new Set(manifest.deleted);
  const paths = new Set<string>([
    ...marks.keys(),
    ...local.keys(),
    ...manifest.files.keys(),
    ...deleted,
  ]);

  const decisions: DriveSyncDecision[] = [];
  for (const entry of [...paths].sort()) {
    if (isIgnoredSyncPath(entry, input.ignoredPaths)) continue;
    if (
      input.ownDeviceId !== undefined &&
      deviceScopedPath(entry)?.deviceId === input.ownDeviceId
    ) {
      decisions.push({ kind: "none", path: entry, reason: "own_device" });
      continue;
    }
    const resolved = manifest.resolvedConflicts.get(entry);
    const consumedRound = input.consumedResolutions?.get(entry);
    decisions.push(
      decideOne(entry, {
        mark: marks.get(entry),
        local: local.get(entry),
        remote: manifest.files.get(entry),
        remoteBase: manifest.bases.get(entry),
        remoteDeleted: deleted.has(entry),
        // 使った選択は効かせない（`DriveResolvedConflict.round` の説明）
        resolved:
          resolved && (consumedRound === undefined || resolved.round > consumedRound)
            ? resolved
            : undefined,
        ownSent: input.ownSent?.get(entry) ?? [],
      })
    );
  }
  return decisions;
}

export type DriveReceivePlan =
  | { kind: "plan"; decisions: DriveSyncDecision[] }
  /** まだ届ききっていません。**計画を何も出さない**（設計書5.10.3） */
  | { kind: "not_arrived"; missing: string[]; mismatched: string[] };

/** 届ききったかを確かめてから3点比較する。届いていなければ決定を1つも返さない */
export function planDriveReceiveChecked(input: {
  marks: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
  manifest: DriveManifest;
  actualRemoteHashes: ReadonlyMap<string, string>;
  ignoredPaths: readonly string[];
  ownDeviceId?: string;
  consumedResolutions?: ReadonlyMap<string, number>;
  ownSent?: ReadonlyMap<string, readonly string[]>;
}): DriveReceivePlan {
  const arrival = checkManifestArrival(input.manifest, input.actualRemoteHashes);
  if (!arrival.arrived) {
    return { kind: "not_arrived", missing: arrival.missing, mismatched: arrival.mismatched };
  }
  return { kind: "plan", decisions: planDriveReceive(input) };
}

/**
 * 1ファイルの決め方。判定の順に意味がある：
 * 向こうで消えた → 向こうの目録に載っていない → こちらの写し → 手元に無い →
 * 中身が同じ → 選び終えた食い違い → 印との比べ。
 */
function decideOne(
  entry: string,
  s: {
    mark: string | undefined;
    local: string | undefined;
    remote: string | undefined;
    remoteBase: string | undefined;
    remoteDeleted: boolean;
    resolved: DriveResolvedConflict | undefined;
    ownSent: readonly string[];
  }
): DriveSyncDecision {
  const settings = isSettingsJsonPath(entry);
  const { local, remote } = s;
  let mark = s.mark;

  if (s.remoteDeleted) {
    if (local === undefined) {
      // 両方で消えた。残った印は外す（あとで向こうに同じ名前が出たとき、
      // 古い印のせいで「手元で消した」と取り違えないため）
      return mark === undefined
        ? { kind: "none", path: entry, reason: "absent" }
        : { kind: "advance", path: entry, hash: null, settings };
    }
    // 一度もそろえていないファイルは、向こうが消したものと同じとは言えない
    if (mark === undefined) return { kind: "none", path: entry, reason: "local_only" };
    return { kind: "remote_deleted", path: entry, localHash: local, localChanged: local !== mark };
  }

  if (remote === undefined) {
    // 消えたとも書かれていない＝向こうがまだ受け取っていない（こちらが
    // 送ったものは、向こうが受け取るまで向こうの目録に載らない）
    if (local === undefined) return { kind: "none", path: entry, reason: "local_deleted" };
    if (mark === undefined) return { kind: "none", path: entry, reason: "local_only" };
    return { kind: "none", path: entry, reason: local === mark ? "unchanged" : "local_changed" };
  }

  // 向こうの中身は、この端末が印のあとで送ったもの（0.132.0）。向こうは
  // こちらの写しを受け取っただけで、新しく書いてはいない。送ったあとで
  // 手元をさらに書いていても食い違いではない——印を向こうへ進めれば、
  // 手元の続きは次に送られる。これが無いと「送る→書き足す→向こうが受け取って
  // 送り返す」のたびに、自分の書いたもの同士が食い違いとして訊かれる
  if (remote !== mark && s.ownSent.includes(remote)) {
    return { kind: "advance", path: entry, hash: remote, settings, echo: true };
  }

  // 向こうは、この端末が印のあとで送った中身の上に書いた（0.132.0）。
  // 向こうの目録の印（`bases`）が、こちらの送った中身のどれかなら、
  // 2台の共通の祖先はこちらの印ではなくその中身である。そこから比べ直す。
  // これが無いと「A が送る → B が受け取って書き足す → A が受け取る」という
  // いちばんふつうの往復が、A では毎回「食い違い」になる（A の印は、A が
  // 受け取ったときにしか進まないため）。
  // 向こうの中身がこちらの印と同じなら比べ直さない：向こうは変わっていない
  // （向こうの印は古い回のもので、同じハッシュへ戻っただけかもしれない）
  if (
    s.remoteBase !== undefined &&
    s.remoteBase !== mark &&
    remote !== mark &&
    s.ownSent.includes(s.remoteBase)
  ) {
    mark = s.remoteBase;
  }

  if (local === undefined) {
    if (mark === undefined) return { kind: "create", path: entry, remoteHash: remote, settings };
    if (remote === mark) return { kind: "none", path: entry, reason: "local_deleted" };
    // 手元で消した・向こうで書き換えた。新しく置くと、作者が消した話が
    // 黙って戻ってくる。消えたままにすると向こうの書き足しが消える。どちらも選ばない
    return { kind: "conflict", path: entry, markHash: mark, localHash: null, remoteHash: remote, settings };
  }

  if (local === remote) {
    // 中身が同じなら食い違いではない（誤検出を出さない）。印だけ追いつかせる
    return local === mark
      ? { kind: "none", path: entry, reason: "unchanged" }
      : { kind: "advance", path: entry, hash: remote, settings };
  }

  // 同じ食い違いを2台で2度訊かない（設計書5.10.4）。もう1台の作者は、
  // 手元の今のこの中身と見比べたうえで向こうの中身を選んでいる。
  // 手元がそのあとさらに変わっていれば当たらず、下の比べで食い違いに戻る
  if (s.resolved !== undefined && s.resolved.against === local) {
    return {
      kind: "receive",
      path: entry,
      expectedLocalHash: local,
      remoteHash: remote,
      viaResolution: true,
      resolutionRound: s.resolved.round,
      settings,
    };
  }

  if (mark === undefined || (local !== mark && remote !== mark)) {
    return { kind: "conflict", path: entry, markHash: mark ?? null, localHash: local, remoteHash: remote, settings };
  }
  if (local === mark) {
    return {
      kind: "receive",
      path: entry,
      expectedLocalHash: local,
      remoteHash: remote,
      viaResolution: false,
      settings,
    };
  }
  return { kind: "none", path: entry, reason: "local_changed" };
}

function unreadable(reason: string): DriveManifestRead {
  return { ok: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 選び終えた食い違いの表を読む。読めなければ理由の文字列を返す */
function readResolvedConflicts(
  value: unknown
): Map<string, DriveResolvedConflict> | string {
  const label = "選び終えた食い違い";
  if (!isPlainObject(value)) return `${label}が読めません`;
  const out = new Map<string, DriveResolvedConflict>();
  for (const [entry, item] of Object.entries(value)) {
    if (!isSafeSyncPath(entry)) return `${label}の道が読めません（${entry}）`;
    if (!isPlainObject(item)) return `${label}の形が読めません（${entry}）`;
    const { against, round } = item;
    if (typeof against !== "string" || !HASH_PATTERN.test(against)) {
      return `${label}のハッシュが読めません（${entry}）`;
    }
    if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
      return `${label}の回の番号が読めません（${entry}）`;
    }
    out.set(entry, { against, round });
  }
  return out;
}

/** 道 → ハッシュの表を読む。読めなければ理由の文字列を返す */
function readHashMap(value: unknown, label: string): Map<string, string> | string {
  if (!isPlainObject(value)) return `${label}が読めません`;
  const out = new Map<string, string>();
  for (const [entry, hash] of Object.entries(value)) {
    if (!isSafeSyncPath(entry)) return `${label}の道が読めません（${entry}）`;
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
      return `${label}のハッシュが読めません（${entry}）`;
    }
    out.set(entry, hash);
  }
  return out;
}
