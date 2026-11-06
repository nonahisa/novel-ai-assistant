import { isValidDeviceId } from "./device";
import {
  DRIVE_FOLDER_MIME,
  DriveApiError,
  compareDriveEntriesByAge,
  type DriveClient,
  type DriveFileEntry,
} from "./driveApi";
import {
  buildDriveManifest,
  isIgnoredSyncPath,
  isSafeSyncPath,
  isSendableSyncPath,
  parseDriveManifest,
  planDriveReceiveChecked,
  serializeDriveManifest,
  type DriveManifest,
  type DriveSyncDecision,
} from "./driveSyncPlan";
import { cloneDriveSyncRecord, type DriveSyncRecord } from "./driveSyncRecord";
import { hashBytes } from "./hash";
import { decideSettingsConflict, type SettingsConflictDecision } from "./settingsConflictRule";

/**
 * Google ドライブで2台をそろえる「送る」「受け取る」の手順（設計書5.10。段階2、0.132.0）。
 *
 * 段階1の計画（`driveSyncPlan.ts`）と Drive の口（`driveApi.ts`）をつなぐ。
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
 *   2台で同じでなければならないが、今の作品の設定（`config.json`）には
 *   2台で共通の識別子が無い。誰がどう作るかは段階3で決める
 *
 * ## 2台より多いとき
 *
 * 作者が決めた使い道は2台（5.10.1）。印は道ごとに1つなので、3台目の目録を
 * 同じ印で比べると基準が混ざる。**向こうの端末のフォルダーが2つ以上あれば
 * 何もしない**（`several_peers`）で返す。
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
  /** 作品のフォルダー名。2台で同じもの */
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
 * 目録と違い、次に「手元が変わった」と読んで送り返す——2台で永久に
 * 往復する。そこで `writtenHash` が向こうのハッシュと違えば印を進めず、
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
      /** 新しい控え。**呼び手が保存する** */
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
 * **最後に目録を書く**（設計書5.10.3）。
 *
 * @param input.peerManifest 最後に受け取った向こうの目録（**届ききったもの**）。
 *   選び終えた食い違いの持ち越しを外すのに使う（`buildDriveManifest`）
 */
export async function sendToDrive(input: {
  client: DriveClient;
  layout: DriveSyncLayout;
  local: LocalWorkFiles;
  record: DriveSyncRecord;
  ignoredPaths: readonly string[];
  now: Date;
  peerManifest?: DriveManifest;
}): Promise<DriveSendResult> {
  const { client, layout } = input;
  const uploaded: string[] = [];
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
    const paths = (await input.local.list())
      .filter((entry) =>
        isSendableSyncPath(entry, { ownDeviceId: layout.deviceId, ignoredPaths: input.ignoredPaths })
      )
      .sort();

    const sent = new Map<string, string>();
    let unchanged = 0;
    for (const entry of paths) {
      const bytes = await input.local.read(entry);
      // 一覧のあとで消えた。目録に載せない（次の回で「消えた」になる）
      if (bytes === undefined) continue;
      const hash = hashBytes(bytes);
      sent.set(entry, hash);
      const existing = remoteByName.get(entry);
      if (existing && (previous?.files.get(entry) === hash || existing.sha256Checksum === hash)) {
        unchanged += 1;
        continue;
      }
      if (existing) await client.updateFile(existing.id, bytes);
      else await client.createFile(files.id, entry, bytes);
      uploaded.push(entry);
    }

    const round = Math.max(input.record.lastRound, previous?.round ?? 0) + 1;
    const manifest = buildDriveManifest({
      deviceId: layout.deviceId,
      deviceName: layout.deviceName,
      round,
      sentAt: input.now.toISOString(),
      files: sent,
      previous,
      resolvedConflicts: input.record.pendingResolutions,
      peerManifest: input.peerManifest,
      marks: input.record.marks,
    });
    const manifestBytes = new TextEncoder().encode(serializeDriveManifest(manifest));
    if (manifestEntry) await client.updateFile(manifestEntry.id, manifestBytes);
    else await client.createFile(device.id, DRIVE_MANIFEST_NAME, manifestBytes, "application/json");

    const record = cloneDriveSyncRecord(input.record);
    record.lastRound = round;
    record.pendingResolutions.clear();
    for (const [entry, hash] of sent) {
      if (record.marks.get(entry) === hash) continue;
      const list = record.sentSinceMark.get(entry) ?? [];
      if (!list.includes(hash)) list.push(hash);
      record.sentSinceMark.set(entry, list);
    }
    return { kind: "sent", manifest, uploaded, unchanged, duplicateFolders, record };
  } catch (error) {
    if (error instanceof DriveApiError) return { kind: "failed", error, uploaded };
    throw error;
  }
}

/** 食い違い1件と、見比べに要る両側の中身 */
export interface DriveConflictReport {
  decision: Extract<DriveSyncDecision, { kind: "conflict" }>;
  /** 手元の中身（手元で消していれば undefined） */
  localBytes: Uint8Array | undefined;
  /** 向こうの中身（目録のハッシュと合うことを確かめたもの） */
  remoteBytes: Uint8Array;
  /** 設定資料で `decideSettingsConflict` が決めなかった理由 */
  settingsReason?: string;
}

export type DriveReceiveResult =
  /** まだ向こうが一度も送っていない */
  | { kind: "nothing_yet" }
  /** 向こうの端末が2つ以上ある。何もしない（このファイルの説明） */
  | { kind: "several_peers"; deviceIds: string[] }
  /** 向こうの目録が読めない。直さずに止める */
  | { kind: "unreadable"; peerDeviceId: string; reason: string }
  /** まだ届ききっていません。**何も書いていない** */
  | { kind: "not_arrived"; peerDeviceId: string; missing: string[]; mismatched: string[] }
  /** ドライブを読む前・計画の前に止まった。何も書いていない */
  | { kind: "failed"; error: DriveApiError }
  | {
      kind: "received";
      peerDeviceId: string;
      /** 届ききった向こうの目録。次に送るとき `peerManifest` に渡す */
      peerManifest: DriveManifest;
      /** 手元へ書いた道（受け取った・新しく置いた・設定資料を合わせた） */
      written: string[];
      /** 中身は書かず印だけ進めた道 */
      advanced: string[];
      /** 設定資料で `decideSettingsConflict` が決めたもの */
      settingsDecided: { path: string; side: "ours" | "theirs" | "merged"; reason: string }[];
      /** 食い違い。**機械は選ばない**——作者に見比べてもらう */
      conflicts: DriveConflictReport[];
      /** 向こうで消えた（手元では消さない。知らせるだけ） */
      remoteDeleted: { path: string; localChanged: boolean }[];
      /** 書けなかったもの（この道の印は進めていない） */
      failures: { path: string; reason: string }[];
      /** ドライブの失敗で途中から先をやめた（やめる前に書いた分の印は `record` に入っている） */
      stoppedBy?: DriveApiError;
      /** 新しい控え。**呼び手が保存する**（途中で止まっても保存する） */
      record: DriveSyncRecord;
    };

/**
 * 向こうの端末のフォルダーから受け取る（設計書5.10.4）。
 *
 * 目録のハッシュと実際の中身が全部合うまで何も書かない。合えば3点比較の
 * 計画に従い、1件ずつ書く。**1件の失敗で全体を止めない**——書けた道だけ
 * 印を進め、書けなかった道は失敗に数える。
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

  let peer: { deviceId: string; manifest: DriveManifest; filesById: Map<string, DriveFileEntry> };
  const cache = new Map<string, Uint8Array>();
  let actual: Map<string, string>;
  try {
    const roots = await client.findFolders(MY_DRIVE, layout.rootFolderName ?? DRIVE_ROOT_FOLDER_NAME);
    if (roots.length === 0) return { kind: "nothing_yet" };
    const works = await client.findFolders(roots[0].id, layout.workFolderName);
    if (works.length === 0) return { kind: "nothing_yet" };

    const peers = oldestByName(
      (await client.listChildren(works[0].id)).filter(
        (entry) =>
          entry.mimeType === DRIVE_FOLDER_MIME &&
          isValidDeviceId(entry.name) &&
          entry.name !== layout.deviceId
      )
    );
    if (peers.size === 0) return { kind: "nothing_yet" };
    if (peers.size > 1) return { kind: "several_peers", deviceIds: [...peers.keys()].sort() };
    const [peerDeviceId, peerFolder] = [...peers][0];

    const peerChildren = await client.listChildren(peerFolder.id);
    const manifestEntry = oldestFileNamed(peerChildren, DRIVE_MANIFEST_NAME);
    if (!manifestEntry) return { kind: "nothing_yet" };
    const read = parseDriveManifest(decodeUtf8(await client.readFile(manifestEntry.id)));
    if (!read.ok) return { kind: "unreadable", peerDeviceId, reason: read.reason };
    if (read.manifest.deviceId !== peerDeviceId) {
      return { kind: "unreadable", peerDeviceId, reason: "目録の端末IDがフォルダーの名前と違います" };
    }

    const filesFolder = oldestByName(
      peerChildren.filter((entry) => entry.mimeType === DRIVE_FOLDER_MIME)
    ).get(DRIVE_FILES_FOLDER_NAME);
    const remoteByName = filesFolder ? byName(await client.listChildren(filesFolder.id)) : new Map();

    // 届ききったか：ドライブが申告するハッシュが目録と合えば読まずに済ませ、
    // 合わない・無いものは中身を読んで確かめる（申告の表記は見立てなので、
    // 合わなくても「違う」とは決めない）
    actual = new Map<string, string>();
    const filesById = new Map<string, DriveFileEntry>();
    for (const [entry, hash] of read.manifest.files) {
      const remote = remoteByName.get(entry);
      if (!remote) continue;
      filesById.set(entry, remote);
      if (remote.sha256Checksum?.toLowerCase() === hash) {
        actual.set(entry, hash);
        continue;
      }
      const bytes = await client.readFile(remote.id);
      cache.set(entry, bytes);
      actual.set(entry, hashBytes(bytes));
    }
    peer = { deviceId: peerDeviceId, manifest: read.manifest, filesById };
  } catch (error) {
    if (error instanceof DriveApiError) return { kind: "failed", error };
    throw error;
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

  const plan = planDriveReceiveChecked({
    marks: input.record.marks,
    local: localHashes,
    manifest: peer.manifest,
    actualRemoteHashes: actual,
    ignoredPaths: input.ignoredPaths,
    ownDeviceId: layout.deviceId,
    consumedResolutions: input.record.consumedResolutions.get(peer.deviceId),
    ownSent: input.record.sentSinceMark,
  });
  if (plan.kind === "not_arrived") {
    return {
      kind: "not_arrived",
      peerDeviceId: peer.deviceId,
      missing: plan.missing,
      mismatched: plan.mismatched,
    };
  }

  const record = cloneDriveSyncRecord(input.record);
  const result: Extract<DriveReceiveResult, { kind: "received" }> = {
    kind: "received",
    peerDeviceId: peer.deviceId,
    peerManifest: peer.manifest,
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
   * 申告のハッシュで済ませた道は、ここで初めて中身を読む
   */
  const remoteBytesOf = async (entry: string, expected: string): Promise<Uint8Array | undefined> => {
    let bytes = cache.get(entry);
    if (!bytes) {
      const remote = peer.filesById.get(entry);
      if (!remote) return undefined;
      bytes = await client.readFile(remote.id);
      cache.set(entry, bytes);
    }
    return hashBytes(bytes) === expected ? bytes : undefined;
  };

  const notMatching = "向こうの中身が目録と合いません（まだ書いている途中かもしれません）";

  for (const decision of plan.decisions) {
    try {
      switch (decision.kind) {
        case "none":
          break;
        case "remote_deleted":
          result.remoteDeleted.push({ path: decision.path, localChanged: decision.localChanged });
          break;
        case "advance": {
          let baseText: string | undefined;
          if (decision.settings && decision.hash !== null) {
            const bytes =
              localHashes.get(decision.path) === decision.hash
                ? localBytes.get(decision.path)
                : await remoteBytesOf(decision.path, decision.hash);
            if (bytes === undefined) {
              result.failures.push({ path: decision.path, reason: notMatching });
              break;
            }
            baseText = decodeUtf8(bytes);
          }
          setMark(record, decision.path, decision.hash, baseText);
          result.advanced.push(decision.path);
          break;
        }
        case "receive":
        case "create": {
          const bytes = await remoteBytesOf(decision.path, decision.remoteHash);
          if (bytes === undefined) {
            result.failures.push({ path: decision.path, reason: notMatching });
            break;
          }
          const outcome =
            decision.kind === "receive"
              ? await input.writer.replace(decision.path, bytes, decision.expectedLocalHash)
              : await input.writer.create(decision.path, bytes);
          if (!recordWrite(result, decision.path, outcome, decision.remoteHash)) break;
          setMark(record, decision.path, decision.remoteHash, decision.settings ? decodeUtf8(bytes) : undefined);
          if (decision.kind === "receive" && decision.viaResolution && decision.resolutionRound !== undefined) {
            const rounds = record.consumedResolutions.get(peer.deviceId) ?? new Map<string, number>();
            rounds.set(decision.path, decision.resolutionRound);
            record.consumedResolutions.set(peer.deviceId, rounds);
          }
          break;
        }
        case "conflict": {
          const remoteBytes = await remoteBytesOf(decision.path, decision.remoteHash);
          if (remoteBytes === undefined) {
            result.failures.push({ path: decision.path, reason: notMatching });
            break;
          }
          const ours = localBytes.get(decision.path);
          if (decision.settings && ours !== undefined && decision.localHash !== null) {
            // 控えの中身が、計画が比べた祖先（`markHash`）と同じものの時だけ使う。
            // 祖先が向こうの印へ比べ直されたとき（`planDriveReceive`）、控えは
            // こちらの古い印の中身なので、それを祖先として合わせると混ぜ方を誤る
            const stored = record.settingsBases.get(decision.path);
            const base =
              stored !== undefined &&
              decision.markHash !== null &&
              hashBytes(new TextEncoder().encode(stored)) === decision.markHash
                ? stored
                : undefined;
            const decided = decideSettingsConflict({
              base,
              ours: decodeUtf8(ours),
              theirs: decodeUtf8(remoteBytes),
            });
            if (decided.side !== "conflict") {
              await applySettingsDecision(result, input.writer, {
                decision,
                decided,
                remoteBytes,
                localHash: decision.localHash,
              });
              break;
            }
            result.conflicts.push({ decision, localBytes: ours, remoteBytes, settingsReason: decided.reason });
            break;
          }
          result.conflicts.push({ decision, localBytes: ours, remoteBytes });
          break;
        }
      }
    } catch (error) {
      // ドライブの失敗はその先も続く見込みが高い（ネットが切れた等）。ここまでの
      // 印を残して止める。手元の書き込みの例外は呼び手の不具合なので投げ直す
      if (error instanceof DriveApiError) {
        result.stoppedBy = error;
        break;
      }
      throw error;
    }
  }
  return result;
}

/** 作者が食い違いで選んだもの（今の「残す文を選ぶ」と同じ3つ。設計書5.10.4） */
export type DriveConflictChoice = "local" | "remote" | "both";

/**
 * 作者が食い違いを選んだあとの処理。選んだことは**次に送るとき目録に載る**
 * （`DriveSyncRecord.pendingResolutions`）ので、もう1台では訊き直さない。
 *
 * - `local`（左を残す）：手元は書かない。印は向こうの中身へ進める（見比べて
 *   退けたものを、次の受け取りで「向こうが変わった」と読まないため）
 * - `remote`（右を残す）：向こうの中身を書く。向こうと同じ中身になるので、
 *   選んだことを送る必要は無い
 * - `both`（両方とも残す）：向こうの中身を `sidePath`（`sideFileName` で作った
 *   別の名前）へ新しく置き、手元はそのまま。印は向こうへ進める
 */
export async function applyDriveConflictChoice(input: {
  report: DriveConflictReport;
  choice: DriveConflictChoice;
  record: DriveSyncRecord;
  writer: LocalWorkWriter;
  sidePath?: string;
}): Promise<{ ok: true; record: DriveSyncRecord } | { ok: false; reason: string }> {
  const { decision, remoteBytes } = input.report;
  const record = cloneDriveSyncRecord(input.record);
  const baseText = decision.settings ? decodeUtf8(remoteBytes) : undefined;

  if (input.choice === "remote") {
    const outcome =
      decision.localHash === null
        ? await input.writer.create(decision.path, remoteBytes)
        : await input.writer.replace(decision.path, remoteBytes, decision.localHash);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    if (outcome.writtenHash !== decision.remoteHash) {
      return { ok: false, reason: "書いた中身が向こうの中身と合いません" };
    }
    setMark(record, decision.path, decision.remoteHash, baseText);
    return { ok: true, record };
  }

  if (input.choice === "both") {
    if (!input.sidePath || !isSafeSyncPath(input.sidePath)) {
      return { ok: false, reason: "両方とも残すための別の名前がありません" };
    }
    const outcome = await input.writer.create(input.sidePath, remoteBytes);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
  }

  setMark(record, decision.path, decision.remoteHash, baseText);
  record.pendingResolutions.set(decision.path, decision.remoteHash);
  return { ok: true, record };
}

/** 設定資料を `decideSettingsConflict` の決めたとおりにする */
async function applySettingsDecision(
  result: Extract<DriveReceiveResult, { kind: "received" }>,
  writer: LocalWorkWriter,
  input: {
    decision: Extract<DriveSyncDecision, { kind: "conflict" }>;
    decided: Exclude<SettingsConflictDecision, { side: "conflict" }>;
    remoteBytes: Uint8Array;
    localHash: string;
  }
): Promise<void> {
  const { decision, decided, remoteBytes } = input;
  const theirsText = decodeUtf8(remoteBytes);
  if (decided.side === "theirs") {
    const outcome = await writer.replace(decision.path, remoteBytes, input.localHash);
    if (!recordWrite(result, decision.path, outcome, decision.remoteHash)) return;
  } else if (decided.side === "merged") {
    // 合わせた中身は向こうとも手元とも違う。書けたハッシュは問わない（次に送る）
    const outcome = await writer.replace(decision.path, new TextEncoder().encode(decided.text), input.localHash);
    if (!outcome.ok) {
      result.failures.push({ path: decision.path, reason: outcome.reason });
      return;
    }
    result.written.push(decision.path);
  }
  // 印は向こうの中身へ。こちらが残した・合わせた中身は、選び終えた印を付けて次に送る
  setMark(result.record, decision.path, decision.remoteHash, theirsText);
  if (decided.side !== "theirs") result.record.pendingResolutions.set(decision.path, decision.remoteHash);
  result.settingsDecided.push({ path: decision.path, side: decided.side, reason: decided.reason });
}

/** 書いた結果を数える。印を進めてよければ true */
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
    // 書く口が中身の形を変えた。印を進めると2台で永久に往復する（`LocalWorkWriter` の説明）
    result.failures.push({
      path: entry,
      reason: "書いた中身が向こうの中身とバイトで合いません（印は進めていません）",
    });
    return false;
  }
  return true;
}

/** 印を置く（null なら外す）。印が進んだ道の「送った中身」は空にする */
function setMark(
  record: DriveSyncRecord,
  entry: string,
  hash: string | null,
  settingsText: string | undefined
): void {
  record.sentSinceMark.delete(entry);
  if (hash === null) {
    record.marks.delete(entry);
    record.settingsBases.delete(entry);
    return;
  }
  record.marks.set(entry, hash);
  if (settingsText !== undefined) record.settingsBases.set(entry, settingsText);
  else record.settingsBases.delete(entry);
}

/** 同じ名前が重なっていれば古いものを採る（2台が同じものを選ぶように） */
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
