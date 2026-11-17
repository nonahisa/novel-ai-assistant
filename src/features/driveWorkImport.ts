// ログの書き先：取り寄せる前は作品のフォルダーが無いので保管庫のログへ。置いたあとは作品へ向ける
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { DriveClient } from "../core/driveApi";
import { writeDestination, writePendingConflicts } from "../core/driveDestination";
import { receiveFromDrive, type DriveReceiveResult } from "../core/driveSyncEngine";
import { emptyDriveSyncRecord } from "../core/driveSyncRecord";
import { listDriveWorks, type DriveWorkCandidate } from "../core/driveWorkImport";
import { describeDriveWorkSync } from "../core/driveWorkSync";
import { pathExists } from "../core/fileSystem";
import { logLine, useLogFile } from "../core/logger";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import { askText, cancelItem } from "../views/dialogs";
import { withProgress } from "../views/progress";
import { whenNoticePicked } from "../views/notify";
import { CHOOSE_TEXT_TO_KEEP } from "../core/gitSyncMenuText";
import { pickNewFolderParent } from "./pickFolder";
import { ensureWorkUid } from "./imeCurrentWork";
import { DRIVE_IGNORED_PATHS, chooseDriveConflicts, workFiles, writeRecord, type DriveSyncDeps } from "./driveSync";

/**
 * 作品の無い機械が、Google ドライブから作品を取り寄せる（設計書5.10.9）。
 *
 * ドライブの作品を名前で選び、置き場所とフォルダー名を決め、**新しいフォルダーへ**全部を
 * 受け取って作品として登録し、送り先を Google ドライブにする。**既にあるフォルダーへは
 * 絶対に取り寄せない**（GitHub から取り寄せる 5.5.11 と同じ。上書きすると、その機械で
 * 書いた原稿が消える）。置くのは `atomicWriteFile` の `create` だけで、受け取りの関所
 * （競合の印・道の照らし方）を通る（`workFiles` の `create` と `receiveFromDrive`）。
 *
 * ブラウザ版では出さない（呼び手が `canRunProcesses()` を見てから動的 import する）。
 */

export type DriveImportResult =
  /** 置き場所に同じ名前のフォルダーがある。何も書いていない */
  | { kind: "exists" }
  /** 受け取った（`receive.kind === "received"`）。届ききっていない等は `receive` を見る */
  | { kind: "received" | "not_received"; receive: DriveReceiveResult };

/**
 * 新しいフォルダーへ受け取る（画面を出さない部分。試験はここを見る）。
 * 空のフォルダーと空の控えで受け取るので、手元に無いものは全部「新しく置く」になる
 */
export async function importDriveWorkInto(
  deps: { client: DriveClient; deviceId: string; deviceName: string },
  workUid: string,
  destination: string
): Promise<DriveImportResult> {
  if (await pathExists(destination)) return { kind: "exists" };
  await vscode.workspace.fs.createDirectory(path.toUri(destination));
  const work = { id: `drive-import-${workUid}`, title: workUid, folderPath: destination } as WorkEntry;
  const files = workFiles(work, deps.deviceId);
  const receive = await receiveFromDrive({
    client: deps.client,
    layout: { workFolderName: workUid, deviceId: deps.deviceId, deviceName: deps.deviceName },
    local: files.local,
    writer: files.writer,
    record: emptyDriveSyncRecord(deps.deviceId),
    ignoredPaths: DRIVE_IGNORED_PATHS,
  });
  if (receive.kind !== "received") return { kind: "not_received", receive };
  useLogFile(destination);
  await writeRecord(work, deps.deviceId, receive.record);
  return { kind: "received", receive };
}

/** 命令「Google ドライブから追加」 */
export async function importWorkFromDrive(deps: DriveSyncDeps): Promise<WorkEntry | undefined> {
  if (!(await deps.auth.isLoggedIn())) {
    const login = "ログインする";
    whenNoticePicked(
      vscode.window.showWarningMessage("Google ドライブから取り寄せていません。Google にログインしていません。", login),
      (picked) => (picked === login ? deps.auth.login() : undefined),
      { label: "Google ドライブのログイン" }
    );
    return undefined;
  }
  // この機械に登録済みの作品の番号は出さない（同じ作品を2つ持たない）
  const exclude = new Set<string>();
  for (const work of deps.registry.list()) {
    const uid = await ensureWorkUid(work, { allowAdd: false });
    if (uid.kind === "ready") exclude.add(uid.workUid);
  }
  const client = deps.auth.driveClient();
  let candidates: DriveWorkCandidate[];
  try {
    candidates = await withProgress("Google ドライブの作品を調べています…", () => listDriveWorks({ client, exclude }));
  } catch (error) {
    logLine(`[drive] 作品の一覧を読めませんでした（${error instanceof Error ? error.message : String(error)}）`);
    void vscode.window.showWarningMessage(
      "Google ドライブの作品の一覧を読めませんでした。ネットにつながっているか確かめてから、もう一度押してください。"
    );
    return undefined;
  }
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage("Google ドライブに、この機械へまだ取り寄せていない作品はありません。");
    return undefined;
  }
  const picked = await showQuickPickKeepingFocus(
    [
      ...candidates.map((candidate) => ({
        label: candidate.title ?? candidate.workUid,
        description: candidate.devices.map((device) => device.deviceName).join("・"),
        candidate,
      })),
      cancelItem(),
    ],
    { title: "Google ドライブから取り寄せる作品", ignoreFocusOut: true }
  );
  if (!picked || !("candidate" in picked)) return undefined;
  const { candidate } = picked;

  const parentPath = await pickNewFolderParent({
    purpose: "作品フォルダを置く場所を選択",
    openLabel: "ここに取り寄せる",
    works: deps.registry.list(),
  });
  if (!parentPath) return undefined;
  const suggested = (candidate.title ?? candidate.workUid).replace(/[/\\:*?"<>|]/g, "_").trim();
  const folderName = await askText({
    title: "フォルダー名",
    prompt: "作品フォルダーの名前（あとから作品名は変えられます）",
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "フォルダー名を入力してください";
      if (/[/\\:*?"<>|]/.test(trimmed)) return "フォルダー名に使えない文字が含まれています";
      return null;
    },
  });
  if (!folderName) return undefined;
  const destination = path.join(parentPath, folderName.trim());

  const result = await withProgress("Google ドライブから取り寄せています…", () =>
    importDriveWorkInto({ client, deviceId: deps.deviceId, deviceName: deps.deviceName }, candidate.workUid, destination)
  );
  if (result.kind === "exists") {
    void vscode.window.showErrorMessage(
      `「${destination}」はすでに存在します。中身を失わないため、取り寄せを中止しました。別の名前を指定してください。`
    );
    return undefined;
  }
  const title = candidate.title ?? folderName.trim();
  if (result.kind === "not_received") {
    const text = describeDriveWorkSync(title, {
      kind: "done",
      uploaded: [],
      receive: result.receive,
      record: emptyDriveSyncRecord(deps.deviceId),
      recordChanged: false,
    }).text;
    void vscode.window.showWarningMessage(
      `${text}作品としては登録していません。「${destination}」に途中まで置いたファイルがあれば、消すか別の名前でもう一度取り寄せてください。`
    );
    return undefined;
  }

  const entry = await deps.registry.addExisting(destination, title);
  if (!entry) return undefined;
  await writeDestination(deps.storage, entry.id, "googleDrive");
  await deps.afterReceived?.(entry);
  const receive = result.receive as Extract<DriveReceiveResult, { kind: "received" }>;
  await writePendingConflicts(deps.storage, entry.id, receive.conflicts.map((c) => c.decision.path));
  const problems = [
    receive.failures.length > 0 ? `置けなかったファイルがあります（${receive.failures.length}件）：${receive.failures.map((f) => f.path).join("、")}。` : "",
    receive.conflicts.length > 0 ? `機械ごとに中身の違うファイルがあります（${receive.conflicts.length}件）。残す文を選んでください。` : "",
  ].join("");
  const text = `${problems}「${entry.title}」を Google ドライブから取り寄せて登録しました（${receive.written.length}件）。送り先は Google ドライブです。`;
  const buttons = receive.conflicts.length > 0 ? [CHOOSE_TEXT_TO_KEEP] : [];
  whenNoticePicked(
    problems ? vscode.window.showWarningMessage(text, ...buttons) : vscode.window.showInformationMessage(text, ...buttons),
    (answer) => (answer === CHOOSE_TEXT_TO_KEEP ? chooseDriveConflicts(deps, entry, receive.conflicts) : undefined),
    { label: "Google ドライブから取り寄せ", workFolder: entry.folderPath }
  );
  return entry;
}
