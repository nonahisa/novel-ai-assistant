/**
 * 使わなくなったものを、起動のたびに自動で片づける（作者の依頼、2026-09-25）。
 *
 * 作者の言葉：「使わなくなったものを適切に片づける担当を置いてください。
 * テスト後のブラウザ版VSCodeが残っています」→「片付け担当以外の手段があれば
 * それでもいいですよ」。
 *
 * 片づけ担当（`.claude/agents/cleaner.md`）の手順のうち、**条件がはっきり
 * 書けるものだけ**をここへ移した。判断が要るもの（スクラッチパッドの写し、
 * 配布物、Chrome のタブ）は担当に残す。
 *
 * 片づけるのは3つ。
 *
 *   1. 取り込み済みの担当の作業場（`.claude/worktrees/agent-*`）
 *   2. 右の枠の起動設定（`.claude/launch.json`）のうち、開くフォルダーがもう無いもの
 *   3. 起動から12時間以上たった試験用のプロセス（Windows）
 *
 * ## 決まり
 *
 * - **消す前に条件を確かめ、1つでも怪しければ触らずに記録だけ残す。**
 *   消しすぎは取り返しがつかないが、消し残しは次の回に拾える
 * - **何が起きても例外で止まらず、終了コード0で終わる。** 起動時に走らせる
 *   ので、ここで止まると作業そのものが始められなくなる
 * - 記録は `.git/novelai-cleanup.log` へ足す（git が追わない場所）
 *
 * ## 使い方
 *
 *   node scripts/cleanup.mjs            消したもの・残したもの・理由を1行ずつ出す
 *   node scripts/cleanup.mjs --dry-run  何も消さず、消すつもりのものだけを出す
 *   node scripts/cleanup.mjs --quiet    起動時のフック用。消したときだけ1行出す
 *
 * ## 判定は純粋な関数に分けてある
 *
 * `judge…` で始まる関数はファイルにもプロセスにも触らない。試験
 * （`test/unit/cross/cleanup.test.ts`）はそこを条件ごとに確かめ、
 * 消す部分（`removeTreeSafely`）は一時フォルダーに作った作り物で確かめる。
 * **本物の作業場は試験で消さない**（この台自体が作業場の中で書かれた）。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// ── 定数 ──────────────────────────────────────────────

/** 試験用プロセスの印。コマンド行にこれを含まないものには触らない */
export const PROCESS_MARKERS = [
  "@vscode/test-web",
  "vscode-test-web",
  ".vscode-test\\vscode-win32-x64-archive",
  "dist/mcp-server.mjs",
  "dist\\mcp-server.mjs",
];

/**
 * MCP サーバーの印。**このセッションの Claude Code が起こしたものは長く生きる**
 * ので、親が生きていれば止めない（ほかの試験用プロセスとは扱いを分ける）
 */
const MCP_MARKERS = ["dist/mcp-server.mjs", "dist\\mcp-server.mjs"];

/** 試験用プロセスを止めてよい経過時間。これより若いものは誰かが使っている見込みがある */
export const PROCESS_MIN_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * 作業場が作られてから、これより短いものは触らない。
 * `git worktree add` の途中（フォルダーはあるが一覧へ載る前）を消さないため
 */
export const WORKTREE_MIN_AGE_MS = 30 * 60 * 1000;

/** 常用の起動設定の印。開くフォルダーの有無に関係なく残す */
export const KEEP_LAUNCH_MARK = "たゆたう鉛_確認用";

/**
 * 作業場の中で、本体への連結（ジャンクション）になっていることがある場所。
 * **連結をたどって消すと本体の依存が消える**（2026-09-24 に `node_modules/.bin`
 * が空になった）。消す前に、この3つは名指しで連結を外す
 */
export const LINKABLE_DIRS = ["node_modules", ".vscode-test", ".vscode-test-web"];

/** 消している途中のものを置く場所（`.claude/worktrees/` の下）。次の回に続きを消す */
export const TRASH_DIR_NAME = ".cleanup-trash";

// ── 道の比べ方 ────────────────────────────────────────

/**
 * Windows は道の大文字小文字を区別せず、`/` と `\` も同じに扱う。
 * `git worktree list` は `C:/Users/...` の形で返し、`realpath` は
 * `c--users` のように小文字で返すことがあるので、揃えてから比べる
 */
export function samePath(a, b, platform = process.platform) {
  return normalizePath(a, platform) === normalizePath(b, platform);
}

function normalizePath(p, platform) {
  const resolved = platform === "win32" ? path.win32.resolve(p) : path.posix.resolve(p);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

/** `a` が `b` と同じか、`b` の中にあるか */
function isInside(a, b, platform = process.platform) {
  const na = normalizePath(a, platform);
  const nb = normalizePath(b, platform);
  const sep = platform === "win32" ? "\\" : "/";
  return na === nb || na.startsWith(nb + sep);
}

// ── 1. 作業場 ─────────────────────────────────────────

/** @typedef {{path: string, branch: string | null, locked: boolean, lockReason: string}} WorktreeEntry */

/**
 * `git worktree list --porcelain` を読む。
 * 1つの作業場は空行で区切られ、`worktree <道>`・`branch refs/heads/<枝>`・
 * `detached`・`locked <理由>` の行を持つ
 *
 * @param {string} text
 * @returns {WorktreeEntry[]}
 */
export function parseWorktreeList(text) {
  /** @type {WorktreeEntry[]} */
  const entries = [];
  /** @type {WorktreeEntry | null} */
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, locked: false, lockReason: "" };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked".length).trim();
    }
  }
  return entries;
}

/** ロックの理由から pid を取り出す（Claude Code は `claude agent … (pid 7188)` と書く） */
export function lockPidOf(reason) {
  const m = /pid\s+(\d+)/i.exec(reason ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * 作業場のフォルダーを1つずつ判定する。ファイルにもプロセスにも触らない。
 *
 * @param {object} input
 * @param {{name:string, path:string, isDirectory:boolean, isLink:boolean, ageMs:number}[]} input.folders
 *   `.claude/worktrees/` の中身
 * @param {{path:string, branch:string|null, locked:boolean, lockReason:string}[]} input.listed
 *   `git worktree list` の結果
 * @param {Set<string>} input.branches 手元の枝の名前
 * @param {(pid:number)=>boolean} input.isPidAlive
 * @param {string[]} input.protectedPaths 決して消さない道（いま動いている作業場など）
 * @param {string} [input.platform]
 * @returns {{name:string, path:string, action:"remove"|"keep", reason:string, listedEntry?:object}[]}
 */
export function judgeWorktreeFolders(input) {
  const platform = input.platform ?? process.platform;
  const results = [];
  for (const folder of input.folders) {
    const keep = (reason) => results.push({ name: folder.name, path: folder.path, action: "keep", reason });
    if (folder.name === TRASH_DIR_NAME) continue;
    // **ほかのセッションの作業場**（`gifted-colden-*` など）。担当のものではないので見ない
    if (!folder.name.startsWith("agent-")) {
      keep("ほかのセッションの作業場（agent- で始まらない）");
      continue;
    }
    if (folder.isLink) {
      keep("作業場そのものが連結になっている（中身が本体の可能性があるので触らない）");
      continue;
    }
    if (!folder.isDirectory) {
      keep("フォルダーではない");
      continue;
    }
    // 守る道がこの作業場の中にある（＝いまこの作業場の中で動いている）なら触らない。
    // 逆向き（作業場が本体の中にある）は当たり前なので見ない
    if (input.protectedPaths.some((p) => isInside(p, folder.path, platform))) {
      keep("いま使っている作業場");
      continue;
    }
    // 消す候補になったものだけ、最後に「新しすぎないか」を見る
    // （残す理由が先に決まるものは、その理由を出したほうが分かりやすい）
    const remove = (reason, extra = {}) => {
      if (!(folder.ageMs >= WORKTREE_MIN_AGE_MS)) {
        keep("最近作られたか書き換えられた。作っている途中かもしれない");
        return;
      }
      results.push({ name: folder.name, path: folder.path, action: "remove", reason, ...extra });
    };
    const listedEntry = input.listed.find((e) => samePath(e.path, folder.path, platform));
    const branchName = `worktree-${folder.name}`;
    // 一覧に載っていて、枝が同じ名前か（切り離し中なら）同じ名前の枝が残っているか
    const hasBranch = input.branches.has(branchName) || (listedEntry?.branch ? input.branches.has(listedEntry.branch) : false);
    if (!listedEntry) {
      remove("git worktree list に載っていない");
      continue;
    }
    if (hasBranch) {
      // **まだ動いている担当のもの。** 追加の指示で再び動くことがある
      keep("一覧に載っていて枝もある。担当がまだ使うかもしれない");
      continue;
    }
    if (listedEntry.locked) {
      const pid = lockPidOf(listedEntry.lockReason);
      if (pid === null) {
        keep(`ロックされていて、ロックした人が分からない（${listedEntry.lockReason || "理由なし"}）`);
        continue;
      }
      if (input.isPidAlive(pid)) {
        keep(`ロックしたプロセス（pid ${pid}）がまだ生きている`);
        continue;
      }
    }
    remove(`枝 ${branchName} がもう無い`, { listedEntry });
  }
  return results;
}

// ── 消す（連結をたどらない） ─────────────────────────

/** 時間切れ。続きは次の回に消す */
export class TimeUpError extends Error {}

/**
 * 連結（ジャンクション・シンボリックリンク）だけを外す。**中身には触らない。**
 *
 * Windows のジャンクションは `cmd /c rmdir "<道>"`（`/s` を付けない）で外す。
 * `/s` を付けたり、中をたどって消したりすると、**つながった先の本体が消える。**
 * 外したあと、本当に無くなったかを確かめ、残っていれば投げる
 * （呼び出し側は、その場所の中へ入らずに止まる）。
 */
export function removeLinkOnly(linkPath, platform = process.platform) {
  if (platform === "win32") {
    try {
      // 道に `"` は入らない（Windows で使えない文字）ので、そのまま囲める
      execFileSync("cmd", ["/d", "/s", "/c", `rmdir "${linkPath}"`], {
        windowsVerbatimArguments: true,
        stdio: "ignore",
        timeout: 20_000,
      });
    } catch {
      // ファイルへのシンボリックリンクは rmdir では外れない。下で unlink を試す
    }
  }
  if (lstatOrNull(linkPath)) {
    try {
      fs.unlinkSync(linkPath);
    } catch {
      // 下で確かめて投げる
    }
  }
  if (lstatOrNull(linkPath)) {
    throw new Error(`連結を外せませんでした：${linkPath}`);
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * フォルダーを消す。**連結をたどらない。**
 *
 * `fs.rmSync({ recursive: true })` や `git worktree remove` は、Windows の
 * ジャンクションをただのフォルダーとして中へ入ることがある。ここでは
 * 1つずつ `lstat` を見て、連結なら連結だけを外す。念のため、フォルダーの
 * 実体の道（`realpath`）が「親の実体＋名前」と食い違うときも連結とみなす
 * （`lstat` が見抜けない種類の差し替えに備える）。
 *
 * @param {string} target
 * @param {{deadline?: number, platform?: string, removeLink?: (p:string)=>void}} [options]
 *   `deadline` を過ぎたら `TimeUpError` を投げる（途中まで消えた状態で残る。次の回に続きを消す）
 */
export function removeTreeSafely(target, options = {}) {
  const platform = options.platform ?? process.platform;
  const removeLink = options.removeLink ?? ((p) => removeLinkOnly(p, platform));
  const deadline = options.deadline ?? Infinity;
  const st = lstatOrNull(target);
  if (!st) return;
  if (st.isSymbolicLink()) {
    removeLink(target);
    return;
  }
  if (!st.isDirectory()) {
    unlinkFile(target);
    return;
  }
  removeDir(target, fs.realpathSync.native(target), { platform, removeLink, deadline });
}

function removeDir(dir, dirReal, ctx) {
  for (const name of fs.readdirSync(dir)) {
    if (Date.now() > ctx.deadline) throw new TimeUpError("時間切れ");
    const child = path.join(dir, name);
    const st = lstatOrNull(child);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      ctx.removeLink(child);
      continue;
    }
    if (st.isDirectory()) {
      const childReal = fs.realpathSync.native(child);
      if (!samePath(childReal, path.join(dirReal, name), ctx.platform)) {
        // 実体が別の場所にある＝連結の一種。中へ入らず、連結だけを外す
        ctx.removeLink(child);
        continue;
      }
      removeDir(child, childReal, ctx);
      continue;
    }
    unlinkFile(child);
  }
  fs.rmdirSync(dir);
}

/** git のオブジェクトは読み取り専用なので、Windows では属性を外してから消す */
function unlinkFile(p) {
  try {
    fs.unlinkSync(p);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      fs.chmodSync(p, 0o666);
      fs.unlinkSync(p);
      return;
    }
    throw error;
  }
}

// ── 2. 起動設定 ──────────────────────────────────────

/** 開くフォルダーとして読める道か（`--port` のような指定や相対の道は読まない） */
function looksLikeAbsoluteFolder(arg, platform) {
  if (typeof arg !== "string" || arg === "" || arg.startsWith("-")) return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("\\\\");
  return arg.startsWith("/");
}

/**
 * 起動設定を1つずつ判定する。
 *
 * **消すのは「最後の引数が絶対の道で、それがもう無い」ものだけ。**
 * 最後の引数が道に見えないもの（`["run", "dev"]` の `dev` など）は、
 * 無いと言い切れないので残す。
 *
 * @param {{name?:string, runtimeArgs?:unknown[]}[]} configs
 * @param {(p:string)=>boolean} pathExists
 */
export function judgeLaunchConfigs(configs, pathExists, platform = process.platform) {
  return configs.map((config, index) => {
    const name = typeof config?.name === "string" ? config.name : `（名前なし ${index + 1}番目）`;
    if (name.includes(KEEP_LAUNCH_MARK)) {
      return { index, name, action: "keep", reason: "常用の設定" };
    }
    const args = Array.isArray(config?.runtimeArgs) ? config.runtimeArgs : [];
    const last = args[args.length - 1];
    if (!looksLikeAbsoluteFolder(last, platform)) {
      return { index, name, action: "keep", reason: "開くフォルダーが読み取れない" };
    }
    if (pathExists(last)) {
      return { index, name, action: "keep", reason: "開くフォルダーがある" };
    }
    return { index, name, action: "remove", reason: `開くフォルダーがもう無い（${last}）` };
  });
}

// ── 3. プロセス ──────────────────────────────────────

function normalizeCommandLine(s) {
  return String(s ?? "").replace(/\//g, "\\").toLowerCase();
}

/** コマンド行に含まれる印を返す（無ければ null）。`/` と `\`、大文字小文字は区別しない */
export function markerOf(commandLine) {
  const cmd = normalizeCommandLine(commandLine);
  return PROCESS_MARKERS.find((m) => cmd.includes(normalizeCommandLine(m))) ?? null;
}

/**
 * 試験用プロセスを判定する。印の無いプロセスは結果に含めない
 * （**作者の VS Code・Chrome・Edge・Ollama・LM Studio には印が無い**ので、ここで外れる）。
 *
 * @param {{pid:number, parentPid:number, start:string|null, commandLine:string|null}[]} procs
 *   動いているプロセスすべて（親が生きているかを見るのに使う）
 * @param {{now:number, selfPids?:Set<number>, minAgeMs?:number}} options
 */
export function judgeProcesses(procs, options) {
  const minAge = options.minAgeMs ?? PROCESS_MIN_AGE_MS;
  const selfPids = options.selfPids ?? new Set();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const results = [];
  for (const proc of procs) {
    const marker = markerOf(proc.commandLine);
    if (!marker) continue;
    const label = shortCommand(proc.commandLine);
    const keep = (reason) => results.push({ pid: proc.pid, label, marker, action: "keep", reason });
    if (selfPids.has(proc.pid)) {
      keep("この片づけ自身か、その親");
      continue;
    }
    // 常用の「ブラウザ版VS Code（たゆたう鉛_確認用）」は、作者が何時間開いたままでも止めない
    // （起動設定を残すのと同じ考え。2026-09-25、本体の取り込みで足した）
    if (String(proc.commandLine ?? "").includes(KEEP_LAUNCH_MARK)) {
      keep("常用のブラウザ版（たゆたう鉛_確認用）");
      continue;
    }
    const started = proc.start ? Date.parse(proc.start) : NaN;
    if (!Number.isFinite(started)) {
      keep("起動時刻が読めない");
      continue;
    }
    const age = options.now - started;
    if (age < minAge) {
      keep(`起動から${formatHours(age)}（12時間未満）`);
      continue;
    }
    if (MCP_MARKERS.includes(marker)) {
      const parent = byPid.get(proc.parentPid);
      // 親の pid が別のプロセスに使い回されていることがある。**子より後に
      // 起動した「親」は本物の親ではない**ので、生きているとは数えない
      const parentStart = parent?.start ? Date.parse(parent.start) : NaN;
      const parentAlive = parent && proc.parentPid > 0 && !(Number.isFinite(parentStart) && parentStart > started);
      if (parentAlive) {
        keep(`親（pid ${proc.parentPid}）が生きている（起こしたセッションがまだ使っている）`);
        continue;
      }
    }
    results.push({ pid: proc.pid, label, marker, action: "remove", reason: `起動から${formatHours(age)}たっている` });
  }
  return results;
}

function formatHours(ms) {
  const h = ms / 3_600_000;
  return h >= 1 ? `${Math.floor(h)}時間` : `${Math.max(0, Math.floor(ms / 60_000))}分`;
}

function shortCommand(commandLine) {
  const s = String(commandLine ?? "").replace(/\s+/g, " ").trim();
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

// ── まとめの1行 ──────────────────────────────────────

/** 「片づけ：作業場2つ・起動設定1つ」の形。何も消さなければ空文字 */
export function summarize(counts, dryRun = false) {
  const parts = [];
  if (counts.worktrees > 0) parts.push(`作業場${counts.worktrees}つ`);
  if (counts.launch > 0) parts.push(`起動設定${counts.launch}つ`);
  if (counts.processes > 0) parts.push(`プロセス${counts.processes}つ`);
  if (parts.length === 0) return "";
  return `${dryRun ? "片づけ（試し。消していない）" : "片づけ"}：${parts.join("・")}`;
}

// ── 実際に動かす部分 ────────────────────────────────

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  }).trim();
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM は「在るが触れない」。在ると数える
    return Boolean(error && error.code === "EPERM");
  }
}

function countBin(mainRoot) {
  try {
    return fs.readdirSync(path.join(mainRoot, "node_modules", ".bin")).length;
  } catch {
    return null;
  }
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 片づけを1回行う。**投げない。** 起きたことは `report` に積む。
 *
 * @param {{dryRun?:boolean, quiet?:boolean, cwd?:string, deadlineMs?:number}} [options]
 */
export function runCleanup(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const cwd = options.cwd ?? process.cwd();
  const deadline = Date.now() + (options.deadlineMs ?? Infinity);
  const report = { lines: [], log: [], counts: { worktrees: 0, launch: 0, processes: 0 }, alarm: "", failures: 0 };
  const note = (kind, subject, reason) => {
    const verb = { removed: dryRun ? "消す予定" : "消した", kept: "残した", failed: "消せず", info: "記録" }[kind];
    const line = `${verb}　${subject}：${reason}`;
    report.lines.push(line);
    report.log.push(line);
    if (kind === "failed") report.failures += 1;
  };

  // 本体（main の作業木）の場所。**作業場の中から走らせても、本体の道具と
  // 起動設定を見る。** 共通の .git の親が本体である
  let mainRoot;
  let gitCommonDir;
  let currentTop = cwd;
  try {
    gitCommonDir = path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"));
    mainRoot = path.dirname(gitCommonDir);
    currentTop = git(cwd, "rev-parse", "--show-toplevel");
  } catch (error) {
    note("failed", "片づけ全体", `git の場所が分からない：${messageOf(error)}`);
    return report;
  }
  report.logFile = path.join(gitCommonDir, "novelai-cleanup.log");

  const binBefore = countBin(mainRoot);
  const checkBin = (after) => {
    if (binBefore === null) return true;
    const now = countBin(mainRoot);
    if (now === null || now < binBefore) {
      report.alarm =
        `【片づけを止めました】本体の node_modules/.bin が ${binBefore} 件から ${now ?? 0} 件に減りました（${after}のあと）。` +
        "連結をたどって本体の依存を消した恐れがあります。npm rebuild（直らなければ npm install）で戻してください。";
      report.log.push(report.alarm);
      return false;
    }
    return true;
  };

  // ── 1. 作業場 ──
  let stopped = false;
  try {
    stopped = !cleanWorktrees({ mainRoot, currentTop, cwd, dryRun, deadline, note, report, checkBin });
  } catch (error) {
    note("failed", "作業場の片づけ", messageOf(error));
  }
  if (stopped) return report;

  // ── 2. 起動設定 ──
  try {
    cleanLaunchJson({ mainRoot, dryRun, note, report });
  } catch (error) {
    note("failed", "起動設定の片づけ", messageOf(error));
  }

  // ── 3. プロセス ──
  try {
    cleanProcesses({ dryRun, note, report });
  } catch (error) {
    note("failed", "プロセスの片づけ", messageOf(error));
  }
  return report;
}

function cleanWorktrees({ mainRoot, currentTop, cwd, dryRun, deadline, note, report, checkBin }) {
  const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
  if (!fs.existsSync(worktreesDir)) return true;
  const trashDir = path.join(worktreesDir, TRASH_DIR_NAME);

  // 前の回に時間切れで残った消しかけを、先に片づける（中身はもう判定済み）
  if (!dryRun && fs.existsSync(trashDir)) {
    for (const name of fs.readdirSync(trashDir)) {
      const p = path.join(trashDir, name);
      try {
        removeTreeSafely(p, { deadline });
        note("info", `消しかけの ${name}`, "前の回の続きを消した");
      } catch (error) {
        if (error instanceof TimeUpError) {
          note("info", `消しかけの ${name}`, "時間切れ。続きは次の回");
          return true;
        }
        note("failed", `消しかけの ${name}`, messageOf(error));
      }
      if (!checkBin(`消しかけの ${name}`)) return false;
    }
  }

  const listText = git(cwd, "worktree", "list", "--porcelain");
  const listed = parseWorktreeList(listText);
  // **一覧が取れなかったときは何もしない。** 空の一覧で判定すると、
  // すべての作業場が「載っていない」ことになり、動いている担当まで消える
  if (listed.length === 0 || !listed.some((e) => samePath(e.path, mainRoot))) {
    note("kept", "作業場すべて", "git worktree list に本体が見当たらない（一覧が信用できない）");
    return true;
  }
  const branches = new Set(
    git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
      .split(/\r?\n/)
      .filter(Boolean)
  );

  const now = Date.now();
  const folders = fs.readdirSync(worktreesDir).map((name) => {
    const p = path.join(worktreesDir, name);
    const st = lstatOrNull(p);
    return {
      name,
      path: p,
      isDirectory: Boolean(st?.isDirectory()),
      isLink: Boolean(st?.isSymbolicLink()),
      // 作られた時刻が取れない環境では、書き換えた時刻で代える（どちらも若いものを守る向き）
      ageMs: st ? now - Math.max(st.birthtimeMs || 0, st.mtimeMs || 0) : 0,
    };
  });

  const judged = judgeWorktreeFolders({
    folders,
    listed,
    branches,
    isPidAlive,
    protectedPaths: [mainRoot, currentTop, cwd],
  });

  let removedAny = false;
  for (const item of judged) {
    const subject = `作業場 ${item.name}`;
    if (item.action === "keep") {
      note("kept", subject, item.reason);
      continue;
    }
    if (dryRun) {
      note("removed", subject, item.reason);
      report.counts.worktrees += 1;
      continue;
    }
    const outcome = removeOneWorktree(item, { cwd, trashDir, deadline });
    if (outcome.ok) {
      removedAny = true;
      report.counts.worktrees += 1;
      note("removed", subject, item.reason + (outcome.note ? `。${outcome.note}` : ""));
    } else {
      note("failed", subject, outcome.reason);
    }
    if (!checkBin(subject)) return false;
    if (outcome.timeUp) break;
  }

  if (!dryRun && removedAny) {
    try {
      git(cwd, "worktree", "prune");
    } catch (error) {
      note("failed", "git worktree prune", messageOf(error));
    }
  }
  // 消しかけ置き場が空になったら、置き場ごと片づける（空でなければ次の回の続き用に残す）
  if (!dryRun) {
    try {
      if (fs.existsSync(trashDir) && fs.readdirSync(trashDir).length === 0) fs.rmdirSync(trashDir);
    } catch {
      // 残っても害は無い。次の回にまた試す
    }
  }
  return true;
}

/**
 * 作業場を1つ消す。
 *
 * 順番に意味がある。
 *   ① 名指しの3つ（node_modules など）の連結を外す——中身をたどらせないため
 *   ② 消しかけ置き場へ名前を変えて移す——**使用中なら Windows はここで断る**ので、
 *      半分だけ消えた作業場を作らずに済む
 *   ③ 連結をたどらずに中身を消す
 */
function removeOneWorktree(item, { cwd, trashDir, deadline }) {
  const detached = [];
  for (const name of LINKABLE_DIRS) {
    const p = path.join(item.path, name);
    const st = lstatOrNull(p);
    if (st?.isSymbolicLink()) {
      try {
        removeLinkOnly(p);
        detached.push(name);
      } catch (error) {
        return { ok: false, reason: `${name} の連結を外せないので、中身に触らずに残した：${messageOf(error)}` };
      }
    }
  }

  // 一覧に載ったままのロックは、外さないと prune が片づけない
  const lockReason = item.listedEntry?.locked ? item.listedEntry.lockReason : null;
  if (lockReason !== null) {
    try {
      git(cwd, "worktree", "unlock", item.path);
    } catch (error) {
      return { ok: false, reason: `ロックを外せない：${messageOf(error)}` };
    }
  }

  const trashPath = path.join(trashDir, `${item.name}-${Date.now()}`);
  try {
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(item.path, trashPath);
  } catch (error) {
    if (lockReason !== null) {
      try {
        git(cwd, "worktree", "lock", "--reason", lockReason, item.path);
      } catch {
        // 元へ戻せなくても、作業場の中身は無事（名前を変えられていない）
      }
    }
    return { ok: false, reason: `使用中らしく動かせないので残した：${messageOf(error)}` };
  }

  const linkNote = detached.length > 0 ? `連結 ${detached.join("・")} を外してから消した` : "";
  try {
    removeTreeSafely(trashPath, { deadline });
  } catch (error) {
    if (error instanceof TimeUpError) {
      return { ok: true, timeUp: true, note: [linkNote, "時間切れ。残りは次の回に消す"].filter(Boolean).join("。") };
    }
    return { ok: false, reason: `途中で消せなくなった（${TRASH_DIR_NAME} に残した）：${messageOf(error)}` };
  }
  return { ok: true, note: linkNote };
}

function cleanLaunchJson({ mainRoot, dryRun, note, report }) {
  const file = path.join(mainRoot, ".claude", "launch.json");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    // **壊れた設定は直さない。** 作者が手で書いている途中かもしれない
    note("kept", "起動設定すべて", `launch.json が読めない：${messageOf(error)}`);
    return;
  }
  if (!data || !Array.isArray(data.configurations)) {
    note("kept", "起動設定すべて", "configurations が無い");
    return;
  }
  const judged = judgeLaunchConfigs(data.configurations, (p) => fs.existsSync(p));
  const removeIdx = new Set();
  for (const item of judged) {
    if (item.action === "keep") {
      note("kept", `起動設定「${item.name}」`, item.reason);
    } else {
      removeIdx.add(item.index);
      note("removed", `起動設定「${item.name}」`, item.reason);
      report.counts.launch += 1;
    }
  }
  if (dryRun || removeIdx.size === 0) return;
  data.configurations = data.configurations.filter((_, i) => !removeIdx.has(i));
  // 書き方（字下げ2・改行コード・最後の改行）は元に合わせる
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(data, null, 2).replace(/\n/g, eol);
  if (/\r?\n$/.test(text)) out += eol;
  // 一時ファイルへ書いてから置き換える（途中で止まっても半端な設定を残さない）。
  // launch.json は git の管理外で、作者の原稿ではない
  const tmp = `${file}.cleanup-${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, "utf8");
  fs.renameSync(tmp, file);
}

function listProcessesWindows() {
  // 起動時刻は UTC の ISO 形式で出す（PowerShell 5.1 の ConvertTo-Json は日時を /Date(…)/ にする）
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId;",
    "    start = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null });",
    "    commandLine = $_.CommandLine }",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function cleanProcesses({ dryRun, note, report }) {
  if (process.platform !== "win32") return;
  const procs = listProcessesWindows();
  // 自分と、自分を起こした親たち（フックを走らせている Claude Code など）は対象から外す
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const selfPids = new Set();
  for (let pid = process.pid, guard = 0; pid && guard < 20 && !selfPids.has(pid); guard += 1) {
    selfPids.add(pid);
    pid = byPid.get(pid)?.parentPid ?? 0;
  }
  const judged = judgeProcesses(procs, { now: Date.now(), selfPids });
  for (const item of judged) {
    const subject = `プロセス ${item.pid}「${item.label}」`;
    if (item.action === "keep") {
      note("kept", subject, item.reason);
      continue;
    }
    if (dryRun) {
      note("removed", subject, item.reason);
      report.counts.processes += 1;
      continue;
    }
    try {
      process.kill(item.pid);
      note("removed", subject, item.reason);
      report.counts.processes += 1;
    } catch (error) {
      if (error && error.code === "ESRCH") {
        // 同じ組の別のプロセスを止めたときに、一緒に終わっていた
        note("removed", subject, `${item.reason}。すでに終わっていた`);
        report.counts.processes += 1;
      } else {
        note("failed", subject, messageOf(error));
      }
    }
  }
}

/** よく出るファイルの失敗は、長い道を並べずに意味だけを書く */
const FS_ERROR_WORDS = {
  EBUSY: "使用中",
  EPERM: "権限が無いか使用中",
  EACCES: "権限が無い",
  ENOENT: "見つからない",
  ENOTEMPTY: "中身が残っている",
};

function messageOf(error) {
  if (error && typeof error === "object" && "code" in error && FS_ERROR_WORDS[error.code]) {
    return `${FS_ERROR_WORDS[error.code]}（${error.code}）`;
  }
  if (error && typeof error === "object") {
    const stderr = "stderr" in error && error.stderr ? String(error.stderr).trim() : "";
    const msg = "message" in error ? String(error.message) : String(error);
    return (stderr || msg).split(/\r?\n/)[0].slice(0, 200);
  }
  return String(error);
}

function appendLog(report, dryRun) {
  if (!report.logFile) return;
  const stamp = timestamp();
  const head = `[${stamp}] ${dryRun ? "片づけ（試し）" : "片づけ"}`;
  const body = report.log.length > 0 ? report.log.map((l) => `[${stamp}]   ${l}`) : [`[${stamp}]   片づけるものなし`];
  try {
    fs.appendFileSync(report.logFile, [head, ...body].join("\n") + "\n", "utf8");
  } catch {
    // 記録が書けなくても、片づけの結果は変わらない
  }
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const quiet = argv.includes("--quiet");
  // 起動時のフックでは、長くかかる削除を20秒で切り上げて次の回へ回す
  // （作業場1つに本物の node_modules があると、消すのに数十秒かかる）
  const report = runCleanup({ dryRun, quiet, deadlineMs: quiet ? 20_000 : undefined });
  appendLog(report, dryRun);

  const out = [];
  if (report.alarm) out.push(report.alarm);
  if (quiet) {
    const summary = summarize(report.counts, dryRun);
    if (summary) {
      out.push(report.failures > 0 ? `${summary}（消せなかったもの${report.failures}つ。記録は .git/novelai-cleanup.log）` : summary);
    }
  } else {
    out.push(...report.lines);
    out.push(summarize(report.counts, dryRun) || (dryRun ? "片づけ（試し）：消すものなし" : "片づけ：消すものなし"));
  }
  if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // **何が起きても0で終わる。** 起動時のフックを止めないため
    process.stdout.write(`片づけ：途中で止まりました（${messageOf(error)}）\n`);
  }
  process.exitCode = 0;
}
