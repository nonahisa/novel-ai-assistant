import { execFile } from "node:child_process";
import type { GitCommandResult, GitCommandRunner } from "./git";

/**
 * GitHub同期を**始める**ための操作。
 *
 * `git.ts` は「もう同期できる状態」からの取得・送信を扱う。
 * こちらは、そこへ至るまで（リポジトリを作る、リモートをつなぐ、
 * 最初の送信をする）を受け持つ。
 *
 * **この層でも自動実行はしない。** 作者がボタンを押したときだけ呼ぶこと。
 * とくに送信は、原稿を外部サービスへ渡す操作である。
 */

/** ローカルで完結する操作の上限 */
const LOCAL_TIMEOUT_MS = 15_000;
/** 送信の上限。作品まるごとの初回送信は時間がかかる */
export const PUSH_TIMEOUT_MS = 180_000;

/** 新しいリポジトリの既定ブランチ。GitHubの既定に合わせる */
export const DEFAULT_BRANCH = "main";

export interface GitSetupResult {
  ok: boolean;
  /** 失敗した理由。作者に見せる */
  detail?: string;
}

/**
 * Gitで管理を始める。
 *
 * `git init` だけでは履歴が1つも無く、送信もできない。
 * **いま作品フォルダにあるものを1つ目の履歴として記録する**ところまで行う。
 */
export async function initRepository(
  cwd: string,
  run: GitCommandRunner
): Promise<GitSetupResult> {
  // -b は Git 2.28 以降。使えない場合に備えて、失敗したら作り直す
  const initialized = await run(["init", "-b", DEFAULT_BRANCH], cwd, LOCAL_TIMEOUT_MS);
  if (initialized.code !== 0) {
    const fallback = await run(["init"], cwd, LOCAL_TIMEOUT_MS);
    if (fallback.code !== 0) return failure(fallback);
    // 既定ブランチ名が master になる古い環境を main へ揃える。
    // まだコミットが無いので、参照を書き換えるだけで済む
    const renamed = await run(
      ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`],
      cwd,
      LOCAL_TIMEOUT_MS
    );
    if (renamed.code !== 0) return failure(renamed);
  }
  return { ok: true };
}

/**
 * コミットする人の名前とメールが設定されているか。
 *
 * 未設定だと `git commit` が失敗する。**初めてGitを使う作者は必ずここで詰まる**ので、
 * 先に確かめて案内する。
 */
export async function hasCommitIdentity(
  cwd: string,
  run: GitCommandRunner
): Promise<boolean> {
  const name = await run(["config", "user.name"], cwd, LOCAL_TIMEOUT_MS);
  const email = await run(["config", "user.email"], cwd, LOCAL_TIMEOUT_MS);
  return name.stdout.trim().length > 0 && email.stdout.trim().length > 0;
}

/** この作品フォルダにだけ、名前とメールを設定する */
export async function setCommitIdentity(
  cwd: string,
  name: string,
  email: string,
  run: GitCommandRunner
): Promise<GitSetupResult> {
  const setName = await run(
    ["config", "--local", "user.name", name],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (setName.code !== 0) return failure(setName);
  const setEmail = await run(
    ["config", "--local", "user.email", email],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (setEmail.code !== 0) return failure(setEmail);
  return { ok: true };
}

/** コミットが1つでもあるか */
export async function hasCommits(
  cwd: string,
  run: GitCommandRunner
): Promise<boolean> {
  const result = await run(
    ["rev-parse", "--verify", "HEAD"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  return result.code === 0;
}

/** 記録の対象になるファイル数。実行前に作者へ見せる */
export async function countTrackableFiles(
  cwd: string,
  run: GitCommandRunner
): Promise<number> {
  const result = await run(
    ["status", "--porcelain", "--untracked-files=all"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) return 0;
  return result.stdout.split("\n").filter((line) => line.trim().length > 0)
    .length;
}

/** いま作品フォルダにあるものを、1つの履歴として記録する */
export async function commitAll(
  cwd: string,
  message: string,
  run: GitCommandRunner
): Promise<GitSetupResult> {
  const added = await run(["add", "-A"], cwd, LOCAL_TIMEOUT_MS);
  if (added.code !== 0) return failure(added);

  const committed = await run(
    ["commit", "-m", message],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (committed.code !== 0) return failure(committed);
  return { ok: true };
}

/** リモートを登録する */
export async function addRemote(
  cwd: string,
  url: string,
  run: GitCommandRunner
): Promise<GitSetupResult> {
  const result = await run(
    ["remote", "add", "origin", url],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) return failure(result);
  return { ok: true };
}

/** 現在のブランチ名。まだコミットが無くても取れる */
export async function currentBranch(
  cwd: string,
  run: GitCommandRunner
): Promise<string> {
  const result = await run(
    ["symbolic-ref", "--short", "HEAD"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : DEFAULT_BRANCH;
}

/** 上流を設定しながら送信する（初回の push -u） */
export async function pushSetUpstream(
  cwd: string,
  branch: string,
  run: GitCommandRunner
): Promise<GitSetupResult> {
  const result = await run(
    ["push", "-u", "origin", branch],
    cwd,
    PUSH_TIMEOUT_MS
  );
  if (result.code !== 0) return failure(result);
  return { ok: true };
}

/**
 * 貼り付けられたリポジトリのURLを検査する。
 *
 * **打ち間違いのまま登録すると、送信のたびに失敗して理由が分かりにくい。**
 * 形が明らかに違うものはここで断る。
 */
export function validateRepositoryUrl(input: string): string | undefined {
  const url = input.trim();
  if (url.length === 0) return "URLを入力してください。";
  if (/^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(url)) return undefined;
  if (/^git@[^:\s]+:[^/\s]+\/[^/\s]+$/.test(url)) return undefined;
  if (/^ssh:\/\/git@[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(url)) return undefined;
  return "https://github.com/ユーザー名/リポジトリ名.git の形で入力してください。";
}

/**
 * 作品名からリポジトリ名を作る。
 *
 * GitHubのリポジトリ名に使えるのは英数字と `-` `_` `.` だけ。
 * **日本語の作品名は変換できない**ので、その場合は空を返して
 * 作者に入力してもらう（勝手にローマ字へ直すと、意図しない名前になる）。
 */
export function suggestRepositoryName(workTitle: string): string {
  const cleaned = workTitle
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.replace(/^[-.]+|[-.]+$/g, "");
}

/** GitHub CLI（gh）が使えて、認証も済んでいるか */
export async function ghAvailable(
  run: CommandRunner = runCommand
): Promise<boolean> {
  const version = await run("gh", ["--version"], undefined, LOCAL_TIMEOUT_MS);
  if (version.code !== 0) return false;
  const auth = await run("gh", ["auth", "status"], undefined, LOCAL_TIMEOUT_MS);
  return auth.code === 0;
}

/**
 * ghでリポジトリを作り、originとして登録する。
 *
 * **必ず private で作る。** 未公開の原稿が世に出る事故は取り返しがつかない。
 * 公開したい場合は、作者がGitHubの画面で変える。
 */
export async function ghCreateRepository(
  cwd: string,
  name: string,
  run: CommandRunner = runCommand
): Promise<GitSetupResult> {
  const result = await run(
    "gh",
    ["repo", "create", name, "--private", "--source", ".", "--remote", "origin"],
    cwd,
    PUSH_TIMEOUT_MS
  );
  if (result.code !== 0) {
    return { ok: false, detail: (result.stderr || result.stdout).trim() };
  }
  return { ok: true };
}

/** gh のように git 以外のコマンドも呼べるようにした実行口（テストで差し替える） */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number
) => Promise<GitCommandResult>;

export const runCommand: CommandRunner = (command, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        env: {
          ...process.env,
          // 認証を聞かれても待ち続けない（拡張機能ホストに入力手段が無い）
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          // ghの対話プロンプトを止める
          GH_PROMPT_DISABLED: "1",
          NO_COLOR: "1",
        },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : -1;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });

function failure(result: GitCommandResult): GitSetupResult {
  return { ok: false, detail: (result.stderr || result.stdout).trim() };
}
