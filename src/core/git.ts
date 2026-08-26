import { execFile } from "node:child_process";

/**
 * gitコマンドの薄い層。
 *
 * VS Code組込みGit拡張のAPIは「ワークスペースに入っているフォルダー」しか
 * 見てくれない。この拡張機能は作品フォルダーをワークスペースへ入れない方針
 * （設計書5.5節末尾、2026-08-10の作者判断）なので、gitを直接実行する。
 *
 * **ローカルを変更するコマンドは、この層では自動実行しない。**
 * 自動で走ってよいのは fetch（取得のみ）だけであり、
 * pull / push は作者がボタンを押したときにだけ呼ぶこと（設計書5.5.1）。
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
 * 設計書5.5.1が自動実行を許しているのはこれだけである。
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
 * それは機械が解決してよい話ではない（設計書5.5.4）。
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

/**
 * gitがマージ未解決としているファイル（リポジトリ相対）。
 *
 * 本文に競合マーカーが残っているだけの状態とは区別する。
 * こちらは「マージの途中」なので、`checkout --ours` でgitに
 * 版を書き戻させることができる。
 */
export async function unmergedPaths(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<string[]> {
  const result = await run(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) return [];
  return [...new Set(result.stdout.split("\0").filter((name) => name !== ""))];
}

/**
 * 競合したファイルを、選んだ側の版で確定させる。
 *
 * **書き込むのはgitである。** この拡張機能は既存の原稿ファイルを
 * 上書きしないという不変条件を持つ（`atomicWrite.ts` 参照）ので、
 * 自分でバイト列を書かず、gitに索引から書き戻させる。
 * 文字コードもgitが持っているものがそのまま出る。
 */
export async function checkoutSide(
  cwd: string,
  relativePath: string,
  side: "ours" | "theirs",
  run: GitCommandRunner = runGit
): Promise<{ ok: boolean; detail?: string }> {
  const checkout = await run(
    ["checkout", `--${side}`, "--", relativePath],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (checkout.code !== 0) {
    return { ok: false, detail: describeFailure(checkout) };
  }

  // 解決済みとして印を付けないと、マージが終わらず
  // 「未解決の競合」が残り続ける
  const add = await run(["add", "--", relativePath], cwd, LOCAL_TIMEOUT_MS);
  if (add.code !== 0) return { ok: false, detail: describeFailure(add) };
  return { ok: true };
}

/** 索引の特定の版を取り出す。1=共通の祖先 / 2=この環境 / 3=別環境 */
export async function showStage(
  cwd: string,
  relativePath: string,
  stage: 1 | 2 | 3,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  const result = await run(
    ["show", `:${stage}:${relativePath}`],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  return result.code === 0 ? result.stdout : undefined;
}

/** 現在のHEADのコミットID。取れなければ undefined */
export async function headCommit(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  const result = await run(["rev-parse", "HEAD"], cwd, LOCAL_TIMEOUT_MS);
  if (result.code !== 0) return undefined;
  const id = result.stdout.trim();
  return /^[0-9a-f]{7,64}$/i.test(id) ? id : undefined;
}

/**
 * 2つのコミットの間で変わったファイル（作品フォルダーからの相対パス）。
 *
 * pullで一度に大量のファイルが変わるため、**何が変わったかはgitに聞く**
 * （設計書5.5.13）。こちらで全ファイルのハッシュを取り直すより速く、
 * 削除・改名も正確に分かる。
 */
export async function changedFilesBetween(
  cwd: string,
  from: string,
  to: string,
  run: GitCommandRunner = runGit
): Promise<string[]> {
  const result = await run(
    // -z: パスをNUL区切りで出す。日本語や空白を含むパスが
    // 引用符付きで返るのを避ける（引用の解除で事故りやすい）
    ["diff", "--name-only", "-z", from, to],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) return [];
  return result.stdout.split("\0").filter((name) => name !== "");
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
  let dirty = 0;
  for (const line of lines) {
    const conflicted = isUnmergedCode(line.slice(0, 2));
    if (conflicted) unmerged++;
    // **競合しているなら数える。** 自動で書かれるものでも、
    // 競合を見逃すわけにはいかない
    if (conflicted || !isAutoWrittenLine(line)) dirty++;
  }
  return { dirty, unmerged };
}

/**
 * 拡張機能が勝手に書き換えるので、変更として数えないもの（設計書5.5.13）。
 *
 * **執筆量の記録は、保存のたびに書き換わる。** 端末ごとに1ファイル持ち、
 * 同期もする（複数のPCで書いた量を合算するため）。だが**作者が何も
 * していなくても必ず変わる**ので、これを数えると、
 *
 * - 記録して送信した直後から、また「1件の変更」と出る
 * - **常に1件出ているので、本当に原稿を書いた1件と見分けが付かない**
 *
 * 作者の指摘（2026-08-24）：「GitHubと同期しても常に1件同期が残る」。
 *
 * **数えないだけで、記録からは外さない。** コミットには入るので、
 * 執筆量は今までどおり別の環境へ同期される。
 */
const AUTO_WRITTEN_PATHS = [".aiwriter/stats/"] as const;

/** その行が、拡張機能の自動書き換えぶんか */
export function isAutoWrittenLine(line: string): boolean {
  // porcelain の行は「XY パス」の形。日本語のパスは引用符で囲まれるので、
  // パスを取り出そうとせず、行に含まれるかだけを見る
  const normalized = line.replace(/\\/g, "/");
  return AUTO_WRITTEN_PATHS.some((target) => normalized.includes(target));
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

/**
 * この環境の git の `user.name`。
 *
 * **編集履歴と競合画面で、同じ名前を出すために使う**（設計書5.6）。
 * 履歴では「誰が直したか」、競合では「どちらの版か」を示すが、
 * **別々の名前を出すと、作者は同じ人だと分からない。**
 */
export async function gitUserName(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  const result = await run(["config", "user.name"], cwd, LOCAL_TIMEOUT_MS);
  if (result.code !== 0) return undefined;
  const name = result.stdout.trim();
  return name || undefined;
}

/**
 * そのファイルを最後に触ったコミットの著者名。
 *
 * **競合の画面で「誰の版か」を出すために使う**（設計書5.5.4）。
 * 「別環境の版」とだけ出すと、**編集部の直しが自分の書き忘れに見える。**
 *
 * @param revision 見たい側。競合中なら `MERGE_HEAD`（取り込もうとしている側）
 */
export async function lastAuthorOf(
  cwd: string,
  relativePath: string,
  revision: string,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  const result = await run(
    // %an は著者名。-1 で最後の1件だけ
    ["log", "-1", "--format=%an", revision, "--", relativePath],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) return undefined;
  const name = result.stdout.trim();
  return name || undefined;
}

/**
 * この作品での `core.autocrlf` の設定。
 *
 * **gitの書き換えは、この拡張機能の管轄外である**（設計書5.5.1）。
 * 本拡張機能は「文字コード・改行コードを保持して書き戻す」を最優先の
 * 決まりにしているが、`git pull` は `core.autocrlf` が有効だと
 * **チェックアウトのときに改行を書き換える。**
 *
 * Windowsでは既定で `true` になっていることが多い。**LFで書いた原稿が、
 * 取り込んだだけでCRLFに変わる。** 投稿サイトのダウンロード形式を
 * そのまま置いている作品では、元の場所へ戻せなくなる。
 *
 * 止める手立ては無いので、**起きうることを伝える**。
 */
export async function readAutoCrlf(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  const result = await run(["config", "core.autocrlf"], cwd, LOCAL_TIMEOUT_MS);
  // 設定が無ければ非0で返る。それは「未設定」であって失敗ではない
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim().toLowerCase();
  return value || undefined;
}

/**
 * その設定だと、取り込みで改行が書き換わりうるか。
 *
 * - `true` … チェックアウトでCRLFへ、コミットでLFへ変える。**書き換わる**
 * - `input` … コミットでLFへ変えるだけ。チェックアウトでは触らない
 * - `false` / 未設定 … 触らない
 */
export function rewritesLineEndings(autoCrlf: string | undefined): boolean {
  return autoCrlf === "true";
}

/** 作者へ伝える文。**何が起きるか・どうすれば止まるかの両方を言う** */
export function describeAutoCrlfRisk(): string {
  return (
    "Gitの設定（core.autocrlf）が有効なため、取り込みのときに改行コードが" +
    "書き換わることがあります。\n\n" +
    "この拡張機能は改行を保ったまま書き戻しますが、Gitによる書き換えまでは" +
    "止められません。投稿サイトからダウンロードした原稿をそのまま置いている" +
    "場合、元の形と変わってしまうことがあります。\n\n" +
    "気になる場合は、この作品のフォルダーで次を実行してください。\n\n" +
    "  git config core.autocrlf false"
  );
}
