import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { runGit, pullFastForward, type GitCommandRunner } from "../core/git";
import {
  commitAll,
  currentBranch,
  ghAvailable,
  ghCreateRepository,
  hasCommits,
  initRepository,
  pushSetUpstream,
  suggestRepositoryName,
} from "../core/gitSetup";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  editingFolderName,
  mergeProposalJsonl,
  replacedDirectories,
  SHARED_FILES,
} from "../core/editingRepo";
import { logFailure } from "../core/logger";
import { withProgress } from "../views/progress";
import { askText } from "../views/dialogs";
import { isEditorMode } from "../core/actorContext";

/**
 * 編集部へ作品を渡し、提案を受け取る（設計書5.7.5）。
 *
 * **作品集へ編集部を招くことはできない。** GitHubの権限はリポジトリ単位で
 * しかかけられないので、招いた時点で全作品が読めてしまう。渡す作品だけを
 * 入れたリポジトリを別に切り出す。
 *
 * 送り出すのは本文と設定資料だけ。**編集部はそこへ書かない**ので、
 * 送り出すたびにまるごと置き換えてよい。提案だけは両方向で混ぜる
 * （承認・却下は作者が書くため）。
 */

/** 編集用フォルダーの場所を覚えておく先。**同期しない**（端末ごとの事情） */
const POINTER_FILE = "editing.json";

interface EditingPointer {
  /** 編集用フォルダーの絶対パス */
  folderPath: string;
  /** 最後に送り出した日時（ISO8601） */
  sharedAt?: string;
}

function pointerPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, "cache", POINTER_FILE);
}

async function readPointer(
  work: WorkEntry
): Promise<EditingPointer | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(pointerPath(work))
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const folderPath = (parsed as Record<string, unknown>).folderPath;
    if (typeof folderPath !== "string" || folderPath.length === 0) {
      return undefined;
    }
    return parsed as EditingPointer;
  } catch {
    // 覚えていないだけ。次で聞き直せばよい
    return undefined;
  }
}

async function writePointer(
  work: WorkEntry,
  pointer: EditingPointer
): Promise<void> {
  const target = pointerPath(work);
  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(target))
  );
  // **場所を覚えるだけのファイルである。** 失っても聞き直せるので、
  // 原子的な書き込みの仕組みまでは要らない
  await vscode.workspace.fs.writeFile(
    path.toUri(target),
    new TextEncoder().encode(`${JSON.stringify(pointer, null, 2)}\n`)
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(target));
    return true;
  } catch {
    return false;
  }
}

async function readTextIfAny(target: string): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** 提案ファイルの、作品フォルダーからの相対パス */
const PROPOSAL_RELATIVE = path.join(".aiwriter", "proposals", "proposals.jsonl");

/**
 * 作品を編集部へ渡せる形にして、GitHubへ送る。
 *
 * **本文と設定はまるごと置き換える。** 編集部がそこへ書かないので、
 * 消して作り直しても失うものが無い。差分を考えないぶん取り違えも起きない。
 */
export async function shareWithEditor(work: WorkEntry): Promise<void> {
  if (isEditorMode()) {
    void vscode.window.showWarningMessage(
      "編集者モードでは、作品を編集部へ渡せません（作者の操作です）。"
    );
    return;
  }

  const config = await readWorkConfig(work);
  const paths = workPaths(work, config ?? undefined);

  const pointer = await readPointer(work);
  let destination = pointer?.folderPath;

  if (!destination || !(await exists(destination))) {
    const chosen = await chooseDestination(work);
    if (!chosen) return;
    destination = chosen;
  }

  const confirmed = await vscode.window.showWarningMessage(
    pointer
      ? `「${work.title}」の本文と設定資料を、編集部へ送り直しますか。`
      : `「${work.title}」を編集部へ渡す形にしますか。`,
    {
      modal: true,
      detail: [
        "本文と設定資料を、編集用のフォルダーへまるごと写します。",
        "",
        "【送るもの】本文・設定資料・提案のやり取り",
        "【送らないもの】キャッシュ・ログ・回復用の退避・これまでの履歴",
        "",
        "編集部はこのリポジトリだけを見ます。ほかの作品は渡りません。",
        "編集部が書けるのは提案だけで、本文は書き換わりません。",
        "",
        `置き場所: ${destination}`,
      ].join("\n"),
    },
    pointer ? "送り直す" : "渡す形にする"
  );
  if (!confirmed) return;

  const result = await withProgress("編集部へ渡す形にしています…", async () => {
    await copyForEditor(paths, destination, config?.manuscriptDir, config?.settingsDir);
    return setUpAndPush(work, destination);
  });

  if (!result.ok) {
    logFailure("編集部へ渡す", { 作品: work.title, 詳細: result.detail });
    const action = await vscode.window.showErrorMessage(
      `編集部へ渡せませんでした: ${result.detail}`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
    return;
  }

  await writePointer(work, {
    folderPath: destination,
    sharedAt: new Date().toISOString(),
  });

  const next = await vscode.window.showInformationMessage(
    `「${work.title}」を編集部へ渡せる形にしました。` +
      "GitHubの「Settings」→「Collaborators」から編集部を招いてください。",
    "GitHubで開く",
    "閉じる"
  );
  if (next === "GitHubで開く" && result.repositoryUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(result.repositoryUrl));
  }
}

/** 置き場所を聞く。**作品フォルダーの中には置かせない**（入れ子のリポジトリになる） */
async function chooseDestination(work: WorkEntry): Promise<string | undefined> {
  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "ここに置く",
    title: "編集用フォルダーを置く場所を選択（作品集の外を勧めます）",
  });
  if (!parent || parent.length === 0) return undefined;

  const name = await askText({
    title: "編集用フォルダーの名前",
    prompt: "編集部へ渡すフォルダーの名前",
    value: editingFolderName(work.title),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "名前を入力してください";
      if (/[/\\:*?"<>|]/.test(trimmed)) {
        return "フォルダー名に使えない文字が含まれています";
      }
      return null;
    },
  });
  if (!name) return undefined;

  const destination = path.join(parent[0].fsPath, name.trim());

  // 作品フォルダーの中へ置くと、作品集のリポジトリに入れ子で入ってしまう
  const normalizedWork = path.normalize(work.folderPath);
  const inside = path
    .normalize(destination)
    .startsWith(normalizedWork + path.separatorFor(normalizedWork));
  if (inside) {
    void vscode.window.showErrorMessage(
      "作品フォルダーの中には置けません。リポジトリが入れ子になり、" +
        "作品集の側へ巻き込まれます。別の場所を選んでください。"
    );
    return undefined;
  }
  return destination;
}

/**
 * 本文・設定・提案を編集用フォルダーへ写す。
 *
 * **本文と設定は消してから写す。** 作品側で消した話が編集用に残り続けると、
 * 編集部は無い話を校閲することになる。
 */
async function copyForEditor(
  paths: ReturnType<typeof workPaths>,
  destination: string,
  manuscriptDir: string | undefined,
  settingsDir: string | undefined
): Promise<void> {
  await vscode.workspace.fs.createDirectory(path.toUri(destination));

  const replaced = replacedDirectories(
    manuscriptDir ?? path.basename(paths.manuscript),
    settingsDir ?? path.basename(paths.settings)
  );
  const sources = new Map([
    [path.basename(paths.manuscript), paths.manuscript],
    [path.basename(paths.settings), paths.settings],
  ]);

  for (const name of replaced) {
    const source = sources.get(name) ?? path.join(paths.root, name);
    if (!(await exists(source))) continue;
    const target = path.join(destination, name);
    if (await exists(target)) {
      await vscode.workspace.fs.delete(path.toUri(target), {
        recursive: true,
        useTrash: false,
      });
    }
    await vscode.workspace.fs.copy(
      path.toUri(source),
      path.toUri(target),
      { overwrite: true }
    );
  }

  for (const relative of SHARED_FILES) {
    const source = path.join(paths.root, relative);
    if (!(await exists(source))) continue;
    const target = path.join(destination, relative);
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );
    await vscode.workspace.fs.copy(
      path.toUri(source),
      path.toUri(target),
      { overwrite: true }
    );
  }

  // **提案だけは混ぜる。** 承認・却下は作者が書くので、置き換えると
  // 編集部の提案が消える
  await mergeProposalsInto(
    path.join(destination, PROPOSAL_RELATIVE),
    await readTextIfAny(path.join(paths.root, PROPOSAL_RELATIVE))
  );
}

/** 提案ファイルへ、相手の行だけを足す */
async function mergeProposalsInto(
  targetPath: string,
  incoming: string
): Promise<number> {
  const existing = await readTextIfAny(targetPath);
  const merged = mergeProposalJsonl(existing, incoming);
  if (merged.text.length === 0) return 0;
  if (merged.added === 0 && merged.text === existing) return 0;
  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(targetPath))
  );
  await vscode.workspace.fs.writeFile(
    path.toUri(targetPath),
    new TextEncoder().encode(merged.text)
  );
  return merged.added;
}

interface PushOutcome {
  ok: boolean;
  detail: string;
  repositoryUrl?: string;
}

/**
 * 編集用フォルダーをGitリポジトリにして送る。
 *
 * 初回は `gh` で非公開のリポジトリを作る。2回目以降は記録して送るだけ。
 */
async function setUpAndPush(
  work: WorkEntry,
  destination: string,
  run: GitCommandRunner = runGit
): Promise<PushOutcome> {
  const isRepo = await exists(path.join(destination, ".git"));
  if (!isRepo) {
    const initialized = await initRepository(destination, run);
    if (!initialized.ok) {
      return { ok: false, detail: initialized.detail ?? "リポジトリを作れませんでした" };
    }
  }

  const message = `${work.title} を編集部へ渡す`;
  const committed = await commitAll(destination, message, run);
  // 変えるものが無いときも `commit` は失敗する。それは失敗ではない
  const nothingToCommit =
    !committed.ok && /nothing to commit|変更されていません/i.test(committed.detail ?? "");
  if (!committed.ok && !nothingToCommit) {
    return { ok: false, detail: committed.detail ?? "記録できませんでした" };
  }

  if (!(await hasCommits(destination, run))) {
    return { ok: false, detail: "記録が1件も作られませんでした" };
  }

  const branch = await currentBranch(destination, run);

  if (!isRepo) {
    if (!(await ghAvailable())) {
      return {
        ok: true,
        detail: "",
        repositoryUrl: undefined,
      };
    }
    const name = await askRepositoryName(work.title);
    if (!name) {
      // 送るのはやめても、フォルダーはできている。あとから送れる
      return { ok: true, detail: "" };
    }
    const created = await ghCreateRepository(destination, name);
    if (!created.ok) {
      return { ok: false, detail: created.detail ?? "GitHubに作れませんでした" };
    }
  }

  const pushed = await pushSetUpstream(destination, branch, run);
  if (!pushed.ok) {
    return { ok: false, detail: pushed.detail ?? "送信できませんでした" };
  }
  return { ok: true, detail: "", repositoryUrl: await remoteUrl(destination, run) };
}

/**
 * GitHubに作るリポジトリの名前を聞く。
 *
 * **日本語の作品名からは名前を作れない。** `suggestRepositoryName` は
 * ASCII以外を落とすので、日本語だけの題では空になる。空のときは作者に
 * 入力してもらう。
 */
async function askRepositoryName(
  workTitle: string
): Promise<string | undefined> {
  const suggested = suggestRepositoryName(workTitle);
  const name = await askText({
    title: "GitHubに作るリポジトリの名前",
    prompt: "編集部へ渡す非公開リポジトリの名前（半角英数）",
    value: suggested.length > 0 ? `${suggested}-editing` : "novel-editing",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "名前を入力してください";
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        return "半角の英数字と . _ - だけが使えます";
      }
      return null;
    },
  });
  return name?.trim();
}

async function remoteUrl(
  cwd: string,
  run: GitCommandRunner
): Promise<string | undefined> {
  const result = await run(["remote", "get-url", "origin"], cwd, 15_000);
  if (result.code !== 0) return undefined;
  const url = result.stdout.trim();
  if (url.length === 0) return undefined;
  // SSH形式（git@github.com:user/repo.git）はブラウザで開けない
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url.replace(/\.git$/, "");
}

/**
 * 編集部の提案を取り込む。
 *
 * **本文には触らない。** 取り込むのは提案のファイルだけで、採るかどうかは
 * 作者が提案パネルで決める。
 */
export async function collectEditorProposals(work: WorkEntry): Promise<void> {
  const pointer = await readPointer(work);
  if (!pointer || !(await exists(pointer.folderPath))) {
    void vscode.window.showInformationMessage(
      `「${work.title}」はまだ編集部へ渡していません。` +
        "先に「編集部へ渡す」を実行してください。"
    );
    return;
  }

  const pulled = await withProgress("編集部の提案を取り寄せています…", () =>
    pullFastForward(pointer.folderPath)
  );
  if (!pulled.ok) {
    // 取り寄せに失敗しても、手元にある分は取り込める。止めずに知らせる
    void vscode.window.showWarningMessage(
      "GitHubから取り寄せられませんでした。手元にある分だけを取り込みます。"
    );
  }

  const incoming = await readTextIfAny(
    path.join(pointer.folderPath, PROPOSAL_RELATIVE)
  );
  if (incoming.trim().length === 0) {
    void vscode.window.showInformationMessage(
      "編集部からの提案はまだありません。"
    );
    return;
  }

  const added = await mergeProposalsInto(
    path.join(workPaths(work).root, PROPOSAL_RELATIVE),
    incoming
  );

  if (added === 0) {
    void vscode.window.showInformationMessage(
      "新しい提案はありませんでした（すべて取り込み済みです）。"
    );
    return;
  }

  const next = await vscode.window.showInformationMessage(
    `編集部からの提案を${added}件取り込みました。`,
    "提案を見る",
    "閉じる"
  );
  if (next === "提案を見る") {
    await vscode.commands.executeCommand("novelai.reviewProposals");
  }
}
