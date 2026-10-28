import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  runGit,
  pullFastForward,
  pullFastForwardAutostash,
  type GitCommandRunner,
} from "../core/git";
import {
  addRemote,
  commitAll,
  createGithubRepositoryWithFreeName,
  currentBranch,
  ensureGithubAuthToken,
  ghAvailable,
  ghCreateRepositoryWithFreeName,
  hasCommits,
  hasGithubSession,
  initRepository,
  pushSetUpstream,
  rememberGithubCredential,
  repositoryDescription,
  runCommand,
} from "../core/gitSetup";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  autoEditingDestination,
  editingFolderName,
  mergeProposalJsonl,
  replacedDirectories,
  SHARED_FILES,
} from "../core/editingRepo";
import {
  editingRepositoryBaseName,
  inviteCollaborator,
  invitationsUrl,
} from "../core/githubCollaboration";
import { parseGithubRepoRef, type GithubRepoRef } from "../core/githubRepoRef";
import { isNestedLocation } from "../core/locationCompare";
import { resolveManuscriptDir } from "../core/manuscriptFolder";
import {
  acceptManuscriptEntry,
  isKnownNonManuscript,
  MANUSCRIPT_TREE_DEPTH,
} from "../core/manuscriptFolderRule";
import { defaultParentForNewFolder, pickNewFolderParent } from "./pickFolder";
import { RECOVERY_DIRECTORY_NAME } from "../core/atomicWrite";
import { logFailure, logStep, useLogFile } from "../core/logger";
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
 *
 * ## 1回で済ませる（作者の裁定、2026-10-28）
 *
 * 置き場もリポジトリ名も訊かない。初回だけ編集部の GitHub 名を訊き、
 * リポジトリを作って送り、招待まで通す。
 */

/** 編集用フォルダーの場所を覚えておく先。**同期しない**（端末ごとの事情） */
const POINTER_FILE = "editing.json";

export interface EditingPointer {
  /** 編集用フォルダーの絶対パス */
  folderPath: string;
  /** 最後に送り出した日時（ISO8601） */
  sharedAt?: string;
  /**
   * 招待を通した編集部の GitHub 名。**招待が通ったときだけ覚える。**
   *
   * pointer は端末ごとで同期しない。別の機械では訊き直す（意図した制約）。
   */
  editorLogin?: string;
}

function pointerPath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, "cache", POINTER_FILE);
}

export async function readPointer(
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
    // 覚えていないだけ。次で決め直せばよい
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
  // **場所を覚えるだけのファイルである。** 失っても決め直せるので、
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

/** GitHub のユーザー名として受ける形（先頭の `@` は落とす） */
function cleanLogin(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

/** 送り先 `origin` があるか（リポジトリを作り終えているか） */
async function hasOrigin(
  folder: string,
  run: GitCommandRunner
): Promise<boolean> {
  if (!(await exists(path.join(folder, ".git")))) return false;
  const result = await run(["remote", "get-url", "origin"], folder, 15_000);
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * 作品を編集部へ渡せる形にして、GitHubへ送り、編集部を招く。
 *
 * **本文と設定はまるごと置き換える。** 編集部がそこへ書かないので、
 * 消して作り直しても失うものが無い。差分を考えないぶん取り違えも起きない。
 *
 * @param works 登録済みの作品（既定の置き場を決めるのに使う。作品の中は避ける）
 */
export async function shareWithEditor(
  work: WorkEntry,
  works: readonly WorkEntry[] = [work]
): Promise<void> {
  if (isEditorMode()) {
    void vscode.window.showWarningMessage(
      "編集者モードでは、作品を編集部へ渡せません（作者の操作です）。"
    );
    return;
  }

  const config = await readWorkConfig(work);
  const paths = workPaths(work, config ?? undefined);
  const run = runGit;

  const pointer = await readPointer(work);
  let destination = pointer?.folderPath;
  if (!destination || !(await exists(destination))) {
    destination = await decideDestination(work, works);
    if (!destination) return;
  }
  const target = destination;

  const repositoryExists = await hasOrigin(target, run);

  // **招待は初回だけ。** 招待が通った名前は pointer に覚えている
  let editorLogin = pointer?.editorLogin;
  if (!editorLogin) {
    const asked = await askText({
      title: "編集部の GitHub ユーザー名",
      prompt:
        "編集部の方の GitHub ユーザー名（招待を送ります。あとで招くなら空のまま Enter）",
      placeHolder: "例: octocat",
      ignoreFocusOut: true,
      validateInput: (value) => {
        const login = cleanLogin(value);
        if (login.length === 0) return null;
        return /^[A-Za-z0-9-]+$/.test(login)
          ? null
          : "半角の英数字と - だけが使えます";
      },
    });
    // 取りやめたら、何も始めない
    if (asked === undefined) return;
    editorLogin = cleanLogin(asked) || undefined;
  }

  const needsSignIn = !repositoryExists && !(await hasGithubSession());
  const confirmed = await vscode.window.showWarningMessage(
    repositoryExists
      ? `「${work.title}」の本文と設定資料を、編集部へ送り直しますか。`
      : `「${work.title}」を編集部へ渡します。` +
          "GitHubに非公開のリポジトリを作って送ります。",
    {
      modal: true,
      detail: [
        "本文と設定資料を、編集用のフォルダーへまるごと写して送ります。",
        "",
        "【送るもの】本文・設定資料・提案のやり取り",
        "【送らないもの】キャッシュ・ログ・回復用の退避・これまでの履歴",
        "",
        "編集部はこのリポジトリだけを見ます。ほかの作品は渡りません。",
        "編集部が書けるのは提案だけで、本文は書き換わりません。",
        ...(repositoryExists
          ? []
          : [
              "",
              "原稿が外部のサービス（GitHub）へ渡ります。" +
                "リポジトリは非公開で作り、非公開になったことを確かめてから送ります。" +
                "名前はこちらで付けます（同じ名前があれば末尾に -2 などを足します）。",
            ]),
        ...(!pointer?.editorLogin && editorLogin
          ? ["", `${editorLogin} さんを共同編集者として招待します。`]
          : []),
        ...(needsSignIn
          ? [
              "",
              "次に VS Code の許可と、ブラウザで GitHub の承認を求められます。" +
                "どちらも［許可］／［Authorize］を押してください。",
            ]
          : []),
        "",
        `置き場所: ${target}`,
      ].join("\n"),
    },
    repositoryExists ? "送り直す" : "渡す"
  );
  if (!confirmed) return;

  const result = await withProgress("編集部へ渡す形にしています…", async () => {
    const pulled = await pullEditingFolder(target, run);
    if (pulled) return pulled;
    await copyForEditor(paths, target, config?.manuscriptDir, config?.settingsDir);
    // 写し終えたら場所を覚える。送信で止まっても、やり直しが同じ場所を使える
    await writePointer(work, { ...pointer, folderPath: target });
    return setUpAndPush(work, target);
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

  // 招待。**失敗しても、渡したこと自体は成功のまま**
  let invite: InviteNotice = { kind: "none" };
  const ref = result.ref;
  if (!pointer?.editorLogin && result.outcome === "pushed") {
    invite = ref
      ? await inviteEditor(editorLogin, ref, result.viaAccount === true)
      : { kind: "skipped" };
  }

  await writePointer(work, {
    folderPath: target,
    sharedAt: new Date().toISOString(),
    // 招待が通った名前だけ覚える（通らなかったら次に訊き直す）
    ...(invite.kind === "invited" || invite.kind === "already"
      ? { editorLogin: invite.login }
      : pointer?.editorLogin
        ? { editorLogin: pointer.editorLogin }
        : {}),
  });

  // **結末で知らせを分ける**（0.74.12）。`ok` だけを見て一律に
  // 「編集部を招いてください」と出していたため、`gh` が無くて送れて
  // いないときにも招けと言い、［GitHubで開く］は何もしないボタンだった
  const notice = shareNoticeFor(result.outcome ?? "pushed", work.title, invite);
  const next = await vscode.window.showInformationMessage(
    notice.message,
    ...notice.actions
  );
  if (next === "リンクを写す" && notice.link) {
    await vscode.env.clipboard.writeText(notice.link);
  } else if (next === "GitHubで開く" && result.repositoryUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(result.repositoryUrl));
  }
}

/** 招待の結末（知らせの文を組むために持ち回る） */
export type InviteNotice =
  | { kind: "invited"; login: string; link: string }
  | { kind: "already"; login: string }
  | { kind: "failed"; login: string; detail: string }
  /** 名前を入れなかった／招待に使うサインインが無かった */
  | { kind: "skipped" }
  /** 招待の対象外（送り直し） */
  | { kind: "none" };

/**
 * 編集部を招く。トークンは VS Code の GitHub アカウントから取る。
 *
 * **サインインの窓を新しく出さない。** アカウントの道で作ったか、すでに
 * サインインがあるときだけ招く。`gh` だけで作った場合は、手で招く案内に落とす。
 */
async function inviteEditor(
  login: string | undefined,
  ref: GithubRepoRef,
  viaAccount: boolean,
  deps: {
    token?: () => Promise<string | undefined>;
    invite?: typeof inviteCollaborator;
  } = {}
): Promise<InviteNotice> {
  if (!login) return { kind: "skipped" };
  const getToken = deps.token ?? ensureGithubAuthToken;
  if (!viaAccount && !(await hasGithubSession())) return { kind: "skipped" };
  const token = await getToken();
  if (!token) return { kind: "skipped" };

  const invited = await (deps.invite ?? inviteCollaborator)(token, ref, login);
  if (!invited.ok) {
    logFailure("編集部の招待", { 相手: login, 理由: invited.reason, 詳細: invited.detail });
    return { kind: "failed", login, detail: invited.detail };
  }
  logStep(
    `編集部を招いた: ${login}（${ref.owner}/${ref.repo}／` +
      `${invited.outcome === "invited" ? "招待" : "すでに共同編集者"}）`
  );
  return invited.outcome === "invited"
    ? { kind: "invited", login, link: invitationsUrl(ref) }
    : { kind: "already", login };
}

/**
 * 編集用フォルダーの置き場を決める。**訊かない。**
 *
 * 既定の置き場の下の `編集部/<編集用フォルダー名>`。作品フォルダーの中になるとき、
 * 既定の置き場が決められないときだけ、従来の選ぶ画面へ落とす。
 * 同じ名前が既にあるときは、中身を巻き込まないよう `-2`… の空いている名前にする。
 */
async function decideDestination(
  work: WorkEntry,
  works: readonly WorkEntry[]
): Promise<string | undefined> {
  const home = await defaultParentForNewFolder(works.length > 0 ? works : [work]);
  if (home) {
    for (let suffix = 1; suffix <= 9; suffix++) {
      const candidate = autoEditingDestination(home, work.title, suffix);
      // 作品フォルダーの中は入れ子のリポジトリになる。ほかの作品の中も同じ
      if (works.some((one) => isNestedLocation(candidate, one.folderPath))) break;
      if (isNestedLocation(candidate, work.folderPath)) break;
      if (!(await exists(candidate))) return candidate;
    }
  }
  return chooseDestination(work);
}

/**
 * 編集用フォルダーを、GitHub の最新へ早送りする（送り直しの前、リポジトリがあるときだけ）。
 *
 * **写す前にやる。** 編集部が先に提案を送っていると、そのまま送って断られる。
 * 写したあとでは未記録の変更ができていて取り込めない。
 *
 * @returns 失敗したときだけ結果を返す（止める）。進めてよいなら `undefined`
 */
async function pullEditingFolder(
  folder: string,
  run: GitCommandRunner
): Promise<PushOutcome | undefined> {
  if (!(await hasOrigin(folder, run))) return undefined;
  const pulled = await pullFastForwardAutostash(folder, run);
  if (pulled.ok) return undefined;
  const detail =
    pulled.failure.kind === "failed"
      ? pulled.failure.detail
      : "編集用フォルダーが GitHub と分かれています（編集用フォルダーを直接変えていないか確かめてください）";
  return { ok: false, detail };
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

  /*
    **本文の場所は、走査と同じ決め方で決める**（`resolveManuscriptDir`）。
    以前は本文フォルダーを決め打ちで写していたため、`manuscriptDir: 本文` の
    まま原稿を直下に置いた作品では、空の `本文/` を写すだけで**本文が1つも
    渡らなかった**（「現代ダンジョンのインフラ担当」）。走査と別の決め方を
    持つと、作者の一覧に出る話と編集部へ渡る話が食い違う。
  */
  const manuscriptLocation = await resolveManuscriptDir(paths);
  const manuscriptAtRoot = sameLocation(manuscriptLocation, paths.root);

  const settingsName = settingsDir ?? path.basename(paths.settings);
  const replaced = replacedDirectories(
    manuscriptDir ?? path.basename(paths.manuscript),
    settingsName
  );
  const sources = new Map([
    [path.basename(paths.manuscript), paths.manuscript],
    [path.basename(paths.settings), paths.settings],
  ]);

  // 1. 置き換えるフォルダーを、編集用の側から先に消す
  for (const name of replaced) {
    const target = path.join(destination, name);
    // **編集用フォルダーそのものは消さない。** `manuscriptDir: "."` の作品だと
    // 名前が「.」になり、消すと `.git` ごと編集用リポジトリが無くなる
    if (sameLocation(target, destination)) continue;
    if (await exists(target)) {
      await vscode.workspace.fs.delete(path.toUri(target), {
        recursive: true,
        useTrash: false,
      });
    }
  }

  // 2. 前回この機能が直下へ写した原稿のうち、今回は写さないものを消す。
  // 作品側で消した話・本文フォルダーへ移した話が残ると、編集部は無い話を
  // 校閲することになる。
  //
  // **消すのは控えに載っているものだけ。** 編集用の直下を「原稿に見える
  // 名前」で選んで消すと、作者が既存のフォルダーを渡し先に選んでいたとき、
  // そこにあった無関係の .txt/.md まで消える。控えが無い（初回・控えが
  // 読めない）ときは、直下からは何も消さない
  const rootCopies = manuscriptAtRoot
    ? await listRootManuscripts(paths.root, paths.settings)
    : [];
  const keep = new Set(rootCopies.map(manifestKey));
  for (const previous of await readShareManifest(destination)) {
    if (keep.has(manifestKey(previous))) continue;
    const target = path.join(destination, ...previous.split("/"));
    if (!(await exists(target))) continue;
    await vscode.workspace.fs.delete(path.toUri(target), { useTrash: false });
  }

  // 3. 写す
  for (const name of replaced) {
    const source = sources.get(name) ?? path.join(paths.root, name);
    const target = path.join(destination, name);
    if (sameLocation(target, destination)) continue;
    // **直下で書く作品の本文フォルダーは写さない。** 中に原稿が無い
    // （だから直下と決まった）ので、写しても空のフォルダーが行くだけ
    if (manuscriptAtRoot && sameLocation(source, paths.manuscript)) continue;
    if (!(await exists(source))) continue;
    await vscode.workspace.fs.copy(
      path.toUri(source),
      path.toUri(target),
      { overwrite: true }
    );
    await removeRecoveryDirectories(target);
  }

  // 直下で書く作品は、原稿を1つずつ同じ相対位置へ写す。**作品の根を
  // まるごと写さない**——キャッシュ・ログ・書庫の `.git` まで付いていく。
  // 編集部の側も `config.json` は同じ（`manuscriptDir: 本文`）で、本文
  // フォルダーが無いので同じ決め方で直下を歩き、同じ話が見える
  for (const relative of rootCopies) {
    const target = path.join(destination, relative);
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );
    await vscode.workspace.fs.copy(
      path.toUri(path.join(paths.root, relative)),
      path.toUri(target),
      { overwrite: true }
    );
  }
  // **写し終えてから控える。** 途中で失敗したときに「写した」と控えると、
  // 次の回に写っていないものを消しにいく（存在を確かめるので害は無いが、
  // 控えと実物がずれる）
  await writeShareManifest(destination, rootCopies);

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
 * 直下へ写した原稿の控え（編集用フォルダーの中に置く）。
 *
 * 送り直すときに消してよいのは「前回この機能が写したもの」だけである。
 * それを知る手段がこの控えしか無い。
 */
const SHARE_MANIFEST_RELATIVE = path.join(
  ".aiwriter",
  "editor-share-manifest.json"
);

/** 控えの中の道は `/` 区切りで持つ（Windows と他の機械で同じ形にする） */
function manifestKey(relative: string): string {
  return relative.replace(/\\/g, "/");
}

/**
 * 前回の控えを読む。**無い・読めない・形が違うときは空**（何も消さない側へ倒す）。
 *
 * この控えは作者のデータではなく、この機能が書くものなので、壊れていたら
 * 次に写したときに書き直してよい。ただし壊れた控えを手がかりに消すことはしない。
 */
async function readShareManifest(destination: string): Promise<string[]> {
  const text = await readTextIfAny(
    path.join(destination, SHARE_MANIFEST_RELATIVE)
  );
  if (text.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const files =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).files
        : undefined;
    if (!Array.isArray(files)) return [];
    // `..` を含む道や絶対パスは、編集用フォルダーの外を指しうるので使わない
    return files.filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length > 0 &&
        !entry.startsWith("/") &&
        !/^[A-Za-z]:/.test(entry) &&
        !entry.split("/").some((part) => part === ".." || part === "")
    );
  } catch {
    return [];
  }
}

async function writeShareManifest(
  destination: string,
  files: readonly string[]
): Promise<void> {
  const target = path.join(destination, SHARE_MANIFEST_RELATIVE);
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  // **場所を覚えるだけの控えである**（`writePointer` と同じ考え方）。失っても
  // 次の回に直下を消さないだけで、原稿は壊れない
  await vscode.workspace.fs.writeFile(
    path.toUri(target),
    new TextEncoder().encode(
      `${JSON.stringify({ files: files.map(manifestKey) }, null, 2)}\n`
    )
  );
}

function sameLocation(a: string, b: string): boolean {
  return path.normalizeForComparison(a) === path.normalizeForComparison(b);
}

/**
 * 作品の根から歩いたときに、原稿として拾うファイルを並べる（根からの相対パス）。
 *
 * **選び方は走査と同じ部品を使う**（`acceptManuscriptEntry`・
 * `isKnownNonManuscript`、深さは `MANUSCRIPT_TREE_DEPTH`、`.` で始まる名前は
 * 飛ばす）。ここで別の選び方をすると、作者の一覧に出る話と編集部へ渡る話が
 * 食い違う。README・LICENSE・AIへの指示書・設定フォルダー・`.aiwriter` は
 * 入らない。
 *
 * 中身は読まない（写すのは `copy` に任せ、バイトをそのまま運ぶ）。
 */
async function listRootManuscripts(
  root: string,
  settings: string
): Promise<string[]> {
  const accept = acceptManuscriptEntry(settings);
  const result: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MANUSCRIPT_TREE_DEPTH) return;
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(path.toUri(current));
    } catch {
      // 編集用フォルダーがまだ無い（初回）・読めないフォルダーは「無い」とみなす。
      // 一括読み（`readTextTree`）も同じく飛ばす
      return;
    }
    for (const [name, type] of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(current, name);
      if (type === vscode.FileType.Directory) {
        if (!accept(name, "directory", full)) continue;
        await walk(full, depth + 1);
      } else if (type === vscode.FileType.File) {
        if (!accept(name, "file", full)) continue;
        if (isKnownNonManuscript(full, root, settings)) continue;
        result.push(path.relative(root, full));
      }
    }
  };
  await walk(root, 0);
  return result;
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
 * うまくいったときの**結末**。2つに分かれる（0.74.12。2026-10-28 に作り替え）。
 *
 * **`ok` だけでは足りない。** かつては結末が1つで、受け取る側は必ず
 * 「GitHubのSettings→Collaboratorsから編集部を招いてください」＋
 * ［GitHubで開く］を出していた。送っていないときにも招けと言い、
 * ボタンは押しても何も起きない（作者の実機報告、2026-09-21）。
 *
 * - `pushed`  … GitHubへ送るところまで通った
 * - `noRoute` … フォルダーは用意したが、送る道（VS Code の GitHub アカウント、
 *               `gh`）がどちらも使えないので送っていない
 */
export type ShareOutcome = "pushed" | "noRoute";

export interface PushOutcome {
  ok: boolean;
  detail: string;
  /** うまくいったとき（`ok`）の結末。失敗のときは無い */
  outcome?: ShareOutcome;
  repositoryUrl?: string;
  /** 送り先の持ち主とリポジトリ名（招待に使う） */
  ref?: GithubRepoRef;
  /** VS Code のアカウントでリポジトリを作ったか（招待のトークンがある道） */
  viaAccount?: boolean;
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
  /** VS Code の GitHub アカウントのトークン。取れなければ `undefined` */
  getToken?: () => Promise<string | undefined>;
  /** VS Code のアカウントで、空いている名前を探しながら非公開リポジトリを作る */
  createViaAccount?: typeof createGithubRepositoryWithFreeName;
  /** gh で作る（送り先の登録も gh が行う） */
  createViaGh?: (
    cwd: string,
    baseName: string,
    description: string
  ) => Promise<{ ok: boolean; name?: string; detail?: string }>;
  /** gh で作ったリポジトリが非公開か。確かめられなければ `undefined` */
  ghIsPrivate?: (cwd: string, name: string) => Promise<boolean | undefined>;
  /** git の保管場所へ鍵を覚えさせる */
  rememberCredential?: typeof rememberGithubCredential;
  /**
   * `false` なら、リポジトリが無いときも作らずに失敗で返す（自動の送り返し用）。
   * 既定は `true`
   */
  allowCreate?: boolean;
  /** 記録の題 */
  message?: string;
}

/** gh の道で、作ったリポジトリが非公開かを読む */
async function ghRepositoryIsPrivate(
  cwd: string,
  name: string
): Promise<boolean | undefined> {
  const result = await runCommand(
    "gh",
    ["repo", "view", name, "--json", "isPrivate", "--jq", ".isPrivate"],
    cwd,
    30_000
  );
  if (result.code !== 0) return undefined;
  const text = result.stdout.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

/**
 * 編集用フォルダーをGitリポジトリにして送る。
 *
 * 初回は非公開のリポジトリを作る。**VS Code の GitHub アカウントの道を先**に試し、
 * 使えなければ `gh`。2回目以降は記録して送るだけ。
 *
 * **非公開で作られたと確かめてから送る**（`isPrivate === true`）。公開リポジトリへ
 * 原稿が出る事故を防ぐ唯一の防波堤である。確かめられなければ送らず、送り先の登録を
 * 外す（残すと、次の送信が確かめなしで通ってしまう）。
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
  const getToken = deps.getToken ?? ensureGithubAuthToken;
  const createViaAccount = deps.createViaAccount ?? createGithubRepositoryWithFreeName;
  const createViaGh =
    deps.createViaGh ??
    ((cwd, baseName, description) =>
      ghCreateRepositoryWithFreeName(cwd, baseName, description));
  const ghIsPrivate = deps.ghIsPrivate ?? ghRepositoryIsPrivate;
  const remember = deps.rememberCredential ?? rememberGithubCredential;

  const isRepo = await exists(path.join(destination, ".git"));
  if (!isRepo) {
    const initialized = await initRepository(destination, run);
    if (!initialized.ok) {
      return { ok: false, detail: initialized.detail ?? "リポジトリを作れませんでした" };
    }
  }

  const message = deps.message ?? `${work.title} を編集部へ渡す`;
  // 変えるものが無いのは失敗ではない。**判定は `commitAll` が持っている**
  // （gitの文言は環境の言語で変わるので、ここで正規表現を書かない）
  const committed = await commitAll(destination, message, run);
  if (!committed.ok) {
    return { ok: false, detail: committed.detail ?? "記録できませんでした" };
  }

  if (!(await hasCommits(destination, run))) {
    return { ok: false, detail: "記録が1つも作られませんでした" };
  }

  const branch = await currentBranch(destination, run);

  let viaAccount = false;
  if (!(await hasOrigin(destination, run))) {
    if (deps.allowCreate === false) {
      return {
        ok: false,
        detail:
          "送り先のリポジトリがまだありません（先に「編集部へ渡す」を実行してください）",
      };
    }
    const baseName = editingRepositoryBaseName(work.title);
    const description = repositoryDescription(`${work.title}（編集部へ渡す用）`);

    const token = await getToken();
    if (token) {
      const created = await createViaAccount(token, baseName, description);
      if (!created.ok || !created.cloneUrl) {
        return { ok: false, detail: created.detail ?? "GitHubに作れませんでした" };
      }
      const createdName = created.name ?? baseName;
      const added = await addRemote(destination, created.cloneUrl, run);
      if (!added.ok) {
        return { ok: false, detail: added.detail ?? "送り先を登録できませんでした" };
      }
      // **鍵を git 側にも覚えさせる**（設計書5.5.12）。作るのは API、送るのは
      // 別プロセスの git なので、しないと送信でまた聞かれる
      await remember(token, created.cloneUrl, destination);
      if (created.isPrivate !== true) {
        // 送り先を外す。残すと、次の送信が非公開の確かめなしで通ってしまう
        await run(["remote", "remove", "origin"], destination, 15_000);
        return {
          ok: false,
          detail:
            `リポジトリ ${createdName} が非公開で作られたことを確かめられなかったため、` +
            "送らずに止めました。GitHubの画面で非公開になっているかを確かめてください。",
        };
      }
      viaAccount = true;
      logStep(`編集用リポジトリを作成（VS Codeアカウント）: ${createdName}（private）`);
    } else if (await hasGh()) {
      const created = await createViaGh(destination, baseName, description);
      if (!created.ok) {
        return { ok: false, detail: created.detail ?? "GitHubに作れませんでした" };
      }
      const createdName = created.name ?? baseName;
      const isPrivate = await ghIsPrivate(destination, createdName);
      if (isPrivate !== true) {
        await run(["remote", "remove", "origin"], destination, 15_000);
        return {
          ok: false,
          detail:
            `リポジトリ ${createdName} が非公開で作られたことを確かめられなかったため、` +
            "送らずに止めました。GitHubの画面で非公開になっているかを確かめてください。",
        };
      }
      logStep(`編集用リポジトリを作成（gh）: ${createdName}（private）`);
    } else {
      // フォルダーはできている。**送れていないことを、そう名乗る**
      return { ok: true, detail: "", outcome: "noRoute" };
    }
  }

  const pushed = await pushSetUpstream(destination, branch, run);
  if (!pushed.ok) {
    return { ok: false, detail: pushed.detail ?? "送信できませんでした" };
  }
  const url = await remoteUrl(destination, run);
  return {
    ok: true,
    detail: "",
    outcome: "pushed",
    repositoryUrl: url,
    ref: url ? parseGithubRepoRef(url) : undefined,
    viaAccount,
  };
}

/** 渡し終わったときに出す知らせ */
export interface ShareNotice {
  message: string;
  /** 押せるボタン。並びのまま出す */
  actions: string[];
  /** ［リンクを写す］で写すリンク（招待したときだけ） */
  link?: string;
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
  workTitle: string,
  invite: InviteNotice = { kind: "none" }
): ShareNotice {
  if (outcome === "noRoute") {
    return {
      message:
        `「${workTitle}」の編集用フォルダーは用意しました。` +
        "GitHubへ送るには、VS Code の GitHub アカウントへのサインインか " +
        "`gh`（GitHub CLI）が要ります。整えてから「編集部へ渡す」をもう一度押してください。",
      actions: ["閉じる"],
    };
  }
  switch (invite.kind) {
    case "invited":
      return {
        message:
          `「${workTitle}」を編集部へ渡し、${invite.login}さんを招待しました。` +
          `招待のリンク：${invite.link}`,
        actions: ["リンクを写す", "GitHubで開く", "閉じる"],
        link: invite.link,
      };
    case "already":
      return {
        message:
          `「${workTitle}」を編集部へ渡しました。` +
          `${invite.login}さんはすでに共同編集者です。`,
        actions: ["GitHubで開く", "閉じる"],
      };
    case "failed":
      return {
        message:
          `「${workTitle}」を編集部へ渡しました。ただし招待はできませんでした` +
          `（${invite.detail}）。GitHubの「Settings」→「Collaborators」から編集部を招いてください。`,
        actions: ["GitHubで開く", "閉じる"],
      };
    case "skipped":
      return {
        message:
          `「${workTitle}」を編集部へ渡しました。編集部はまだ招いていません。` +
          "GitHubの「Settings」→「Collaborators」から招いてください。",
        actions: ["GitHubで開く", "閉じる"],
      };
    case "none":
      return {
        message: `「${workTitle}」を編集部へ送り直しました。`,
        actions: ["GitHubで開く", "閉じる"],
      };
  }
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

/** 提案の取り込みの結果 */
export type ImportResult =
  | { status: "noPointer" }
  | {
      status: "done";
      /** 取り寄せ（早送り）に失敗した。手元にある分だけ取り込んだ */
      pullFailed: boolean;
      /** 編集用フォルダーに提案が1件でもあったか */
      hadIncoming: boolean;
      /** 作品の台帳へ足した件数 */
      added: number;
    };

/**
 * 編集部の提案を取り込む（**知らせを出さない**）。
 *
 * 手動の「編集部提案取込」と、同期のあとの自動の取り込みが、同じ中身を使う。
 * **本文には触らない。** 取り込むのは提案のファイルだけ。
 */
export async function importEditorProposalsQuietly(
  work: WorkEntry,
  run?: GitCommandRunner
): Promise<ImportResult> {
  const pointer = await readPointer(work);
  if (!pointer || !(await exists(pointer.folderPath))) {
    return { status: "noPointer" };
  }

  const pulled = await pullFastForward(pointer.folderPath, run);

  const incoming = await readTextIfAny(
    path.join(pointer.folderPath, PROPOSAL_RELATIVE)
  );
  if (incoming.trim().length === 0) {
    return { status: "done", pullFailed: !pulled.ok, hadIncoming: false, added: 0 };
  }
  const added = await mergeProposalsInto(
    path.join(workPaths(work).root, PROPOSAL_RELATIVE),
    incoming
  );
  return { status: "done", pullFailed: !pulled.ok, hadIncoming: true, added };
}

/**
 * 編集部の提案を取り込む（手動の道。「編集部提案取込」）。
 *
 * **本文には触らない。** 取り込むのは提案のファイルだけで、採るかどうかは
 * 作者が提案パネルで決める。
 */
export async function collectEditorProposals(work: WorkEntry): Promise<void> {
  const result = await withProgress("編集部の提案を取り寄せています…", () =>
    importEditorProposalsQuietly(work)
  );
  if (result.status === "noPointer") {
    void vscode.window.showInformationMessage(
      `「${work.title}」はまだ編集部へ渡していません。` +
        "先に「編集部へ渡す」を実行してください。"
    );
    return;
  }
  if (result.pullFailed) {
    // 取り寄せに失敗しても、手元にある分は取り込める。止めずに知らせる
    void vscode.window.showWarningMessage(
      "GitHubから取り寄せられませんでした。手元にある分だけを取り込みます。"
    );
  }
  if (!result.hadIncoming) {
    void vscode.window.showInformationMessage(
      "編集部からの提案はまだありません。"
    );
    return;
  }
  if (result.added === 0) {
    void vscode.window.showInformationMessage(
      "新しい提案はありませんでした（すべて取り込み済みです）。"
    );
    return;
  }

  const next = await vscode.window.showInformationMessage(
    `編集部からの提案を${result.added}件取り込みました。`,
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

/**
 * 採否を、確認なしで編集部へ送り返す（自動の送り返し。作者の裁定、2026-10-28）。
 *
 * **リポジトリを作らない。** 渡してある作品（pointer とリポジトリがある）にだけ効く。
 * 順は 早送りで取り寄せる → 写す（提案は混ぜる）→ 記録 → 送る。
 * 写してから取り寄せると未記録の変更で断られ、取り寄せずに送ると編集部が
 * 先に送っていたときに断られる。
 */
export async function resendDecisionsQuietly(
  work: WorkEntry,
  run: GitCommandRunner = runGit
): Promise<PushOutcome & { skipped?: boolean }> {
  const pointer = await readPointer(work);
  if (!pointer || !(await exists(pointer.folderPath))) {
    return { ok: false, detail: "編集用フォルダーの記録がありません", skipped: true };
  }
  const destination = pointer.folderPath;
  if (!(await hasOrigin(destination, run))) {
    return {
      ok: false,
      detail: "編集用フォルダーの送り先がまだありません",
      skipped: true,
    };
  }

  const pulled = await pullEditingFolder(destination, run);
  if (pulled) return pulled;

  const config = await readWorkConfig(work);
  const paths = workPaths(work, config ?? undefined);
  await copyForEditor(paths, destination, config?.manuscriptDir, config?.settingsDir);
  const pushed = await setUpAndPush(work, destination, {
    run,
    allowCreate: false,
    message: `${work.title} の採否を編集部へ返す`,
  });
  if (pushed.ok) {
    await writePointer(work, { ...pointer, sharedAt: new Date().toISOString() });
  }
  return pushed;
}
