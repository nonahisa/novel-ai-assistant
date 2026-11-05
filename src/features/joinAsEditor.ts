import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig } from "../core/workRegistry";
import { currentMode } from "../core/actorContext";
import { joinEditorDestination } from "../core/editingRepo";
import {
  acceptEditorInvitation,
  cloneUrlOf,
} from "../core/githubCollaboration";
import { describeRepoRefProblem, parseGithubRepoRef } from "../core/githubRepoRef";
import { cloneWithCredential } from "./shareWithEditor";
import { isGitAvailable, runGit } from "../core/git";
import {
  ensureGithubAuthToken,
} from "../core/gitSetup";
import { pathExists } from "../core/fileSystem";
// ログの書き先：作品が定まらない
// 参加は取り寄せる前の操作で、まだ作品のフォルダーが無い（あっても登録前）。
// 書き先にできる `.aiwriter` が無いので、記録は出力チャンネルだけに出す。
import { logFailure, logStep } from "../core/logger";
import { askText } from "../views/dialogs";
import { withProgress } from "../views/progress";
import { notifyDone, whenNoticePicked } from "../views/notify";
import { defaultParentForNewFolder, pickNewFolderParent } from "./pickFolder";
import { applyMode, describeModeChange } from "./switchMode";

/**
 * 編集部として参加する（作者の裁定、2026-10-28「この形で作る」）。
 *
 * 作者から届いたリンクを貼ると、招待の受諾・取り寄せ・登録・編集者モードまでを
 * 1回で通す。以前は GitHub の画面で招待を受け、手で clone して、モードを切り替えて
 * いた。
 *
 * **順は 受諾 → 取り寄せ → 登録 → モード。** 登録の前に編集者モードにすると、
 * 取り寄せに失敗したとき、作品の無い編集者モードの環境が残る。
 *
 * **リンクは貼ってもらう。** URI ハンドラは拡張機能に1つしか持てず、読者統計の
 * ヘルパー連携が使っているので使わない。
 */
/** 作品の送り先（origin）の GitHub の持ち主と名前。読めなければ undefined */
async function originRepoOf(folder: string): Promise<{ owner: string; repo: string } | undefined> {
  const result = await runGit(["remote", "get-url", "origin"], folder, 15_000).catch(() => undefined);
  const url = result && result.code === 0 ? result.stdout.trim() : "";
  return url ? parseGithubRepoRef(url) : undefined;
}

/** 参加している作品のうち、送り先がそのリンクと同じもの（大文字小文字は見ない） */
async function findJoinedWork(
  works: readonly WorkEntry[],
  ref: { owner: string; repo: string }
): Promise<WorkEntry | undefined> {
  for (const work of works) {
    const origin = await originRepoOf(work.folderPath);
    if (
      origin !== undefined &&
      origin.owner.toLowerCase() === ref.owner.toLowerCase() &&
      origin.repo.toLowerCase() === ref.repo.toLowerCase()
    ) {
      return work;
    }
  }
  return undefined;
}

/**
 * 参加が済んだときの結果。**参加した作品を返す**（編集者メニューがその作品を選ぶ）。
 * もう参加していた作品のリンクなら、その作品を `already` で返す
 */
export type JoinAsEditorResult =
  | { kind: "joined"; work: WorkEntry }
  | { kind: "already"; work: WorkEntry }
  | undefined;

/** 編集者メニューの受け取りの手順の名前（案内の文で指す） */
export const RECEIVE_STEP_LABEL = "1. 作者の最新の原稿を受け取る";

export async function joinAsEditor(registry: WorkRegistry): Promise<JoinAsEditorResult> {
  const mode = currentMode();
  const registered = registry.list();
  /*
    **編集者は複数の作品に参加できる**（作者の指示 2026-11-05 夜。以前は「作品は1つまで」で、
    2作品目のリンクを貼ると「登録を外して」と出た）。参加のリンクを貼ると作品が増え、
    編集者メニューの一番上で切り替える。

    作者モードの環境から参加するときも、作品の数では止めない（以前は「作品は1つまで」を
    すり抜けないよう、作品があると止めていた）。確認の窓で、この環境が編集者モードになる
    ことと使えなくなる操作を先に見せる
  */
  if (!(await isGitAvailable())) {
    // ボタンが押されるのを待たずに戻る（`whenNoticePicked`。待つと「いま動いています」が出続ける）
    whenNoticePicked(
      vscode.window.showInformationMessage(
        "Gitが見つかりませんでした。作品を取り寄せるにはGitが必要です。",
        "導入方法を見る",
        "閉じる"
      ),
      async (action) => {
        if (action === "導入方法を見る") {
          await vscode.env.openExternal(
            vscode.Uri.parse("https://git-scm.com/downloads")
          );
        }
      },
      { label: "編集者として参加" }
    );
    return;
  }

  const link = await askText({
    title: "編集者として参加",
    prompt: "作者から届いたリンクを貼り付けてください",
    placeHolder: "https://github.com/ユーザー名/リポジトリ名",
    ignoreFocusOut: true,
    validateInput: (value) => describeRepoRefProblem(value) ?? null,
  });
  if (!link) return;
  const ref = parseGithubRepoRef(link);
  if (!ref) return;

  /*
    **同じ作品のリンクなら、参加し直さずに受け取りへ案内する**（作者の答え 2026-11-05。0.127.6）。
    編集者（kmizu さん）が、作者の最新の原稿を受け取ろうとして「参加」を押し直し、迷った。
    編集者モードで参加している作品の送り先（origin）と比べ、同じなら取り寄せる前に止める。
    作者モードの環境の作品（自分の作品）は比べない——置き場の重なりは下の「すでに存在します」で止まる
  */
  if (mode === "editor") {
    const already = await findJoinedWork(registered, ref);
    if (already) {
      void vscode.window.showInformationMessage(
        `「${already.title}」には、もう編集者として参加しています。` +
          `作者の最新の原稿を受け取るには、編集者メニューの「${RECEIVE_STEP_LABEL}」を押してください。`
      );
      return { kind: "already", work: already };
    }
  }

  // 置き場。**訊かない**（既定の置き場の下の `編集部/<リポジトリ名>`）。
  // 既定が決められないときだけ選んでもらう
  let home = await defaultParentForNewFolder(registered);
  if (!home) {
    home = await pickNewFolderParent({
      purpose: "編集者の作品を置く場所を選択",
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
    `編集者として「${ref.owner}/${ref.repo}」に参加します。`,
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
    logFailure("編集者として参加（招待の受諾）", {
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
    `編集者の招待を${accepted.outcome === "accepted" ? "受けた" : "受け済みと確認"}: ` +
      `${ref.owner}/${ref.repo}`
  );

  const cloned = await cloneIntoPlace(token, ref, destination);
  if (!cloned.ok) {
    logFailure("編集者として参加（取り寄せ）", {
      リポジトリ: `${ref.owner}/${ref.repo}`,
      詳細: cloned.detail,
    });
    whenNoticePicked(
      vscode.window.showErrorMessage(
        `取り寄せられませんでした: ${cloned.detail}`,
        "ログを表示",
        "閉じる"
      ),
      async (action) => {
        if (action === "ログを表示") {
          await vscode.commands.executeCommand("novelai.showLog");
        }
      },
      { label: "編集者として参加" }
    );
    return;
  }

  // 題は、取り寄せた作品の config.json から。無ければリポジトリ名
  const title = await titleOf(destination, ref.repo);
  const entry = await registry.addExisting(destination, title);
  if (!entry) {
    // 登録の側が断った理由（重複など）は、登録簿が別に知らせている。
    // ここでは、取り寄せた場所が残っていることと、次の手を言う
    void vscode.window.showWarningMessage(
      "取り寄せは終わりましたが、作品として登録できませんでした。" +
        `取り寄せた場所は ${destination} です。登録の理由は直前の知らせを確かめ、` +
        "解決したら「フォルダから追加」で登録してください（編集者モードへは切り替えていません）。"
    );
    return;
  }

  // **登録のあとでモードを切り替える**（取り寄せに失敗したとき、作品の無い編集者モードを残さない）
  if (switching) await applyMode("editor");

  notifyDone(
    `「${entry.title}」に編集者として参加しました。` +
      "開いたときに、作者からの更新が自動で取り込まれます。"
  );
  return { kind: "joined", work: entry };
}

/** 鍵を覚えさせてから取り寄せる。通らなければ `gh` で取り寄せる */
async function cloneIntoPlace(
  token: string,
  ref: { owner: string; repo: string },
  destination: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // 鍵を覚えさせ、取り寄せる。**失敗したら途中のフォルダーを消す**（残ると次の回が
  // 「すでに存在します」で止まる。取り寄せる前にこの場所が無かったことは確かめてある）
  return withProgress("作品を取り寄せています…", () =>
    cloneWithCredential(token, cloneUrlOf(ref), destination)
  );
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
