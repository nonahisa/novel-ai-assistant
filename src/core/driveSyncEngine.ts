import { isValidDeviceId } from "./device";
import {
  DRIVE_FOLDER_MIME,
  DriveApiError,
  compareDriveEntriesByAge,
  type DriveClient,
  type DriveFileEntry,
} from "./driveApi";
import {
  DRIVE_DELETED,
  buildDriveManifest,
  checkManifestArrival,
  isIgnoredSyncPath,
  isSafeSyncPath,
  isSendableSyncPath,
  joinDriveLineage,
  localDriveLineage,
  parseDriveManifest,
  planDriveReceive,
  planDriveSend,
  serializeDriveManifest,
  type DriveConflictSide,
  type DriveLineage,
  type DriveManifest,
  type DrivePeer,
  type DriveSyncDecision,
} from "./driveSyncPlan";
import { cloneDriveSyncRecord, type DriveSyncRecord } from "./driveSyncRecord";
import { hashBytes } from "./hash";
import {
  decideSettingsConflict,
  isSettingsJsonPath,
  type SettingsConflictDecision,
} from "./settingsConflictRule";

/**
 * Google ドライブで作品をそろえる「送る」「受け取る」の手順（設計書5.10。段階2、0.132.0。
 * 3台以上へ 0.133.0）。
 *
 * 計画（`driveSyncPlan.ts`）と Drive の口（`driveApi.ts`）をつなぐ。
 * **手元のファイルの読み書きも差し替えられる形**にした（`LocalWorkFiles`・
 * `LocalWorkWriter`）。core は原稿へ直に書かない——手元の原稿へ書く口は
 * 呼び手が `writeTextFilePreservingFormat`（既にある話）と `atomicWriteFile` の
 * `create`（新しい話）で作って渡す（設計書5.10.2）。モバイル版はそこだけ
 * 差し替えて同じ手順を使う。`vscode`・`node:` は読まない
 * （`driveSyncEngine.test.ts` が見張る）。
 *
 * ## ドライブの中の組み方（設計書5.10.3）
 *
 * ```
 * 統合小説執筆環境/<作品のフォルダー名>/<端末ID>/manifest.json
 *                                            /files/<作品フォルダーからの道>
 * ```
 *
 * - ファイルは `files/` の下に**道をそのまま名前にして平らに**置く
 *   （例：名前が「本文/第1話.txt」）。話ごとにフォルダーを掘ると、送るたびに
 *   フォルダーの数だけ一覧を読むことになる。目録（`manifest.json`）と同じ
 *   フォルダーに置かないのは、作品の根に `manifest.json` という話があると
 *   名前がぶつかるため。名前に「/」を使えるかは見立て（`driveApi.ts`）
 * - 作品のフォルダー名は**呼び手が決めて渡す**（`DriveSyncLayout.workFolderName`）。
 *   どの端末でも同じでなければならないが、今の作品の設定（`config.json`）には
 *   端末に共通の識別子が無い。誰がどう作るかは段階3で決める
 *
 * ## 相手は何台でもよい（設計書5.10.6）
 *
 * 作品のフォルダーの中の、自分以外の端末のフォルダー全部を相手にする。比べは
 * 中身の系譜でするので、相手の台数で規則は変わらない（`planDriveReceive`）。
 */

/** ドライブの根に作るフォルダーの名前（作者がドライブの画面で見る） */
export const DRIVE_ROOT_FOLDER_NAME = "統合小説執筆環境";
/** 端末のフォルダーの中の目録の名前 */
export const DRIVE_MANIFEST_NAME = "manifest.json";
/** 端末のフォルダーの中の、ファイルを置くフォルダーの名前 */
export const DRIVE_FILES_FOLDER_NAME = "files";

/** マイドライブの根（`'root' in parents`。見立て：`driveApi.ts`） */
const MY_DRIVE = "root";

export interface DriveSyncLayout {
  /** 作品のフォルダー名。どの端末でも同じもの */
  workFolderName: string;
  /** この端末のID（`core/device.ts`） */
  deviceId: string;
  /** この端末の名前（目録に載せる。画面に出す） */
  deviceName: string;
  /** 根のフォルダー名。既定 `DRIVE_ROOT_FOLDER_NAME` */
  rootFolderName?: string;
}

/** 手元の作品フォルダーを読む口 */
export interface LocalWorkFiles {
  /** 作品フォルダーからの道の一覧（区切りは「/」） */
  list(): Promise<string[]>;
  /** 中身の生のバイト。無ければ undefined。**ハッシュは生のバイトで取る**（復号した文字では取らない） */
  read(path: string): Promise<Uint8Array | undefined>;
}

export type LocalWriteOutcome =
  /** `writtenHash`：書いたあとのファイルの生のバイトのハッシュ */
  | { ok: true; writtenHash: string }
  /** 書かなかった（未保存の文書・競合マーカー・校閲中・期待ハッシュが合わない等） */
  | { ok: false; reason: string };

/**
 * 手元の作品フォルダーへ書く口。**書くのは呼び手**（設計書5.10.2）。
 *
 * - `replace`：既にあるファイルを向こうの中身へ。本文は `writeTextFilePreservingFormat`
 *   （`expectedHash` に `expectedLocalHash`）。未保存の文書・競合マーカー・
 *   編集部が校閲中の話は書かずに `ok: false`
 * - `create`：手元に無いファイルを置く（`atomicWriteFile` の `create`）
 *
 * **書けた中身は、向こうの中身とバイトまで同じでなければならない。**
 * 書く口が改行や文字コードを手元の形へ直すと、書けたもののハッシュが
 * 目録と違い、次に「手元で書いた」と読んで送り返す——端末の間で永久に
 * 往復する。そこで `writtenHash` が向こうのハッシュと違えば系譜を進めず、
 * 失敗に数える（受け取ったバイトの形をどう書くかは段階3の呼び手が決める）
 */
export interface LocalWorkWriter {
  replace(path: string, bytes: Uint8Array, expectedLocalHash: string): Promise<LocalWriteOutcome>;
  create(path: string, bytes: Uint8Array): Promise<LocalWriteOutcome>;
}

export type DriveSendResult =
  | {
      kind: "sent";
      manifest: DriveManifest;
      /** 書いた（新しく置いた・書き換えた）道 */
      uploaded: string[];
      /** 前の回と同じなので書かなかった数 */
      unchanged: number;
      /** 同じ名前のフォルダーが重なっていた数（2台が同時に初めて送ったとき） */
      duplicateFolders: number;
      /** 新しい控え（系譜の頭を送った中身へ進めたもの）。**呼び手が保存する** */
      record: DriveSyncRecord;
    }
  /**
   * 途中で止まった。**目録は書いていない**ので、向こうは「まだ届ききって
   * いません」と読む（書いたファイルは次の回で目録に載る）。控えは変えない
   */
  | { kind: "failed"; error: DriveApiError; uploaded: string[] }
  /** 前に送った自分の目録が読めない。直さずに止める */
  | { kind: "own_manifest_unreadable"; reason: string };

/**
 * 手元の作品を、この端末のフォルダーへ送る。変わったファイルだけを書き、
 * **最後に目録を書く**（設計書5.10.3）。目録には系譜を載せ（`planDriveSend`）、
 * 送れたら控えの系譜の頭を送った中身へ進める。
 */
export async function sendToDrive(input: {
  client: DriveClient;
  layout: DriveSyncLayout;
  local: LocalWorkFiles;
  record: DriveSyncRecord;
  ignoredPaths: readonly string[];
  now: Date;
}): Promise<DriveSendResult> {
  const { client, layout } = input;
  const uploaded: string[] = [];
  const isSendable = (entry: string) =>
    isSendableSyncPath(entry, { ownDeviceId: layout.deviceId, ignoredPaths: input.ignoredPaths });
  try {
    const root = await client.ensureFolder(MY_DRIVE, layout.rootFolderName ?? DRIVE_ROOT_FOLDER_NAME);
    const work = await client.ensureFolder(root.id, layout.workFolderName);
    const device = await client.ensureFolder(work.id, layout.deviceId);
    const files = await client.ensureFolder(device.id, DRIVE_FILES_FOLDER_NAME);
    const duplicateFolders = root.duplicates + work.duplicates + device.duplicates + files.duplicates;

    const manifestEntry = oldestFileNamed(await client.listChildren(device.id), DRIVE_MANIFEST_NAME);
    let previous: DriveManifest | undefined;
    if (manifestEntry) {
      const read = parseDriveManifest(decodeUtf8(await client.readFile(manifestEntry.id)));
      if (!read.ok) return { kind: "own_manifest_unreadable", reason: read.reason };
      if (read.manifest.deviceId !== layout.deviceId) {
        return { kind: "own_manifest_unreadable", reason: "ほかの端末の目録が置かれています" };
      }
      previous = read.manifest;
    }

    const remoteByName = byName(await client.listChildren(files.id));
    const paths = (await input.local.list()).filter(isSendable).sort();

    const sent = new Map<string, string>();
    const settingsTexts = new Map<string, string>();
    let unchanged = 0;
    for (const entry of paths) {
      const bytes = await input.local.read(entry);
      // 一覧のあとで消えた。目録には「消えた」で載る（控えに頭があれば）
      if (bytes === undefined) continue;
      const hash = hashBytes(bytes);
      sent.set(entry, hash);
      if (isSettingsJsonPath(entry)) settingsTexts.set(entry, decodeUtf8(bytes));
      const existing = remoteByName.get(entry);
      if (existing && (previous?.files.get(entry)?.hash === hash || existing.sha256Checksum === hash)) {
        unchanged += 1;
        continue;
      }
      if (existing) await client.updateFile(existing.id, bytes);
      else await client.createFile(files.id, entry, bytes);
      uploaded.push(entry);
    }

    const lineages = planDriveSend({
      lineage: input.record.lineage,
      local: sent,
      previous,
      isSendable,
    });
    const round = Math.max(input.record.lastRound, previous?.round ?? 0) + 1;
    const manifest = buildDriveManifest({
      deviceId: layout.deviceId,
      deviceName: layout.deviceName,
      round,
      sentAt: input.now.toISOString(),
      files: lineages,
    });
    const manifestBytes = new TextEncoder().encode(serializeDriveManifest(manifest));
    if (manifestEntry) await client.updateFile(manifestEntry.id, manifestBytes);
    else await client.createFile(device.id, DRIVE_MANIFEST_NAME, manifestBytes, "application/json");

    // 目録まで書けたので、送った中身を系譜の頭にする。相手がこれを送り返してきても、
    // 相手の中身はこちらの祖先（または同じ）なので食い違いにならない
    const record = cloneDriveSyncRecord(input.record);
    record.lastRound = round;
    for (const [entry, lineage] of lineages) {
      setHead(record, entry, lineage, settingsTexts.get(entry));
    }
    return { kind: "sent", manifest, uploaded, unchanged, duplicateFolders, record };
  } catch (error) {
    if (error instanceof DriveApiError) return { kind: "failed", error, uploaded };
    throw error;
  }
}

/** 食い違いの相手1件と、その中身（目録のハッシュと合うことを確かめたもの） */
export interface DriveConflictRemote extends DriveConflictSide {
  bytes: Uint8Array;
}

/** 食い違い1件と、見比べに要る中身 */
export interface DriveConflictReport {
  decision: Extract<DriveSyncDecision, { kind: "conflict" }>;
  /** 手元の中身（手元で消していれば undefined） */
  localBytes: Uint8Array | undefined;
  /** 食い違いの相手の一覧（端末と中身）。**どう選ばせるかは呼び手が決める** */
  remotes: DriveConflictRemote[];
  /** `remotes[0]` の中身（相手が1台のときの見比べに） */
  remoteBytes: Uint8Array;
  /** 設定資料で `decideSettingsConflict` が決めなかった理由 */
  settingsReason?: string;
}

/** 届ききっていない相手（その相手の分だけ受け取りを見送った） */
export interface DriveNotArrived {
  peerDeviceId: string;
  missing: string[];
  mismatched: string[];
}

export type DriveReceiveResult =
  /** まだどの相手も一度も送っていない */
  | { kind: "nothing_yet" }
  /** 相手の目録が1つでも読めない。直さずに止める（何も書いていない） */
  | { kind: "unreadable"; peerDeviceId: string; reason: string }
  /**
   * どの相手もまだ届ききっていません。**何も書いていない**。
   * 先頭の相手の分を `peerDeviceId` 以下に、全部を `waiting` に
   */
  | ({ kind: "not_arrived"; waiting: DriveNotArrived[] } & DriveNotArrived)
  /** ドライブを読む前・計画の前に止まった。何も書いていない */
  | { kind: "failed"; error: DriveApiError }
  | {
      kind: "received";
      /** 比べに使った相手（届ききったもの） */
      peers: DrivePeer[];
      /** 届ききっていないので見送った相手。次の受け取りで比べる */
      waiting: DriveNotArrived[];
      /** 手元へ書いた道（受け取った・新しく置いた・設定資料を合わせた） */
      written: string[];
      /** 中身は書かず系譜だけ進めた道 */
      advanced: string[];
      /** 設定資料で `decideSettingsConflict` が決めたもの */
      settingsDecided: { path: string; side: "ours" | "theirs" | "merged"; reason: string }[];
      /** 食い違い。**機械は選ばない**——作者に見比べてもらう */
      conflicts: DriveConflictReport[];
      /** 向こうで消えた（手元では消さない。知らせるだけ） */
      remoteDeleted: { path: string; localChanged: boolean; from: string[] }[];
      /** 書けなかったもの（この道の系譜は進めていない） */
      failures: { path: string; reason: string }[];
      /** ドライブの失敗で途中から先をやめた（やめる前に書いた分の系譜は `record` に入っている） */
      stoppedBy?: DriveApiError;
      /** 新しい控え。**呼び手が保存する**（途中で止まっても保存する） */
      record: DriveSyncRecord;
    };

/** 読み込んだ相手1台（届いたかを確かめる前） */
interface LoadedPeer extends DrivePeer {
  filesByPath: Map<string, DriveFileEntry>;
  /** 中身を読んだもの（届いたかを確かめるために読んだ分も） */
  cache: Map<string, Uint8Array>;
}

/**
 * 相手の端末のフォルダー全部から受け取る（設計書5.10.6）。
 *
 * 相手ごとに、目録のハッシュと実際の中身が全部合うかを確かめ、**合わない相手は
 * 見送る**（`waiting`。ほかの相手の分は進める——送る途中で止まった端末が
 * 長く戻らないと、ほかの全部の受け取りが止まるため）。目録が読めない相手が
 * 1つでもあれば、何も書かずに止める。合った相手全部と系譜で比べ、1件ずつ書く。
 * **1件の失敗で全体を止めない**——書けた道だけ系譜を進め、書けなかった道は
 * 失敗に数える。
 */
export async function receiveFromDrive(input: {
  client: DriveClient;
  layout: DriveSyncLayout;
  local: LocalWorkFiles;
  writer: LocalWorkWriter;
  record: DriveSyncRecord;
  ignoredPaths: readonly string[];
}): Promise<DriveReceiveResult> {
  const { client, layout } = input;

  const arrived: LoadedPeer[] = [];
  const waiting: DriveNotArrived[] = [];
  try {
    const roots = await client.findFolders(MY_DRIVE, layout.rootFolderName ?? DRIVE_ROOT_FOLDER_NAME);
    if (roots.length === 0) return { kind: "nothing_yet" };
    const works = await client.findFolders(roots[0].id, layout.workFolderName);
    if (works.length === 0) return { kind: "nothing_yet" };

    const peerFolders = oldestByName(
      (await client.listChildren(works[0].id)).filter(
        (entry) =>
          entry.mimeType === DRIVE_FOLDER_MIME &&
          isValidDeviceId(entry.name) &&
          entry.name !== layout.deviceId
      )
    );
    for (const peerDeviceId of [...peerFolders.keys()].sort()) {
      const peerFolder = peerFolders.get(peerDeviceId) as DriveFileEntry;
      const peerChildren = await client.listChildren(peerFolder.id);
      const manifestEntry = oldestFileNamed(peerChildren, DRIVE_MANIFEST_NAME);
      // フォルダーだけ作って目録をまだ書いていない端末（初めて送る途中）
      if (!manifestEntry) continue;
      const read = parseDriveManifest(decodeUtf8(await client.readFile(manifestEntry.id)));
      if (!read.ok) return { kind: "unreadable", peerDeviceId, reason: read.reason };
      if (read.manifest.deviceId !== peerDeviceId) {
        return { kind: "unreadable", peerDeviceId, reason: "目録の端末IDがフォルダーの名前と違います" };
      }

      const filesFolder = oldestByName(
        peerChildren.filter((entry) => entry.mimeType === DRIVE_FOLDER_MIME)
      ).get(DRIVE_FILES_FOLDER_NAME);
      const remoteByName = filesFolder ? byName(await client.listChildren(filesFolder.id)) : new Map<string, DriveFileEntry>();

      // 届ききったか：ドライブが申告するハッシュが目録と合えば読まずに済ませ、
      // 合わない・無いものは中身を読んで確かめる（申告の表記は見立てなので、
      // 合わなくても「違う」とは決めない）
      const actual = new Map<string, string>();
      const filesByPath = new Map<string, DriveFileEntry>();
      const cache = new Map<string, Uint8Array>();
      for (const [entry, lineage] of read.manifest.files) {
        if (lineage.hash === DRIVE_DELETED) continue;
        const remote = remoteByName.get(entry);
        if (!remote) continue;
        filesByPath.set(entry, remote);
        if (remote.sha256Checksum?.toLowerCase() === lineage.hash) {
          actual.set(entry, lineage.hash);
          continue;
        }
        const bytes = await client.readFile(remote.id);
        cache.set(entry, bytes);
        actual.set(entry, hashBytes(bytes));
      }
      const arrival = checkManifestArrival(read.manifest, actual);
      if (!arrival.arrived) {
        waiting.push({ peerDeviceId, missing: arrival.missing, mismatched: arrival.mismatched });
        continue;
      }
      arrived.push({
        deviceId: peerDeviceId,
        deviceName: read.manifest.deviceName,
        manifest: read.manifest,
        filesByPath,
        cache,
      });
    }
  } catch (error) {
    if (error instanceof DriveApiError) return { kind: "failed", error };
    throw error;
  }
  if (arrived.length === 0) {
    if (waiting.length === 0) return { kind: "nothing_yet" };
    return { kind: "not_arrived", ...waiting[0], waiting };
  }

  const localBytes = new Map<string, Uint8Array>();
  const localHashes = new Map<string, string>();
  for (const entry of await input.local.list()) {
    // 送らないもの（キャッシュ等）は計画でも外すので、読まずに済ませる（規則4）
    if (!isSafeSyncPath(entry) || isIgnoredSyncPath(entry, input.ignoredPaths)) continue;
    const bytes = await input.local.read(entry);
    if (bytes === undefined) continue;
    localBytes.set(entry, bytes);
    localHashes.set(entry, hashBytes(bytes));
  }

  const decisions = planDriveReceive({
    lineage: input.record.lineage,
    local: localHashes,
    peers: arrived,
    ignoredPaths: input.ignoredPaths,
    ownDeviceId: layout.deviceId,
  });

  const record = cloneDriveSyncRecord(input.record);
  const result: Extract<DriveReceiveResult, { kind: "received" }> = {
    kind: "received",
    peers: arrived.map(({ deviceId, deviceName, manifest }) => ({ deviceId, deviceName, manifest })),
    waiting,
    written: [],
    advanced: [],
    settingsDecided: [],
    conflicts: [],
    remoteDeleted: [],
    failures: [],
    record,
  };

  /**
   * 向こうの中身。**書く前に目録のハッシュと合うことを確かめる**——届ききったかを
   * 申告のハッシュで済ませた道は、ここで初めて中身を読む。同じ中身を持つ端末が
   * いくつかあれば、先頭から読む
   */
  const remoteBytesOf = async (
    from: readonly string[],
    entry: string,
    expected: string
  ): Promise<Uint8Array | undefined> => {
    for (const deviceId of from) {
      const peer = arrived.find((item) => item.deviceId === deviceId);
      if (!peer) continue;
      let bytes = peer.cache.get(entry);
      if (!bytes) {
        const remote = peer.filesByPath.get(entry);
        if (!remote) continue;
        bytes = await client.readFile(remote.id);
        peer.cache.set(entry, bytes);
      }
      if (hashBytes(bytes) === expected) return bytes;
    }
    return undefined;
  };
  const idsOf = (side: DriveConflictSide) => side.devices.map((device) => device.deviceId);

  const notMatching = "向こうの中身が目録と合いません（まだ書いている途中かもしれません）";

  for (const decision of decisions) {
    try {
      switch (decision.kind) {
        case "none":
          break;
        case "remote_deleted":
          result.remoteDeleted.push({
            path: decision.path,
            localChanged: decision.localChanged,
            from: decision.from,
          });
          break;
        case "advance": {
          // 中身は手元と同じ（または両方で消えた）。設定資料の控えは手元の中身で
          const bytes = localBytes.get(decision.path);
          const text =
            decision.settings && decision.lineage.hash !== DRIVE_DELETED && bytes !== undefined
              ? decodeUtf8(bytes)
              : undefined;
          setHead(record, decision.path, decision.lineage, text);
          result.advanced.push(decision.path);
          break;
        }
        case "receive":
        case "create": {
          const bytes = await remoteBytesOf(decision.from, decision.path, decision.remoteHash);
          if (bytes === undefined) {
            result.failures.push({ path: decision.path, reason: notMatching });
            break;
          }
          const outcome =
            decision.kind === "receive"
              ? await input.writer.replace(decision.path, bytes, decision.expectedLocalHash)
              : await input.writer.create(decision.path, bytes);
          if (!recordWrite(result, decision.path, outcome, decision.remoteHash)) break;
          setHead(record, decision.path, decision.lineage, decision.settings ? decodeUtf8(bytes) : undefined);
          break;
        }
        case "conflict": {
          const remotes: DriveConflictRemote[] = [];
          for (const side of decision.remotes) {
            const bytes = await remoteBytesOf(idsOf(side), decision.path, side.lineage.hash);
            if (bytes === undefined) break;
            remotes.push({ ...side, bytes });
          }
          if (remotes.length !== decision.remotes.length) {
            result.failures.push({ path: decision.path, reason: notMatching });
            break;
          }
          const ours = localBytes.get(decision.path);
          // 設定資料は、相手が1つのときだけ項目ごとに合わせる（3つ以上を一度に
          // 合わせる規則は無い。作者に見比べてもらう）
          if (
            decision.settings &&
            remotes.length === 1 &&
            ours !== undefined &&
            decision.localHash !== null &&
            decision.local !== null
          ) {
            const base = commonSettingsBase(record, decision.path, decision.local, remotes[0].lineage);
            const decided = decideSettingsConflict({
              base,
              ours: decodeUtf8(ours),
              theirs: decodeUtf8(remotes[0].bytes),
            });
            if (decided.side !== "conflict") {
              await applySettingsDecision(result, input.writer, {
                path: decision.path,
                local: decision.local,
                localHash: decision.localHash,
                localText: decodeUtf8(ours),
                remote: remotes[0],
                decided,
              });
              break;
            }
            result.conflicts.push({
              decision,
              localBytes: ours,
              remotes,
              remoteBytes: remotes[0].bytes,
              settingsReason: decided.reason,
            });
            break;
          }
          result.conflicts.push({ decision, localBytes: ours, remotes, remoteBytes: remotes[0].bytes });
          break;
        }
      }
    } catch (error) {
      // ドライブの失敗はその先も続く見込みが高い（ネットが切れた等）。ここまでの
      // 系譜を残して止める。手元の書き込みの例外は呼び手の不具合なので投げ直す
      if (error instanceof DriveApiError) {
        result.stoppedBy = error;
        break;
      }
      throw error;
    }
  }
  return result;
}

/**
 * 設定資料の食い違いの base（共通の祖先の中身）。控えにある頭の中身が、
 * 手元の系譜にも相手の祖先にも入っているときだけ使う——そうでなければ
 * 共通の祖先だと言えず、それを base に合わせると混ぜ方を誤る
 */
function commonSettingsBase(
  record: DriveSyncRecord,
  entry: string,
  local: DriveLineage,
  remote: DriveLineage
): string | undefined {
  const stored = record.settingsBases.get(entry);
  if (stored === undefined) return undefined;
  const hash = hashBytes(new TextEncoder().encode(stored));
  const inLocal = local.hash === hash || local.ancestors.includes(hash);
  return inLocal && remote.ancestors.includes(hash) ? stored : undefined;
}

/** 作者が食い違いで選んだもの（今の「残す文を選ぶ」と同じ3つ。設計書5.10.4） */
export type DriveConflictChoice = "local" | "remote" | "both";

/**
 * 作者が食い違いを選んだあとの処理（合流。設計書5.10.6）。
 *
 * **1回に比べるのは手元と相手1つ**（`peerDeviceId` で選ぶ。相手が1つなら省ける）。
 * 選んだ結果の系譜に、退けた側の中身も祖先として入れる（`joinDriveLineage`）。
 * 次に送るとほかの端末へ届き、同じ食い違いを2度訊かない。相手が2つ以上
 * 食い違っていれば、1つ選んだあと**受け取り直す**と、残りとの食い違いが
 * 新しい報告として出る（古い報告で続けて選ぶと断る）。
 *
 * - `local`（手元を残す）：手元は書かない
 * - `remote`（相手を残す）：相手の中身を書く
 * - `both`（両方とも残す）：相手の中身を `sidePath`（`sideFileName` で作った
 *   別の名前）へ新しく置き、手元はそのまま
 */
export async function applyDriveConflictChoice(input: {
  report: DriveConflictReport;
  choice: DriveConflictChoice;
  record: DriveSyncRecord;
  writer: LocalWorkWriter;
  sidePath?: string;
  peerDeviceId?: string;
}): Promise<{ ok: true; record: DriveSyncRecord } | { ok: false; reason: string }> {
  const { decision } = input.report;
  const remote =
    input.peerDeviceId === undefined
      ? input.report.remotes.length === 1
        ? input.report.remotes[0]
        : undefined
      : input.report.remotes.find((side) =>
          side.devices.some((device) => device.deviceId === input.peerDeviceId)
        );
  if (!remote) return { ok: false, reason: "どの端末の中身と比べたのかが分かりません" };

  // 報告のあとで控えが変わっていれば（同じ報告でもう選んだ等）、古い報告では選ばない。
  // 報告の系譜は、同じ中身の相手の祖先を足したもの（`planDriveReceive`）なので
  // 控えと同じとは限らない。選ぶと `gen` が報告より大きくなるので、それで見分ける
  const current = localDriveLineage(input.record.lineage.get(decision.path), decision.localHash ?? undefined);
  if (!stillCurrent(current, decision.local)) {
    return { ok: false, reason: "前の選択のあとで控えが変わっています。受け取り直してください" };
  }
  const local = decision.local;
  const record = cloneDriveSyncRecord(input.record);
  const remoteText = decision.settings ? decodeUtf8(remote.bytes) : undefined;

  if (input.choice === "remote") {
    const outcome =
      decision.localHash === null
        ? await input.writer.create(decision.path, remote.bytes)
        : await input.writer.replace(decision.path, remote.bytes, decision.localHash);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    if (outcome.writtenHash !== remote.lineage.hash) {
      return { ok: false, reason: "書いた中身が向こうの中身と合いません" };
    }
    setHead(record, decision.path, joinDriveLineage(remote.lineage, local ? [local] : []), remoteText);
    return { ok: true, record };
  }

  // 手元を残す。手元がこのファイルを知らない（相手どうしだけの食い違いで、手元に
  // 一度も無い）ときは、残す中身が無い
  if (!local) return { ok: false, reason: "このパソコンにはこのファイルがありません" };
  if (input.choice === "both") {
    if (!input.sidePath || !isSafeSyncPath(input.sidePath)) {
      return { ok: false, reason: "両方とも残すための別の名前がありません" };
    }
    const outcome = await input.writer.create(input.sidePath, remote.bytes);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
  }
  const localText =
    decision.settings && input.report.localBytes !== undefined ? decodeUtf8(input.report.localBytes) : undefined;
  setHead(record, decision.path, joinDriveLineage(local, [remote.lineage]), localText);
  return { ok: true, record };
}

/** 設定資料を `decideSettingsConflict` の決めたとおりにする（相手が1つのとき） */
async function applySettingsDecision(
  result: Extract<DriveReceiveResult, { kind: "received" }>,
  writer: LocalWorkWriter,
  input: {
    path: string;
    local: DriveLineage;
    localHash: string;
    localText: string;
    remote: DriveConflictRemote;
    decided: Exclude<SettingsConflictDecision, { side: "conflict" }>;
  }
): Promise<void> {
  const { path: entry, local, remote, decided } = input;
  if (decided.side === "theirs") {
    const outcome = await writer.replace(entry, remote.bytes, input.localHash);
    if (!recordWrite(result, entry, outcome, remote.lineage.hash)) return;
    setHead(result.record, entry, joinDriveLineage(remote.lineage, [local]), decodeUtf8(remote.bytes));
  } else if (decided.side === "merged") {
    const outcome = await writer.replace(entry, new TextEncoder().encode(decided.text), input.localHash);
    if (!outcome.ok) {
      result.failures.push({ path: entry, reason: outcome.reason });
      return;
    }
    result.written.push(entry);
    // 合わせた中身は手元とも向こうとも違う新しい中身。両方を祖先に持たせる。
    // 系譜の頭は実際に書けた中身のハッシュにする（次に送るのはそれなので）
    setHead(result.record, entry, joinDriveLineage(local, [remote.lineage], outcome.writtenHash), decided.text);
  } else {
    // こちらを残した。書かずに、相手の中身を祖先へ入れる
    setHead(result.record, entry, joinDriveLineage(local, [remote.lineage]), input.localText);
  }
  result.settingsDecided.push({ path: entry, side: decided.side, reason: decided.reason });
}

/** 書いた結果を数える。系譜を進めてよければ true */
function recordWrite(
  result: Extract<DriveReceiveResult, { kind: "received" }>,
  entry: string,
  outcome: LocalWriteOutcome,
  remoteHash: string
): boolean {
  if (!outcome.ok) {
    result.failures.push({ path: entry, reason: outcome.reason });
    return false;
  }
  result.written.push(entry);
  if (outcome.writtenHash !== remoteHash) {
    // 書く口が中身の形を変えた。系譜を進めると端末の間で永久に往復する（`LocalWorkWriter` の説明）
    result.failures.push({
      path: entry,
      reason: "書いた中身が向こうの中身とバイトで合いません（系譜は進めていません）",
    });
    return false;
  }
  return true;
}

/** 系譜の頭を置く。設定資料の控えは中身があれば置き、無ければ外す */
function setHead(
  record: DriveSyncRecord,
  entry: string,
  lineage: DriveLineage,
  settingsText: string | undefined
): void {
  record.lineage.set(entry, lineage);
  if (settingsText !== undefined && lineage.hash !== DRIVE_DELETED) record.settingsBases.set(entry, settingsText);
  else record.settingsBases.delete(entry);
}

/** 控えの今（`current`）が、報告を作ったときの手元（`reported`）から進んでいないか */
function stillCurrent(current: DriveLineage | undefined, reported: DriveLineage | null): boolean {
  if (current === undefined || reported === null) return current === undefined && reported === null;
  return current.hash === reported.hash && current.gen <= reported.gen;
}

/** 同じ名前が重なっていれば古いものを採る（どの端末も同じものを選ぶように） */
function oldestByName(entries: DriveFileEntry[]): Map<string, DriveFileEntry> {
  const out = new Map<string, DriveFileEntry>();
  for (const entry of [...entries].sort(compareDriveEntriesByAge)) {
    if (!out.has(entry.name)) out.set(entry.name, entry);
  }
  return out;
}

function byName(entries: DriveFileEntry[]): Map<string, DriveFileEntry> {
  return oldestByName(
    entries.filter((entry) => entry.mimeType !== DRIVE_FOLDER_MIME)
  );
}

function oldestFileNamed(entries: DriveFileEntry[], name: string): DriveFileEntry | undefined {
  return byName(entries).get(name);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}
