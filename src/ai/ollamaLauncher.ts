import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { childProcessEnv } from "./childProcessEnv";
import { logFailure, logStep } from "../core/logger";

/**
 * Ollamaサーバーの起動を支援する。
 *
 * Ollamaはインストールしても自動起動しない環境が多く、
 * 「AIに接続できません」と言われるたびに作者が手動で立ち上げるのは煩わしい。
 * ただし勝手に起動はせず、必ず作者に確認してから呼ぶこと。
 */

/** 起動を試みてよいか。リモートのOllamaはこちらからは起動できない */
export function isLocalEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * 実行ファイルの候補を、探す順に返す。
 *
 * **既定の置き場所を先、PATHを後にする**（`lmstudioLauncher.ts` と同じ順）。
 *
 * 逆にしていたせいで、**PATHの候補が存在確認なしで必ず返り、実在する
 * インストール先が一度も試されなかった**（`resolveExecutable` は
 * 区切りを含まない候補をPATH解決に任せてそのまま返す）。コメントは
 * 「PATHが通っていない環境のために既定のインストール先も見る」と
 * 書いてあったが、そこへ到達する道が無かった。
 *
 * **Windowsでは現実に起こる**：インストーラがPATHを更新しても、
 * すでに動いているVS Codeの環境には反映されない。入れた直後に
 * 起動を試すと「見つからない」で失敗する（作者の報告
 * 「Ollamaが自動で立ち上がりません」2026-08-30）。0.28.14
 */
export function executableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): string[] {
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
      path.join(programFiles, "Ollama", "ollama.exe"),
      "ollama.exe",
    ];
  }
  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin/ollama",
      "/usr/local/bin/ollama",
      "/Applications/Ollama.app/Contents/Resources/ollama",
      "ollama",
    ];
  }
  return ["/usr/local/bin/ollama", "/usr/bin/ollama", "ollama"];
}

/**
 * 実行ファイルの場所を決める。
 * 見つからなければ undefined（＝インストールされていない可能性）。
 */
export async function resolveExecutable(
  configuredPath?: string,
  candidates: string[] = executableCandidates()
): Promise<string | undefined> {
  const configured = configuredPath?.trim();
  if (configured) {
    // 明示指定は存在確認だけして、そのまま使う（作者の指定を尊重する）
    return (await isExecutableFile(configured)) ? configured : undefined;
  }

  for (const candidate of candidates) {
    // パス区切りを含まないものはPATH解決に任せるため、存在確認をしない
    if (!candidate.includes(path.sep) && !candidate.includes("/")) {
      return candidate;
    }
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export type StartOutcome =
  | { ok: true }
  | { ok: false; reason: "not_installed" | "spawn_failed" | "timeout"; detail?: string };

export interface StartOptions {
  endpoint: string;
  /** 設定で明示された実行ファイルのパス */
  executablePath?: string;
  /** 起動を待つ上限。初回起動は数秒かかる */
  timeoutMs?: number;
  /** 疎通確認。テストから差し替えられるようにする */
  probe?: (endpoint: string) => Promise<boolean>;
}

/**
 * Ollamaサーバーを起動し、応答するまで待つ。
 *
 * VSCodeを閉じてもサーバーが残るよう、切り離した子プロセスとして起動する。
 * これはOllamaを手動で起動した場合と同じ状態であり、
 * 拡張機能の終了に巻き込んで止めると、他のツールの利用を妨げるため。
 */
export async function startOllama(
  options: StartOptions
): Promise<StartOutcome> {
  // **各段を残す。** LM Studioで「起動しない」と報告されたとき、
  // 起動処理が一切ログを書いておらず**何が起きたか確かめられなかった**
  // （設計書6.24）。Ollamaでも同じ報告を受けて同じ状況になったので、
  // 同じ扱いに揃える（0.28.14）
  const exe = await resolveExecutable(options.executablePath);
  if (!exe) {
    logFailure("Ollamaの起動", {
      理由: "実行ファイルが見つからない",
      探した場所: executableCandidates().join(" / "),
      設定: options.executablePath ?? "（未指定）",
    });
    return { ok: false, reason: "not_installed" };
  }
  logStep(`Ollama：起動を試みます（${exe} serve）`);

  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.timeoutMs ?? 30000;
  const startedAt = Date.now();

  try {
    const child = spawn(exe, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // 拡張機能ホストの環境をそのまま継がせない（`childProcessEnv.ts`）。
      // Ollamaは Electron ではないので今のところ害は無いが、
      // **同じ穴を2か所に残さない**——LM Studioでは60秒の時間切れになった
      env: childProcessEnv(),
    });

    // spawn自体の失敗（実行ファイルが無い等）は非同期で飛んでくる
    const spawnError = await new Promise<Error | undefined>((resolve) => {
      const onError = (e: Error) => resolve(e);
      child.once("error", onError);
      // エラーが来なければ起動したとみなす
      setTimeout(() => {
        child.removeListener("error", onError);
        resolve(undefined);
      }, 300);
    });
    if (spawnError) {
      logFailure("Ollamaの起動", { 場所: exe, 内容: spawnError.message });
      return { ok: false, reason: "spawn_failed", detail: spawnError.message };
    }

    child.unref();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logFailure("Ollamaの起動", { 場所: exe, 内容: detail });
    return { ok: false, reason: "spawn_failed", detail };
  }

  // 起動しても即座には応答しないため、応答するまで待つ
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(options.endpoint)) {
      logStep(`Ollama：応答を確認しました（${Date.now() - startedAt}ミリ秒）`);
      return { ok: true };
    }
    await delay(500);
  }
  logFailure("Ollamaの起動", {
    場所: exe,
    理由: `${Math.round(timeoutMs / 1000)}秒待っても応答しませんでした`,
    接続先: options.endpoint,
  });
  return { ok: false, reason: "timeout" };
}

async function defaultProbe(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 選択された実行ファイルが妥当か検証する。
 *
 * 選択ダイアログは何でも選べてしまうため、明らかに違うものを
 * 設定に書き込む前に気づけるようにする。
 * ただしOllamaはリネームやラッパー経由でも使われうるので、
 * 名前が違うだけでは拒否せず「確認が必要」に留める。
 */
export type ExecutableCheck =
  | { verdict: "ok" }
  | { verdict: "missing" }
  | { verdict: "suspicious"; reason: string };

export async function checkSelectedExecutable(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<ExecutableCheck> {
  if (!(await isExecutableFile(filePath))) return { verdict: "missing" };

  const base = path.basename(filePath).toLowerCase();

  if (platform === "win32" && !base.endsWith(".exe")) {
    return {
      verdict: "suspicious",
      reason: "実行ファイル（.exe）ではないようです。",
    };
  }

  // "ollama app.exe" はトレイ常駐アプリで、serve を受け付けない
  if (base === "ollama app.exe" || base === "ollama app") {
    return {
      verdict: "suspicious",
      reason:
        "これはトレイ常駐アプリです。サーバーを起動するには ollama.exe を選んでください。",
    };
  }

  const stem = base.replace(/\.exe$/, "");
  if (stem !== "ollama") {
    return {
      verdict: "suspicious",
      reason: `ファイル名が「${path.basename(filePath)}」です。`,
    };
  }

  return { verdict: "ok" };
}

/** 選択ダイアログに渡すフィルタ。プラットフォームで拡張子が異なる */
export function openDialogFilters(
  platform: NodeJS.Platform = process.platform
): Record<string, string[]> | undefined {
  if (platform === "win32") {
    return { "実行ファイル": ["exe"], "すべてのファイル": ["*"] };
  }
  // macOS/Linuxの実行ファイルに拡張子は無い
  return undefined;
}

/** 起動に失敗した理由を、作者が次に取れる操作つきで説明する */
export function describeStartFailure(outcome: StartOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "not_installed":
      return (
        "Ollamaの実行ファイルが見つかりませんでした。" +
        "インストール済みの場合は、設定 novelai.ollama.executablePath に " +
        "ollama の場所を指定してください。"
      );
    case "spawn_failed":
      return (
        "Ollamaを起動できませんでした。" +
        "手動で起動してから、もう一度お試しください。" +
        (outcome.detail ? `（${outcome.detail}）` : "")
      );
    case "timeout":
      return (
        "Ollamaを起動しましたが、応答するまでに時間がかかっています。" +
        "しばらく待ってから「再試行」を押してください。"
      );
  }
}
