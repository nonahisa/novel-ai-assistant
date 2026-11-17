// ログの書き先：機械ごとの話で、どの作品のログでもないので保管庫のログへ倒す（IME 連動と同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import { atomicWriteFile } from "../core/atomicWrite";
import { DriveApiError, driveNextAction, type DriveClient } from "../core/driveApi";
import { imeStateDir } from "../core/imeCurrentWork";
import {
  IME_SENDER_FILE,
  buildImeSenderJson,
  imeCoreExecutable,
  parseImeSyncInfo,
  runImeLearningSync,
  type ImeEngine,
  type ImeSyncInfo,
} from "../core/imeLearningSync";
import { logLine } from "../core/logger";
import { canRunProcesses, environmentVariable, hostPlatform, randomHex } from "../core/runtime";

/**
 * オリジナルIME の学習を Google ドライブでそろえる（設計書5.10.8。段階3）。
 * 手順・写しの確かめ・ドライブの読み書きは `core/imeLearningSync.ts`（`runImeLearningSync`）。
 * ここはエンジン（`novel-ime-core`）を起こす口と、送り手の印（`sender.json`）を書く所だけ。
 *
 * **設定（`novelai.googleDrive.syncImeLearning`、既定 off）を入れたときだけ動く**。off の間は
 * エンジンを起こすことも含めて何もしない（本物での往復を確かめてから作者が入れる）。
 * エンジンの無い機械・ブラウザ版・リモートでも何もしない。
 *
 * - エンジンは引数を配列で渡して直に起こす（シェルを通さない）。`node:child_process`・
 *   `node:os` は動的 import（実装ルール7）
 * - 写しは一時のフォルダー（OS の一時の所の下、`novelai-ime-sync-<乱数>`）に置き、終わったら消す
 * - **打った文は外へ出さない**——送るのはエンジンが書いた写しだけ。記録の置き場で書くのは
 *   `sender.json` だけで、ほかのファイルは開かない
 * - 送り手の印は**送れたときと、送れる見込みのあるとき**（Google ドライブの作品があり、
 *   ログインしている）だけ書く。送れないのに書くと、IME の同期のアプリが送るのをやめ、
 *   誰も送らなくなる
 * - 失敗しても作者の作業を止めない。知らせは出さず、ログへ残す
 */

/** 設定の名前（package.json の `novelai.googleDrive.syncImeLearning`） */
export const IME_LEARNING_SYNC_SETTING = "googleDrive.syncImeLearning";

/** エンジンを待つ上限 */
const ENGINE_TIMEOUT_MS = 60 * 1000;

export function imeLearningSyncEnabled(): boolean {
  return vscode.workspace.getConfiguration("novelai").get<boolean>(IME_LEARNING_SYNC_SETTING, false);
}

/** エンジンの場所。設定が off・ブラウザ版・リモート・エンジンの無い機械では undefined */
async function findEngine(): Promise<string | undefined> {
  if (!imeLearningSyncEnabled() || !canRunProcesses() || vscode.env.remoteName) return undefined;
  const platform = hostPlatform();
  let home: string | undefined;
  if (platform === "darwin") {
    try {
      home = (await import("node:os")).homedir();
    } catch {
      home = environmentVariable("HOME");
    }
  }
  const exe = imeCoreExecutable(imeStateDir({ platform, localAppData: environmentVariable("LOCALAPPDATA"), home }), platform);
  if (!exe) return undefined;
  try {
    const stat = await vscode.workspace.fs.stat(path.toUri(exe));
    return (stat.type & vscode.FileType.File) !== 0 ? exe : undefined;
  } catch {
    return undefined;
  }
}

interface EngineRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runEngine(exe: string, args: readonly string[]): Promise<EngineRun> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      exe,
      [...args],
      { timeout: ENGINE_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

async function syncInfo(exe: string): Promise<ImeSyncInfo | string> {
  const run = await runEngine(exe, ["sync-info"]);
  if (run.code !== 0) return `sync-info が終了コード ${run.code}`;
  return parseImeSyncInfo(run.stdout);
}

async function writeSenderFile(dir: string, machineId: string, version: string): Promise<void> {
  await atomicWriteFile(
    path.join(dir, IME_SENDER_FILE),
    new TextEncoder().encode(buildImeSenderJson({ version, machineId, at: new Date() }))
  );
}

/**
 * 送り手の印を書き直す（起動するたびと1日1回。設計書5.10.8）。`canSend` が偽
 * （Google ドライブの作品が無い・ログインしていない）なら書かない
 */
export async function refreshImeSender(version: string, canSend: () => Promise<boolean>): Promise<void> {
  try {
    const exe = await findEngine();
    if (!exe || !(await canSend())) return;
    const info = await syncInfo(exe);
    if (typeof info === "string") {
      logLine(`六徳 IME の送り手の印を書いていません（${info}）`);
      return;
    }
    await writeSenderFile(info.dir, info.machineId, version);
  } catch (error) {
    logLine(`六徳 IME の送り手の印を書けませんでした（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/**
 * この機械の写しを送り、ほかの機械の写しを `sync-in` へ渡す。［保存・同期］の
 * Google ドライブの分のあとに1回走る（作品ごとではない。学習は機械ごと）
 */
export async function syncImeLearning(input: { client: DriveClient; version: string }): Promise<void> {
  const exe = await findEngine();
  if (!exe) return;
  let tempDir: string | undefined;
  try {
    const os = await import("node:os");
    tempDir = path.join(os.tmpdir(), `novelai-ime-sync-${randomHex(6)}`);
    await vscode.workspace.fs.createDirectory(path.toUri(tempDir));
    const temp = tempDir;
    let infoDir: string | undefined;
    const engine: ImeEngine = {
      info: async () => {
        const info = await syncInfo(exe);
        if (typeof info !== "string") infoDir = info.dir;
        return info;
      },
      exportAll: async () => {
        const outFile = path.join(temp, "out.jsonl");
        const run = await runEngine(exe, ["sync-out", "--all", "--file", outFile]);
        logLine(`六徳 IME の写しを作りました（終了コード ${run.code}）${run.stderr.trim()}`);
        if (run.code !== 0) return `sync-out が終了コード ${run.code}`;
        try {
          return await vscode.workspace.fs.readFile(path.toUri(outFile));
        } catch {
          // `--file` を知らない古いエンジン（写しを書かない）
          return "写しがありません（--all・--file のあるエンジンが要ります）";
        }
      },
      importExport: async (machineId, bytes) => {
        const file = path.join(temp, `in-${machineId}.jsonl`);
        await atomicWriteFile(file, bytes, { mode: "create" });
        const run = await runEngine(exe, ["sync-in", file]);
        logLine(`六徳 IME の学習を受け取りました（${machineId}、終了コード ${run.code}）${run.stdout.trim()}`);
      },
    };
    const result = await runImeLearningSync({
      engine,
      client: input.client,
      writeSender: async (machineId) => {
        if (infoDir) await writeSenderFile(infoDir, machineId, input.version);
      },
    });
    if (typeof result === "string") {
      logLine(`六徳 IME の学習をそろえませんでした（${result}）`);
      return;
    }
    if (result.sent !== true) logLine(`六徳 IME の学習を送っていません（${result.sent}）`);
    for (const skipped of result.skipped) {
      logLine(`六徳 IME の写しを受け取っていません（${skipped.machineId}：${skipped.reason}）`);
    }
  } catch (error) {
    if (error instanceof DriveApiError) {
      logLine(`六徳 IME の学習をそろえられませんでした（${error.kind}）。${driveNextAction(error.kind)}`);
    } else {
      logLine(`六徳 IME の学習をそろえられませんでした（${error instanceof Error ? error.message : String(error)}）`);
    }
  } finally {
    if (tempDir) {
      try {
        await vscode.workspace.fs.delete(path.toUri(tempDir), { recursive: true, useTrash: false });
      } catch {
        // 一時の所は OS が片づける
      }
    }
  }
}
