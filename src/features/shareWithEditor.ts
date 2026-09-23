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
import { isNestedLocation } from "../core/locationCompare";
import { pickNewFolderParent } from "./pickFolder";
import { RECOVERY_DIRECTORY_NAME } from "../core/atomicWrite";
import { logFailure, useLogFile } from "../core/logger";
import { withProgress } from "../views/progress";
import { askText } from "../views/dialogs";
import { isEditorMode } from "../core/actorContext";

/**
 * 編集部へ作品を渡し、提案を受け取る（設計書5.7.5）。
 *
 * **書庫へ編集部を招くことはできない。** GitHubの権限はリポジトリ単位で
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
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
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

  // **結末で知らせを分ける**（0.74.12）。`ok` だけを見て一律に
  // 「編集部を招いてください」と出していたため、`gh` が無くて送れて
  // いないときにも招けと言い、［GitHubで開く］は何もしないボタンだった
  const notice = shareNoticeFor(result.outcome ?? "pushed", work.title);
  const next = await vscode.window.showInformationMessage(
    notice.message,
    ...notice.actions
  );
  if (next === "GitHubで開く" && result.repositoryUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(result.repositoryUrl));
  }
}

/** 置き場所を聞く。**作品フォルダーの中には置かせない**（入れ子のリポジトリになる） */
async function chooseDestination(work: WorkEntry): Promise<string | undefined> {
  // **既定の場所を明示する**（設計書6.97.6）。渡さないとVS Codeは
  // 「最後に使った場所」を開く。見出しで「書庫の外を勧めます」と書いておいて、
  // 窓が作品フォルダーの中で開くのでは案内になっていない。
  //
  // **渡すのはこの作品だけ。** `shareWithEditor` は登録簿を受け取らないので、
  // ほかの作品の場所は見ていない。この作品の書庫の1つ上が既定になる
  const parentPath = await pickNewFolderParent({
    purpose: "編集用フォルダーを置く場所を選択（書庫の外を勧めます）",
    openLabel: "ここに置く",
    works: [work],
  });
  if (!parentPath) return undefined;

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

  const destination = path.join(parentPath, name.trim());

  // 作品フォルダーの中へ置くと、書庫のリポジトリに入れ子で入ってしまう。
  // **判定は `isNestedLocation` に任せる**——以前はここで独自に比べており、
  // 大文字小文字の違いを見ていなかった（置き場は作者がダイアログで選ぶので、
  // 登録時の `work.folderPath` と綴りだけが違う道になりうる）
  if (isNestedLocation(destination, work.folderPath)) {
    void vscode.window.showErrorMessage(
      "作品フォルダーの中には置けません。リポジトリが入れ子になり、" +
        "書庫の側へ巻き込まれます。別の場所を選んでください。"
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
 *
 * 外へ出してあるのは試験のため（`shareWithEditor.test.ts`）。渡すかどうかの
 * 確認は `shareWithEditor` が持つので、外の呼び出し口としては使わない。
 */
export async function copyForEditor(
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
    await removeRecoveryDirectories(target);
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

/**
 * 写した中から、回復用の退避（`.novelai-recovery`）を消す。
 *
 * **写す前に除けない。** `vscode.workspace.fs.copy` はフォルダーをまるごと
 * 写す口しか持たず、除外を渡せない。1件ずつ写す形に書き直すと本文の写しが
 * 遅くなるうえ、写し漏れの道が増える。**写してから消す。**
 *
 * 退避は元のファイルと同じ階層に作られる（`atomicWrite.ts` の
 * `recoveryDirectoryFor`）。本文の下にも設定の下にもでき、深さが決まらない
 * ので、写した先をたどって名前で消す。
 *
 * 渡す先は編集部の手元である。**直す前の版が5世代ぶん一緒に行くと、
 * 編集部はどれが今の原稿か分からない**（`.gitignore` があるのでgitには
 * 乗らないが、フォルダーごと手渡すと付いていく）。
 */
async function removeRecoveryDirectories(target: string): Promise<void> {
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(target));
  } catch {
    // 読めないのは、そもそも写せていないということ。写しの失敗は
    // 呼び出し側（copy）が投げるので、ここでは黙って戻る
    return;
  }
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const child = path.join(target, name);
    if (name === RECOVERY_DIRECTORY_NAME) {
      await vscode.workspace.fs.delete(path.toUri(child), {
        recursive: true,
        useTrash: false,
      });
      continue;
    }
    await removeRecoveryDirectories(child);
  }
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

/**
 * うまくいったときの**結末**。3つに分かれる（0.74.12）。
 *
 * **`ok` だけでは足りない。** かつては3つとも `{ ok: true }` で返しており、
 * 受け取る側は必ず「GitHubのSettings→Collaboratorsから編集部を招いて
 * ください」＋［GitHubで開く］を出していた。`gh` が無くて送っていないとき
 * も、名前の入力を取りやめたときも、**リポジトリが無いのに招けと言い、
 * ボタンは押しても何も起きない**（作者の実機報告、2026-09-21）。
 *
 * - `pushed`    … GitHubへ送るところまで通った
 * - `noGh`      … フォルダーは用意したが、`gh` が無いので送っていない
 * - `cancelled` … リポジトリ名の入力を作者が取りやめた
 */
export type ShareOutcome = "pushed" | "noGh" | "cancelled";

interface PushOutcome {
  ok: boolean;
  detail: string;
  /** うまくいったとき（`ok`）の結末。失敗のときは無い */
  outcome?: ShareOutcome;
  repositoryUrl?: string;
}

/**
 * `setUpAndPush` が外から差し替えられるもの。**試験のためだけにある。**
 *
 * 製品の呼び出しは何も渡さない（既定が本物である）。
 */
export interface SetUpAndPushDeps {
  run?: GitCommandRunner;
  /** GitHub CLI が使えるか */
  ghAvailable?: () => Promise<boolean>;
  /** リポジトリ名を聞く。取りやめたら `undefined` */
  askRepositoryName?: (workTitle: string) => Promise<string | undefined>;
  /** GitHubに非公開のリポジトリを作る */
  createRepository?: (
    cwd: string,
    name: string
  ) => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * 編集用フォルダーをGitリポジトリにして送る。
 *
 * 初回は `gh` で非公開のリポジトリを作る。2回目以降は記録して送るだけ。
 *
 * 外へ出してあるのは試験のため（`shareWithEditor.test.ts`）。
 */
export async function setUpAndPush(
  work: WorkEntry,
  destination: string,
  deps: SetUpAndPushDeps = {}
): Promise<PushOutcome> {
  const run = deps.run ?? runGit;
  const hasGh = deps.ghAvailable ?? ghAvailable;
  const askName = deps.askRepositoryName ?? askRepositoryName;
  const createRepository = deps.createRepository ?? ghCreateRepository;

  const isRepo = await exists(path.join(destination, ".git"));
  if (!isRepo) {
    const initialized = await initRepository(destination, run);
    if (!initialized.ok) {
      return { ok: false, detail: initialized.detail ?? "リポジトリを作れませんでした" };
    }
  }

  const message = `${work.title} を編集部へ渡す`;
  // 変えるものが無いのは失敗ではない。**判定は `commitAll` が持っている**
  // （gitの文言は環境の言語で変わるので、ここで正規表現を書かない）
  const committed = await commitAll(destination, message, run);
  if (!committed.ok) {
    return { ok: false, detail: committed.detail ?? "記録できませんでした" };
  }

  if (!(await hasCommits(destination, run))) {
    return { ok: false, detail: "記録が1件も作られませんでした" };
  }

  const branch = await currentBranch(destination, run);

  if (!isRepo) {
    if (!(await hasGh())) {
      // フォルダーはできている。**送れていないことを、そう名乗る**
      return { ok: true, detail: "", outcome: "noGh" };
    }
    const name = await askName(work.title);
    if (!name) {
      // 送るのはやめても、フォルダーはできている。あとから送れる
      return { ok: true, detail: "", outcome: "cancelled" };
    }
    const created = await createRepository(destination, name);
    if (!created.ok) {
      return { ok: false, detail: created.detail ?? "GitHubに作れませんでした" };
    }
  }

  const pushed = await pushSetUpstream(destination, branch, run);
  if (!pushed.ok) {
    return { ok: false, detail: pushed.detail ?? "送信できませんでした" };
  }
  return {
    ok: true,
    detail: "",
    outcome: "pushed",
    repositoryUrl: await remoteUrl(destination, run),
  };
}

/** 渡し終わったときに出す知らせ */
export interface ShareNotice {
  message: string;
  /** 押せるボタン。並びのまま出す */
  actions: string[];
}

/**
 * 結末ごとの知らせを組む。
 *
 * **［GitHubで開く］は、送れたときだけ出す。** 送っていないのに出すと、
 * 押しても何も起きないボタンになる（開く先が無い）。
 *
 * 外へ出してあるのは試験のため。文言を写して測ると、直したときに
 * テストだけが古くなる。
 */
export function shareNoticeFor(
  outcome: ShareOutcome,
  workTitle: string
): ShareNotice {
  switch (outcome) {
    case "pushed":
      return {
        message:
          `「${workTitle}」を編集部へ渡せる形にしました。` +
          "GitHubの「Settings」→「Collaborators」から編集部を招いてください。",
        actions: ["GitHubで開く", "閉じる"],
      };
    case "noGh":
      return {
        message:
          `「${workTitle}」の編集用フォルダーは用意しました。` +
          "GitHubへ送るには `gh`（GitHub CLI）が要ります。" +
          "入れてから「編集部共有」をもう一度押してください。",
        actions: ["閉じる"],
      };
    case "cancelled":
      return {
        message:
          `「${workTitle}」の編集用フォルダーは用意しました。` +
          "あとから「編集部共有」で送れます。",
        actions: ["閉じる"],
      };
  }
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
        "先に「編集部共有」を実行してください。"
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
    // いま取り込んだ作品の提案を見る。引数無しだと作品選択からやり直させる
    await vscode.commands.executeCommand("novelai.reviewProposals", {
      type: "work",
      work,
    });
  }
}
