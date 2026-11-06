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

/** 目録の形の版。形を変えたら上げる。読む側は知らない版を「読めない」にする */
export const DRIVE_MANIFEST_FORMAT = 1;

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
   * その端末で消えたファイル。**一度消えたものは積んだまま載せる**——
   * 受け取る側は最新の目録しか読まないので、間の回を読み逃しても
   * 消えたことが分かるようにする
   */
  deleted: readonly string[];
  /**
   * 選び終えた食い違い：道 → そのとき見比べた**相手のハッシュ**（設計書5.10.4）。
   * 受け取る側は、手元の今がこのハッシュと同じなら選び直させずに受け取る
   */
  resolvedConflicts: ReadonlyMap<string, string>;
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
  const resolvedConflicts = readHashMap(value.resolvedConflicts, "選び終えた食い違い");
  if (typeof resolvedConflicts === "string") return unreadable(resolvedConflicts);

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
  const sorted = (map: ReadonlyMap<string, string>) => {
    const out: Record<string, string> = {};
    for (const key of [...map.keys()].sort()) out[key] = map.get(key) as string;
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
 *   今回選んだものが前の回のものより優先する
 */
export function buildDriveManifest(input: {
  deviceId: string;
  deviceName: string;
  round: number;
  sentAt: string;
  files: ReadonlyMap<string, string>;
  previous?: DriveManifest;
  resolvedConflicts?: ReadonlyMap<string, string>;
}): DriveManifest {
  const deleted = new Set<string>();
  if (input.previous) {
    for (const entry of input.previous.deleted) deleted.add(entry);
    for (const entry of input.previous.files.keys()) deleted.add(entry);
  }
  for (const entry of input.files.keys()) deleted.delete(entry);

  const resolvedConflicts = new Map<string, string>();
  for (const [entry, hash] of input.previous?.resolvedConflicts ?? []) {
    if (input.files.has(entry)) resolvedConflicts.set(entry, hash);
  }
  for (const [entry, hash] of input.resolvedConflicts ?? []) {
    if (input.files.has(entry)) resolvedConflicts.set(entry, hash);
  }

  return {
    formatVersion: DRIVE_MANIFEST_FORMAT,
    sentAt: input.sentAt,
    round: input.round,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    files: new Map(input.files),
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
 * どの一覧に書かれていても送らないもの。`IGNORED_PATHS` は Git の除外として
 * 書かれているので、Git が自分で持つ `.git/` を含まない。ドライブでは
 * 製品が自分で一覧を作るので、ここで外す。
 */
const ALWAYS_IGNORED: readonly string[] = [".git/"];

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
  | "absent";

export type DriveSyncDecision =
  | { kind: "none"; path: string; reason: DriveNoneReason }
  /**
   * 向こうの中身を受け取る。書くときの期待ハッシュは `expectedLocalHash`
   * （3点比較の直前に読んだ手元の今。設計書5.10.2）。
   * `viaResolution` は、もう1台で選び終えた食い違いの結果として受け取るとき
   */
  | {
      kind: "receive";
      path: string;
      expectedLocalHash: string;
      remoteHash: string;
      viaResolution: boolean;
      settings: boolean;
    }
  /** 中身は書かず、印だけを進める。`hash` が null なら印を外す（両方で消えた） */
  | { kind: "advance"; path: string; hash: string | null; settings: boolean }
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
 */
export function planDriveReceive(input: {
  marks: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
  manifest: DriveManifest;
  ignoredPaths: readonly string[];
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
    decisions.push(
      decideOne(entry, {
        mark: marks.get(entry),
        local: local.get(entry),
        remote: manifest.files.get(entry),
        remoteDeleted: deleted.has(entry),
        resolved: manifest.resolvedConflicts.get(entry),
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
}): DriveReceivePlan {
  const arrival = checkManifestArrival(input.manifest, input.actualRemoteHashes);
  if (!arrival.arrived) {
    return { kind: "not_arrived", missing: arrival.missing, mismatched: arrival.mismatched };
  }
  return { kind: "plan", decisions: planDriveReceive(input) };
}

/**
 * 1ファイルの決め方。判定の順に意味がある：
 * 向こうで消えた → 向こうの目録に載っていない → 手元に無い → 中身が同じ →
 * 選び終えた食い違い → 印との比べ。
 */
function decideOne(
  entry: string,
  s: {
    mark: string | undefined;
    local: string | undefined;
    remote: string | undefined;
    remoteDeleted: boolean;
    resolved: string | undefined;
  }
): DriveSyncDecision {
  const settings = isSettingsJsonPath(entry);
  const { mark, local, remote } = s;

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
  if (s.resolved === local) {
    return {
      kind: "receive",
      path: entry,
      expectedLocalHash: local,
      remoteHash: remote,
      viaResolution: true,
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
