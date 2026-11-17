// ログの書き先：作品ごと（`useLogFile`）。作品をまたぐ知らせは保管庫のログ
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  DRIVE_SYNC_RECORD_IGNORE_RULE,
  IGNORED_PATHS,
  ON_USE_IGNORED_PATHS,
  ensureOnUseIgnoreRule,
} from "../core/workRegistry";
import { atomicWriteFile } from "../core/atomicWrite";
import { isNotFound } from "../core/fileRead";
import { hashBytes } from "../core/hash";
import { decodeBytes, hasUnsavedChanges, replaceFileWithReceivedBytes } from "../core/textFile";
import { logFailure, logLine, useLogFile } from "../core/logger";
import type { GitSyncStatus } from "../core/git";
import {
  checkSwitchToDrive,
  checkSwitchToGithub,
  destinationOf,
  findDriveUnsent,
  readDestinations,
  readPendingConflicts,
  writeDestination,
  writePendingConflicts,
  type DestinationStorage,
  type WorkGitState,
} from "../core/driveDestination";
import { isSendableSyncPath } from "../core/driveSyncPlan";
import {
  applyDriveConflictChoice,
  applyDriveMergeChoice,
  type DriveConflictReport,
  type DriveSyncLayout,
  type LocalWorkFiles,
  type LocalWorkWriter,
  type LocalWriteOutcome,
} from "../core/driveSyncEngine";
import {
  driveBasePath,
  driveSyncRecordPath,
  emptyDriveSyncRecord,
  parseDriveSyncRecord,
  serializeDriveSyncRecord,
  type DriveSyncRecord,
} from "../core/driveSyncRecord";
import { describeDriveWorkSync, runDriveWorkSync } from "../core/driveWorkSync";
import { sideFileName } from "../core/conflictFile";
import { isEditorMode } from "../core/actorContext";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import { cancelItem } from "../views/dialogs";
import { whenNoticePicked } from "../views/notify";
import type { GoogleDriveAuth } from "./googleDriveAuth";
import { ensureWorkUid } from "./imeCurrentWork";
import { CHOOSE_TEXT_TO_KEEP } from "../core/gitSyncMenuText";

/**
 * 送り先が Google ドライブの作品をそろえる（設計書5.10.5・5.10.9。段階3）。
 *
 * 手順は core（`driveWorkSync.ts`・`driveSyncEngine.ts`）。ここは VS Code の口だけ：
 * 手元の作品のフォルダーの読み書き（`workspace.fs`）・控えの保存・知らせと見比べ・
 * 送り先の切り替え・開いたときの自動の受け取り。
 *
 * **手元の原稿へ書くのは2つの口だけ**（設計書5.10.2）：既にあるファイルは
 * `replaceFileWithReceivedBytes`（校閲中・未保存・競合の印・ハッシュの2回の照合・
 * 回復先への控え→消す→作り直す。受け取ったバイトをそのまま書く）、無いファイルは
 * `atomicWriteFile` の `create`。`replaceGuarded` は使わない。
 *
 * **ブラウザ版では動かさない**（設計書5.10.2）。呼び手（`extension.ts`）が
 * `canRunProcesses()` を見てから動的 import する。
 */

/** ドライブへ送らないもの：一括の除外と、使った作品だけに足す除外（IME の控え・この端末の控え） */
export const DRIVE_IGNORED_PATHS: readonly string[] = [...IGNORED_PATHS, ...ON_USE_IGNORED_PATHS];

export interface DriveSyncDeps {
  registry: WorkRegistry;
  /** 送り先・選んでいない食い違いの置き場（globalState） */
  storage: DestinationStorage;
  deviceId: string;
  /** この機械の名前（目録に載せる。画面に出る） */
  deviceName: string;
  auth: GoogleDriveAuth;
  /** git の置き場の様子（切り替えの判断に使う） */
  gitStatusOf(workId: string): GitSyncStatus | undefined;
  /** 受け取りの間、設定資料の見張りを止める（設計書5.5.18。戻す関数を返す） */
  pauseSettingsWatch?: () => () => void;
  /** 手元へ書いたあとの数え直し（走査・用語・設定資料のパネル・執筆量の基準。設計書5.5.8） */
  afterReceived?: (work: WorkEntry) => void | Promise<void>;
  /** 見比べの画面へ読み取り専用の文を出す口（`extension.ts` が登録した仕組み） */
  compare: DriveCompareProvider;
}

/** 見比べの画面へ出す読み取り専用の文 */
export interface DriveCompareProvider {
  register(key: string, label: string, text: string): vscode.Uri;
}

/** 送り先が Google ドライブの作品か（git の同期から外すのに使う） */
export function isDriveWork(storage: Pick<DestinationStorage, "get">, work: WorkEntry): boolean {
  return destinationOf(storage, work.id) === "googleDrive";
}

export function driveWorksOf(deps: Pick<DriveSyncDeps, "registry" | "storage">): WorkEntry[] {
  const table = readDestinations(deps.storage);
  return deps.registry.list().filter((work) => table.get(work.id) === "googleDrive");
}

/**
 * 同時に2回走らせない（2つの同期が同じ控えを読んで書くと、片方の進みが消える）。
 * 走っている間に押されたら、終わるのを待ってから走る（開いた直後の受け取りの最中に
 * ［保存・同期］を押しても、黙って見送らない）
 */
let running: Promise<void> | undefined;

/**
 * ［保存・同期］のうち、送り先が Google ドライブの作品の分（「送る → 受け取る」）。
 * `receiveOnly` は開いたときの自動の受け取り。**未保存の文書がある作品は飛ばす**。
 * 知らせは作品をまとめて1回。食い違いがあれば［残す文を選ぶ］を添える（答えは待たない）
 */
export async function syncDriveWorks(
  deps: DriveSyncDeps,
  options: { receiveOnly: boolean; quietWhenNothing?: boolean }
): Promise<void> {
  while (running) await running.catch(() => undefined);
  let finish: () => void = () => undefined;
  running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    await syncDriveWorksNow(deps, options);
  } finally {
    running = undefined;
    finish();
  }
}

async function syncDriveWorksNow(
  deps: DriveSyncDeps,
  options: { receiveOnly: boolean; quietWhenNothing?: boolean }
): Promise<void> {
  const works = driveWorksOf(deps);
  if (works.length === 0) return;
  if (!(await deps.auth.isLoggedIn())) {
    const login = "ログインする";
    whenNoticePicked(
      vscode.window.showWarningMessage(
        `Google ドライブ${options.receiveOnly ? "から受け取って" : "へ送って"}いません（${works.length}作品）。Google にログインしていません。`,
        login
      ),
      (picked) => (picked === login ? deps.auth.login() : undefined),
      { label: "Google ドライブのログイン" }
    );
    return;
  }
  const resume = deps.pauseSettingsWatch?.();
  const lines: { text: string; problem: boolean }[] = [];
  const toChoose: { work: WorkEntry; reports: DriveConflictReport[] }[] = [];
  try {
    for (const work of works) {
      try {
        const outcome = await syncOneWork(deps, work, options.receiveOnly);
        if (outcome) {
          lines.push(outcome.line);
          if (outcome.reports.length > 0) toChoose.push({ work, reports: outcome.reports });
        }
      } catch (error) {
        // 1作品の失敗で残りを止めない
        useLogFile(work.folderPath);
        logFailure("Google ドライブの同期で例外", {
          作品: work.title,
          詳細: error instanceof Error ? error.message : String(error),
        });
        lines.push({ text: `「${work.title}」は Google ドライブとそろえられませんでした。ログを開いて、記録された内容を確かめてください。`, problem: true });
      }
    }
  } finally {
    resume?.();
  }
  const problems = lines.filter((line) => line.problem);
  if (options.quietWhenNothing && problems.length === 0 && toChoose.length === 0 && lines.every((l) => /変わったものはありませんでした|まだ何も届いていません/.test(l.text))) {
    return;
  }
  // 届いていないこと・作者がすることを先に（2026-11-03 の決まり）
  const text = [...problems, ...lines.filter((line) => !line.problem)].map((line) => line.text).join("\n");
  const buttons = toChoose.length > 0 ? [CHOOSE_TEXT_TO_KEEP] : [];
  const warn = problems.length > 0 || toChoose.length > 0;
  whenNoticePicked(
    warn ? vscode.window.showWarningMessage(text, ...buttons) : vscode.window.showInformationMessage(text, ...buttons),
    async (picked) => {
      if (picked !== CHOOSE_TEXT_TO_KEEP) return;
      for (const item of toChoose) await chooseDriveConflicts(deps, item.work, item.reports);
    },
    { label: "Google ドライブの食い違いを選ぶ" }
  );
}

/** 作品1つ。未保存がある作品は飛ばす（知らせの1行を返す） */
async function syncOneWork(
  deps: DriveSyncDeps,
  work: WorkEntry,
  receiveOnly: boolean
): Promise<{ line: { text: string; problem: boolean }; reports: DriveConflictReport[] } | undefined> {
  useLogFile(work.folderPath);
  if (hasUnsavedInside(work.folderPath)) {
    // 書きかけを勝手に確定させない・受け取りで上書きしない（設計書5.10.1・6.15.1）
    return {
      line: { text: `「${work.title}」は保存していないファイルがあるので、Google ドライブとそろえていません。保存してから、もう一度［保存・同期］を押してください。`, problem: true },
      reports: [],
    };
  }
  const uid = await ensureWorkUid(work, { allowAdd: !isEditorMode() });
  if (uid.kind !== "ready") {
    return { line: { text: `「${work.title}」は Google ドライブとそろえていません。${uid.reason}。`, problem: true }, reports: [] };
  }
  const loaded = await readRecord(work, deps.deviceId);
  if (!loaded.ok) {
    return {
      line: { text: `「${work.title}」は Google ドライブとそろえていません。この端末の控え（${driveSyncRecordPath(deps.deviceId)}）が読めません（直さずに止めました：${loaded.reason}）。`, problem: true },
      reports: [],
    };
  }
  // Git の除外の行は送る前に足す（送ったあとで足すと、.gitignore がいつも「送っていない変更」になる）
  await ensureOnUseIgnoreRule(work.folderPath, DRIVE_SYNC_RECORD_IGNORE_RULE);
  const files = workFiles(work, deps.deviceId);
  const layout: DriveSyncLayout = { workFolderName: uid.workUid, deviceId: deps.deviceId, deviceName: deps.deviceName };
  const result = await runDriveWorkSync({
    client: deps.auth.driveClient(),
    layout,
    local: files.local,
    writer: files.writer,
    record: loaded.record,
    ignoredPaths: DRIVE_IGNORED_PATHS,
    now: new Date(),
    sizes: receiveOnly ? new Map() : await files.sizes(),
    receiveOnly,
  });
  if (result.kind === "done" && result.recordChanged) await writeRecord(work, deps.deviceId, result.record);
  const notice = describeDriveWorkSync(work.title, result);
  logLine(`[drive] ${notice.text}`);
  if (result.kind === "done" && result.receive.kind === "received") {
    if (result.receive.written.length > 0) await deps.afterReceived?.(work);
    await writePendingConflicts(deps.storage, work.id, result.receive.conflicts.map((c) => c.decision.path));
    return { line: notice, reports: result.receive.conflicts };
  }
  return { line: notice, reports: [] };
}

/**
 * 食い違いを作者に選んでもらう（設計書5.10.4・5.10.7）。同じ場所だけを選ぶ報告
 * （`merge`）は場所ごとに、ほかはファイルごとに、今の「残す文を選ぶ」と同じ見比べで。
 * 途中でやめたら、その作品のそこから先は何も書かない
 */
export async function chooseDriveConflicts(
  deps: DriveSyncDeps,
  work: WorkEntry,
  reports: readonly DriveConflictReport[]
): Promise<void> {
  useLogFile(work.folderPath);
  const files = workFiles(work, deps.deviceId);
  const pending = new Set(readPendingConflicts(deps.storage, work.id));
  let wrote = false;
  for (const report of reports) {
    const loaded = await readRecord(work, deps.deviceId);
    if (!loaded.ok) {
      void vscode.window.showWarningMessage(`「${work.title}」の控えが読めないので、選んだものを書いていません（${loaded.reason}）。`);
      return;
    }
    const done =
      report.merge && report.merge.text.regions.length > 0
        ? await chooseRegions(deps, work, report, loaded.record, files.writer)
        : await chooseWholeFile(deps, work, report, loaded.record, files.writer);
    if (done === "cancelled") break;
    if (done === "failed") continue;
    await writeRecord(work, deps.deviceId, done);
    pending.delete(report.decision.path);
    wrote = true;
  }
  await writePendingConflicts(deps.storage, work.id, [...pending]);
  if (wrote) {
    await deps.afterReceived?.(work);
    void vscode.window.showInformationMessage(
      `「${work.title}」で選んだ文を残しました。もう1台へは次の［保存・同期］で届きます。`
    );
  }
}

const HERE = "このパソコン";

async function chooseWholeFile(
  deps: DriveSyncDeps,
  work: WorkEntry,
  report: DriveConflictReport,
  record: DriveSyncRecord,
  writer: LocalWorkWriter
): Promise<DriveSyncRecord | "cancelled" | "failed"> {
  const entry = report.decision.path;
  const fileName = entry.split("/").pop() ?? entry;
  const decoder = new TextDecoder();
  const ours = report.localBytes === undefined ? "" : decoder.decode(report.localBytes);
  const namesOf = (remote: DriveConflictReport["remotes"][number]) => remote.devices.map((d) => d.deviceName).join("・");
  const showDiff = async (remote: DriveConflictReport["remotes"][number]) => {
    const key = `${work.id}-${Date.now()}`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      deps.compare.register(key, HERE, ours),
      deps.compare.register(key, namesOf(remote), decoder.decode(remote.bytes)),
      `${fileName}：${HERE} ↔ ${namesOf(remote)}`,
      { preview: true }
    );
  };
  await showDiff(report.remotes[0]);

  type Item = vscode.QuickPickItem & { act: "local" | "remote" | "both" | "view"; peer?: string; remoteIndex?: number };
  const items: Item[] = [];
  if (report.localBytes !== undefined) items.push({ label: `$(arrow-left) ${HERE}の文を残す`, act: "local" });
  // このパソコンで消した × もう1台で書いた：消したままにする道が無いと、選べずに控えに残り続ける
  else if (report.decision.local !== null) items.push({ label: `$(trash) ${HERE}で消したままにする`, act: "local" });
  report.remotes.forEach((remote, index) => {
    items.push({ label: `$(arrow-right) ${namesOf(remote)}の文を残す`, act: "remote", peer: remote.devices[0].deviceId, remoteIndex: index });
  });
  if (report.localBytes !== undefined) items.push({ label: "$(files) 両方とも残す", act: "both" });
  if (report.remotes.length > 1) {
    report.remotes.forEach((remote, index) => {
      items.push({ label: `$(diff) ${namesOf(remote)}の文と見比べる`, act: "view", remoteIndex: index });
    });
  }
  for (;;) {
    const picked = await showQuickPickKeepingFocus([...items, cancelItem()], {
      title: `${fileName}：どの文を残しますか`,
      ignoreFocusOut: true,
    });
    if (!picked || !("act" in picked)) return "cancelled";
    if (picked.act === "view") {
      await showDiff(report.remotes[picked.remoteIndex as number]);
      continue;
    }
    let sidePaths: Map<string, string> | undefined;
    if (picked.act === "both") {
      // 選ばなかった候補（相手の全部）を、同じフォルダーの別の名前で新しく置く
      const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
      const taken = new Set(await namesInWorkFolder(work, dir));
      sidePaths = new Map();
      for (const remote of report.remotes) {
        const name = sideFileName(fileName, new Date(), taken);
        taken.add(name);
        sidePaths.set(remote.lineage.hash, `${dir}${name}`);
      }
    }
    const result = await applyDriveConflictChoice({
      report,
      choice: picked.act,
      record,
      writer,
      peerDeviceId: picked.act === "remote" ? picked.peer : undefined,
      sidePaths,
    });
    if (!result.ok) {
      void vscode.window.showWarningMessage(`「${entry}」は書いていません。${result.reason}。`);
      return "failed";
    }
    if (sidePaths) {
      void vscode.window.showInformationMessage(`もう1台の文は「${[...sidePaths.values()].join("」「")}」に残しました。`);
    }
    return result.record;
  }
}

async function chooseRegions(
  deps: DriveSyncDeps,
  work: WorkEntry,
  report: DriveConflictReport,
  record: DriveSyncRecord,
  writer: LocalWorkWriter
): Promise<DriveSyncRecord | "cancelled" | "failed"> {
  const merge = report.merge as NonNullable<DriveConflictReport["merge"]>;
  const entry = report.decision.path;
  const fileName = entry.split("/").pop() ?? entry;
  const devicesOf = new Map(
    merge.candidates.map((candidate) => [
      candidate.hash,
      candidate.local ? [HERE] : candidate.devices.map((device) => device.deviceName),
    ])
  );
  const picks: number[] = [];
  const regions = merge.text.regions;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const items = region.options.map((option, index) => ({
      label: [...new Set(option.candidates.flatMap((id) => devicesOf.get(id) ?? []))].join("・"),
      detail: option.lines.length === 0 ? "（この場所を消す）" : option.lines.join(" ⏎ "),
      index,
    }));
    const base = region.baseLines.join(" ⏎ ");
    const picked = await showQuickPickKeepingFocus([...items, cancelItem()], {
      title: `${fileName}：2台で同じ所を書き換えています（${i + 1}／${regions.length}）`,
      placeHolder: base === "" ? "元の文：（ここには何もありませんでした）" : `元の文：${base}`,
      ignoreFocusOut: true,
      matchOnDetail: true,
    });
    if (!picked || !("index" in picked)) return "cancelled";
    picks.push(picked.index);
  }
  const result = await applyDriveMergeChoice({ report, picks, record, writer });
  if (!result.ok) {
    void vscode.window.showWarningMessage(`「${entry}」は書いていません。${result.reason}。`);
    return "failed";
  }
  return result.record;
}

/**
 * 送り先を切り替える（設計書5.10.5）。**未送信・食い違い・未保存を残したまま移らない**。
 * 編集者モードでは切り替えない（編集部との受け渡しは GitHub の道で作ってある）
 */
export async function switchSyncDestination(deps: DriveSyncDeps, work: WorkEntry): Promise<void> {
  if (isEditorMode()) {
    void vscode.window.showInformationMessage("編集者モードでは送り先を切り替えられません。");
    return;
  }
  const current = destinationOf(deps.storage, work.id);
  const toDrive = { label: "$(cloud) Google ドライブ", to: "googleDrive" as const };
  const toGithub = { label: "$(github) GitHub", to: "github" as const };
  const picked = await showQuickPickKeepingFocus([current === "github" ? toDrive : toGithub, cancelItem()], {
    title: `「${work.title}」の送り先（いま：${current === "github" ? "GitHub" : "Google ドライブ"}）`,
    ignoreFocusOut: true,
  });
  if (!picked || !("to" in picked)) return;
  const unsavedFiles = unsavedCountInside(work.folderPath);

  if (picked.to === "googleDrive") {
    const loggedIn = await deps.auth.isLoggedIn();
    const git = gitStateOf(deps, work);
    const uid = await workUidState(work);
    const check = checkSwitchToDrive({ unsavedFiles, git: git ?? { kind: "none" }, workUid: uid, loggedIn });
    const reasons = check.ok ? [] : [...check.reasons];
    if (git === undefined) reasons.push("GitHub の様子をまだ読めていません。少し待ってから、もう一度切り替えてください");
    if (reasons.length > 0) {
      await refuse(work, reasons, !loggedIn ? deps.auth : undefined);
      return;
    }
    // 番号の無い作品は、ここで作って書く（既にある番号は変えない。設計書6.13.7）
    const ensured = await ensureWorkUid(work, { allowAdd: true });
    if (ensured.kind !== "ready") {
      await refuse(work, [ensured.reason], undefined);
      return;
    }
    // Git の除外の行は切り替えるときに足す（2台とも、送る前に同じ1行が入る）
    await ensureOnUseIgnoreRule(work.folderPath, DRIVE_SYNC_RECORD_IGNORE_RULE);
    await writeDestination(deps.storage, work.id, "googleDrive");
    logLine(`[drive] 送り先を Google ドライブにしました：${work.title}`);
    const sync = "保存・同期";
    whenNoticePicked(
      vscode.window.showInformationMessage(
        `「${work.title}」の送り先を Google ドライブにしました。［保存・同期］で送ります。もう1台でも同じように切り替えてください。`,
        sync
      ),
      (answer) => (answer === sync ? vscode.commands.executeCommand("novelai.saveAndSync") : undefined),
      { label: "送り先の切り替え", workFolder: work.folderPath }
    );
    return;
  }

  // Google ドライブ → GitHub
  const loaded = await readRecord(work, deps.deviceId);
  let unsent: string[] | undefined;
  if (loaded.ok) {
    const files = workFiles(work, deps.deviceId);
    const local = new Map<string, string>();
    for (const entry of await files.local.list()) {
      const bytes = await files.local.read(entry);
      if (bytes !== undefined) local.set(entry, hashBytes(bytes));
    }
    unsent = findDriveUnsent({
      record: loaded.record,
      local,
      isSendable: (entry) => isSendableSyncPath(entry, { ownDeviceId: deps.deviceId, ignoredPaths: DRIVE_IGNORED_PATHS }),
    });
  }
  const check = checkSwitchToGithub({
    unsavedFiles,
    unsent,
    pendingConflicts: readPendingConflicts(deps.storage, work.id),
  });
  if (!check.ok) {
    await refuse(work, check.reasons, undefined);
    return;
  }
  await writeDestination(deps.storage, work.id, "github");
  logLine(`[drive] 送り先を GitHub に戻しました：${work.title}`);
  void vscode.window.showInformationMessage(
    `「${work.title}」の送り先を GitHub に戻しました。Google ドライブの写しは消していません。`
  );
}

async function refuse(work: WorkEntry, reasons: readonly string[], auth: GoogleDriveAuth | undefined): Promise<void> {
  const login = "ログインする";
  whenNoticePicked(
    vscode.window.showWarningMessage(
      `「${work.title}」の送り先は切り替えていません。${reasons.join("。")}。`,
      ...(auth ? [login] : [])
    ),
    (picked) => (picked === login && auth ? auth.login() : undefined),
    { label: "送り先の切り替え", workFolder: work.folderPath }
  );
}

/** 作品の番号の様子（足さずに読むだけ） */
async function workUidState(work: WorkEntry): Promise<"present" | "absent" | "invalid"> {
  const result = await ensureWorkUid(work, { allowAdd: false });
  if (result.kind === "ready") return "present";
  return /形が違います|読めません/.test(result.reason) ? "invalid" : "absent";
}

/** git の置き場の様子（切り替えの判断に要る所だけ）。まだ読めていなければ undefined */
function gitStateOf(deps: DriveSyncDeps, work: WorkEntry): WorkGitState | undefined {
  const status = deps.gitStatusOf(work.id);
  if (!status) return undefined;
  if (status.kind === "git_missing" || status.kind === "not_a_repo") return { kind: "none" };
  // 状態を読めなかった。分からないまま移らない
  if (status.kind === "failed") return undefined;
  const root = status.root;
  const sharedWith = deps.registry
    .list()
    .filter(
      (other) =>
        other.id !== work.id &&
        !isDriveWork(deps.storage, other) &&
        (path.isSamePath(other.folderPath, root) || path.isPathInside(root, other.folderPath))
    )
    .map((other) => other.title);
  if (status.kind === "detached") return { kind: "repo", unsent: false, behind: false, conflicted: true, sharedWith };
  if (status.kind === "tracked") {
    return {
      kind: "repo",
      unsent: status.aheadHere > 0 || status.dirtyHere > 0,
      behind: status.behindHere > 0,
      conflicted: status.unmerged > 0,
      sharedWith,
    };
  }
  return { kind: "repo", unsent: status.dirtyHere > 0, behind: false, conflicted: false, sharedWith };
}

/** 手元の作品のフォルダーの読み書きの口（core の `LocalWorkFiles`・`LocalWorkWriter`） */
export function workFiles(work: WorkEntry, deviceId: string): {
  local: LocalWorkFiles;
  writer: LocalWorkWriter;
  sizes(): Promise<Map<string, number>>;
} {
  const root = work.folderPath;
  const abs = (entry: string) => path.join(root, ...entry.split("/"));
  const baseDir = path.join(root, ...driveBasePath(deviceId, "x").split("/").slice(0, -1));

  const readOrUndefined = async (location: string): Promise<Uint8Array | undefined> => {
    try {
      return await vscode.workspace.fs.readFile(path.toUri(location));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };

  /** 送らないフォルダー（`.git/`・回復先・キャッシュ等）は中まで降りない（読む量を減らす） */
  const skipDir = (entry: string) =>
    entry === ".git" ||
    DRIVE_IGNORED_PATHS.some((rule) => rule.endsWith("/") && `${entry}/` === rule) ||
    `${entry}/` === ".aiwriter/drive-sync/";

  const walk = async (): Promise<{ entry: string; size?: number }[]> => {
    const out: { entry: string; size?: number }[] = [];
    const visit = async (dir: string) => {
      let children: [string, vscode.FileType][];
      try {
        children = await vscode.workspace.fs.readDirectory(path.toUri(dir === "" ? root : abs(dir)));
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const [name, type] of children) {
        const entry = dir === "" ? name : `${dir}/${name}`;
        if ((type & vscode.FileType.Directory) !== 0) {
          if (!skipDir(entry)) await visit(entry);
        } else if ((type & vscode.FileType.File) !== 0) {
          out.push({ entry });
        }
      }
    };
    await visit("");
    return out;
  };

  const local: LocalWorkFiles = {
    list: async () => (await walk()).map((item) => item.entry),
    read: (entry) => readOrUndefined(abs(entry)),
    listBases: async () => {
      try {
        return (await vscode.workspace.fs.readDirectory(path.toUri(baseDir)))
          .filter(([, type]) => (type & vscode.FileType.File) !== 0)
          .map(([name]) => name);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },
    readBase: (hash) => readOrUndefined(path.join(root, ...driveBasePath(deviceId, hash).split("/"))),
  };

  const create = async (location: string, bytes: Uint8Array): Promise<LocalWriteOutcome> => {
    try {
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(location)));
      await atomicWriteFile(location, bytes, { mode: "create" });
    } catch (error) {
      return { ok: false, reason: `新しく置けませんでした（${error instanceof Error ? error.message : String(error)}）` };
    }
    const written = await readOrUndefined(location);
    return written ? { ok: true, writtenHash: hashBytes(written) } : { ok: false, reason: "置いたファイルが読めません" };
  };

  const writer: LocalWorkWriter = {
    replace: async (entry, bytes, expectedLocalHash) => {
      const location = abs(entry);
      const result = await replaceFileWithReceivedBytes(location, bytes, expectedLocalHash);
      if (!result.ok) return { ok: false, reason: describeWriteFailure(result.reason, result.detail) };
      const written = await readOrUndefined(location);
      return written ? { ok: true, writtenHash: hashBytes(written) } : { ok: false, reason: "書いたファイルが読めません" };
    },
    create: async (entry, bytes) => {
      const location = abs(entry);
      if (hasUnsavedChanges(location)) return { ok: false, reason: "保存していない文書が開いています" };
      // 既にあるファイルの置き換え（`replaceFileWithReceivedBytes`）と同じく、マーカー入りの中身は置かない
      if (decodeBytes(bytes).hasConflictMarkers) return { ok: false, reason: "競合マーカーがあります" };
      return create(location, bytes);
    },
    writeBase: async (hash, bytes) => {
      const location = path.join(root, ...driveBasePath(deviceId, hash).split("/"));
      // 名前が中身のハッシュなので、既にあれば同じ中身
      if ((await readOrUndefined(location)) !== undefined) return { ok: true, writtenHash: hash };
      return create(location, bytes);
    },
    removeBase: async (hash) => {
      // 消すのは置き場の中だけ（名前はハッシュの形しか来ない。core が確かめてから渡す）
      if (!/^[0-9a-f]{64}$/.test(hash)) return;
      try {
        await vscode.workspace.fs.delete(path.toUri(path.join(baseDir, hash)), { useTrash: false });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };

  const sizes = async () => {
    const out = new Map<string, number>();
    for (const { entry } of await walk()) {
      if (!isSendableSyncPath(entry, { ownDeviceId: deviceId, ignoredPaths: DRIVE_IGNORED_PATHS })) continue;
      try {
        out.set(entry, (await vscode.workspace.fs.stat(path.toUri(abs(entry)))).size);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return out;
  };

  return { local, writer, sizes };
}

function describeWriteFailure(reason: string, detail: string | undefined): string {
  switch (reason) {
    case "unsaved_changes":
      return "保存していない文書が開いています";
    case "modified_externally":
      return "読んだあとで変わっています";
    case "conflict_markers":
      return "競合マーカーがあります";
    case "editor_locked":
      return detail ?? "編集部が校閲中です";
    default:
      return detail ?? "書けませんでした";
  }
}

/** この端末の控えを読む。無ければ空。**壊れていれば直さず止める** */
export async function readRecord(
  work: WorkEntry,
  deviceId: string
): Promise<{ ok: true; record: DriveSyncRecord } | { ok: false; reason: string }> {
  const location = path.join(work.folderPath, ...driveSyncRecordPath(deviceId).split("/"));
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(location));
  } catch (error) {
    if (isNotFound(error)) return { ok: true, record: emptyDriveSyncRecord(deviceId) };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return parseDriveSyncRecord(new TextDecoder().decode(bytes), deviceId);
}

/** 控えを書く（毎回書き換わる控えなので `atomicWriteFile` の指定なし①。Git の除外は使った作品にだけ足す） */
export async function writeRecord(work: WorkEntry, deviceId: string, record: DriveSyncRecord): Promise<void> {
  await ensureOnUseIgnoreRule(work.folderPath, DRIVE_SYNC_RECORD_IGNORE_RULE);
  const location = path.join(work.folderPath, ...driveSyncRecordPath(deviceId).split("/"));
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(location)));
  await atomicWriteFile(location, new TextEncoder().encode(serializeDriveSyncRecord(record)));
}

async function namesInWorkFolder(work: WorkEntry, dir: string): Promise<string[]> {
  try {
    const location = dir === "" ? work.folderPath : path.join(work.folderPath, ...dir.replace(/\/$/, "").split("/"));
    return (await vscode.workspace.fs.readDirectory(path.toUri(location))).map(([name]) => name);
  } catch {
    return [];
  }
}

function unsavedCountInside(root: string): number {
  return vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && path.isPathInside(root, path.fromUri(document.uri))
  ).length;
}

function hasUnsavedInside(root: string): boolean {
  return unsavedCountInside(root) > 0;
}

