import { DRIVE_SIMPLE_UPLOAD_LIMIT, driveNextAction, type DriveApiError, type DriveClient } from "./driveApi";
import { findTooLargeForDrive } from "./driveDestination";
import { isSendableSyncPath } from "./driveSyncPlan";
import {
  receiveFromDrive,
  sendToDrive,
  type DriveReceiveResult,
  type DriveSyncLayout,
  type LocalWorkFiles,
  type LocalWorkWriter,
} from "./driveSyncEngine";
import type { DriveSyncRecord } from "./driveSyncRecord";

/**
 * 送り先が Google ドライブの作品の［保存・同期］1回（設計書5.10.5・5.10.9。段階3）。
 * 中身は「送る → 受け取る」。`vscode`・`node:` を読まない（`driveWorkSync.test.ts`）。
 *
 * - 送る前に、一度に送れない大きさのファイルを探し、あればファイル名つきで止める
 *   （送りが毎回同じ所で止まり、目録まで届かないため。黙って外さない）
 * - 送りが止まったら受け取らない（ネットが切れた・鍵が切れた等は受け取りでも同じ）
 * - 控え（`record`）は送れたら送りの控え、受け取ったら受け取りの控え。**呼び手が保存する**
 *   （受け取りが途中で止まっても、そこまでの控えを保存する）
 * - 自動の受け取り（VS Code を開いたとき）は `receiveOnly`
 */
export type DriveWorkSyncResult =
  | { kind: "too_large"; paths: string[] }
  | { kind: "send_failed"; error: DriveApiError }
  | { kind: "own_manifest_unreadable"; reason: string }
  /** 競合マーカーの入ったファイルがある。何も送っていない（受け取りもしていない） */
  | { kind: "conflict_markers"; paths: string[] }
  | {
      kind: "done";
      /** 送った道（送らなかったときは空） */
      uploaded: string[];
      receive: DriveReceiveResult;
      /** いちばん新しい控え（保存する） */
      record: DriveSyncRecord;
      /** 送れて控えが進んだか（受け取りが失敗しても、送りの控えは保存する） */
      recordChanged: boolean;
    };

export async function runDriveWorkSync(input: {
  client: DriveClient;
  layout: DriveSyncLayout;
  local: LocalWorkFiles;
  writer: LocalWorkWriter;
  record: DriveSyncRecord;
  ignoredPaths: readonly string[];
  now: Date;
  /** 手元のファイルの大きさ（道 → バイト）。送る前の確かめに使う */
  sizes: ReadonlyMap<string, number>;
  receiveOnly?: boolean;
  sizeLimit?: number;
}): Promise<DriveWorkSyncResult> {
  let record = input.record;
  let recordChanged = false;
  let uploaded: string[] = [];
  if (!input.receiveOnly) {
    const tooLarge = findTooLargeForDrive(input.sizes, input.sizeLimit ?? DRIVE_SIMPLE_UPLOAD_LIMIT, (entry) =>
      isSendableSyncPath(entry, { ownDeviceId: input.layout.deviceId, ignoredPaths: input.ignoredPaths })
    );
    if (tooLarge.length > 0) return { kind: "too_large", paths: tooLarge };
    const sent = await sendToDrive({
      client: input.client,
      layout: input.layout,
      local: input.local,
      writer: input.writer,
      record,
      ignoredPaths: input.ignoredPaths,
      now: input.now,
    });
    if (sent.kind === "failed") return { kind: "send_failed", error: sent.error };
    if (sent.kind === "own_manifest_unreadable") return { kind: "own_manifest_unreadable", reason: sent.reason };
    if (sent.kind === "conflict_markers") return { kind: "conflict_markers", paths: sent.paths };
    record = sent.record;
    recordChanged = true;
    uploaded = sent.uploaded;
  }
  const receive = await receiveFromDrive({
    client: input.client,
    layout: input.layout,
    local: input.local,
    writer: input.writer,
    record,
    ignoredPaths: input.ignoredPaths,
  });
  if (receive.kind === "received") {
    record = receive.record;
    recordChanged = true;
  }
  return { kind: "done", uploaded, receive, record, recordChanged };
}

/** 知らせの1件（作品1つ分）。`problem` が先に並ぶ（届いていないことを先に書く。2026-11-03） */
export interface DriveSyncNotice {
  /** 作者が見る文。届いていないこと・作者がすることが先、済んだことはあと */
  text: string;
  /** 届いていない・止まった所があるか（警告で出す） */
  problem: boolean;
  /** 選ぶ食い違いがあるか（［残す文を選ぶ］を出す） */
  conflicts: number;
  /** 手元へ書いたか（数え直しが要る） */
  wrote: boolean;
}

/**
 * 作品1つの結果を、作者が読む文にする。**種別ごとに次の操作を1つ**（実装ルール5）。
 * 英語の生の文（API の本文）は出さない（ログへ）。
 */
export function describeDriveWorkSync(title: string, result: DriveWorkSyncResult): DriveSyncNotice {
  const quiet = { conflicts: 0, wrote: false };
  if (result.kind === "too_large") {
    return {
      ...quiet,
      problem: true,
      text: `「${title}」は Google ドライブへ送っていません。5MB を超えるファイルがあります：${result.paths.join("、")}。${driveNextAction("too_large")}`,
    };
  }
  if (result.kind === "send_failed") {
    return {
      ...quiet,
      problem: true,
      text: `「${title}」は Google ドライブへ送れませんでした。${driveNextAction(result.error.kind)}`,
    };
  }
  if (result.kind === "conflict_markers") {
    return {
      ...quiet,
      problem: true,
      text: `「${title}」は Google ドライブへ送っていません。競合マーカー（<<<<<<<）の残ったファイルがあります：${result.paths.join("、")}。マーカーを消して保存してから、もう一度［保存・同期］を押してください。`,
    };
  }
  if (result.kind === "own_manifest_unreadable") {
    return {
      ...quiet,
      problem: true,
      text: `「${title}」は Google ドライブへ送っていません。前に送った目録が読めません（直さずに止めました）。ログを開いて、記録された内容を確かめてください。`,
    };
  }
  const sentText = result.uploaded.length > 0 ? `送りました（${result.uploaded.length}件）。` : "";
  const receive = result.receive;
  switch (receive.kind) {
    case "nothing_yet":
      return { ...quiet, problem: false, text: `「${title}」：${sentText}もう1台からはまだ何も届いていません。` };
    case "failed":
      return {
        ...quiet,
        problem: true,
        text: `「${title}」は Google ドライブから受け取れませんでした。${driveNextAction(receive.error.kind)}${sentText ? `（${sentText}）` : ""}`,
      };
    case "unreadable":
      return {
        ...quiet,
        problem: true,
        text: `「${title}」はもう1台の目録が読めないので受け取っていません（直さずに止めました）。ログを開いて、記録された内容を確かめてください。${sentText}`,
      };
    case "not_arrived":
      return {
        ...quiet,
        problem: true,
        text: `「${title}」はもう1台からまだ届ききっていません。しばらく待ってから、もう一度［保存・同期］を押してください。${sentText}`,
      };
    case "received": {
      const problems: string[] = [];
      if (receive.conflicts.length > 0) {
        problems.push(`2台で同じ所を書き換えたファイルがあります（${receive.conflicts.length}件）。残す文を選んでください。`);
      }
      if (receive.failures.length > 0) {
        problems.push(
          `受け取れなかったファイルがあります（${receive.failures.length}件）：${receive.failures.map((f) => f.path).join("、")}。保存してから、もう一度［保存・同期］を押してください。`
        );
      }
      if (receive.stoppedBy) {
        problems.push(`受け取りが途中で止まりました。${driveNextAction(receive.stoppedBy.kind)}`);
      }
      if (receive.waiting.length > 0) {
        problems.push("まだ届ききっていない機械があります。しばらく待ってから、もう一度［保存・同期］を押してください。");
      }
      const notes: string[] = [];
      if (receive.remoteDeleted.length > 0) {
        notes.push(
          `もう1台で消えたファイルがあります（このパソコンでは消していません）：${receive.remoteDeleted.map((d) => d.path).join("、")}。`
        );
      }
      const written = receive.written.length;
      const merged = receive.merged.length;
      const done = [
        sentText,
        written > 0 ? `受け取りました（${written}件）。` : "",
        merged > 0 ? `${Math.max(...receive.merged.map((m) => m.devices.length))}台の直しを合わせました（${merged}件）。` : "",
      ].join("");
      const text = [...problems, ...notes, done || "変わったものはありませんでした。"].join("");
      return {
        problem: problems.length > 0,
        conflicts: receive.conflicts.length,
        wrote: written > 0,
        text: `「${title}」：${text}`,
      };
    }
  }
}
