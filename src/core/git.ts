import { execFile } from "node:child_process";

/**
 * gitコマンドの薄い層。
 *
 * VS Code組込みGit拡張のAPIは「ワークスペースに入っているフォルダー」しか
 * 見てくれない。この拡張機能は作品フォルダーをワークスペースへ入れない方針
 * （設計書3.5節末尾、2026-08-10の作者判断）なので、gitを直接実行する。
 *
 * **ローカルを変更するコマンドは、この層では自動実行しない。**
 * 自動で走ってよいのは fetch（取得のみ）だけであり、
 * pull / push は作者がボタンを押したときにだけ呼ぶこと（設計書3.5.1）。
 *
 * vscodeに依存させないのは、テストで実際のgitを動かして確かめるため。
 */

export interface GitCommandResult {
  /** 終了コード。実行できなかった場合は -1 */
  code: number;
  stdout: string;
  stderr: string;
}

/** テストで差し替えるための実行口 */
export type GitCommandRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number
) => Promise<GitCommandResult>;

/** ローカルだけで完結する問い合わせの上限。すぐ返るはず */
const LOCAL_TIMEOUT_MS = 10_000;

/** fetchの上限。回線が遅いこともあるので長めに取る */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * gitを実行する。
 *
 * **シェルを介さない**（`execFile`）。作品フォルダーのパスには空白も
 * 日本語も入るため、シェル経由にすると引用の取り扱いで事故る。
 */
export const runGit: GitCommandRunner = (args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        // 認証を聞かれても待ち続けないようにする。
        // 拡張機能ホストには入力する手段がないので、
        // 止めておかないと fetch がタイムアウトまで固まる
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
          SSH_ASKPASS: "echo",
          // ページャが起動すると終了しないコマンドがある
          GIT_PAGER: "cat",
          // 出力の言語を固定する。文面で判定はしないが、ログの読み手を揃える
          LC_ALL: "C",
        },
        // 巨大な出力でメモリを食わないよう上限を置く
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

/**
 * 同期状態。
 *
 * 「まだ判断できない」と「問題がある」を型で分けている。
 * リポジトリでない作品や、リモートを設定していない作品は**異常ではない**ので、
 * 警告として出すと毎回消せない表示が残ってしまう。
 */
export type GitSyncStatus =
  /** gitコマンドが見つからない */
  | { kind: "git_missing" }
  /** Gitリポジトリではない（Gitを使わずに執筆している作品） */
  | { kind: "not_a_repo" }
  /** リポジトリだがリモートが未設定（ローカルだけで履歴を取っている） */
  | { kind: "no_remote"; root: string }
  /** ブランチではなく特定のコミットを直接見ている */
  | { kind: "detached"; root: string }
  /** 現在のブランチに上流が無い（push -u がまだ） */
  | { kind: "no_upstream"; root: string; branch: string }
  /** 判定できた */
  | {
      kind: "tracked";
      root: string;
      branch: string;
      upstream: string;
      /** 別環境で進んでいて、まだ取り込んでいないコミット数 */
      behind: number;
      /** この環境で進んでいて、まだ送信していないコミット数 */
      ahead: number;
      /** 変更のあるファイル数（未追跡を含む） */
      dirty: number;
      /** Gitがマージ未解決としているファイル数 */
      unmerged: number;
    }
  /** 実行はできたが失敗した。理由はログへ回す */
  | { kind: "failed"; detail: string };

/** gitコマンドを使えるか */
export async function isGitAvailable(
  run: GitCommandRunner = runGit,
  cwd: string = process.cwd()
): Promise<boolean> {
  const result = await run(["--version"], cwd, LOCAL_TIMEOUT_MS);
  return result.code === 0;
}

/**
 * 作品フォルダーの同期状態を調べる。
 *
 * ここではネットワークに触れない。取得済みの情報だけで判定するので、
 * 最新かどうかは直前に fetch したかで決まる。
 */
export async function readSyncStatus(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<GitSyncStatus> {
  const inside = await run(
    ["rev-parse", "--is-inside-work-tree"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (inside.code !== 0) {
    // gitが無い場合と、リポジトリでない場合を区別する。
    // 「リポジトリでない」は正常な状態なので、警告として扱わない
    if (!(await isGitAvailable(run, cwd))) return { kind: "git_missing" };
    return { kind: "not_a_repo" };
  }
  if (inside.stdout.trim() !== "true") return { kind: "not_a_repo" };

  const topLevel = await run(
    ["rev-parse", "--show-toplevel"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (topLevel.code !== 0) {
    return { kind: "failed", detail: describeFailure(topLevel) };
  }
  const root = topLevel.stdout.trim();

  const remotes = await run(["remote"], cwd, LOCAL_TIMEOUT_MS);
  if (remotes.code !== 0) {
    return { kind: "failed", detail: describeFailure(remotes) };
  }
  if (remotes.stdout.trim() === "") return { kind: "no_remote", root };

  // --quiet を付けるのは、切り離されたHEADでエラー文を出さないため
  const branchResult = await run(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (branchResult.code !== 0) return { kind: "detached", root };
  const branch = branchResult.stdout.trim();
  if (!branch) return { kind: "detached", root };

  const upstreamResult = await run(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (upstreamResult.code !== 0) {
    return { kind: "no_upstream", root, branch };
  }
  const upstream = upstreamResult.stdout.trim();

  const counts = await run(
    ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (counts.code !== 0) {
    return { kind: "failed", detail: describeFailure(counts) };
  }
  const parsed = parseAheadBehind(counts.stdout);
  if (!parsed) {
    return {
      kind: "failed",
      detail: `コミット数を解析できません: ${counts.stdout.trim()}`,
    };
  }

  const status = await run(
    ["status", "--porcelain"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (status.code !== 0) {
    return { kind: "failed", detail: describeFailure(status) };
  }
  const working = parseStatusPorcelain(status.stdout);

  return {
    kind: "tracked",
    root,
    branch,
    upstream,
    behind: parsed.behind,
    ahead: parsed.ahead,
    dirty: working.dirty,
    unmerged: working.unmerged,
  };
}

/**
 * リモートの状態を取り込む（**ローカルは変更しない**）。
 *
 * 設計書3.5.1が自動実行を許しているのはこれだけである。
 * fetchは取得のみで作業ツリーにもブランチにも触れないため、
 * 執筆中に走っても原稿が変わることはない。
 */
export async function fetchRemote(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<{ ok: boolean; detail?: string }> {
  const result = await run(
    // --no-tags: タグまで持ってくる必要はない
    // --quiet: 進捗表示はこちらのUIで出す
    ["fetch", "--no-tags", "--quiet"],
    cwd,
    FETCH_TIMEOUT_MS
  );
  if (result.code === 0) return { ok: true };
  return { ok: false, detail: describeFailure(result) };
}

/** 取り込みの失敗理由。作者に出す文言はfeatures側で決める */
export type PullFailure =
  /** ローカルに未コミットの変更があり、上書きの恐れがある */
  | { kind: "dirty" }
  /** 早送りできない（両方で別々に進んでいる） */
  | { kind: "diverged" }
  | { kind: "failed"; detail: string };

/**
 * 取り込む。**必ず作者の操作を起点に呼ぶこと。**
 *
 * `--ff-only` にするのは、マージコミットを勝手に作らないため。
 * 早送りできない＝両方の環境で別々に書いた状態であり、
 * それは機械が解決してよい話ではない（設計書3.5.4）。
 */
export async function pullFastForward(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<{ ok: true } | { ok: false; failure: PullFailure }> {
  // 未コミットの変更があるとpullは原稿を巻き込みうる。
  // gitも多くの場合は拒否するが、拒否の条件は状況によって変わるため、
  // こちら側で先に止める。作者の書きかけを守るほうを優先する
  const status = await readSyncStatus(cwd, run);
  if (status.kind === "tracked" && status.dirty > 0) {
    return { ok: false, failure: { kind: "dirty" } };
  }

  const result = await run(["pull", "--ff-only"], cwd, FETCH_TIMEOUT_MS);
  if (result.code === 0) return { ok: true };

  const after = await readSyncStatus(cwd, run);
  if (after.kind === "tracked" && after.ahead > 0 && after.behind > 0) {
    return { ok: false, failure: { kind: "diverged" } };
  }
  return {
    ok: false,
    failure: { kind: "failed", detail: describeFailure(result) },
  };
}

/** 送信する。**必ず作者の操作を起点に呼ぶこと。** */
export async function push(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<{ ok: boolean; detail?: string }> {
  const result = await run(["push"], cwd, FETCH_TIMEOUT_MS);
  if (result.code === 0) return { ok: true };
  return { ok: false, detail: describeFailure(result) };
}

/**
 * `rev-list --left-right --count <upstream>...HEAD` の出力を読む。
 *
 * 左が上流にだけあるコミット（＝この環境が遅れている数）、
 * 右がHEADにだけあるコミット（＝まだ送っていない数）。
 */
export function parseAheadBehind(
  stdout: string
): { behind: number; ahead: number } | undefined {
  const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
  if (!matched) return undefined;
  return { behind: Number(matched[1]), ahead: Number(matched[2]) };
}

/**
 * `git status --porcelain` を数える。
 *
 * 未追跡ファイル（`??`）も変更に含める。原稿を新しく足しただけで
 * まだ追加していない状態は、送信し忘れると失われるため。
 */
export function parseStatusPorcelain(stdout: string): {
  dirty: number;
  unmerged: number;
} {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let unmerged = 0;
  for (const line of lines) {
    if (isUnmergedCode(line.slice(0, 2))) unmerged++;
  }
  return { dirty: lines.length, unmerged };
}

/**
 * マージ未解決を表すコード。
 *
 * 片側でも `U` ならマージ未解決。加えて `AA`（両方で追加）と
 * `DD`（両方で削除）も未解決として扱う（gitの定義どおり）。
 */
function isUnmergedCode(code: string): boolean {
  if (code.length < 2) return false;
  const [x, y] = code;
  if (x === "U" || y === "U") return true;
  return code === "AA" || code === "DD";
}

/** 失敗の説明。ログへ残す用で、通知にはそのまま出さない */
function describeFailure(result: GitCommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join(" / ");
  return detail || `gitが終了コード ${result.code} で終了しました`;
}
