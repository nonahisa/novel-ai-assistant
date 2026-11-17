import { DRIVE_FOLDER_MIME, compareDriveEntriesByAge, type DriveClient, type DriveFileEntry } from "./driveApi";
import { DRIVE_ROOT_FOLDER_NAME } from "./driveSyncEngine";
import { hashBytes } from "./hash";

/**
 * オリジナルIME の学習を Google ドライブでそろえる（設計書5.10.8。段階3）。
 *
 * 形の正はオリジナルIME の設計書「6.3.1」の「拡張機能からも同期する」「送り手の印」と、
 * 2026-11-17 に IME と決めた形（エンジンが書く写しを運ぶ）。
 *
 * - **送るのはエンジンが書く写し**（`novel-ime-core sync-out --all --file <先>`）。
 *   `記録/<機械ID>.jsonl` をそのまま送らない（読みの長い行が入っているため）。
 *   写しは頭の行「#novel-ime-sync 1 dev=…」と終わりの行「#end dev=…」で挟まれる
 * - **受け取った写しは作り替えずに `sync-in <ファイル>` へ渡す**（同じ行を2回足さない・
 *   自分の機械の分を足さないのはエンジン）
 * - ドライブの中：`統合小説執筆環境/オリジナルIME/<機械ID>/記録.jsonl`。自分の機械の
 *   フォルダーにしか書かない（設計書5.10.3 と同じ考え）
 * - **打った文は外へ出さない**——運ぶのはエンジンの写しだけで、拡張機能は記録の
 *   フォルダーのほかを開かない
 *
 * exe を動かすのは features（`node:child_process` を動的 import）。ここは
 * 写しの確かめ・ドライブの読み書き・印の形だけで、`vscode`・`node:` を読まない
 * （`imeLearningSync.test.ts` が見張る）。
 */

/** ドライブの中の、IME の学習の置き場（根のフォルダーの下） */
export const IME_DRIVE_FOLDER_NAME = "オリジナルIME";
/** 機械のフォルダーの中の写しの名前 */
export const IME_DRIVE_FILE_NAME = "記録.jsonl";
/** エンジンの置き場（オリジナルIME の置き場の中）の名前 */
export const IME_CORE_EXE_WINDOWS = "novel-ime-core.exe";
export const IME_CORE_EXE_MAC = "novel-ime-core";
/** 送り手の印の名前（記録の置き場の中。ASCII） */
export const IME_SENDER_FILE = "sender.json";
/** 送り手の印を書き直す間（1日1回。設計書5.10.8） */
export const IME_SENDER_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * 機械ID の形（ドライブのフォルダー名と写しの `dev=` に使う）。エンジンの決まり
 * （novel-ime `core/src/record.rs` の `valid_dev`：16進の8〜32字）と同じにする
 */
const MACHINE_ID_PATTERN = /^[0-9a-fA-F]{8,32}$/;

export function isImeMachineId(value: string): boolean {
  return MACHINE_ID_PATTERN.test(value);
}

/**
 * エンジンの場所。オリジナルIME の置き場（`imeStateDir`。IME 連動と同じ見つけ方）の
 * 中の exe。置き場が無い OS（Linux 等）では undefined
 */
export function imeCoreExecutable(stateDir: string | undefined, platform: string | undefined): string | undefined {
  if (!stateDir) return undefined;
  if (platform === "win32") return `${stateDir.replace(/[\\/]+$/, "")}\\${IME_CORE_EXE_WINDOWS}`;
  if (platform === "darwin") return `${stateDir.replace(/\/+$/, "")}/${IME_CORE_EXE_MAC}`;
  return undefined;
}

export interface ImeSyncInfo {
  machineId: string;
  /** 学習の記録の置き場（`sender.json` を書く所） */
  dir: string;
}

/** `sync-info` の標準出力（`{"machine":…,"dir":…,"records":[…]}`）を読む。形が違えば理由 */
export function parseImeSyncInfo(stdout: string): ImeSyncInfo | string {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return "sync-info の出力が JSON として読めません";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "sync-info の出力の形が違います";
  const { machine, dir } = value as Record<string, unknown>;
  if (typeof machine !== "string" || !isImeMachineId(machine)) return "sync-info の機械ID の形が違います";
  if (typeof dir !== "string" || dir.trim() === "") return "sync-info に記録の置き場がありません";
  return { machineId: machine, dir };
}

/**
 * 写しが書き終わった形か（頭の行と終わりの行があり、どちらも `dev=` がその機械）。
 * 送る前（自分の写し）と、`sync-in` へ渡す前（ほかの機械の写し）に確かめる——
 * 途中で切れた写しや、ほかの機械の写しを別の機械のものとして運ばない
 */
export function checkImeExport(bytes: Uint8Array, machineId: string): true | string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "写しが UTF-8 として読めません";
  }
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length < 2) return "写しの頭か終わりの行がありません";
  const head = lines[0];
  const end = lines[lines.length - 1];
  if (!head.startsWith("#novel-ime-sync 1 ")) return "写しの頭の行がありません";
  if (!end.startsWith("#end ")) return "写しの終わりの行がありません（書いている途中かもしれません）";
  const devOf = (line: string) => line.split(" ").find((part) => part.startsWith("dev="))?.slice(4);
  if (devOf(head) !== machineId || devOf(end) !== machineId) return "写しの機械ID がフォルダーの名前と違います";
  return true;
}

/** 送り手の印（`sender.json`）の中身 */
export function buildImeSenderJson(input: { version: string; machineId: string; at: Date }): string {
  return (
    JSON.stringify({
      sender: "novel-ai-assistant",
      version: input.version,
      machineId: input.machineId,
      at: input.at.toISOString(),
    }) + "\n"
  );
}

export type ImeSendResult = { kind: "sent" } | { kind: "unchanged" };

/** この機械の写しを、この機械のフォルダーへ置く（前と同じ中身なら書かない） */
export async function sendImeLearning(input: {
  client: DriveClient;
  machineId: string;
  bytes: Uint8Array;
  rootFolderName?: string;
}): Promise<ImeSendResult> {
  const { client } = input;
  if (!isImeMachineId(input.machineId)) throw new Error("機械ID の形が違います");
  const root = await client.ensureFolder("root", input.rootFolderName ?? DRIVE_ROOT_FOLDER_NAME);
  const ime = await client.ensureFolder(root.id, IME_DRIVE_FOLDER_NAME);
  const machine = await client.ensureFolder(ime.id, input.machineId);
  const existing = oldestFile(await client.listChildren(machine.id), IME_DRIVE_FILE_NAME);
  if (existing) {
    if (existing.sha256Checksum?.toLowerCase() === hashBytes(input.bytes)) return { kind: "unchanged" };
    await client.updateFile(existing.id, input.bytes);
  } else {
    await client.createFile(machine.id, IME_DRIVE_FILE_NAME, input.bytes, "application/octet-stream");
  }
  return { kind: "sent" };
}

export interface ImeReceived {
  machineId: string;
  bytes: Uint8Array;
}

/**
 * ほかの機械の写しを集める（自分の機械のフォルダーは読まない）。書き終わっていない・
 * 機械ID の合わない写しは `skipped`（`sync-in` へ渡さない）
 */
export async function receiveImeLearning(input: {
  client: DriveClient;
  machineId: string;
  rootFolderName?: string;
}): Promise<{ received: ImeReceived[]; skipped: { machineId: string; reason: string }[] }> {
  const { client } = input;
  const out = { received: [] as ImeReceived[], skipped: [] as { machineId: string; reason: string }[] };
  const roots = await client.findFolders("root", input.rootFolderName ?? DRIVE_ROOT_FOLDER_NAME);
  if (roots.length === 0) return out;
  const imes = await client.findFolders(roots[0].id, IME_DRIVE_FOLDER_NAME);
  if (imes.length === 0) return out;
  const folders = new Map<string, DriveFileEntry>();
  for (const entry of [...(await client.listChildren(imes[0].id))].sort(compareDriveEntriesByAge)) {
    if (entry.mimeType !== DRIVE_FOLDER_MIME || !isImeMachineId(entry.name) || entry.name === input.machineId) continue;
    if (!folders.has(entry.name)) folders.set(entry.name, entry);
  }
  for (const machineId of [...folders.keys()].sort()) {
    const file = oldestFile(await client.listChildren((folders.get(machineId) as DriveFileEntry).id), IME_DRIVE_FILE_NAME);
    if (!file) continue;
    const bytes = await client.readFile(file.id);
    const checked = checkImeExport(bytes, machineId);
    if (checked !== true) out.skipped.push({ machineId, reason: checked });
    else out.received.push({ machineId, bytes });
  }
  return out;
}

function oldestFile(entries: readonly DriveFileEntry[], name: string): DriveFileEntry | undefined {
  return [...entries]
    .filter((entry) => entry.mimeType !== DRIVE_FOLDER_MIME && entry.name === name)
    .sort(compareDriveEntriesByAge)[0];
}

/** エンジン（`novel-ime-core`）の口。手元は exe を起こし、試験は偽物を渡す */
export interface ImeEngine {
  /** `sync-info`。読めなければ理由 */
  info(): Promise<ImeSyncInfo | string>;
  /** `sync-out --all --file <一時の先>` で書かせた写し。書かなければ理由 */
  exportAll(): Promise<Uint8Array | string>;
  /** ほかの機械の写しを一時の所に置いて `sync-in <ファイル>` へ渡す */
  importExport(machineId: string, bytes: Uint8Array): Promise<void>;
}

export interface ImeLearningSyncResult {
  /** 送れた（前と同じで書かなかったものを含む）か。送れなければ理由 */
  sent: true | string;
  /** sync-in へ渡した機械 */
  imported: string[];
  skipped: { machineId: string; reason: string }[];
}

/**
 * 学習を1回そろえる（設計書5.10.8）。順は sync-info → 写しを書かせる → 書き終わった形と
 * 機械ID を確かめる → 送る → **送れたあとだけ送り手の印を書く** → ほかの機械の写しを確かめて
 * sync-in へ。送り手の印を送れないときに書くと、IME の同期のアプリが送るのをやめ、
 * 誰も送らなくなるため。ドライブの失敗はそのまま投げる（呼び手がログへ）
 */
export async function runImeLearningSync(input: {
  engine: ImeEngine;
  client: DriveClient;
  /** 送り手の印を書く（機械ID を渡す） */
  writeSender: (machineId: string) => Promise<void>;
}): Promise<ImeLearningSyncResult | string> {
  const info = await input.engine.info();
  if (typeof info === "string") return info;
  let sent: true | string;
  const bytes = await input.engine.exportAll();
  if (typeof bytes === "string") sent = bytes;
  else {
    const checked = checkImeExport(bytes, info.machineId);
    if (checked !== true) sent = checked;
    else {
      await sendImeLearning({ client: input.client, machineId: info.machineId, bytes });
      sent = true;
    }
  }
  if (sent === true) await input.writeSender(info.machineId);
  const received = await receiveImeLearning({ client: input.client, machineId: info.machineId });
  const imported: string[] = [];
  for (const item of received.received) {
    await input.engine.importExport(item.machineId, item.bytes);
    imported.push(item.machineId);
  }
  return { sent, imported, skipped: received.skipped };
}
