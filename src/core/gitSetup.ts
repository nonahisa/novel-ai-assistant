import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { GitCommandResult, GitCommandRunner } from "./git";
import { isRecord } from "./isRecord";

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
  /**
   * 記録するものが無かった（`commitAll` のみ）。
   *
   * **失敗ではない。** 数えた時点から実行までの間に、別の窓や前回の実行が
   * 先に記録しただけである。呼び出し側は「記録は作られなかった」とだけ
   * 扱い、**後の手順（取り込み・送信）は続ける**こと。
   */
  nothingToCommit?: boolean;
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

/**
 * いま作品フォルダにあるものを、1つの履歴として記録する。
 *
 * **記録するものが無いのは、失敗ではない。**
 * gitは「nothing to commit」を**終了コード1**で返す。これをそのまま失敗として
 * 扱うと、次のようになる（2026-08-26、作者の実機で起きた）。
 *
 *   ・novel（…）：記録できませんでした: On branch main / nothing to commit
 *
 * 件数を数えてから記録するまでの間はごく短いが、**別の窓・前回の実行・
 * 作者自身の操作**が先に記録すれば空になる。しかも「すべて同期」では
 * ここで打ち切るため、**本当に必要な取り込みと送信まで止まっていた。**
 *
 * **判定はgitの文言に頼らない。** 「nothing to commit」は環境の言語で変わる
 * （日本語のgitは「コミットするべき変更がありません」と書く）。
 * `git diff --cached --quiet` の終了コードで見る——0なら記録するものが無い。
 * HEADがまだ無い（初回コミット前）状態でも正しく答える。
 */
export async function commitAll(
  cwd: string,
  message: string,
  run: GitCommandRunner
): Promise<GitSetupResult> {
  const added = await run(["add", "-A"], cwd, LOCAL_TIMEOUT_MS);
  if (added.code !== 0) return failure(added);

  if (await nothingStaged(cwd, run)) return { ok: true, nothingToCommit: true };

  const committed = await run(
    ["commit", "-m", message],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (committed.code !== 0) {
    // 上で見てから commit までの間に、別の窓が記録したかもしれない。
    // **失敗の文言ではなく、いまの状態をもう一度見て決める**
    if (await nothingStaged(cwd, run)) return { ok: true, nothingToCommit: true };
    return failure(committed);
  }
  return { ok: true };
}

/**
 * 記録するものが無いか。
 *
 * 終了コードは 0＝差が無い／1＝差がある。それ以外（判定できなかった）は
 * **「無い」と決めつけない**——記録できるものを黙って捨てないためである。
 */
async function nothingStaged(
  cwd: string,
  run: GitCommandRunner
): Promise<boolean> {
  const staged = await run(
    ["diff", "--cached", "--quiet"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  return staged.code === 0;
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

  // **鍵を埋め込んだURLは受け取らない。**
  // GitHubの案内どおりに `https://<トークン>@github.com/...` を貼る人がいるが、
  // そのURLは `.git/config` に平文で残り、ログにも出る。
  // 認証はOSの保管場所（Windowsなら資格情報マネージャー）に任せる。
  //
  // 見るのは http(s) だけ——ssh の `git@` は資格情報ではなく利用者名である
  // （`ssh://` は下の形で `git@` に限って受けている）
  const host = /^https?:\/\/([^/\s]*)/i.exec(url)?.[1];
  if (host?.includes("@")) {
    return (
      "トークンやパスワードはURLに書かないでください。" +
      "https://github.com/ユーザー名/リポジトリ名.git の形で入力してください。"
    );
  }

  // **平文の http は断る。** 未公開の原稿が、そのまま回線を流れる。
  // 打ち間違いであることがほとんどで、通しても送信で失敗する
  if (/^http:\/\//i.test(url)) {
    return "https:// で始まるURLを入力してください（http では原稿が保護されません）。";
  }

  if (/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(url)) return undefined;
  if (/^git@[^:\s]+:[^/\s]+\/[^/\s]+$/.test(url)) return undefined;
  if (/^ssh:\/\/git@[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(url)) return undefined;
  return "https://github.com/ユーザー名/リポジトリ名.git の形で入力してください。";
}

/**
 * 英数字だけの作品名を、そのままリポジトリ名の形にする。
 *
 * GitHubのリポジトリ名に使えるのは英数字と `-` `_` `.` だけ。
 * **英数字以外が1字でも混ざる題からは作らない（空を返す）。** 以前は使えない字を
 * 消すだけだったので、「GitHub試験_確認用」から切れ端の「GitHub_」が作られ、
 * 作者は意味の分からない名前のまま作ってしまった（2026-10-26 の実機）。
 * 勝手にローマ字へ直すのも、意図しない名前になるのでしない。
 */
export function asciiRepositoryName(workTitle: string): string {
  const trimmed = workTitle.trim();
  if (!/^[A-Za-z0-9._\s-]*$/.test(trimmed)) return "";
  const cleaned = trimmed.replace(/\s+/g, "-");
  // 端の記号は名前として意味を持たないので削る（`_` も。GitHub_ の再発を防ぐ）
  return cleaned.replace(/^[-._]+|[-._]+$/g, "");
}

/**
 * 新しく作るリポジトリの名前を決める（作者の裁定、2026-10-26「日付つき＋説明欄に題」）。
 *
 * **作者に名前を訊かない。** 英数字だけの題はそのまま、それ以外は
 * `novel-YYYYMMDD` にする。日本語の題は名前に入れられない代わりに、
 * リポジトリの説明欄（`description`）へ入れて GitHub の一覧で見分けられるようにする。
 * 日付は**手元の暦**で組む（UTC で組むと、夜中に作った作品が前日の日付になる）。
 */
export function suggestRepositoryName(
  workTitle: string,
  now: Date = new Date()
): string {
  const ascii = asciiRepositoryName(workTitle);
  if (ascii.length > 0) return ascii;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `novel-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 同じ名前があったときに試す名前の数（`-2` から `-9` まで） */
const MAX_NAME_ATTEMPTS = 8;

/** 同じ名前が既にあったときに試す、次の名前（`-2`、`-3`…） */
export function repositoryNameCandidates(baseName: string): string[] {
  const names = [baseName];
  for (let i = 2; i <= MAX_NAME_ATTEMPTS + 1; i++) names.push(`${baseName}-${i}`);
  return names;
}

/**
 * GitHub の説明欄へ入れる文。改行などは1行へ畳み、長すぎる分は切る
 * （GitHub の説明欄は350字まで。超えると作成そのものが断られる）。
 */
export function repositoryDescription(workTitle: string): string {
  return workTitle.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** gh の失敗の文から「同じ名前がある」を見分ける */
function ghNameTaken(detail: string): boolean {
  return /already exists/i.test(detail);
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
  run: CommandRunner = runCommand,
  description?: string
): Promise<GitSetupResult & { nameTaken?: boolean }> {
  const args = ["repo", "create", name, "--private", "--source", ".", "--remote", "origin"];
  if (description) args.push("--description", description);
  const result = await run("gh", args, cwd, PUSH_TIMEOUT_MS);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, detail, nameTaken: ghNameTaken(detail) };
  }
  return { ok: true };
}

/**
 * gh で、空いている名前を探しながら作る（同じ名前があれば `-2`、`-3`…）。
 *
 * 名前を作者に訊かなくなったので、同じ日に2つ目の作品を送ると
 * `novel-YYYYMMDD` がぶつかる。ぶつかったときだけ次の名前を試す。
 */
export async function ghCreateRepositoryWithFreeName(
  cwd: string,
  baseName: string,
  description: string | undefined,
  run: CommandRunner = runCommand
): Promise<GitSetupResult & { name?: string }> {
  let last: GitSetupResult = { ok: false };
  for (const name of repositoryNameCandidates(baseName)) {
    const created = await ghCreateRepository(cwd, name, run, description);
    if (created.ok) return { ok: true, name };
    last = created;
    if (!created.nameTaken) return created;
  }
  return last;
}

/**
 * VS Code本体のGitHubアカウントで、非公開リポジトリを直接作る。
 *
 * `gh`（GitHub CLI）の追加インストールを要らなくするための経路。
 * VS Codeには最初からGitHub認証の仕組みが入っており、
 * Settings Syncなどで既にサインイン済みならそのセッションをそのまま使える。
 * 未サインインなら、見慣れたブラウザでの承認画面が出る。
 *
 * **リポジトリの作成だけをこの経路で行い、実際の push 認証はGitの
 * 資格情報管理（Windowsなら Git Credential Manager）に任せる。** 両者は別物で、
 * ここで取ったトークンをgit自体の認証に流用しようとすると、
 * gitのバージョンや設定次第で失敗し方が変わり、原因の切り分けが難しくなる。
 */

/** VS Code本体のGitHub認証で要求するスコープ。非公開リポジトリの作成に要る */
const GITHUB_OAUTH_SCOPES = ["repo"] as const;

/** `vscode.authentication.getSession` の差し替え口（テストで使う） */
export type GithubAuthenticate = (
  scopes: readonly string[]
) => Thenable<{ accessToken: string } | undefined>;

/**
 * VS Codeのアカウントでサインインし、トークンを取る。
 *
 * 作者がブラウザでの承認をキャンセルすると、VS Codeは例外を投げる。
 * ここでは「サインインしなかった」として吸収し、
 * 呼び出し側に生の例外を伝播させない。
 */
export async function ensureGithubAuthToken(
  authenticate: GithubAuthenticate = (scopes) =>
    vscode.authentication.getSession("github", scopes, {
      createIfNone: true,
    })
): Promise<string | undefined> {
  try {
    const session = await authenticate(GITHUB_OAUTH_SCOPES);
    return session?.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * repo の権限を持つ GitHub のサインインが、もう VS Code にあるか（窓を出さずに確かめる）。
 *
 * 無ければ、このあと VS Code の［許可］とブラウザの［Authorize］が出る。
 * **出る前に一言断るため**に使う（作者の裁定、2026-10-26）。既にあるのに断ると、
 * 出ない窓を作者が待ってしまうので、あるときは断らない。
 * 確かめられないときは「無い」と答える（断りが余計に出るほうが、黙って窓が出るより害が小さい）。
 */
export async function hasGithubSession(
  peek: GithubAuthenticate = (scopes) =>
    vscode.authentication.getSession("github", scopes, { silent: true })
): Promise<boolean> {
  try {
    return (await peek(GITHUB_OAUTH_SCOPES)) !== undefined;
  } catch {
    return false;
  }
}

export const GITHUB_API_BASE = "https://api.github.com";
// GitHub APIはUser-Agentの無いリクエストを拒否する
export const GITHUB_USER_AGENT = "novel-ai-assistant-vscode-extension";

/**
 * GitHub REST APIで非公開リポジトリを作る（`gh`コマンドを使わない経路）。
 *
 * **必ず private で作る。** 未公開の原稿が世に出る事故は取り返しがつかない。
 * 公開したい場合は、作者がGitHubの画面で変える。
 */
export async function createGithubRepositoryViaApi(
  token: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
  description?: string
): Promise<
  GitSetupResult & { cloneUrl?: string; nameTaken?: boolean; isPrivate?: boolean }
> {
  const payload: { name: string; private: true; description?: string } = {
    name,
    private: true,
  };
  if (description) payload.description = description;
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GITHUB_USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      // JSON以外の応答は、状態の番号だけで扱う
    }
    const classified = classifyGithubApiError(response.status, errorBody);
    return { ok: false, detail: classified.detail, nameTaken: classified.nameTaken };
  }

  let body: { clone_url?: string; private?: boolean };
  try {
    body = (await response.json()) as { clone_url?: string; private?: boolean };
  } catch {
    return { ok: false, detail: "GitHubの応答を解釈できませんでした。" };
  }
  if (!body.clone_url) {
    return {
      ok: false,
      detail: "GitHubの応答にリポジトリのURLが含まれていません。",
    };
  }
  return {
    ok: true,
    cloneUrl: body.clone_url,
    ...(typeof body.private === "boolean" ? { isPrivate: body.private } : {}),
  };
}

/**
 * 空いている名前を探しながら、VS Code のアカウントで非公開リポジトリを作る。
 *
 * 名前を作者に訊かなくなった（2026-10-26 の裁定）ので、同じ日の2作品目は
 * `novel-YYYYMMDD` がぶつかる。**ぶつかったときだけ**次の名前（`-2`…）を試し、
 * ほかの失敗（サインイン切れ・回線）はその場で返す（名前を変えても直らない）。
 */
export async function createGithubRepositoryWithFreeName(
  token: string,
  baseName: string,
  description: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<GitSetupResult & { cloneUrl?: string; name?: string; isPrivate?: boolean }> {
  let last: GitSetupResult = { ok: false };
  for (const name of repositoryNameCandidates(baseName)) {
    const created = await createGithubRepositoryViaApi(token, name, fetchImpl, description);
    if (created.ok) return { ...created, name };
    last = created;
    if (!created.nameTaken) return created;
  }
  return last;
}

/**
 * GitHub APIのエラー応答から、作者に見せられる理由を取り出す。
 *
 * **同じ名前の判定は `errors[]` も見る。** GitHub は 422 のとき、上の `message` には
 * "Repository creation failed." とだけ書き、「name already exists on this account」は
 * `errors[].message` に入れる。`message` だけを見ていたので、2026-09-21 に生の
 * "Repository creation failed" がそのまま作者に出た。
 */
export function classifyGithubApiError(
  status: number,
  body: unknown
): { detail: string; nameTaken: boolean; kind: GithubApiErrorKind } {
  const record = isRecord(body) ? body : {};
  const message = typeof record.message === "string" ? record.message : "";
  const errors = Array.isArray(record.errors) ? record.errors.filter(isRecord) : [];
  const nameTaken =
    status === 422 &&
    (/already exists/i.test(message) ||
      errors.some(
        (error) =>
          (typeof error.message === "string" && /already exists/i.test(error.message)) ||
          (error.code === "already_exists" && (error.field === undefined || error.field === "name"))
      ));
  if (nameTaken) {
    return {
      detail: "同じ名前のリポジトリが既にGitHub上にあります。別の名前を指定してください。",
      nameTaken: true,
      kind: "nameTaken",
    };
  }
  if (status === 401) {
    return {
      detail: "GitHubへのサインインが有効ではありません。もう一度お試しください。",
      nameTaken: false,
      kind: "unauthorized",
    };
  }
  /*
    **エラー文から原因を当てにいかない**（実装ルール5）。分けるのは状態の番号だけ。
    403 は権限が足りない、404 は「その名前の人／リポジトリが無い」か「見えない」
    （GitHub は権限の無い非公開リポジトリにも 404 を返す）。どちらかは番号からは
    決められないので、呼ぶ側が文脈（招待か、リポジトリの確認か）に合わせて言い直す。
  */
  const kind: GithubApiErrorKind =
    status === 403
      ? "forbidden"
      : status === 404
        ? "notFound"
        : status === 422
          ? "validation"
          : "other";
  if (message) {
    // errors[] に理由があれば添える（message だけでは「失敗した」としか分からない）
    const reasons = errors
      .map((error) => (typeof error.message === "string" ? error.message : ""))
      .filter((reason) => reason.length > 0);
    return {
      detail: `GitHub: ${message}${reasons.length > 0 ? `（${reasons.join("／")}）` : ""}`,
      nameTaken: false,
      kind,
    };
  }
  return { detail: `HTTP ${status}`, nameTaken: false, kind };
}

/** GitHub API の失敗を、状態の番号で大きく分けたもの */
export type GithubApiErrorKind =
  | "nameTaken"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "validation"
  | "other";

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

/**
 * つながらないことが原因の失敗か。
 *
 * gitの失敗はそのまま出すと英語で、作者には「何が悪いのか」が分からない。
 * **回線が無いだけなのか、設定が違うのかで、次にやることが正反対になる。**
 * 前者なら待てばよく、後者なら設定を直す必要がある。
 *
 * 判定できないものは undefined を返し、元の文言をそのまま見せる。
 * 当てにいって外すより、生の理由を見せるほうが害が小さい。
 */
export function describeNetworkFailure(
  detail: string | undefined
): string | undefined {
  if (!detail) return undefined;
  const text = detail.toLowerCase();

  const offline = [
    "could not resolve host",
    "name or service not known",
    "temporary failure in name resolution",
    "network is unreachable",
    "no route to host",
    "failed to connect",
    "connection timed out",
    "connection refused",
    "operation timed out",
    "unable to access",
  ];
  if (offline.some((pattern) => text.includes(pattern))) {
    return "インターネットにつながっていないようです。接続してからもう一度お試しください。";
  }

  const auth = [
    "authentication failed",
    "permission denied",
    "could not read from remote repository",
    "invalid username or password",
    "403 forbidden",
    "terminal prompts disabled",
  ];
  if (auth.some((pattern) => text.includes(pattern))) {
    return (
      "GitHubへのログインができませんでした。" +
      "リポジトリのURLと、GitHubの認証（Git Credential Manager や SSH鍵）を確かめてください。"
    );
  }

  const notFound = ["repository not found", "does not appear to be a git repository"];
  if (notFound.some((pattern) => text.includes(pattern))) {
    return "送り先のリポジトリが見つかりません。URLを確かめてください。";
  }

  return undefined;
}

/**
 * VS Codeのアカウントで得た鍵を、git側にも覚えさせる（設計書5.5.12）。
 *
 * **「VS Codeのアカウントを使う」と答えたのに、送信でまた聞かれる**という
 * 報告があった（2026-08-21、作者が実機で発見）。
 *
 * 理由は2つ重なっている。
 *
 * 1. リポジトリを作るのはGitHubのAPIで、**鍵はこの拡張機能が持っているだけ**。
 *    `git push` は別のプロセスなので、その鍵を知らない
 * 2. `runGit` は `GIT_ASKPASS=echo` を渡している（背景のfetchが固まらないため）。
 *    これはgit自身の入力は止めるが、**Windowsの資格情報マネージャーは別枠**で、
 *    自前の画面を出す
 *
 * そこで `git credential approve` で、git が使う保管場所（Windowsなら
 * 資格情報マネージャー）へ入れておく。**次のpushは黙って通る。**
 *
 * **鍵を平文で置かない。** `.git/config` のURLへ埋め込む手もあるが、
 * それだと作品フォルダーに鍵が残る。保管場所はOSに任せる。
 *
 * 保管の仕組みが設定されていない環境では、gitは黙って何もしない。
 * その場合はこれまで通り、送信時に聞かれる（失敗はしない）。
 */
export async function rememberGithubCredential(
  token: string,
  cloneUrl: string,
  cwd: string
): Promise<boolean> {
  const target = parseHttpsRemote(cloneUrl);
  if (!target) return false;

  const input = [
    "protocol=https",
    `host=${target.host}`,
    `username=${target.owner}`,
    `password=${token}`,
    "",
    "",
  ].join("\n");

  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["credential", "approve"],
      { cwd, timeout: LOCAL_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(!error)
    );
    child.stdin?.end(input);
  });
}

/** `https://github.com/owner/repo.git` から、ホストと所有者を取り出す */
export function parseHttpsRemote(
  url: string
): { host: string; owner: string } | undefined {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/[^/]+?(?:\.git)?\/?$/.exec(
    url.trim()
  );
  if (!match) return undefined;
  return { host: match[1], owner: match[2] };
}
