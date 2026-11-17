import { isValidDeviceId } from "./device";
import { DRIVE_FOLDER_MIME, compareDriveEntriesByAge, type DriveClient, type DriveFileEntry } from "./driveApi";
import { DRIVE_FILES_FOLDER_NAME, DRIVE_MANIFEST_NAME, DRIVE_ROOT_FOLDER_NAME } from "./driveSyncEngine";
import { parseDriveManifest } from "./driveSyncPlan";
import { isValidWorkUid } from "./imeCurrentWork";

/**
 * 作品の無い機械が、Google ドライブから作品を取り寄せる（設計書5.10.9）。ここは一覧づくり。
 * 受け取りそのものは `receiveFromDrive`（空のフォルダーと空の控えで受け取れば、全部が
 * 「新しく置く」になる）。`vscode`・`node:` を読まない（`driveWorkImport.test.ts`）。
 *
 * - 作品のフォルダー（名前が workUid の形のもの）ごとに1行。IME の学習の置き場などは出さない
 * - 作品の名前は、いちばん新しく送った端末（目録の送った時刻）の `.aiwriter/config.json` の
 *   `title`。読めなければ undefined（画面は番号で出す）。**ドライブの中身は作者以外も書けうる
 *   ので、名前は画面に出すだけで、道や命令には使わない**
 * - この機械に登録済みの番号（`exclude`）は出さない（同じ作品を2つ持たない）
 */

export interface DriveWorkCandidate {
  workUid: string;
  /** 作品の名前（読めなければ undefined） */
  title: string | undefined;
  /** 目録の読めた端末（送った時刻の新しい順） */
  devices: { deviceId: string; deviceName: string; sentAt: string }[];
}

/** 名前として受け取る長さの上限（画面の一覧に出すだけ） */
const TITLE_LIMIT = 200;

export async function listDriveWorks(input: {
  client: DriveClient;
  exclude: ReadonlySet<string>;
  rootFolderName?: string;
}): Promise<DriveWorkCandidate[]> {
  const { client } = input;
  const roots = await client.findFolders("root", input.rootFolderName ?? DRIVE_ROOT_FOLDER_NAME);
  if (roots.length === 0) return [];
  const works = oldestFolders(await client.listChildren(roots[0].id)).filter(
    ([name]) => isValidWorkUid(name) && !input.exclude.has(name)
  );
  const out: DriveWorkCandidate[] = [];
  for (const [workUid, folder] of works.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const devices: (DriveWorkCandidate["devices"][number] & { folder: DriveFileEntry })[] = [];
    for (const [deviceId, deviceFolder] of oldestFolders(await client.listChildren(folder.id))) {
      if (!isValidDeviceId(deviceId)) continue;
      const manifestEntry = oldestFile(await client.listChildren(deviceFolder.id), DRIVE_MANIFEST_NAME);
      if (!manifestEntry) continue;
      const read = parseDriveManifest(new TextDecoder().decode(await client.readFile(manifestEntry.id)));
      if (!read.ok || read.manifest.deviceId !== deviceId) continue;
      devices.push({ deviceId, deviceName: read.manifest.deviceName, sentAt: read.manifest.sentAt, folder: deviceFolder });
    }
    if (devices.length === 0) continue;
    devices.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
    out.push({
      workUid,
      title: await titleOf(client, devices[0].folder),
      devices: devices.map(({ deviceId, deviceName, sentAt }) => ({ deviceId, deviceName, sentAt })),
    });
  }
  return out;
}

async function titleOf(client: DriveClient, deviceFolder: DriveFileEntry): Promise<string | undefined> {
  const files = oldestFolders(await client.listChildren(deviceFolder.id)).find(([name]) => name === DRIVE_FILES_FOLDER_NAME)?.[1];
  if (!files) return undefined;
  const config = oldestFile(await client.listChildren(files.id), ".aiwriter/config.json");
  if (!config) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await client.readFile(config.id)).replace(/^﻿/, ""));
    if (typeof value !== "object" || value === null) return undefined;
    const title = (value as Record<string, unknown>).title;
    if (typeof title !== "string") return undefined;
    const trimmed = title.replace(/[\u0000-\u001f]/g, "").trim();
    return trimmed === "" ? undefined : trimmed.slice(0, TITLE_LIMIT);
  } catch {
    return undefined;
  }
}

function oldestFolders(entries: readonly DriveFileEntry[]): [string, DriveFileEntry][] {
  const out = new Map<string, DriveFileEntry>();
  for (const entry of [...entries].sort(compareDriveEntriesByAge)) {
    if (entry.mimeType === DRIVE_FOLDER_MIME && !out.has(entry.name)) out.set(entry.name, entry);
  }
  return [...out];
}

function oldestFile(entries: readonly DriveFileEntry[], name: string): DriveFileEntry | undefined {
  return [...entries]
    .filter((entry) => entry.mimeType !== DRIVE_FOLDER_MIME && entry.name === name)
    .sort(compareDriveEntriesByAge)[0];
}
