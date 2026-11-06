import { isValidDeviceId } from "./device";
import { isSettingsJsonPath } from "./settingsConflictRule";

/**
 * Google ドライブで作品をそろえる（設計書5.10）の計画の関数。
 *
 * **ここは計画を返すだけで、何も書かない。** 読み書き・Drive API・画面は
 * `driveSyncEngine.ts` と呼び手の仕事である。中身（目録・系譜の比べ方・規則）を
 * ここへ集めるのは、モバイル版へそのまま持っていくため（作者の決定、2026-11-06 昼）。
 * そのため `vscode`・`node:`・`./paths`（vscode を読む）を import しない
 * （`test/unit/core/driveSyncPlan.test.ts` の最後のテストが見張る）。
 *
 * ハッシュは呼び手が `core/hash.ts` の `hashBytes` で作って渡す。
 * 道は作品フォルダーからの相対で、区切りは「/」にそろえたもの。
 *
 * ## 中身の系譜で比べる（設計書5.10.6。0.133.0）
 *
 * 3台以上でそろえるため、「前回そろえたときの印」（相手ごとに1つ）ではなく、
 * ファイルごとに**今の中身と、それがどの中身から来たか**（祖先の並び）を持つ
 * （`DriveLineage`）。相手が何台でも、比べ方は「どちらの中身がもう一方の祖先に
 * 入っているか」だけで決まる（`compareDriveLineage`）。
 */

/**
 * 目録の形の版。形を変えたら上げる。読む側は知らない版を「読めない」にする。
 *
 * 3（0.133.0）：ファイルごとに系譜（`DriveLineage`）を持たせ、送った端末の印
 * （`bases`）と選び終えた食い違い（`resolvedConflicts`）を外した。消えたファイルも
 * `files` の中に「消えた」という中身（`DRIVE_DELETED`）として置く。版1・2を書いた
 * 製品は配っていない（段階1・2は画面から使えなかった）ので、前の版は読まない
 */
export const DRIVE_MANIFEST_FORMAT = 3;

/**
 * 祖先の並びの上限（設計書5.10.6 の K）。
 *
 * これより古い中身は比べられない。比べられないときは食い違いになる
 * （黙って上書きしない。見逃しより誤検出を取る）。32 は、1台が相手の
 * 受け取りを待たずに 32 回送るまでは往復で迷わない、という目安。
 */
export const DRIVE_LINEAGE_LIMIT = 32;

/**
 * 「消えた」という中身の印。ハッシュ（64桁の16進）とは決して重ならない文字にする。
 * 消えたことも1つの中身として系譜に積む（消したあとで書き直した・向こうで
 * 消したものを手元では消していない、を同じ規則で比べるため）
 */
export const DRIVE_DELETED = "deleted";

/**
 * ファイル1つの系譜（設計書5.10.6）。
 *
 * - `hash`：今の中身のハッシュ。消えていれば `DRIVE_DELETED`
 * - `ancestors`：この中身がどの中身から来たか。**新しい順**、上限 `DRIVE_LINEAGE_LIMIT`
 * - `gen`：書き換えた回数のようなもの（書き換え・消す・合流で1つ増える）。
 *   **2つの系譜が互いを祖先に持つときだけ**どちらが新しいかを決めるのに使う。
 *   そうなるのは、書いてから元に戻したとき（「元の文 → 直した文 → 元の文」で、
 *   元の文が直した文の祖先にも子孫にもなる）と、同じ食い違いを2台で別々に
 *   選んだとき。ほかの場面では見ない（数がずれても判断を誤らないように）
 */
export interface DriveLineage {
  hash: string;
  gen: number;
  ancestors: readonly string[];
}

/**
 * 送る側が最後に書く目録（`manifest.json`。設計書5.10.3）。
 *
 * 道を鍵にする所は Map にしてある。JSON の素のオブジェクトのままだと、
 * `__proto__` のような道が来たときに中身と取り違える。
 */
export interface DriveManifest {
  formatVersion: typeof DRIVE_MANIFEST_FORMAT;
  /** 送った時刻（ISO 8601）。「その端末が最後に送ったのは いつ」を見せるため */
  sentAt: string;
  /** 送った回の番号（1から）。同じく「何回目」を見せるため */
  round: number;
  /** 送った端末のID（`core/device.ts`） */
  deviceId: string;
  /** 送った端末の名前（画面に出す。空でもよい） */
  deviceName: string;
  /**
   * 送ったファイルの道 → 系譜。その端末の作品の全部（変わったものだけではない）。
   * **消えたファイルも `hash: DRIVE_DELETED` で積んだまま載せる**——受け取る側は
   * 最新の目録しか読まないので、間の回を読み逃しても消えたことが分かるようにする
   */
  files: ReadonlyMap<string, DriveLineage>;
}

export type DriveManifestRead =
  | { ok: true; manifest: DriveManifest }
  | { ok: false; reason: string };

/** `hashBytes`（SHA-256）の16進。形の違うハッシュは壊れた目録として扱う */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 円記号。符号で書くのは、文字のまま書くと読み違えやすく、書く道具に潰されるため */
const BACKSLASH = String.fromCharCode(0x5c);

function isContentId(value: unknown): value is string {
  return typeof value === "string" && (value === DRIVE_DELETED || HASH_PATTERN.test(value));
}

/** 重なりを除き、上限で切る（新しい順を保つ） */
function trimAncestors(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= DRIVE_LINEAGE_LIMIT) break;
  }
  return out;
}

/**
 * 手元の今の系譜。控えの頭（`head`：前回そろえた・送ったときの系譜）と、
 * 手元の今のハッシュ（無ければ消えた）から作る。
 *
 * - 今の中身が頭と同じ → 頭のまま
 * - 違う → 頭を祖先の先頭に足した新しい系譜（手元で書いた）
 * - 頭が無い → 祖先の無い系譜（どこから来たか分からない）
 * - 手元に無い → 頭が「消えた」ならそのまま、在れば「消えた」を新しく積む。
 *   頭も無ければ undefined（この端末はこのファイルを知らない）
 */
export function localDriveLineage(
  head: DriveLineage | undefined,
  localHash: string | undefined
): DriveLineage | undefined {
  const now = localHash ?? DRIVE_DELETED;
  if (head === undefined) {
    return localHash === undefined ? undefined : { hash: localHash, gen: 0, ancestors: [] };
  }
  if (head.hash === now) return head;
  return {
    hash: now,
    gen: head.gen + 1,
    ancestors: trimAncestors([head.hash, ...head.ancestors]),
  };
}

export type DriveLineageRelation = "same" | "newer" | "older" | "diverged";

/**
 * 2つの系譜の比べ（設計書5.10.6 の4通り）。`remote` から見た `local` との関係を返す。
 *
 * - `same`：中身が同じ
 * - `newer`：向こうが新しい（手元の中身が向こうの祖先にある）→ 受け取ってよい
 * - `older`：こちらが新しい（向こうの中身が手元の祖先にある）→ 何もしない
 * - `diverged`：どちらでもない → 食い違い。祖先の上限を越えて古い中身も、
 *   祖先に見つからないのでここへ来る（黙って上書きしない）
 *
 * 互いに相手を祖先に持つときだけ `gen` で決める（`DriveLineage.gen` の説明）。
 * `gen` も同じなら決められないので食い違い。
 */
export function compareDriveLineage(
  local: DriveLineage | undefined,
  remote: DriveLineage
): DriveLineageRelation {
  // 手元が何も知らないファイルは、向こうの中身が何であれ向こうが新しい
  if (local === undefined) return "newer";
  if (local.hash === remote.hash) return "same";
  const remoteHasLocal = remote.ancestors.includes(local.hash);
  const localHasRemote = local.ancestors.includes(remote.hash);
  if (remoteHasLocal && (!localHasRemote || remote.gen > local.gen)) return "newer";
  if (localHasRemote && (!remoteHasLocal || local.gen > remote.gen)) return "older";
  return "diverged";
}

/**
 * 中身が同じ系譜を1つにまとめる。祖先は両方を足す（手元の順を先に）。
 *
 * 足すのは、別の端末で選び終えた食い違いの知らせを運ぶため——A が B の中身を
 * 退けて自分の中身を残すと、A の系譜の祖先に B の中身が入る。A と同じ中身を
 * 前から持っていた端末も、まとめると B の中身を祖先に持ち、B から見て新しい側になる
 */
export function mergeSameDriveLineage(a: DriveLineage, b: DriveLineage): DriveLineage {
  return {
    hash: a.hash,
    gen: Math.max(a.gen, b.gen),
    ancestors: trimAncestors([...a.ancestors, ...b.ancestors]),
  };
}

/**
 * 食い違いを選び終えたあとの系譜（合流。設計書5.10.6）。
 *
 * 残した中身（`kept`）を頭にし、**退けた側（`others`）の中身とその祖先も祖先に入れる**。
 * ほかの端末から見ると、どちらの枝も選んだ結果の祖先にあるので、同じ食い違いを
 * 2度訊かない。`gen` は両方より1つ大きくする（同じ食い違いを別の端末が別に
 * 選んでいたとき、あとで選び直した側が新しくなるように）。
 *
 * @param hash 結果の中身。ふつうは `kept.hash`。設定資料を項目ごとに合わせたときは
 *   合わせた中身のハッシュで、そのときは `kept` の中身も祖先に入れる
 */
export function joinDriveLineage(
  kept: DriveLineage,
  others: readonly DriveLineage[],
  hash: string = kept.hash
): DriveLineage {
  const heads = [kept, ...others].filter((item) => item.hash !== hash).map((item) => item.hash);
  return {
    hash,
    gen: Math.max(kept.gen, ...others.map((item) => item.gen)) + 1,
    ancestors: trimAncestors([
      ...heads,
      ...kept.ancestors,
      ...others.flatMap((item) => item.ancestors),
    ]),
  };
}

/**
 * 目録に書いてある道が、作品フォルダーの中を指すか。
 *
 * **受け取りではこの道へ手元の原稿を書く。** ここで止めないと、壊れた目録や
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
 * 系譜1つを読む（目録と控えで共通）。読めなければ理由の文字列を返す。
 * 上限より長い祖先は「読めない」——黙って切ると、書いた製品と読む製品で
 * 比べられる範囲が食い違う（上限を変えるなら形の版を上げる）
 */
export function readDriveLineage(value: unknown): DriveLineage | string {
  if (!isPlainObject(value)) return "系譜の形ではありません";
  const { hash, gen, ancestors } = value;
  if (!isContentId(hash)) return "中身のハッシュが読めません";
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0) {
    return "系譜の回の数が読めません";
  }
  if (!Array.isArray(ancestors) || !ancestors.every(isContentId)) {
    return "祖先の並びが読めません";
  }
  if (ancestors.length > DRIVE_LINEAGE_LIMIT) return "祖先の並びが上限より長くなっています";
  if (new Set(ancestors).size !== ancestors.length) return "祖先の並びに同じ中身が重なっています";
  return { hash, gen, ancestors: [...ancestors] as string[] };
}

/** 系譜を文字にする形（目録と控えで共通） */
export function lineageToJson(lineage: DriveLineage): {
  hash: string;
  gen: number;
  ancestors: string[];
} {
  return { hash: lineage.hash, gen: lineage.gen, ancestors: [...lineage.ancestors] };
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

  if (!isPlainObject(value.files)) return unreadable("ファイルの一覧が読めません");
  const files = new Map<string, DriveLineage>();
  for (const [entry, item] of Object.entries(value.files)) {
    if (!isSafeSyncPath(entry)) return unreadable(`ファイルの一覧の道が読めません（${entry}）`);
    const lineage = readDriveLineage(item);
    if (typeof lineage === "string") return unreadable(`${lineage}（${entry}）`);
    // 消えたものは、何が消えたかが分からないと比べられない
    if (lineage.hash === DRIVE_DELETED && lineage.ancestors.length === 0) {
      return unreadable(`何が消えたのかが書かれていません（${entry}）`);
    }
    files.set(entry, lineage);
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
    },
  };
}

/**
 * 目録を文字にする。道の順に並べる——同じ中身なら同じ文字になり、
 * ドライブの画面で作者が見比べたときに順番の違いが変更に見えない。
 */
export function serializeDriveManifest(manifest: DriveManifest): string {
  const files: Record<string, ReturnType<typeof lineageToJson>> = {};
  for (const key of [...manifest.files.keys()].sort()) {
    files[key] = lineageToJson(manifest.files.get(key) as DriveLineage);
  }
  return (
    JSON.stringify(
      {
        formatVersion: manifest.formatVersion,
        sentAt: manifest.sentAt,
        round: manifest.round,
        deviceId: manifest.deviceId,
        deviceName: manifest.deviceName,
        files,
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * 送るときの系譜（設計書5.10.6）。道 → この回に目録へ載せる系譜。
 *
 * - 手元に在るファイル：控えの頭（`lineage`）から `localDriveLineage` で作る。
 *   **送ったら控えの頭をこれへ進める**（呼び手）。そうすると、相手がこちらの
 *   写しを送り返してきても「向こうの中身がこちらの祖先にある」で何もしない
 * - 手元に無いファイル：控えの頭が在れば「消えた」を積む。控えに無くても前の回の
 *   目録（`previous`）に載っていれば、そこから「消えた」を積む（控えを失っても、
 *   一度消えたものを載せ続ける）
 *
 * @param isSendable 送ってよい道か（`isSendableSyncPath`）。外れる道は載せない
 */
export function planDriveSend(input: {
  lineage: ReadonlyMap<string, DriveLineage>;
  local: ReadonlyMap<string, string>;
  previous?: DriveManifest;
  isSendable: (syncPath: string) => boolean;
}): Map<string, DriveLineage> {
  const paths = new Set<string>([
    ...input.local.keys(),
    ...input.lineage.keys(),
    ...(input.previous?.files.keys() ?? []),
  ]);
  const out = new Map<string, DriveLineage>();
  for (const entry of [...paths].sort()) {
    if (!input.isSendable(entry)) continue;
    const localHash = input.local.get(entry);
    const head =
      input.lineage.get(entry) ??
      (localHash === undefined ? input.previous?.files.get(entry) : undefined);
    const lineage = localDriveLineage(head, localHash);
    if (lineage) out.set(entry, lineage);
  }
  return out;
}

/** 送る側が目録を組む。系譜は `planDriveSend` で作ったもの */
export function buildDriveManifest(input: {
  deviceId: string;
  deviceName: string;
  round: number;
  sentAt: string;
  files: ReadonlyMap<string, DriveLineage>;
}): DriveManifest {
  return {
    formatVersion: DRIVE_MANIFEST_FORMAT,
    sentAt: input.sentAt,
    round: input.round,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    files: new Map(input.files),
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
 * 消えたファイルは中身が無いので確かめない。向こうのフォルダーに目録に無い
 * ファイルがあるのは問わない（消えたファイルの写しを向こうに残してよい作りのため）。
 */
export function checkManifestArrival(
  manifest: DriveManifest,
  actualRemoteHashes: ReadonlyMap<string, string>
): DriveArrival {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [entry, lineage] of manifest.files) {
    if (lineage.hash === DRIVE_DELETED) continue;
    const actual = actualRemoteHashes.get(entry);
    if (actual === undefined) missing.push(entry);
    else if (actual !== lineage.hash) mismatched.push(entry);
  }
  if (missing.length === 0 && mismatched.length === 0) return { arrived: true };
  return { arrived: false, missing: missing.sort(), mismatched: mismatched.sort() };
}

/**
 * ドライブでそろえるときの、この端末だけの控えの置き場
 * （`.aiwriter/` の下。中身は `core/driveSyncRecord.ts`）。
 *
 * `sessions/`・`stats/` と同じく `<端末ID>.json` の1本にする。控えは
 * 「この端末が前回そろえたとき何を見たか」なので、**ほかの端末へ送ると
 * 意味が壊れる**（向こうの比べの基準が、こちらの控えに置き換わる）。
 */
export const DRIVE_SYNC_RECORD_DIR = "drive-sync";

/** 控えの置き場の、作品フォルダーからの道（「/」で終わる＝その下の全部） */
export const DRIVE_SYNC_RECORD_PREFIX = `.aiwriter/${DRIVE_SYNC_RECORD_DIR}/`;

/**
 * どの一覧に書かれていても送らないもの。
 *
 * - `.git/`：`IGNORED_PATHS` は Git の除外として書かれているので、Git が自分で
 *   持つ `.git/` を含まない。ドライブでは製品が自分で一覧を作るので、ここで外す
 * - 控えの置き場：**`IGNORED_PATHS` へは足さない**（0.132.0）。あちらは起動の
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
  /** 手元もどの相手も同じ中身（または相手が古い） */
  | "unchanged"
  /** 手元だけが新しい（次に送る） */
  | "local_changed"
  /** 手元だけが消した（次に送る） */
  | "local_deleted"
  /** 手元にだけある・どの相手の目録にもまだ載っていない（次に送る） */
  | "local_only"
  /** 手元にも無く、相手でも消えている */
  | "absent"
  /** この端末のファイル（`deviceScopedPath`）。向こうにあるのは写しなので受け取らない */
  | "own_device";

/** 受け取りの相手1台 */
export interface DrivePeer {
  deviceId: string;
  deviceName: string;
  /** **届ききったもの**だけを渡す（`checkManifestArrival`） */
  manifest: DriveManifest;
}

/** 同じ中身を持つ相手のまとまり（食い違いの相手の一覧の1件） */
export interface DriveConflictSide {
  /** その中身を持つ端末（目録の順。先頭から読む） */
  devices: { deviceId: string; deviceName: string }[];
  /** その中身の系譜（同じ中身の端末どうしはまとめてある） */
  lineage: DriveLineage;
}

export type DriveSyncDecision =
  | { kind: "none"; path: string; reason: DriveNoneReason }
  /**
   * 向こうの中身を受け取る。書くときの期待ハッシュは `expectedLocalHash`
   * （比べる直前に読んだ手元の今。設計書5.10.2）。書けたら控えの頭を `lineage` に。
   * `from` はその中身を持つ端末（読むのは先頭から）
   */
  | {
      kind: "receive";
      path: string;
      expectedLocalHash: string;
      remoteHash: string;
      lineage: DriveLineage;
      from: string[];
      settings: boolean;
    }
  /** 中身は書かず、控えの頭だけを `lineage` へ進める（中身が同じ・両方で消えた） */
  | { kind: "advance"; path: string; lineage: DriveLineage; settings: boolean }
  /** 手元に無いファイルを置く（`atomicWriteFile` の `create`） */
  | {
      kind: "create";
      path: string;
      remoteHash: string;
      lineage: DriveLineage;
      from: string[];
      settings: boolean;
    }
  /**
   * 食い違い。**機械は選ばない。** 相手の一覧（`remotes`）を返すまでで、
   * どう選ばせるかはここでは決めない（作者に訊いている途中。設計書5.10.6）。
   *
   * - `localHash`：手元の今。null なら手元に無い（消した・まだ一度も無い）
   * - `local`：手元の今の系譜。null なら手元はこのファイルを知らない
   * - `remotes`：手元より新しいとも古いとも言えない相手の中身（同じ中身はまとめる。
   *   ほかの相手の祖先に入っている中身は除く）。1件以上
   * - `localIsAncestor`：手元の中身はどの相手にも含まれている（相手どうしだけが
   *   食い違っている）
   * - `settings`：true なら相手が1件のとき `decideSettingsConflict` へ回す
   */
  | {
      kind: "conflict";
      path: string;
      localHash: string | null;
      local: DriveLineage | null;
      remotes: DriveConflictSide[];
      localIsAncestor: boolean;
      settings: boolean;
    }
  /** 向こうで消えた。**手元では消さない。知らせるだけ**（設計書5.4.5） */
  | {
      kind: "remote_deleted";
      path: string;
      localHash: string;
      /** 手元の中身が、消した端末の知らない中身か（消したあとで手元を書いた等） */
      localChanged: boolean;
      from: string[];
    };

/**
 * 受け取りの比べ（設計書5.10.6）。相手が何台でも、ファイルごとに決定を1つ返す。道の順。
 *
 * @param input.lineage この端末の控えの頭（道 → 系譜。`DriveSyncRecord.lineage`）
 * @param input.local 手元の今（道 → ハッシュ）
 * @param input.peers 相手の目録（**届ききったもの**だけ）。自分の目録は渡さない
 * @param input.ownDeviceId この端末のID。渡すと、この端末のファイル
 *   （`deviceScopedPath`）は受け取らない（`own_device`）
 */
export function planDriveReceive(input: {
  lineage: ReadonlyMap<string, DriveLineage>;
  local: ReadonlyMap<string, string>;
  peers: readonly DrivePeer[];
  ignoredPaths: readonly string[];
  ownDeviceId?: string;
}): DriveSyncDecision[] {
  const paths = new Set<string>([...input.lineage.keys(), ...input.local.keys()]);
  for (const peer of input.peers) for (const entry of peer.manifest.files.keys()) paths.add(entry);

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
    const remotes: { deviceId: string; deviceName: string; lineage: DriveLineage }[] = [];
    for (const peer of input.peers) {
      const lineage = peer.manifest.files.get(entry);
      if (lineage) remotes.push({ deviceId: peer.deviceId, deviceName: peer.deviceName, lineage });
    }
    decisions.push(
      decideOne(entry, {
        head: input.lineage.get(entry),
        localHash: input.local.get(entry),
        remotes,
      })
    );
  }
  return decisions;
}

/** 同じ中身の相手をまとめる（目録の順を保つ） */
function groupByContent(
  remotes: readonly { deviceId: string; deviceName: string; lineage: DriveLineage }[]
): DriveConflictSide[] {
  const groups: DriveConflictSide[] = [];
  for (const remote of remotes) {
    const found = groups.find((group) => group.lineage.hash === remote.lineage.hash);
    if (found) {
      found.devices.push({ deviceId: remote.deviceId, deviceName: remote.deviceName });
      found.lineage = mergeSameDriveLineage(found.lineage, remote.lineage);
    } else {
      groups.push({
        devices: [{ deviceId: remote.deviceId, deviceName: remote.deviceName }],
        lineage: remote.lineage,
      });
    }
  }
  return groups;
}

/** `candidates` のうち、`others` の全部より新しい（または同じ中身の）もの。無ければ undefined */
function findNewest(
  candidates: readonly DriveConflictSide[],
  others: readonly DriveLineage[]
): DriveConflictSide | undefined {
  return candidates.find((candidate) =>
    others.every(
      (other) =>
        other.hash === candidate.lineage.hash ||
        compareDriveLineage(other, candidate.lineage) === "newer"
    )
  );
}

function sameLineage(a: DriveLineage | undefined, b: DriveLineage): boolean {
  return (
    a !== undefined &&
    a.hash === b.hash &&
    a.gen === b.gen &&
    a.ancestors.length === b.ancestors.length &&
    a.ancestors.every((item, index) => item === b.ancestors[index])
  );
}

/**
 * 1ファイルの決め方（設計書5.10.6）。
 *
 * 1. 手元の今の系譜を作る（`localDriveLineage`）
 * 2. 相手の中身を、手元と同じ・手元より古い・それ以外（新しい／食い違う）に分ける
 * 3. それ以外が無ければ何もしない（同じ中身の相手の祖先は控えへ足す）
 * 4. それ以外の中で、ほかの全部と手元より新しい中身が1つあれば、それを1回で受け取る
 * 5. 無ければ食い違い。ただし「消えた」は手元では消さない（知らせるだけ）
 */
function decideOne(
  entry: string,
  s: {
    head: DriveLineage | undefined;
    localHash: string | undefined;
    remotes: readonly { deviceId: string; deviceName: string; lineage: DriveLineage }[];
  }
): DriveSyncDecision {
  const settings = isSettingsJsonPath(entry);
  const { head, localHash } = s;
  const ownLineage = localDriveLineage(head, localHash);

  const quietReason = (): DriveNoneReason => {
    if (ownLineage === undefined) return "absent";
    if (localHash === undefined) return ownLineage === head ? "absent" : "local_deleted";
    if (head === undefined) return "local_only";
    return ownLineage === head ? "unchanged" : "local_changed";
  };

  // どの相手の目録にも載っていない＝相手がまだ受け取っていない（こちらが
  // 送ったものは、相手が受け取るまで相手の目録に載らない）
  if (s.remotes.length === 0) return { kind: "none", path: entry, reason: quietReason() };

  const groups = groupByContent(s.remotes);
  // 手元と同じ中身の相手が知っている祖先は、手元の系譜にも足してから比べる。
  // 足さないと、選び終えた食い違いの知らせ（同じ中身の端末が運ぶ祖先）や
  // 元に戻した中身の新しさが、ほかの相手との比べに効かない
  let local = ownLineage;
  let hadSame = false;
  for (const group of groups) {
    if (local !== undefined && group.lineage.hash === local.hash) {
      local = mergeSameDriveLineage(local, group.lineage);
      hadSame = true;
    }
  }
  const relations = groups.map((group) => compareDriveLineage(local, group.lineage));
  const ahead = groups.filter((_, i) => relations[i] === "newer" || relations[i] === "diverged");

  if (ahead.length === 0) {
    // どの相手も同じか古い。相手が古いだけなら何もしない（手元の続きは次に送る）。
    // 中身が同じ相手がいれば、その祖先を控えへ足す（`mergeSameDriveLineage`）
    if (local === undefined || !hadSame || sameLineage(head, local)) {
      return { kind: "none", path: entry, reason: quietReason() };
    }
    return { kind: "advance", path: entry, lineage: local, settings };
  }

  const others = local === undefined ? ahead.map((g) => g.lineage) : [local, ...ahead.map((g) => g.lineage)];
  const deviceIds = (side: DriveConflictSide) => side.devices.map((device) => device.deviceId);

  const take = (side: DriveConflictSide): DriveSyncDecision => {
    if (localHash !== undefined) {
      return {
        kind: "receive",
        path: entry,
        expectedLocalHash: localHash,
        remoteHash: side.lineage.hash,
        lineage: side.lineage,
        from: deviceIds(side),
        settings,
      };
    }
    return {
      kind: "create",
      path: entry,
      remoteHash: side.lineage.hash,
      lineage: side.lineage,
      from: deviceIds(side),
      settings,
    };
  };

  const newest = findNewest(ahead, others);
  if (newest) {
    if (newest.lineage.hash !== DRIVE_DELETED) return take(newest);
    // いちばん新しいのが「消えた」。手元に在っても消さない（設計書5.4.5）
    if (localHash !== undefined) {
      return { kind: "remote_deleted", path: entry, localHash, localChanged: false, from: deviceIds(newest) };
    }
    // 手元でも無い。知らないファイルなら何もしない。知っていれば「消えた」へ進める
    // （あとで誰かが書き直したとき、それを新しい中身として受け取れるように）
    if (local === undefined) return { kind: "none", path: entry, reason: "absent" };
    return { kind: "advance", path: entry, lineage: newest.lineage, settings };
  }

  // 「消えた」を除いて、いちばん新しい中身を探す。消えたことは手元に当てないので、
  // 消した端末と書き足した端末が分かれていれば、書き足した中身を受け取る
  const present = ahead.filter((group) => group.lineage.hash !== DRIVE_DELETED);
  const presentOthers =
    local === undefined ? present.map((g) => g.lineage) : [local, ...present.map((g) => g.lineage)];
  const newestPresent = findNewest(present, presentOthers);
  if (newestPresent) return take(newestPresent);

  if (present.length === 0) {
    // 相手は消しただけで、手元の中身は消した端末の知らないもの
    if (localHash === undefined) return { kind: "none", path: entry, reason: quietReason() };
    // 一度もそろえていないファイルは、向こうが消したものと同じとは言えない
    if (head === undefined) return { kind: "none", path: entry, reason: "local_only" };
    const deleted = ahead.flatMap(deviceIds);
    return { kind: "remote_deleted", path: entry, localHash, localChanged: true, from: deleted };
  }

  // 食い違い。ほかの相手の祖先に入っている中身は一覧から除く（同じ枝の古い側）
  const remotes = present.filter(
    (group) =>
      !present.some(
        (other) => other !== group && compareDriveLineage(group.lineage, other.lineage) === "newer"
      )
  );
  const localIsAncestor =
    local !== undefined &&
    remotes.every((group) => compareDriveLineage(local, group.lineage) === "newer");
  return {
    kind: "conflict",
    path: entry,
    localHash: localHash ?? null,
    local: local ?? null,
    remotes,
    localIsAncestor,
    settings,
  };
}

function unreadable(reason: string): DriveManifestRead {
  return { ok: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
