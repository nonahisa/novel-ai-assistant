/**
 * 画面の自動テストが起こした VS Code を**必ず止め、一時フォルダーを消す**（設計書6.113）。
 *
 * 2026-10-03、`npm run test:e2e` のテスト用 VS Code が2つ、画面の外に置かれたまま
 * 動き続けていた（作者のタスクバーに黒い窓として見えた）。1件ごとの片づけ
 * （`withVsCode` の finally）だけでは、**テストが時間切れになったり、走りを途中で
 * 止めたりすると届かない**。そこで：
 *
 * - 起こすたびに、その一時フォルダーの根（と分かれば PID）を**台帳のファイルへ書き足す**。
 *   vitest の globalSetup はテストと別のプロセスで走るので、覚えておく先はファイルにする
 * - 1件ごとの片づけと、走りの最初と最後（globalSetup とその後始末）で、台帳に載った
 *   ものを**プロセスの木ごと**止め、一時フォルダーを消す。最初にも見るのは、
 *   前の走りが途中で止められて残したものを拾うため
 * - **止める相手は、起動の引数に一時フォルダーの名前を含むプロセスだけ。**
 *   `Code.exe` を名前で止めると作者の VS Code まで落ちる。PID だけで止めると、
 *   番号が別のプロセスへ使い回されていたときに無関係のものを止める
 *
 * 失敗したときの画面の写真（`novelai-e2e-screenshots`）は台帳に載せない（残す）。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * 台帳の置き場。**作業場ごとに分ける**——別の作業場で同時に走っている
 * テストの VS Code を、こちらの後始末が止めないようにする
 */
const LEDGER = path.join(
  tmpdir(),
  `novelai-e2e-launched-${createHash("sha1").update(repositoryRoot).digest("hex").slice(0, 10)}.jsonl`
);

interface LaunchEntry {
  /** 一時フォルダーの根（作品・user-data・拡張機能の置き場がこの下にある） */
  root: string;
  /** 起こした Code.exe の PID。起動の途中で落ちたときは無い */
  pid?: number;
  /** 1件ごとの片づけが済んだ（走りの最後に見直さなくてよい） */
  done?: boolean;
}

/** 起こす前・起こした直後に台帳へ書き足す（同じ根が2行になってもよい） */
export async function recordLaunch(entry: LaunchEntry): Promise<void> {
  await appendFile(LEDGER, JSON.stringify(entry) + "\n", "utf8");
}

async function readLedger(): Promise<LaunchEntry[]> {
  let text: string;
  try {
    text = await readFile(LEDGER, "utf8");
  } catch {
    return [];
  }
  const entries: LaunchEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LaunchEntry);
    } catch {
      // 書きかけの行（書き足しの途中で止められた）は読み飛ばす
    }
  }
  return entries;
}

/**
 * 起動の引数に `marker` を含むプロセスの PID（Windows だけ。ほかは空）。
 * **問い合わせている PowerShell 自身も引数に marker を含む**ので、自分を除く
 */
async function processesWithMarker(marker: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  // 一時フォルダーの名前は英数字と「-」だけ（mkdtemp の形）なので、そのまま埋めてよい
  if (!/^[A-Za-z0-9_-]+$/.test(marker)) return [];
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { windowsHide: true, timeout: 30_000 }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** その PID の起動の引数に marker が含まれるか（番号の使い回しに当たらないため） */
async function pidHasMarker(pid: number, marker: string): Promise<boolean> {
  return (await processesWithMarker(marker)).includes(pid);
}

/** プロセスを木ごと止める。もう居なければ何もしない */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // もう居ない
  }
}

/**
 * 1回ぶんの起動を止めて、一時フォルダーを消す。
 * PID が分かっていても、**引数に一時フォルダーの名前を含むことを確かめてから**止める
 */
export async function stopLaunch(entry: LaunchEntry): Promise<void> {
  const marker = path.basename(entry.root);
  if (entry.pid !== undefined) {
    if (process.platform !== "win32" || (await pidHasMarker(entry.pid, marker))) {
      await killTree(entry.pid);
    }
  }
  // 親が先に居なくなって木から外れた子（拡張機能ホストなど）も、引数で拾って止める
  for (const pid of await processesWithMarker(marker)) await killTree(pid);
  // Windows は止めた直後にファイルを掴んでいることがあるので、何度か試す
  await rm(entry.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
    () => undefined
  );
  if (!existsSync(entry.root) && (await processesWithMarker(marker)).length === 0) {
    await recordLaunch({ root: entry.root, done: true });
  }
}

/** 台帳に載ったもののうち、片づけ済みでないものを止めて消し、台帳も消す（走りの最初と最後） */
export async function sweepLaunches(): Promise<void> {
  const entries = await readLedger();
  const byRoot = new Map<string, LaunchEntry>();
  for (const entry of entries) {
    const known = byRoot.get(entry.root);
    byRoot.set(entry.root, {
      root: entry.root,
      pid: entry.pid ?? known?.pid,
      done: (entry.done ?? false) || (known?.done ?? false),
    });
  }
  for (const entry of byRoot.values()) {
    if (entry.done) continue;
    await stopLaunch(entry);
    console.error(`[E2E] 残っていたテスト用 VS Code と一時フォルダーを片づけました: ${entry.root}`);
  }
  await rm(LEDGER, { force: true }).catch(() => undefined);
}
