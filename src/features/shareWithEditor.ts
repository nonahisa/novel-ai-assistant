import * as path from "../core/paths";
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  fetchRemote,
  readSyncStatus,
  runGit,
  pullFastForward,
  pullFastForwardAutostash,
  parseStatusPorcelainPaths,
  type GitCommandRunner,
} from "../core/git";
import { cloneRepository, cloneWithGh } from "../core/gitClone";
import { runSerialized } from "../core/ledgerQueue";
import { FileLockStore } from "../core/fileLockStore";
import { ProposalStore } from "../core/proposalStore";
import { normalizeFile, parseLockEvents, resolveLocks } from "../models/fileLock";
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
  describeLockRange,
  editingFolderName,
  editingPlaceProblem,
  editingQueueKey,
  LEDGER_FILES,
  mergeProposalJsonl,
  normalizeRelativeKey,
  planShareSource,
  replacedDirectories,
  SHARED_FILES,
} from "../core/editingRepo";
import {
  cloneUrlOf,
  editingRepositoryBaseName,
  fetchRepositoryPrivacy,
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
import { whenNoticePicked } from "../views/notify";
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

/**
 * 編集部の送り先と相手（**同期される**。`.aiwriter/editing.json`、cache の外）。
 *
 * 端末ごとに残す pointer（`folderPath` だけ）と分けた理由：別の機械で「渡す」を
 * 押すと、送り先を知らないために**2つ目のリポジトリを作って**いた。送り先の URL を
 * 同期される場所に置けば、2台目はそれを取り寄せて使える。
 */
export interface EditingSite {
  /** 編集用リポジトリの取り寄せ用URL（`https://github.com/owner/repo.git`） */
  remoteUrl?: string;
  /** 招待が通った編集部の GitHub 名 */
  editorLogin?: string;
}

const SITE_RELATIVE = path.join(".aiwriter", "editing.json");

function sitePath(work: WorkEntry): string {
  return path.join(workPaths(work).root, SITE_RELATIVE);
}

export async function readSite(work: WorkEntry): Promise<EditingSite> {
  const text = await readTextIfAny(sitePath(work));
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.remoteUrl === "string" && record.remoteUrl.length > 0
        ? { remoteUrl: record.remoteUrl }
        : {}),
      ...(typeof record.editorLogin === "string" && record.editorLogin.length > 0
        ? { editorLogin: record.editorLogin }
        : {}),
    };
  } catch {
    return {};
  }
}

export async function writeSite(work: WorkEntry, site: EditingSite): Promise<void> {
  const target = sitePath(work);
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
  await vscode.workspace.fs.writeFile(
    path.toUri(target),
    new TextEncoder().encode(`${JSON.stringify(site, null, 2)}\n`)
  );
}

/** 2つの GitHub の指し方が同じリポジトリか（大小・`.git`・形の違いを吸収する） */
export function sameRepository(left: string, right: string): boolean {
  const a = parseGithubRepoRef(left);
  const b = parseGithubRepoRef(right);
  if (!a || !b) return false;
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
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
export async function hasOrigin(
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

  const run = runGit;
  rememberRegisteredWorks(works);

  const pointer = await readPointer(work);
  const site = await readSite(work);
  let destination = pointer?.folderPath;
  // **別の機械で渡した作品**：送り先の URL は同期される `.aiwriter/editing.json` にある。
  // この機械に編集用フォルダーが無ければ、新しく作らずにそのリポジトリを取り寄せて使う
  let cloneFrom: string | undefined;
  const source = planShareSource({
    pointerFolderExists: !!destination && (await exists(destination)),
    rememberedRemoteUrl: site.remoteUrl,
  });
  if (source !== "reuse") {
    destination = await decideDestination(work, works);
    if (!destination) return;
    if (source === "clone") cloneFrom = site.remoteUrl;
  }
  if (!destination) return;
  const target: string = destination;

  const repositoryExists = cloneFrom !== undefined || (await hasOrigin(target, run));

  // **招待は初回だけ。** 招待が通った名前は `.aiwriter/editing.json` に覚えている
  // （条件は「今回作ったか」ではなく「名前が覚えられているか」。作成のあとで送信が
  // 止まっても、次の回で招待が抜けない）
  let editorLogin = site.editorLogin ?? pointer?.editorLogin;
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
        ...(!(site.editorLogin ?? pointer?.editorLogin) && editorLogin
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

  // **同じ編集用フォルダーの作業は1本ずつ**（自動の送り返し・取り込みと重ならない）
  const result = await runSerialized(editingQueueKey(target), async () =>
    withProgress("編集部へ渡す形にしています…", async (): Promise<PushOutcome> => {
      if (cloneFrom) {
        const cloned = await cloneEditingRepository(cloneFrom, target);
        if (!cloned.ok) return { ok: false, detail: cloned.detail };
      }
      return sendToEditor(work, target, { run, pointer, site, works });
    })
  );

  if (!result.ok) {
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("編集部へ渡す", { 作品: work.title, 詳細: result.detail });
    whenNoticePicked(
      vscode.window.showErrorMessage(
        `編集部へ渡せませんでした: ${result.detail}`,
        "ログを表示",
        "閉じる"
      ),
      async (action) => {
        if (action === "ログを表示") {
          await vscode.commands.executeCommand("novelai.showLog");
        }
      },
      { label: "編集部へ渡す", workFolder: work.folderPath }
    );
    return;
  }

  // 招待。**失敗しても、渡したこと自体は成功のまま**
  let invite: InviteNotice = { kind: "none" };
  const ref = result.ref;
  const knownLogin = site.editorLogin ?? pointer?.editorLogin;
  if (!knownLogin && result.outcome === "pushed") {
    invite = ref
      ? await inviteEditor(editorLogin, ref, result.viaAccount === true)
      : { kind: "skipped" };
  }

  await writePointer(work, {
    folderPath: target,
    sharedAt: new Date().toISOString(),
  });
  // 送り先と、招待が通った名前（通らなかったら次に訊き直す）を、同期される場所へ
  const nextSite: EditingSite = {
    ...(result.ref ? { remoteUrl: cloneUrlOf(result.ref) } : site.remoteUrl ? { remoteUrl: site.remoteUrl } : {}),
    ...(invite.kind === "invited" || invite.kind === "already"
      ? { editorLogin: invite.login }
      : knownLogin
        ? { editorLogin: knownLogin }
        : {}),
  };
  await writeSite(work, nextSite);

  // 範囲が校閲中で送らなかったものがあれば、そう言う
  if (result.skippedLocked && result.skippedLocked.length > 0) {
    void vscode.window.showInformationMessage(skippedLockedMessage(result.skippedLocked));
  }

  // **結末で知らせを分ける**（0.74.12）。`ok` だけを見て一律に
  // 「編集部を招いてください」と出していたため、`gh` が無くて送れて
  // いないときにも招けと言い、［GitHubで開く］は何もしないボタンだった
  const notice = shareNoticeFor(result.outcome ?? "pushed", work.title, invite);
  // **ボタンが押されるのを待たずに戻る**（`whenNoticePicked`）。待つと、知らせが
  // 通知センターへ沈んだあいだ「『編集部へ渡す』はいま動いています」が出続け、
  // 自動の送り返しも札を見て控え続ける（作者の実機、2026-10-30）
  const repositoryUrl = result.repositoryUrl;
  whenNoticePicked(
    vscode.window.showInformationMessage(notice.message, ...notice.actions),
    async (next) => {
      if (next === "リンクを写す" && notice.link) {
        await vscode.env.clipboard.writeText(notice.link);
      } else if (next === "GitHubで開く" && repositoryUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(repositoryUrl));
      }
    },
    { label: "編集部へ渡す", workFolder: work.folderPath }
  );
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
 * GitHub の鍵を取る（招待・権利の取り消し・非公開の確認が使う）。
 *
 * **サインインの窓を新しく出さない。** VS Code のアカウントで作った／すでにサインインが
 * あるときはその鍵。無ければ `gh` の鍵（`gh auth token`）を借りる。どちらも無ければ `undefined`。
 */
export async function acquireGithubToken(
  viaAccount: boolean,
  deps: {
    token?: () => Promise<string | undefined>;
    hasSession?: () => Promise<boolean>;
    ghToken?: () => Promise<string | undefined>;
  } = {}
): Promise<string | undefined> {
  const getToken = deps.token ?? ensureGithubAuthToken;
  const hasSession = deps.hasSession ?? (() => hasGithubSession());
  return viaAccount || (await hasSession())
    ? await getToken()
    : await (deps.ghToken ?? ghAuthToken)();
}

/**
 * 編集部を招く。トークンは VS Code の GitHub アカウントから取る。
 *
 * **サインインの窓を新しく出さない。** アカウントの道で作ったか、すでに
 * サインインがあるときはその鍵で招く。無ければ `gh` が持っている鍵
 * （`gh auth token`）を借りる——`gh` だけで作った作者にも「招待まで自動」を
 * 通すため（作者の裁定 2026-10-28）。どちらも無ければ、手で招く案内に落とす。
 */
export async function inviteEditor(
  login: string | undefined,
  ref: GithubRepoRef,
  viaAccount: boolean,
  deps: {
    token?: () => Promise<string | undefined>;
    hasSession?: () => Promise<boolean>;
    ghToken?: () => Promise<string | undefined>;
    invite?: typeof inviteCollaborator;
  } = {}
): Promise<InviteNotice> {
  if (!login) return { kind: "skipped" };
  const token = await acquireGithubToken(viaAccount, deps);
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
  return chooseDestination(work, works);
}

/**
 * 編集用フォルダーを、GitHub の最新へ早送りする（送り直しの前、リポジトリがあるときだけ）。
 *
 * **写す前にやる。** 編集部が先に提案を送っていると、そのまま送って断られる。
 * 写したあとでは未記録の変更ができていて取り込めない。
 *
 * @returns 失敗したときだけ結果を返す（止める）。進めてよいなら `undefined`
 */
export async function prepareEditingFolder(
  folder: string,
  run: GitCommandRunner,
  registeredWorks?: readonly WorkEntry[]
): Promise<PushOutcome | undefined> {
  if (!(await hasOrigin(folder, run))) return undefined;
  const status = await readSyncStatus(folder, run);
  // **上流がまだ無いときは取り寄せない。** 初回の送信が途中で止まったフォルダーでは、
  // 取り寄せる先が無く、ここで失敗すると以後ずっと止まる。送信（push -u）に任せる
  if (status.kind !== "tracked") return undefined;

  const pulled = await pullFastForwardAutostash(folder, run);
  if (pulled.ok) return undefined;
  if (pulled.failure.kind === "diverged") {
    // 編集用フォルダーの中身は、提案・鍵の台帳以外すべて作者の側から作り直せる。
    // 両方の台帳を混ぜて取っておき、相手の最新へ合わせてから台帳を戻す
    const reconciled = await reconcileDiverged(folder, run, { registeredWorks });
    return reconciled.ok ? undefined : { ok: false, detail: reconciled.detail };
  }
  return {
    ok: false,
    detail:
      pulled.failure.kind === "failed"
        ? pulled.failure.detail
        : "編集用フォルダーに記録していない変更が残っているため、取り寄せられませんでした",
  };
}

/**
 * 分かれてしまった編集用フォルダー（または編集部の作業フォルダー）を、相手の最新に合わせ直す。
 *
 * 1. fetch する
 * 2. **台帳（提案・鍵・編集履歴）を、手元と相手の両方から混ぜて取っておく**
 *    （`mergeProposalJsonl`。どちらの行も消さない）
 * 3. `reset --hard @{u}` で相手の最新に合わせる
 * 4. 混ぜた台帳を書き戻す（記録と送信は呼び出し側）
 *
 * 台帳以外（本文・設定資料）は、作者の側が写し直す／編集部の側は書かないので、
 * 相手の側をそのまま使ってよい。
 */
export interface ReconcileOptions {
  /**
   * 台帳3本（提案・鍵・編集履歴）以外に、変更か送れていない記録があれば**止める**
   * （編集部の側。`reset --hard` は黙って消すので、消えるものが無いと確かめてからだけ走らせる）。
   * 作者の側の編集用フォルダーは、提案・鍵の台帳以外すべて作者の側から作り直せるので付けない。
   */
  ledgerOnly?: boolean;
  /**
   * 登録済みの作品。**どの作品も含まず、どの作品の中でもない**フォルダーにだけ
   * `reset --hard` を走らせる（作者が選んだ置き場が書庫そのものだったとき、書庫に走らせない）。
   */
  registeredWorks?: readonly WorkEntry[];
}

export async function reconcileDiverged(
  folder: string,
  run: GitCommandRunner,
  options: ReconcileOptions = {}
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // **reset の前に確かめる**（消えてからでは遅い）
  if (options.registeredWorks) {
    const problem = editingPlaceProblem(
      folder,
      options.registeredWorks.map((one) => one.folderPath)
    );
    if (problem) {
      return {
        ok: false,
        detail:
          "この場所は登録済みの作品を含む／作品の中にあるため、合わせ直し（reset）を走らせませんでした。" +
          "編集用フォルダーは、作品とは別の新しい場所にしてください。",
      };
    }
  }
  const fetched = await fetchRemote(folder, run);
  if (!fetched.ok) {
    return { ok: false, detail: fetched.detail ?? "GitHub から取り寄せられませんでした" };
  }
  if (options.ledgerOnly) {
    const outside = await changesBeyondLedgers(folder, run);
    if (outside === undefined || outside.length > 0) {
      return {
        ok: false,
        detail:
          outside === undefined
            ? "作業フォルダーの状態を読めなかったため、合わせ直しませんでした。"
            : `台帳（提案・鍵・編集履歴）以外に、変更か送れていない記録があるため、合わせ直さずに止めました（${outside
                .slice(0, 3)
                .join("、")}${outside.length > 3 ? " ほか" : ""}）。` +
              "先に「GitHubと同期」で取り込んでから、もう一度押してください。",
      };
    }
  }
  const merged = new Map<string, string>();
  for (const relative of LEDGER_FILES) {
    const local = await readTextIfAny(path.join(folder, ...relative.split("/")));
    const shown = await run(["show", `@{u}:${relative}`], folder, 15_000);
    const remote = shown.code === 0 ? shown.stdout : "";
    const mixed = mergeProposalJsonl(local, remote);
    if (mixed.text.length > 0) merged.set(relative, mixed.text);
  }
  const reset = await run(["reset", "--hard", "@{u}"], folder, 30_000);
  if (reset.code !== 0) {
    return {
      ok: false,
      detail: `相手の最新に合わせられませんでした: ${(reset.stderr || reset.stdout).trim()}`,
    };
  }
  for (const [relative, text] of merged) {
    const target = path.join(folder, ...relative.split("/"));
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await vscode.workspace.fs.writeFile(path.toUri(target), new TextEncoder().encode(text));
  }
  logStep(`分かれた編集用フォルダーを、台帳を混ぜて合わせ直した（${folder}）`);
  return { ok: true };
}

/**
 * 台帳3本以外の、変更か送れていない記録のパス。読めなければ `undefined`。
 *
 * `status --porcelain`（作業ツリーの変更）と、`@{u}...HEAD`（上流との分かれ目から
 * 手元の側で触ったパス＝送れていない記録）を合わせて見る。
 */
export async function changesBeyondLedgers(
  folder: string,
  run: GitCommandRunner
): Promise<string[] | undefined> {
  const working = await run(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    folder,
    15_000
  );
  if (working.code !== 0) return undefined;
  const unpushed = await run(["diff", "--name-only", "-z", "@{u}...HEAD"], folder, 15_000);
  if (unpushed.code !== 0) return undefined;
  const changed = [
    ...parseStatusPorcelainPaths(working.stdout),
    ...unpushed.stdout.split(String.fromCharCode(0)).filter((name) => name !== ""),
  ];
  const ledgers = new Set<string>(LEDGER_FILES);
  return [...new Set(changed.map(normalizeRelativeKey))].filter((name) => !ledgers.has(name));
}

/**
 * 送信が断られたか。**fetch してから、相手が先に進んでいる（behind）かで見る**
 * （エラー文から原因を当てない）。
 */
export async function pushWasRejected(
  folder: string,
  run: GitCommandRunner
): Promise<boolean> {
  const fetched = await fetchRemote(folder, run);
  if (!fetched.ok) return false;
  const status = await readSyncStatus(folder, run);
  return status.kind === "tracked" && status.behind > 0;
}

/**
 * 登録済みの作品（直近に分かったもの）。送り返しなど、作品を1つしか受け取らない入口でも
 * 「置き場が書庫を含まないか」を確かめられるよう、分かった時点で覚えておく。
 */
let knownWorks: readonly WorkEntry[] = [];

export function rememberRegisteredWorks(works: readonly WorkEntry[]): void {
  knownWorks = works;
}

/** この作品と、覚えている登録済みの作品（重複は道で除く） */
function worksFor(work: WorkEntry, given?: readonly WorkEntry[]): WorkEntry[] {
  const seen = new Set<string>();
  const result: WorkEntry[] = [];
  for (const one of [work, ...(given ?? []), ...knownWorks]) {
    const key = one.folderPath;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(one);
  }
  return result;
}

/** 送り返しの付き物：渡し方の細部（試験で差し替える） */
export interface SendContext {
  /** 登録済みの作品（置き場の安全の確認に使う） */
  works?: readonly WorkEntry[];
  run: GitCommandRunner;
  pointer?: EditingPointer;
  site: EditingSite;
  /** 記録の題 */
  message?: string;
  /** `false` ならリポジトリを作らない（自動の送り返し） */
  allowCreate?: boolean;
  /** 非公開の確認で使う口 */
  verify?: VerifyDeps;
  /** `setUpAndPush` へ渡す差し替え（試験用） */
  setUp?: SetUpAndPushDeps;
}

/** 非公開の確認で差し替えられる口 */
export interface VerifyDeps {
  token?: () => Promise<string | undefined>;
  hasSession?: () => Promise<boolean>;
  ghToken?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * **覚えている送り先と違う origin は、非公開と確かめるまで送らない。**
 *
 * 置き場を作者が選ぶ道で、origin を持つ既存のフォルダーを選ぶと、非公開かどうかを
 * 確かめずに原稿が出ていく。この機能が作った送り先（`.aiwriter/editing.json` の
 * `remoteUrl` と同じ）は作成時に確かめてあるので飛ばす。確かめられなければ送らない。
 */
export async function verifyKnownDestination(
  folder: string,
  site: EditingSite,
  run: GitCommandRunner,
  deps: VerifyDeps = {}
): Promise<PushOutcome | undefined> {
  if (!(await hasOrigin(folder, run))) return undefined;
  const origin = (await run(["remote", "get-url", "origin"], folder, 15_000)).stdout.trim();
  if (site.remoteUrl && sameRepository(site.remoteUrl, origin)) return undefined;

  const refuse = (why: string): PushOutcome => ({
    ok: false,
    detail:
      `この編集用フォルダーの送り先が非公開かどうかを確かめられなかったため、送らずに止めました（${why}）。` +
      "原稿が公開のリポジトリへ出る事故を防ぐためです。",
  });
  const ref = parseGithubRepoRef(origin);
  if (!ref) return refuse("送り先が GitHub のリポジトリとして読めません");
  const token = await acquireGithubToken(false, deps);
  if (!token) return refuse("確かめるための GitHub のサインインがありません");
  const privacy = await fetchRepositoryPrivacy(token, ref, deps.fetchImpl);
  if (!privacy.ok) return refuse(privacy.detail);
  if (!privacy.isPrivate) return refuse("公開のリポジトリです");
  return undefined;
}

/**
 * 編集用フォルダーへ写して、記録して、送る（手動の「渡す」と自動の送り返しの本体）。
 *
 * 順は 送り先の確認 → 取り寄せ（分かれていれば台帳を混ぜて合わせ直す）→ 写す → 送る。
 * 送信が断られたら（fetch して相手が先に進んでいたら）合わせ直して**もう1回だけ**送る。
 * **呼び出し側が、編集用フォルダーごとの順番待ち（`editingQueueKey`）に載せる。**
 */
export async function sendToEditor(
  work: WorkEntry,
  destination: string,
  ctx: SendContext
): Promise<PushOutcome> {
  const run = ctx.run;
  const config = await readWorkConfig(work);
  const paths = workPaths(work, config ?? undefined);

  // **写す前に、置き場が作品を含まない・作品の中でもないと確かめる。** 写しは置き換え対象の
  // フォルダーを消し、合わせ直しは `reset --hard` を走らせる。置き場が書庫そのものだと両方が
  // 作者の原稿に届く
  const registered = worksFor(work, ctx.works);
  const placeProblem = editingPlaceProblem(
    destination,
    registered.map((one) => one.folderPath)
  );
  if (placeProblem) {
    return {
      ok: false,
      detail:
        "この編集用フォルダーは、登録済みの作品を含む／作品の中にあるため、使えません" +
        "（作者の原稿を巻き込むおそれがあります）。作品とは別の新しい場所へ渡し直してください。",
    };
  }

  const verified = await verifyKnownDestination(destination, ctx.site, run, ctx.verify);
  if (verified) return verified;
  const prepared = await prepareEditingFolder(destination, run, registered);
  if (prepared) return prepared;

  let copied = await copyForEditor(paths, destination, config?.manuscriptDir, config?.settingsDir);
  // 写し終えたら場所を覚える。送信で止まっても、やり直しが同じ場所を使える
  await writePointer(work, { ...ctx.pointer, folderPath: destination });

  const setUp: SetUpAndPushDeps = {
    run,
    ...(ctx.message ? { message: ctx.message } : {}),
    ...(ctx.allowCreate === false ? { allowCreate: false } : {}),
    // 作って非公開と確かめたら、すぐ送り先を覚える（送信が止まっても、別の機械や次の回が
    // 2つ目のリポジトリを作らない）
    onCreated: async (info) => {
      await writeSite(work, { ...(await readSite(work)), remoteUrl: info.cloneUrl });
    },
    ...ctx.setUp,
  };
  let result = await setUpAndPush(work, destination, setUp);
  if (!result.ok && (await pushWasRejected(destination, run))) {
    logStep(`編集用フォルダーへの送信が断られたので、台帳を混ぜて合わせ直して送り直す（${work.title}）`);
    const reconciled = await reconcileDiverged(destination, run, { registeredWorks: registered });
    if (!reconciled.ok) return { ok: false, detail: reconciled.detail };
    copied =await copyForEditor(paths, destination, config?.manuscriptDir, config?.settingsDir);
    result = await setUpAndPush(work, destination, setUp);
  }
  return { ...result, skippedLocked: copied.skippedLocked };
}

/** 鍵を覚えさせてから取り寄せる。通らなければ `gh` で取り寄せる。失敗したら途中のフォルダーを消す */
export async function cloneWithCredential(
  token: string | undefined,
  url: string,
  destination: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // **宛先が既にあれば取り寄せない。** 失敗のあとの後始末で宛先を消すので、作者が選んだ
  // 既存のフォルダーを丸ごと消さないよう、消してよいのは**この関数が自分で作ったとき
  // だけ**にする（先に無いことを確かめる）
  if (await exists(destination)) {
    return {
      ok: false,
      detail: `「${destination}」はすでに存在します。中身を失わないため、取り寄せませんでした。`,
    };
  }
  const parent = path.dirname(destination);
  await vscode.workspace.fs.createDirectory(path.toUri(parent));
  // `git credential approve` の作業ディレクトリは、あるフォルダーでなければならない
  if (token) await rememberGithubCredential(token, url, parent);

  let result = await cloneRepository(url, destination);
  // 保管の仕組みが無い環境では、鍵が効かず認証で断られる。gh が使えるなら回す
  if (!result.ok && result.needsAuth && (await ghAvailable())) {
    result = await cloneWithGh(url, destination);
  }
  if (result.ok) return { ok: true };
  // **途中のフォルダーを残さない。** 残ると次の回が「すでに存在します」で止まる
  // （取り寄せる前にこのフォルダーが無かったことは、呼び出し側が確かめてある）
  try {
    await vscode.workspace.fs.delete(path.toUri(destination), {
      recursive: true,
      useTrash: false,
    });
  } catch {
    // 無ければ消すものも無い
  }
  return { ok: false, detail: result.detail ?? "理由は不明です" };
}

/** 別の機械で渡した編集用リポジトリを、この機械へ取り寄せる */
async function cloneEditingRepository(
  url: string,
  destination: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const token = (await acquireGithubToken(false)) ?? (await ensureGithubAuthToken());
  return cloneWithCredential(token, url, destination);
}

/** 送り返しで範囲を飛ばしたときの知らせ */
export function skippedLockedMessage(skipped: readonly string[]): string {
  return `${describeLockRange([...skipped])}は編集部が校閲中のため送っていません。`;
}

/** 置き場所を聞く。**作品フォルダーの中には置かせない**（入れ子のリポジトリになる） */
export async function chooseDestination(
  work: WorkEntry,
  works: readonly WorkEntry[] = [work]
): Promise<string | undefined> {
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
  const problem = editingPlaceProblem(destination, [
    work.folderPath,
    ...works.map((one) => one.folderPath),
  ]);
  if (problem === "insideWork") {
    void vscode.window.showErrorMessage(
      "作品フォルダーの中には置けません。リポジトリが入れ子になり、" +
        "書庫の側へ巻き込まれます。別の場所を選んでください。"
    );
    return undefined;
  }
  if (problem === "containsWork") {
    void vscode.window.showErrorMessage(
      "作品を含むフォルダー（書庫そのものなど）は、編集用フォルダーにできません。" +
        "別の場所を選んでください。"
    );
    return undefined;
  }
  // **すでにある場所は断る。** 取り寄せの失敗の後始末や、合わせ直しが、作者の既存の
  // フォルダーの中身を消しうる。新しい名前の場所だけを使う
  if (await exists(destination)) {
    void vscode.window.showErrorMessage(
      `「${destination}」はすでに存在します。中身を失わないため、使えません。` +
        "まだ無い名前を指定してください。"
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
): Promise<{ skippedLocked: string[] }> {
  await vscode.workspace.fs.createDirectory(path.toUri(destination));

  /*
    **台帳（提案・鍵）は最初に混ぜる。** 鍵は両方向に流す——作者が解除した行を
    編集部へ届けるためで、編集部の側の鍵が作者へ届くのは取り込みの側。
    混ぜたあとの編集用フォルダーの鍵を見て、**編集部が校閲中の話は消さず・写さない**
    （校閲中に作者の版で上書きすると、編集部の読んでいる本文が足元から変わる）。
  */
  for (const relative of [PROPOSAL_RELATIVE, LOCK_RELATIVE]) {
    await mergeProposalsInto(
      path.join(destination, relative),
      await readTextIfAny(path.join(paths.root, relative))
    );
  }
  const locked = await editorLockedPaths(destination);
  // **突き合わせは `normalizeFile`（小文字・区切りの統一）に揃える。** 鍵の `file` は
  // 小文字で記録されるので、`Manuscript/Chapter03.txt` のように大文字を含む道が素通りして
  // 校閲中の話を上書き・削除していた
  const isLocked = (relative: string): boolean => locked.has(normalizeFile(relative));
  /** 実際に飛ばした話（作品の綴りのまま）。鍵があっても何もしなかったものは載せない */
  const skipped = new Map<string, string>();
  const skip = (relative: string): void => {
    skipped.set(normalizeFile(relative), manifestKey(relative));
  };
  /** この置き換え対象のフォルダーの中に、校閲中の話があるか */
  const hasLockedUnder = (name: string): boolean => {
    const prefix = `${normalizeFile(name)}/`;
    return [...locked].some((key) => key.startsWith(prefix));
  };

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
    if (!(await exists(target))) continue;
    if (hasLockedUnder(name)) {
      // 範囲があるときは、校閲中でない話だけを消す（校閲中の話は残す）
      for (const file of await walkFiles(target)) {
        if (isLocked(`${manifestKey(name)}/${file}`)) {
          skip(`${manifestKey(name)}/${file}`);
          continue;
        }
        await vscode.workspace.fs.delete(path.toUri(path.join(target, ...file.split("/"))), {
          useTrash: false,
        });
      }
      continue;
    }
    await vscode.workspace.fs.delete(path.toUri(target), {
      recursive: true,
      useTrash: false,
    });
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
  const previousManifest = await readShareManifest(destination);
  for (const previous of previousManifest) {
    if (keep.has(manifestKey(previous))) continue;
    // 校閲中の話は、作者の側で消えていても消さない
    if (isLocked(previous)) {
      if (await exists(path.join(destination, ...previous.split("/")))) skip(previous);
      continue;
    }
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
    if (hasLockedUnder(name)) {
      // 範囲があるときは、本文を1件ずつ写す（校閲中の話は写さない）
      for (const file of await walkFiles(source)) {
        if (isLocked(`${manifestKey(name)}/${file}`)) {
          skip(`${manifestKey(name)}/${file}`);
          continue;
        }
        const to = path.join(target, ...file.split("/"));
        await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(to)));
        await vscode.workspace.fs.copy(
          path.toUri(path.join(source, ...file.split("/"))),
          path.toUri(to),
          { overwrite: true }
        );
      }
      await removeRecoveryDirectories(target);
      continue;
    }
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
    if (isLocked(relative)) {
      skip(relative);
      continue;
    }
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
  // 校閲中で残した話も控えに残す（鍵が解けたあとの送り直しで、作者の側で消えていれば消すため）
  await writeShareManifest(destination, [
    ...rootCopies,
    ...previousManifest.filter(
      (previous) => isLocked(previous) && !keep.has(manifestKey(previous))
    ),
  ]);

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

  // 提案と鍵の台帳は、冒頭で混ぜてある（承認・却下は作者が書くので、置き換えると
  // 編集部の提案が消える）
  return { skippedLocked: [...skipped.values()] };
}

/** 鍵の台帳の、作品フォルダーからの相対パス */
const LOCK_RELATIVE = path.join(".aiwriter", "locks", "locks.jsonl");

/**
 * 編集用フォルダーの鍵の台帳から、**編集部が押さえているファイル**を取り出す
 * （相対パスは `manifestKey` で `/` に揃える）。
 */
export async function editorLockedPaths(folder: string): Promise<Set<string>> {
  const text = await readTextIfAny(path.join(folder, LOCK_RELATIVE));
  const locked = new Set<string>();
  for (const lock of resolveLocks(parseLockEvents(text)).values()) {
    // 鍵の台帳は `normalizeFile`（小文字）で突き合わせる
    if (lock.holderKind === "editor") locked.add(normalizeFile(lock.file));
  }
  return locked;
}

/** フォルダーの中のファイルを、フォルダーからの相対（`/` 区切り）で並べる */
async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(path.join(root, ...(prefix ? prefix.split("/") : []))));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const [name, type] of entries) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (type === vscode.FileType.Directory) {
      files.push(...(await walkFiles(root, relative)));
    } else if (type === vscode.FileType.File) {
      files.push(relative);
    }
  }
  return files;
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
  /** 編集部が校閲中のため、送らなかった話（作品からの相対パス） */
  skippedLocked?: string[];
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
  /**
   * リポジトリを作り、**非公開と確かめた直後**に呼ぶ。送り先を同期される場所へ覚えさせる
   * （送信が止まっても、別の機械や次の回が2つ目のリポジトリを作らないため）
   */
  onCreated?: (info: { cloneUrl: string }) => Promise<void>;
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
 * `gh` がサインインに使っている鍵を借りる（招待の口を叩くため）。
 * `gh` が無い・サインインしていなければ `undefined`
 */
async function ghAuthToken(): Promise<string | undefined> {
  if (!(await ghAvailable())) return undefined;
  const result = await runCommand("gh", ["auth", "token"], undefined, 15_000);
  if (result.code !== 0) return undefined;
  const token = result.stdout.trim();
  return token.length > 0 ? token : undefined;
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
      await deps.onCreated?.({ cloneUrl: created.cloneUrl });
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
      const createdUrl = await remoteUrl(destination, run);
      const createdRef = createdUrl ? parseGithubRepoRef(createdUrl) : undefined;
      if (createdRef) await deps.onCreated?.({ cloneUrl: cloneUrlOf(createdRef) });
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
      /** 作品の台帳へ足した提案の件数 */
      added: number;
      /** 新しく編集部の鍵がかかったファイル（作品からの相対パス） */
      locksAcquired: string[];
      /** 編集部の鍵が解けたファイル */
      locksReleased: string[];
    };

/**
 * 編集部の提案と校閲の鍵を取り込む（**知らせを出さない**）。
 *
 * 手動の「編集部提案取込」と、同期のあとの自動の取り込みが、同じ中身を使う。
 * **本文には触らない。** 取り込むのは提案と鍵の台帳だけ。鍵は release の行も流れてくるので、
 * 解除も作者の側へ届く。台帳への書き込みは、提案・鍵それぞれの書き込みの鎖
 * （`ProposalStore`／`FileLockStore` の `mergeIncoming`）を通す。
 *
 * **編集用フォルダーごとの順番待ちに載る**（手動の渡す・送り返しと重ならない）。
 */
export async function importEditorProposalsQuietly(
  work: WorkEntry,
  run?: GitCommandRunner
): Promise<ImportResult> {
  const pointer = await readPointer(work);
  if (!pointer || !(await exists(pointer.folderPath))) {
    return { status: "noPointer" };
  }
  const folder = pointer.folderPath;
  return runSerialized(editingQueueKey(folder), async (): Promise<ImportResult> => {
    const runner = run ?? runGit;
    const pulled = await pullFastForward(folder, runner);

    /*
      **取り寄せが断られたとき、手元の台帳は古いかもしれない。** 分かれたままの編集用フォルダー
      （作者の写しが送れていない間に、編集部が先に送った）は、早送りできず、古い鍵を読み続ける
      （解除や新しい範囲が届かない）。状態で見分ける（エラー文は見ない）：
      - 分かれている（ahead と behind の両方）なら、台帳を混ぜて合わせ直す（`reconcileDiverged`。
        登録済みの作品を含む置き場には走らせない）
      - 合わせ直せない／遅れているだけで取り込めないときは、上流の台帳（`@{u}`）も混ぜて読む
    */
    let behindUpstream = false;
    if (!pulled.ok) {
      const status = await readSyncStatus(folder, runner);
      if (status.kind === "tracked" && status.behind > 0) {
        behindUpstream = true;
        if (status.ahead > 0) {
          const reconciled = await reconcileDiverged(folder, runner, {
            registeredWorks: worksFor(work),
          });
          if (reconciled.ok) behindUpstream = false;
        }
      }
    }
    const readLedger = async (relative: string): Promise<string> => {
      const local = await readTextIfAny(path.join(folder, relative));
      if (!behindUpstream) return local;
      const shown = await runner(
        ["show", `@{u}:${normalizeRelativeKey(relative)}`],
        folder,
        15_000
      );
      return shown.code === 0 ? mergeProposalJsonl(local, shown.stdout).text : local;
    };
    const incoming = await readLedger(PROPOSAL_RELATIVE);
    const incomingLocks = await readLedger(LOCK_RELATIVE);

    const added =
      incoming.trim().length > 0
        ? await new ProposalStore(work).mergeIncoming(incoming)
        : 0;

    let locksAcquired: string[] = [];
    let locksReleased: string[] = [];
    if (incomingLocks.trim().length > 0) {
      const store = new FileLockStore(work);
      const before = editorHeld(await store.load());
      await store.mergeIncoming(incomingLocks);
      const after = editorHeld(await store.load());
      locksAcquired = [...after].filter((file) => !before.has(file));
      locksReleased = [...before].filter((file) => !after.has(file));
    }
    return {
      status: "done",
      pullFailed: !pulled.ok,
      hadIncoming: incoming.trim().length > 0,
      added,
      locksAcquired,
      locksReleased,
    };
  });
}

/** 編集部が押さえているファイル（`/` 区切りに揃えたもの） */
function editorHeld(locks: Map<string, { holderKind: string; file: string }>): Set<string> {
  const held = new Set<string>();
  for (const lock of locks.values()) {
    if (lock.holderKind === "editor") held.add(manifestKey(lock.file));
  }
  return held;
}

/** 鍵が動いたときの知らせの文（取り込みの手動・自動で共有する） */
export function describeLockChanges(result: {
  locksAcquired: readonly string[];
  locksReleased: readonly string[];
}): string[] {
  const messages: string[] = [];
  if (result.locksAcquired.length > 0) {
    messages.push(
      `編集部が${describeLockRange([...result.locksAcquired])}を校閲中です。` +
        "終わるまで、この範囲は書けません。"
    );
  }
  if (result.locksReleased.length > 0) {
    messages.push(`${describeLockRange([...result.locksReleased])}の校閲が終わりました。`);
  }
  return messages;
}

/**
 * 編集部の提案を取り込む（手動の道。「編集部提案取込」）。
 *
 * **本文には触らない。** 取り込むのは提案と鍵の台帳だけで、採るかどうかは
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
  for (const text of describeLockChanges(result)) {
    void vscode.window.showInformationMessage(text);
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

  whenNoticePicked(
    vscode.window.showInformationMessage(
      `編集部からの提案を${result.added}件取り込みました。`,
      "提案を見る",
      "閉じる"
    ),
    async (next) => {
      if (next === "提案を見る") {
        // いま取り込んだ作品の提案を見る。引数無しだと作品選択からやり直させる
        await vscode.commands.executeCommand("novelai.reviewProposals", {
          type: "work",
          work,
        });
      }
    },
    { label: "編集部提案取込", workFolder: work.folderPath }
  );
}

/**
 * 採否を、確認なしで編集部へ送り返す（自動の送り返し。作者の裁定、2026-10-28）。
 *
 * **リポジトリを作らない。** 渡してある作品（pointer とリポジトリがある）にだけ効く。
 * 中身は `sendToEditor`（取り寄せ → 写す → 記録 → 送る。断られたら台帳を混ぜて1回だけやり直す）。
 * **編集用フォルダーごとの順番待ちに載る。**
 */
export async function resendDecisionsQuietly(
  work: WorkEntry,
  run: GitCommandRunner = runGit,
  verify?: VerifyDeps
): Promise<PushOutcome & { skipped?: boolean }> {
  const pointer = await readPointer(work);
  if (!pointer || !(await exists(pointer.folderPath))) {
    return { ok: false, detail: "編集用フォルダーの記録がありません", skipped: true };
  }
  const destination = pointer.folderPath;
  return runSerialized(editingQueueKey(destination), async () => {
    if (!(await hasOrigin(destination, run))) {
      return {
        ok: false,
        detail: "編集用フォルダーの送り先がまだありません",
        skipped: true,
      };
    }
    const pushed = await sendToEditor(work, destination, {
      run,
      pointer,
      site: await readSite(work),
      allowCreate: false,
      message: `${work.title} の採否を編集部へ返す`,
      verify,
    });
    if (pushed.ok) {
      await writePointer(work, { ...pointer, sharedAt: new Date().toISOString() });
    }
    return pushed;
  });
}

