import { runGit, type GitCommandRunner } from "./git";

/**
 * 過去の版から原稿を戻すための問い合わせ（設計書5.5.10）。
 *
 * **履歴は消さない。** `reset --hard` のように過去を書き換える方法は使わない。
 * 「戻す」も1つの変更として履歴の先に積む。こうしておけば、戻したこと自体を
 * さらに戻せる。作者はプログラマではないので、取り返しのつかない操作を
 * 用意してはいけない。
 */

/** ローカルだけで完結する問い合わせの上限 */
const LOCAL_TIMEOUT_MS = 10_000;

/** 履歴に出す件数。これ以上さかのぼりたいことは稀で、選ぶのが大変になる */
export const HISTORY_LIMIT = 30;

/** 項目の区切り。件名に現れない制御文字（US, 0x1f）を使う */
const FIELD_SEPARATOR = String.fromCharCode(31);

export interface CommitEntry {
  /** 完全なコミットID */
  id: string;
  /** 表示用の短いID */
  shortId: string;
  /** 「2026-08-14 21:03」の形 */
  date: string;
  /** コミットの件名 */
  subject: string;
}

/** 新しい順に履歴を読む */
export async function listCommits(
  cwd: string,
  limit: number = HISTORY_LIMIT,
  run: GitCommandRunner = runGit
): Promise<CommitEntry[]> {
  const result = await run(
    [
      "log",
      `--max-count=${Math.max(1, Math.floor(limit))}`,
      `--format=%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%ad${FIELD_SEPARATOR}%s`,
      "--date=format:%Y-%m-%d %H:%M",
    ],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) return [];
  return parseCommitLog(result.stdout);
}

export function parseCommitLog(stdout: string): CommitEntry[] {
  const entries: CommitEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const [id, shortId, date, ...rest] = line.split(FIELD_SEPARATOR);
    if (!id || !shortId) continue;
    entries.push({
      id: id.trim(),
      shortId: shortId.trim(),
      date: (date ?? "").trim(),
      // 件名に区切り文字が入ることはないが、入っても落とさず戻す
      subject: rest.join(FIELD_SEPARATOR).trim(),
    });
  }
  return entries;
}

export interface RestorePlan {
  /** その版と今とで中身が違うファイル */
  changed: string[];
  /** その版のあとで増えたファイル。戻すと消える */
  addedSince: string[];
  /** その版のあとで消したファイル。戻すと復活する */
  removedSince: string[];
}

export function isEmptyPlan(plan: RestorePlan): boolean {
  return (
    plan.changed.length === 0 &&
    plan.addedSince.length === 0 &&
    plan.removedSince.length === 0
  );
}

/**
 * 戻すと何が起きるかを先に数える。
 *
 * **「消える」ファイルがあることを、実行前に必ず作者へ見せる。**
 * 戻した版より後に書いた話は、戻すと無くなる。件数だけでも見えていれば、
 * 意図しない操作をその場で止められる。
 */
export async function planRestore(
  cwd: string,
  commit: string,
  run: GitCommandRunner = runGit
): Promise<RestorePlan> {
  const result = await run(
    ["diff", "--name-status", "-z", commit, "HEAD"],
    cwd,
    LOCAL_TIMEOUT_MS
  );
  if (result.code !== 0) {
    return { changed: [], addedSince: [], removedSince: [] };
  }
  return parseNameStatus(result.stdout);
}

/**
 * `git diff --name-status -z` の出力を読む。
 *
 * NUL区切りで「状態」「パス」が交互に並ぶ。改名（R）と複製（C）だけは
 * 「状態」「元のパス」「新しいパス」の3つ組になる。
 *
 * 状態は**その版から今へ向かった向き**で付く。今しか無いファイル（A）は、
 * 戻すと消える側になる。
 */
export function parseNameStatus(stdout: string): RestorePlan {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const plan: RestorePlan = { changed: [], addedSince: [], removedSince: [] };

  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    const code = status[0];
    if (code === "R" || code === "C") {
      const from = tokens[index++];
      const to = tokens[index++];
      if (from === undefined || to === undefined) break;
      // 改名は「元の名前が戻り、今の名前が消える」
      plan.removedSince.push(from);
      plan.addedSince.push(to);
      continue;
    }
    const file = tokens[index++];
    if (file === undefined) break;
    if (code === "A") {
      plan.addedSince.push(file);
    } else if (code === "D") {
      plan.removedSince.push(file);
    } else {
      plan.changed.push(file);
    }
  }
  return plan;
}

export interface RestoreResult {
  ok: boolean;
  detail?: string;
}

/**
 * その版の中身を作業フォルダーへ書き戻す。
 *
 * `checkout` は「その版にあるファイル」しか戻さないため、**あとで増えた
 * ファイルは残ってしまう**。それでは戻したことにならないので、増えた分は
 * 明示的に消す。消す対象は `planRestore` で作者に見せたものと同じである。
 */
export async function restoreToCommit(
  cwd: string,
  commit: string,
  plan: RestorePlan,
  run: GitCommandRunner = runGit
): Promise<RestoreResult> {
  const restored = await run(["checkout", commit, "--", "."], cwd, LOCAL_TIMEOUT_MS);
  if (restored.code !== 0) {
    return { ok: false, detail: failureDetail(restored.stderr, restored.stdout) };
  }

  if (plan.addedSince.length > 0) {
    // パスが多いとコマンドラインの上限に当たるので、小分けにする
    for (const batch of chunk(plan.addedSince, 50)) {
      const removed = await run(
        ["rm", "--force", "--quiet", "--", ...batch],
        cwd,
        LOCAL_TIMEOUT_MS
      );
      if (removed.code !== 0) {
        return {
          ok: false,
          detail: failureDetail(removed.stderr, removed.stdout),
        };
      }
    }
  }
  return { ok: true };
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function failureDetail(stderr: string, stdout: string): string {
  const detail = `${stderr}\n${stdout}`.trim();
  return detail.length > 0 ? detail : "gitが理由を返しませんでした。";
}
