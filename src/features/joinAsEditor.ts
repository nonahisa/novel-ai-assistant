import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig } from "../core/workRegistry";
import { currentMode } from "../core/actorContext";
import { EDITOR_WORK_LIMIT } from "../core/editorMode";
import { joinEditorDestination } from "../core/editingRepo";
import {
  acceptEditorInvitation,
  cloneUrlOf,
} from "../core/githubCollaboration";
import { describeRepoRefProblem, parseGithubRepoRef } from "../core/githubRepoRef";
import { cloneRepository, cloneWithGh } from "../core/gitClone";
import { isGitAvailable } from "../core/git";
import {
  ensureGithubAuthToken,
  ghAvailable,
  rememberGithubCredential,
} from "../core/gitSetup";
import { pathExists } from "../core/fileSystem";
// ログの書き先：作品が定まらない
// 参加は取り寄せる前の操作で、まだ作品のフォルダーが無い（あっても登録前）。
// 書き先にできる `.aiwriter` が無いので、記録は出力チャンネルだけに出す。
import { logFailure, logStep } from "../core/logger";
import { askText } from "../views/dialogs";
import { withProgress } from "../views/progress";
import { notifyDone } from "../views/notify";
import { defaultParentForNewFolder, pickNewFolderParent } from "./pickFolder";
import { applyMode, describeModeChange } from "./switchMode";

/**
 * 編集部として参加する（作者の裁定、2026-10-28「この形で作る」）。
 *
 * 作者から届いたリンクを貼ると、招待の受諾・取り寄せ・登録・編集者モードまでを
 * 1回で通す。以前は GitHub の画面で招待を受け、手で clone して、モードを切り替えて
 * いた。
 *
 * **順は 受諾 → 取り寄せ → 登録 → モード。** 先にモードを編集者にすると、
 * 登録が「作品は1つまで」の制限に当たる（`canRegisterWork`）。
 *
 * **リンクは貼ってもらう。** URI ハンドラは拡張機能に1つしか持てず、読者統計の
 * ヘルパー連携が使っているので使わない。
 */
export async function joinAsEditor(registry: WorkRegistry): Promise<void> {
  const mode = currentMode();
  const registered = registry.list();

  // 編集者モードの環境は作品1つまで。**取り寄せる前に**止める（取り寄せたあとで
  // 登録を断られると、置き場に中途半端なフォルダーが残る）
  if (mode === "editor" && registered.length >= EDITOR_WORK_LIMIT) {
    void vscode.window.showWarningMessage(
      `編集者モードの環境で登録できる作品は ${EDITOR_WORK_LIMIT} つまでです` +
        `（いまは「${registered[0]?.title ?? "登録済みの作品"}」）。` +
        "別の作品に参加するには、先にその作品の登録を外してください。"
    );
    return;
  }

  if (!(await isGitAvailable())) {
    const action = await vscode.window.showInformationMessage(
      "Gitが見つかりませんでした。作品を取り寄せるにはGitが必要です。",
      "導入方法を見る",
      "閉じる"
    );
    if (action === "導入方法を見る") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://git-scm.com/downloads")
      );
    }
    return;
  }

  const link = await askText({
    title: "編集部として参加",
    prompt: "作者から届いたリンクを貼り付けてください",
    placeHolder: "https://github.com/ユーザー名/リポジトリ名",
    ignoreFocusOut: true,
    validateInput: (value) => describeRepoRefProblem(value) ?? null,
  });
  if (!link) return;
  const ref = parseGithubRepoRef(link);
  if (!ref) return;

  // 置き場。**訊かない**（既定の置き場の下の `編集部/<リポジトリ名>`）。
  // 既定が決められないときだけ選んでもらう
  let home = await defaultParentForNewFolder(registered);
  if (!home) {
    home = await pickNewFolderParent({
      purpose: "編集部の作品を置く場所を選択",
      openLabel: "ここに置く",
      works: registered,
    });
    if (!home) return;
  }
  const destination = joinEditorDestination(home, ref.repo);
  // **既にあるフォルダーへは取り寄せない。** 上書きすると中身が消える
  if (await pathExists(destination)) {
    void vscode.window.showErrorMessage(
      `「${destination}」はすでに存在します。` +
        "中身を失わないため、参加を中止しました。" +
        "そのフォルダーが前に取り寄せた同じ作品なら、「フォルダから追加」で登録できます。"
    );
    return;
  }

  // **確認は最初の1回にまとめる。** 作者モードから切り替えるときは、編集者モードで
  // 使えなくなる操作も先に見せる（切り替えの確認と同じ文）
  const switching = mode === "author";
  const confirmed = await vscode.window.showWarningMessage(
    `編集部として「${ref.owner}/${ref.repo}」に参加します。`,
    {
      modal: true,
      detail: [
        "GitHubの招待を受け、作品をこの環境へ取り寄せて登録します。",
        `置き場所: ${destination}`,
        ...(switching
          ? [
              "",
              "続けて、この環境を「編集者」に切り替えます。",
              "",
              describeModeChange("editor"),
            ]
          : []),
      ].join("\n"),
    },
    "参加する"
  );
  if (!confirmed) return;

  const token = await withProgress("GitHubへサインインしています", () =>
    ensureGithubAuthToken()
  );
  if (!token) {
    void vscode.window.showWarningMessage(
      "GitHubへのサインインが完了しなかったため、参加を中止しました。"
    );
    return;
  }

  const accepted = await withProgress("招待を確かめています…", () =>
    acceptEditorInvitation(token, ref)
  );
  if (!accepted.ok) {
    logFailure("編集部として参加（招待の受諾）", {
      リポジトリ: `${ref.owner}/${ref.repo}`,
      理由: accepted.reason,
      詳細: accepted.detail,
    });
    void vscode.window.showErrorMessage(
      accepted.reason === "notInvited"
        ? accepted.detail
        : `招待を受けられませんでした: ${accepted.detail}`
    );
    return;
  }
  logStep(
    `編集部の招待を${accepted.outcome === "accepted" ? "受けた" : "受け済みと確認"}: ` +
      `${ref.owner}/${ref.repo}`
  );

  const cloned = await cloneIntoPlace(token, ref, destination);
  if (!cloned.ok) {
    logFailure("編集部として参加（取り寄せ）", {
      リポジトリ: `${ref.owner}/${ref.repo}`,
      詳細: cloned.detail,
    });
    const action = await vscode.window.showErrorMessage(
      `取り寄せられませんでした: ${cloned.detail}`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") {
      await vscode.commands.executeCommand("novelai.showLog");
    }
    return;
  }

  // 題は、取り寄せた作品の config.json から。無ければリポジトリ名
  const title = await titleOf(destination, ref.repo);
  const entry = await registry.addExisting(destination, title);
  if (!entry) return;

  // **登録のあとでモードを切り替える**（先だと作品1つの制限に当たる）
  if (switching) await applyMode("editor");

  notifyDone(
    `「${entry.title}」に編集部として参加しました。` +
      "開いたときに、作者からの更新が自動で取り込まれます。"
  );
}

/** 鍵を覚えさせてから取り寄せる。通らなければ `gh` で取り寄せる */
async function cloneIntoPlace(
  token: string,
  ref: { owner: string; repo: string },
  destination: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const parent = path.dirname(destination);
  await vscode.workspace.fs.createDirectory(path.toUri(parent));

  const url = cloneUrlOf(ref);
  // `git credential approve` の作業ディレクトリは、あるフォルダーでなければならない
  await rememberGithubCredential(token, url, parent);

  let result = await withProgress("作品を取り寄せています…", () =>
    cloneRepository(url, destination)
  );
  // 保管の仕組みが無い環境では、鍵が効かず認証で断られる。gh が使えるなら回す
  if (!result.ok && result.needsAuth && (await ghAvailable())) {
    result = await withProgress("GitHub CLIで取り寄せています…", () =>
      cloneWithGh(url, destination)
    );
  }
  return result.ok
    ? { ok: true }
    : { ok: false, detail: result.detail ?? "理由は不明です" };
}

async function titleOf(folder: string, fallback: string): Promise<string> {
  try {
    const stub: WorkEntry = {
      id: "join_probe",
      title: fallback,
      folderPath: folder,
      registeredAt: new Date().toISOString(),
    };
    const config = await readWorkConfig(stub);
    const title = config?.workTitle?.trim();
    return title && title.length > 0 ? title : fallback;
  } catch {
    return fallback;
  }
}
