import { execFile } from "node:child_process";
// 同じ場所かの判定は `locationCompare` が持つ。**写しを作らない**——
// 以前は「編集部へ渡す」側に別の判定があり、片方だけが大文字小文字を
// そろえていた（`locationCompare.ts` の冒頭に経緯がある）
import { isSameLocation } from "./locationCompare";

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

/** 実行口に添えられるもの */
export interface GitRunOptions {
  /**
   * 標準入力へ流す文字列。**パスの一覧を命令の外で渡すために使う**
   * （`--pathspec-from-file=-`。`runGitForPaths` の下の説明）。
   */
  input?: string;
}

/** テストで差し替えるための実行口 */
export type GitCommandRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number,
  options?: GitRunOptions
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
export const runGit: GitCommandRunner = (args, cwd, timeoutMs, options) =>
  new Promise((resolve) => {
    const child = execFile(
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
    // **渡すものが無いときも閉じる。** 開いたままだと、標準入力を読む
    // 命令（`--pathspec-from-file=-`）が入力の終わりを待ち続ける
    child.stdin?.end(options?.input ?? "");
  });

/**
 * 1回の命令に並べてよいパスの字数の目安。
 *
 * **Windows では、1回の起動に渡せるコマンドの長さが 32,767 字まで**
 * （CreateProcess の上限。日本語も1字は1字）。git の実行ファイルの場所・
 * 引用符・空白・ほかの引数のぶんを差し引いて、余裕を大きく取る。
 * 超えると git が起動すらせず、エラーの文面も「長すぎる」とは言わない。
 */
export const COMMAND_LINE_PATH_BUDGET = 24_000;

/** パス1つが命令の中で占める字数（前後の引用符と区切りの空白を足す） */
function commandLineCost(entry: string): number {
  return entry.length + 3;
}

/**
 * パスの一覧を、1回の命令に収まる束に分ける（設計書6.67、残課題 F2）。
 *
 * 1つだけで目安を超えるパスも、その1つで1束にする（落とさない）。
 */
export function splitPathsForCommandLine(
  entries: readonly string[],
  budget: number = COMMAND_LINE_PATH_BUDGET
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const cost = commandLineCost(entry);
    if (current.length > 0 && used + cost > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(entry);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * パスを名指しする命令（`add`・`ls-files` など）を、長さの上限に収まる
 * 束に分けて走らせる。
 *
 * **分けてよい命令にだけ使う。** 何回に分けても結果が同じもの（ステージ・
 * 問い合わせ）に限る。`commit` を分けると記録が割れる（`commitPaths` を使う）。
 * 出力は束の順に繋ぐ。1つでも失敗したら、そこで止めてその結果を返す。
 */
export async function runGitForPaths(
  run: GitCommandRunner,
  baseArgs: readonly string[],
  entries: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<GitCommandResult> {
  let stdout = "";
  let stderr = "";
  for (const batch of splitPathsForCommandLine(entries)) {
    const result = await run([...baseArgs, "--", ...batch], cwd, timeoutMs);
    if (result.code !== 0) return result;
    stdout += result.stdout;
    stderr += result.stderr;
  }
  return { code: 0, stdout, stderr };
}

/**
 * 名指ししたパスだけを1つのコミットにする（`git commit -m … -- パス…`）。
 *
 * **分けられない。** 名前の変更を2つのコミットに割ると、GitHub 上で改名が
 * 途切れて見える。そこで、並べると長すぎるときだけ**パスを標準入力で渡す**
 * （`--pathspec-from-file=- --pathspec-file-nul`。区切りはNUL——日本語の
 * ファイル名に改行は入らないが、区切りの取り違えの余地を残さない）。
 * 短いときは今までどおり命令に並べる。標準入力の道は git 2.26 以降にしか
 * 無いので、要らないときにまで古い git を締め出さない。
 *
 * パスを添えたコミットは、索引に別の仕事で載っていたものを巻き込まない
 * （`--only` の働き）。標準入力で渡しても同じである。
 */
export async function commitPaths(
  run: GitCommandRunner,
  message: string,
  entries: readonly string[],
  cwd: string,
  timeoutMs: number,
  /** 目安の字数。試験で標準入力の道を短いパスで通すために差し替えられる */
  budget: number = COMMAND_LINE_PATH_BUDGET
): Promise<GitCommandResult> {
  const total = entries.reduce((sum, entry) => sum + commandLineCost(entry), 0);
  if (total <= budget) {
    return run(["commit", "-m", message, "--", ...entries], cwd, timeoutMs);
  }
  return run(
    ["commit", "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"],
    cwd,
    timeoutMs,
    // **区切りのNULは生で書かない**（CLAUDE.md。`sourceHygiene.test.ts` が見る）
    { input: entries.join(String.fromCharCode(0)) }
  );
}

/**
 * 分かれているとき、同じ箇所で衝突しているファイル（設計書5.5.18）。
 *
 * **`readSyncStatus` は埋めない。** 数えるには `merge-tree` を走らせる必要が
 * あり、一覧を描くたびに全作品ぶん動かすと重い。分かれている置き場だけを
 * 見張り側（`GitSyncMonitor`）が数えて添える。
 *
 * 誰が決めることになるかで分けてある——**「競合解決があるかないか
 * わからない」**（作者、2026-09-10）に答えるための数字だからである。
 */
export interface DivergenceConflicts {
  /** 設定資料のJSON。規則で決まることが多い（`settingsConflictRule.ts`） */
  settings: string[];
  /** 本文。**同じ箇所を両方で書いたものだけ**がここに来る */
  manuscripts: string[];
  /** 拡張機能が自動で書くもの。この端末の側を残す */
  autoWritten: string[];
  /** 追記型。両方の行を残して畳む（履歴・提案・ロック） */
  appendOnly: string[];
}

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
  | { kind: "no_remote"; root: string; dirty: number; dirtyHere: number }
  /** ブランチではなく特定のコミットを直接見ている */
  | { kind: "detached"; root: string }
  /** 現在のブランチに上流が無い（push -u がまだ） */
  | {
      kind: "no_upstream";
      root: string;
      branch: string;
      dirty: number;
      dirtyHere: number;
    }
  /** 判定できた */
  | {
      kind: "tracked";
      root: string;
      branch: string;
      upstream: string;
      /** 別環境で進んでいて、まだ取り込んでいないコミット数。**置き場ぜんぶ** */
      behind: number;
      /** この環境で進んでいて、まだ送信していないコミット数。**置き場ぜんぶ** */
      ahead: number;
      /**
       * **その作品に触れた**ぶんだけの、取り込み待ち・送信待ちの数。
       *
       * 書庫では `ahead` が全作品の合計になる。作品一覧の各行にそれを出すと
       * **全部の行に同じ数字が並び、どの作品を送ればよいのか分からない**
       * （実データで11作品すべてに「送信待ち13」と出た）。
       *
       * 送るのも取り込むのも置き場ぜんぶが単位なので、`ahead`／`behind` は残す。
       */
      behindHere: number;
      aheadHere: number;
      /** 変更のあるファイル数（未追跡を含む）。**置き場ぜんぶ** */
      dirty: number;
      /**
       * **訊ねたフォルダーの中だけ**の変更のあるファイル数。
       *
       * 書庫（1つの置き場に複数の作品）では、`dirty` は置き場ぜんぶの数に
       * なる。作品一覧の各行に置き場の数を出すと、**どの作品に書きかけが
       * あるのか分からない**（作者の指摘、2026-08-26：
       * 「未同期の作品がわかりません」）。
       *
       * 取り込みの可否は置き場ぜんぶで決まるので、`dirty` は残す。
       */
      dirtyHere: number;
      /** Gitがマージ未解決としているファイル数 */
      unmerged: number;
      /**
       * 分かれているとき、同じ箇所で衝突するファイル（設計書5.5.18）。
       *
       * **`readSyncStatus` は埋めない**（`merge-tree` を走らせる必要があり、
       * 一覧の描き直しごとに全作品ぶん動かすと重い）。分かれている置き場に
       * ついてだけ、見張り側が数えて添える。
       */
      conflicts?: DivergenceConflicts;
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

  // **作業ツリーの状態は、どの分かれ道でも要る。** リモートが無くても
  // 「記録していない変更が何件あるか」は作者に見せたい
  const working = await readWorkingTree(cwd, root, run);
  if (!working) {
    return { kind: "failed", detail: "作業ツリーの状態を読めませんでした" };
  }

  const remotes = await run(["remote"], cwd, LOCAL_TIMEOUT_MS);
  if (remotes.code !== 0) {
    return { kind: "failed", detail: describeFailure(remotes) };
  }
  if (remotes.stdout.trim() === "") {
    return { kind: "no_remote", root, dirty: working.dirty, dirtyHere: working.dirtyHere };
  }

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
    return {
      kind: "no_upstream",
      root,
      branch,
      dirty: working.dirty,
      dirtyHere: working.dirtyHere,
    };
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

  // その作品に触れたコミットだけを数え直す。
  // **置き場の根そのものなら同じ**なので、gitを二度呼ばない
  const here = isSameLocation(cwd, root)
    ? parsed
    : parseAheadBehind(
        (
          await run(
            [
              "rev-list",
              "--left-right",
              "--count",
              `${upstream}...HEAD`,
              "--",
              ".",
            ],
            cwd,
            LOCAL_TIMEOUT_MS
          )
        ).stdout
      ) ?? parsed;

  return {
    kind: "tracked",
    root,
    branch,
    upstream,
    behind: parsed.behind,
    ahead: parsed.ahead,
    behindHere: here.behind,
    aheadHere: here.ahead,
    dirty: working.dirty,
    dirtyHere: working.dirtyHere,
    unmerged: working.unmerged,
  };
}

/**
 * 作業ツリーの状態を読む。
 *
 * **置き場ぜんぶと、訊ねたフォルダーの中との2つを返す。**
 * 書庫では前者が全作品の合計になるため、作品一覧に出すと
 * どの作品に書きかけがあるのか分からない。
 *
 * 訊ねた先が置き場の根そのものなら**2つは同じ**なので、gitを二度呼ばない
 * （作品の数だけプロセスを起こすと、一覧の描き直しが目に見えて遅くなる）。
 */
async function readWorkingTree(
  cwd: string,
  root: string,
  run: GitCommandRunner
): Promise<{ dirty: number; dirtyHere: number; unmerged: number } | undefined> {
  const whole = await run(["status", "--porcelain"], cwd, LOCAL_TIMEOUT_MS);
  if (whole.code !== 0) return undefined;
  const counted = parseStatusPorcelain(whole.stdout);

  if (isSameLocation(cwd, root)) {
    return { ...counted, dirtyHere: counted.dirty };
  }

  // `-- .` で、いま居るフォルダーの下だけに絞る。
  // **パスを自分で切り分けない**——日本語のパスは引用符で囲まれるうえ、
  // 改名は2つのパスを持つ。gitに絞らせるほうが確かである
  const here = await run(
    ["status", "--porcelain", "--", "."],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  return {
    ...counted,
    dirtyHere: here.code === 0 ? parseStatusPorcelain(here.stdout).dirty : counted.dirty,
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
 * 書きかけを抱えたまま、**早送りだけで**取り込む（設計書5.5.18）。
 *
 * **分岐は、遅れている側が先にコミットした瞬間に生まれる。** 21件遅れた
 * 手元で「取り込む前の自動保存」をすると、その1件で ahead が立ち、
 * 早送りで済むはずだった取り込みが合流になる（2026-09-11、作者のノートPCが
 * 25件先・21件遅れになり、衝突を1件ずつ選ばされて抜けられなくなった）。
 * **早送りできるうちに取り込めば、分岐そのものが生まれない。**
 *
 * そのため `pullFastForward` と違い、**未コミットの変更があっても止めない。**
 * `--autostash` は、書きかけをgitがいったん退避し、取り込んだあとで戻す
 * 指定である。早送りは手元の履歴を動かさないので、作者のコミットは
 * 1つも書き換わらない。戻しに失敗した場合もgitは退避（stash）を残すため、
 * 書きかけが消えることはない（**呼び出し側は、戻しが食い違ったまま
 * 記録へ進まないこと**——競合マーカーごとコミットしてしまう）。
 *
 * **`--rebase` は使わない。** 作者のコミットを作り直すことになり、
 * 「履歴は消さない」（設計書5.5.4）に反する。
 */
export async function pullFastForwardAutostash(
  cwd: string,
  run: GitCommandRunner = runGit
): Promise<{ ok: true } | { ok: false; failure: PullFailure }> {
  const result = await run(
    ["pull", "--ff-only", "--autostash"],
    cwd,
    FETCH_TIMEOUT_MS
  );
  if (result.code === 0) return { ok: true };

  // 失敗の読み分けは `pullFastForward` と揃える。
  // 早送りできない＝分かれている、が最も多い
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

/**
 * 選んだ側で確定できたかどうかだけを返す。
 *
 * **合流の途中から呼ぶ側のための形である。** 落ちたらファイル単位で
 * 知らせるのではなく `merge --abort` でまとめて戻すので、理由の文字列は
 * 使い道が無い。**写しを作らないため、中身は `checkoutSide` に任せる**
 * ——合流（`features/resolveDivergence.ts`）と1件ずつの見比べ
 * （`features/resolveConflicts.ts`）の両方がここを通る。
 */
export async function keepSideOfConflict(
  cwd: string,
  relativePath: string,
  side: "ours" | "theirs",
  run: GitCommandRunner = runGit
): Promise<boolean> {
  return (await checkoutSide(cwd, relativePath, side, run)).ok;
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

/**
 * 分かれたあと、**それぞれの側で変わったファイル**（設計書6.15.1）。
 *
 * 機械を行き来したときに「自動で揃えてよいか」を決めるのに使う。
 * **重なりはファイル単位で見る**——行単位で見て自動で混ぜると、
 * どちらの文章が消えたか作者が気づけない（設計書6.15）。
 *
 * 3点（`...`）で訊くと、gitが分かれ目（merge-base）を自分で見つけてくれる。
 * 分かれ目を別に訊かずに済むので、往復が1回減る。
 *
 * **ローカルだけで完結する**（取得済みの上流を見るだけ）。読めなければ
 * 両側とも空で返す——呼び出し側は「調べられなかった」を
 * **重なっている側へ倒して**扱うこと。
 */
export async function changedFilesEachSide(
  cwd: string,
  upstream: string,
  run: GitCommandRunner = runGit
): Promise<{ ok: boolean; local: string[]; remote: string[] }> {
  const local = await run(
    ["diff", "--name-only", "-z", `${upstream}...HEAD`],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (local.code !== 0) return { ok: false, local: [], remote: [] };
  const remote = await run(
    ["diff", "--name-only", "-z", `HEAD...${upstream}`],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (remote.code !== 0) return { ok: false, local: [], remote: [] };
  return {
    ok: true,
    local: splitNulPaths(local.stdout),
    remote: splitNulPaths(remote.stdout),
  };
}

/** NUL区切りのパス一覧をほどく。**区切りはエスケープで書く**（生の制御文字を置かない） */
function splitNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((name) => name !== "");
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
