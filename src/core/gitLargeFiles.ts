import * as path from "./paths";
import { fileReader } from "./fileRead";
import { mapLimit } from "./mapLimit";
import { runGitForPaths, type GitCommandRunner } from "./git";

/**
 * GitHub に送れない大きさのファイルを、記録・送信の前に見つける（設計書5.5.21）。
 *
 * 2026-11-14 の作者の実機：書庫に 722MB の zip・380MB の onnx が入った記録ができ、
 * 送信が GitHub に断られ続けた。手元の記録は残って「未送信 1」のまま、同期のたびに
 * 同じ断られ方を繰り返していた。**記録してから断られると、作者の手では戻しにくい**
 * （記録を取り消す操作が要る）ので、記録の前に止める。
 */

/**
 * GitHub が1ファイルに許す上限（これを超えると送信を断る）。
 *
 * GitHub の言う「100MB」は 100×1024×1024 バイトで数えている（断りの文の
 * 「100.00 MB」と同じ数え方）。**ここ1か所だけに置く**。
 */
export const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

/** 知らせで道を並べる数。超えたぶんは「ほかN件」 */
const LIST_SHOWN = 3;

/** 大きさを見る stat を同時に走らせる数 */
const STAT_CONCURRENCY = 8;

/** 上限を超えたファイル1つ */
export interface LargeFile {
  /** 置き場の根からの道（git の書き方。区切りは `/`） */
  path: string;
  /** バイト数 */
  size: number;
  /** まだ git に入っていないファイルか（.gitignore に足せば外れる） */
  untracked: boolean;
}

/** ファイルの大きさを返す。ファイルでない・読めないなら undefined */
export type SizeOf = (absolutePath: string) => Promise<number | undefined>;

const defaultSizeOf: SizeOf = async (absolutePath) => {
  try {
    const stat = await (await fileReader()).stat(absolutePath);
    return stat.type === "file" ? stat.size : undefined;
  } catch {
    // 削除・改名の元・読めない道は「大きくない」に倒す。止めるのは確かに大きいものだけ
    return undefined;
  }
};

/**
 * `git status --porcelain -z --untracked-files=all` から、記録で入る道を取り出す。
 *
 * 改名・複写（X か Y が R/C）は、続く1件に元の道が来るので読み飛ばす（入るのは新しい道）。
 */
export function parseRecordableEntries(
  stdout: string
): Array<{ path: string; untracked: boolean }> {
  const fields = stdout.split("\u0000").filter((one) => one !== "");
  const entries: Array<{ path: string; untracked: boolean }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    if (/[RC]/.test(code)) index++;
    // 消したファイルは送らない（大きさも無い）
    if (code.includes("D") && !/[RC]/.test(code)) continue;
    entries.push({ path: field.slice(3), untracked: code === "??" });
  }
  return entries;
}

/**
 * これから記録する変更のうち、上限を超えるファイル。
 *
 * `cwd` は置き場の中のどこでもよい（根を読んでから、根で状態を読む）。
 * 読めなければ空——止めるのは確かに大きいと分かったものだけにする。
 */
export async function findLargeFilesToRecord(
  cwd: string,
  run: GitCommandRunner,
  sizeOf: SizeOf = defaultSizeOf
): Promise<{ root: string; files: LargeFile[] }> {
  const top = await run(["rev-parse", "--show-toplevel"], cwd, 10_000);
  const root = top.code === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : cwd;
  const status = await run(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    root,
    30_000
  );
  if (status.code !== 0) return { root, files: [] };
  const entries = parseRecordableEntries(status.stdout);
  const sizes = await mapLimit(entries, STAT_CONCURRENCY, (entry) =>
    sizeOf(path.join(root, entry.path))
  );
  const files = entries
    .map((entry, index) => ({ ...entry, size: sizes[index] ?? 0 }))
    .filter((entry) => entry.size > GITHUB_FILE_LIMIT_BYTES);
  return { root, files };
}

/**
 * `git ls-tree -r -l -z` の1件（`<mode> <type> <object> <size>\t<path>`）を読む。
 * 大きさが数でない（下位のリポジトリ `-`）ものは落とす。
 */
export function parseLsTreeSizes(stdout: string): Array<{ path: string; size: number }> {
  const found: Array<{ path: string; size: number }> = [];
  for (const field of stdout.split("\u0000")) {
    const tab = field.indexOf("\t");
    if (tab < 0) continue;
    const size = Number(field.slice(0, tab).trim().split(/\s+/)[3]);
    if (!Number.isFinite(size)) continue;
    found.push({ path: field.slice(tab + 1), size });
  }
  return found;
}

/**
 * まだ送っていない記録（`upstream..HEAD`）に入っている、上限を超えるファイル。
 *
 * **すでに記録してしまった分は、記録の前の検査では止まらない**（作者の書庫がいまこの形）。
 * 送ると GitHub が断るうえ、1GB 近い送信は断りの返事より先に時間切れになりうる。
 * そこで送る前に見る。見るのは送る記録で足された・変わった道の、いまの HEAD での大きさ
 * （途中の記録で足して後の記録で消したものは見えない。そのときは GitHub の断りの文が出る）。
 */
export async function findLargeFilesToSend(
  root: string,
  upstream: string,
  run: GitCommandRunner
): Promise<LargeFile[]> {
  const changed = await run(
    ["log", "--format=", "--name-only", "-z", "--diff-filter=AM", `${upstream}..HEAD`],
    root,
    30_000
  );
  if (changed.code !== 0) return [];
  const paths = [
    ...new Set(changed.stdout.split(/\u0000|\n/).filter((one) => one.trim() !== "")),
  ];
  if (paths.length === 0) return [];
  const listed = await runGitForPaths(run, ["ls-tree", "-r", "-l", "-z", "HEAD"], paths, root, 30_000);
  if (listed.code !== 0) return [];
  return parseLsTreeSizes(listed.stdout)
    .filter((one) => one.size > GITHUB_FILE_LIMIT_BYTES)
    .map((one) => ({ ...one, untracked: false }));
}

/** 「722.0MB」の形 */
export function formatMegabytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/** 道と大きさを並べる。多ければ最初の数件と「ほかN件」 */
export function listLargeFiles(files: readonly LargeFile[]): string {
  const lines = files
    .slice(0, LIST_SHOWN)
    .map((one) => `・${one.path}（${formatMegabytes(one.size)}）`);
  if (files.length > LIST_SHOWN) lines.push(`ほか${files.length - LIST_SHOWN}件`);
  return lines.join("\n");
}

/** 記録の前に止めたときの文 */
export function describeTooLargeToRecord(files: readonly LargeFile[]): string {
  return (
    "GitHub に送れない大きさ（1ファイル100MB超）のファイルがあるので、記録も送信もしませんでした。\n" +
    listLargeFiles(files)
  );
}

/** 送る前に止めたときの文 */
export function describeTooLargeToSend(files: readonly LargeFile[]): string {
  return (
    "まだ送っていない記録に、GitHub に送れない大きさ（1ファイル100MB超）のファイルが入っているので、送りませんでした。\n" +
    listLargeFiles(files)
  );
}

/**
 * .gitignore に足す1行。根からの道に固定する（`/` で始める）。
 *
 * .gitignore では `*`・`?`・`[`・`]`・`\` が型の記号になり、末尾の空白は捨てられ、
 * 先頭の `#`・`!` は別の意味になる。**そのファイルだけ**に当たるよう打ち消す。
 */
export function ignoreRuleFor(relativePath: string): string {
  const escaped = relativePath
    .replace(/[\\*?[\]]/g, (mark) => `\\${mark}`)
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
  // 先頭に `/` を付けるので、`#`・`!` が行頭に来ることはない
  return `/${escaped}`;
}
