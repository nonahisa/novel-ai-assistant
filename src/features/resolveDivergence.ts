import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  fetchRemote,
  keepSideOfConflict,
  readSyncStatus,
  runGit,
  showStage,
  type GitCommandRunner,
} from "../core/git";
import { mergeProposalJsonl } from "../core/editingRepo";
import { commitAll, countTrackableFiles, hasCommitIdentity } from "../core/gitSetup";
import { buildSyncTarget, worksInside } from "../core/syncTarget";
import {
  describeMergePreview,
  mergeTreeArgs,
  parseMergeTree,
  type MergePreview,
} from "../core/mergePreview";
import { classifyConflicts } from "../core/divergenceScan";
import { decideSettingsConflict } from "../core/settingsConflictRule";
import {
  containsConflictMarkers,
  describeGuardFailure,
  guardResult,
  unexpectedChanges,
} from "../core/mergeGuard";
import { sha256Bytes } from "../core/hash";
import {
  logFailure,
  logStep,
  showLog,
  useLogFile,
} from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import type { WalkConflictsResult } from "./resolveConflicts";

/**
 * 分岐したときに、畳めるものは畳む（設計書5.5.16／5.5.18）。
 *
 * 作者の指示（2026-08-26）：「重なっていないなら、マージは自動で行ってください」。
 * 作者の指示（2026-09-10）：「設定資料ファイルは作者が書き換えた部分が変わって
 * いなければ、時系列的に新しいほうに自動で合わせてください。本文も同じ個所の
 * 衝突がなければ、自動で合流させる」「別れた分をあわせるは何のためにある
 * 処理ですか？もう少し手軽にできないですか」。
 *
 * ## これまでは行き止まりだった
 *
 * 別のPCとこちらの両方で書き進めると分岐する。取り込みは早送りできるときだけ
 * 行う決まりなので（5.5.1）、拡張機能は
 * 「Gitのクライアントで見比べてから解決してください」としか言えなかった。
 * **プログラマでない作者に、それは手渡せる道ではない。**
 *
 * 5.5.16で「分かれた分を合わせる」を足したが、**作者のものが1件でも衝突したら
 * 畳まない**という決まりのため、実際の置き場では毎回そこで止まっていた。
 * 作者の言葉では「競合がぜんぜん消えません」。**安全側の設計が、そのまま
 * 行き止まりになっていた。**
 *
 * ## いまの決まり（5.5.18）
 *
 * 1. **自動生成物** → この端末の側を残す（作り直せるもの）
 * 1'. **追記型**（履歴・提案・ロック） → **両方の行を残す**。
 *    行が混ざっただけなので、どちらかを選ぶ必要が無い（`core/editHistory.ts`）
 * 2. **設定資料のJSON** → `core/settingsConflictRule.ts` の規則で決める
 *    （作者が書いた部分が同じなら、時系列で新しいほうへ）
 * 3. **決まらなかった設定資料と、本文** → 作者に1件ずつ選んでもらう。
 *    **同じ箇所を両方で書き換えたものだけ**がここに来る（別の箇所は
 *    gitが合流済み）
 *
 * ## 畳む前後で守ること（5.5.16から変えない）
 *
 * 1. **未記録の変更を先に記録する**（汚れているとマージを始められない）
 * 2. **退避の枝を作る**（確定したあとに戻したくなることがある）
 * 3. `--no-commit` で畳み、**確定する前に検査する**
 * 4. 検査：競合マーカーが残っていないか／**取り込んでいないファイルが
 *    変わっていないか**（`core.autocrlf` が効く経路。目では気づけない）
 * 5. 1つでも落ちたら `merge --abort` で戻す
 *
 * **送信はこの関数からはしない。** 同期の中から呼ばれたときは、合流のあとに
 * 呼び出し側が送信の手順へ進む（5.5.1の「外へ出る操作は作者の操作を起点に」は
 * 同期のボタンが起点になっているので守られている）。
 */

export interface ResolveDivergenceDeps {
  registry: WorkRegistry;
  run?: GitCommandRunner;
  /** 済んだあとに状態表示を作り直す */
  monitor?: { refreshAll(options: { fetch: boolean }): Promise<void> };
}

/** 指紋を取る対象。**作者が書くもの**だけを見る */
const WATCHED_EXTENSIONS = [".txt", ".md", ".json", ".jsonl"];

/**
 * 記録の書き先を、その置き場の作品のログへ向ける（0.45.0）。
 *
 * **合わせる相手は「置き場」であって作品ではない。** 1つのリポジトリに
 * 複数の作品が入る（設計書5.7.9）ので、代表として先頭の作品のログへ書く。
 * 登録済みの作品が無い置き場では向けない（書き先が無い）。
 *
 * この先で呼ぶ `reportFold` は置き場しか受け取らないが、ここを通ったあとの
 * 書き先をそのまま使うので、向け直す必要はない。
 */
function useRootLog(deps: ResolveDivergenceDeps, root: string): void {
  const work = worksInside(deps.registry.list(), root)[0];
  if (work) useLogFile(work.folderPath);
}

/** 合わせる相手の置き場 */
export interface FoldTarget {
  root: string;
  label: string;
  upstream: string;
}

/** 規則で決めた1件 */
export interface SettingsResolution {
  file: string;
  side: "ours" | "theirs";
  reason: string;
}

export type FoldOutcome =
  | {
      ok: true;
      /** 退避の枝の名前 */
      backup: string;
      /** 取り込んだファイル数 */
      incoming: number;
      /** 規則で揃えた設定資料 */
      settingsAutoResolved: SettingsResolution[];
      /**
       * 見比べの入口で「全部、新しいほうを採る」を押して片づいた設定資料の件数。
       *
       * **作者が1件ずつ選んだ分と混ぜない**（2026-09-11）。混ぜると、
       * 13件を一括で寄せただけなのに「お選びいただきました」と知らせてしまう
       */
      settingsBulkResolved: number;
      /** 作者が1件ずつ選んだファイル */
      manuscriptConflicts: string[];
    }
  | { ok: false; reason: string; authored?: string[] };

/**
 * 作者が1件ずつ選ぶところ。
 *
 * **差し替えられる形にしてある。** 本物のgitで規則の分岐を確かめるには、
 * 画面を出さずに答えを決められる必要がある（試験でしか使わない）。
 */
export type ConflictWalker = (input: {
  root: string;
  label: string;
  files: string[];
  run: GitCommandRunner;
}) => Promise<WalkConflictsResult>;

export interface FoldOptions {
  progress?: { report(value: { message?: string }): void };
  walk?: ConflictWalker;
}

export async function resolveDivergence(
  deps: ResolveDivergenceDeps,
  work?: WorkEntry
): Promise<void> {
  const run = deps.run ?? runGit;
  const target = await pickTarget(deps, work, run);
  if (!target) return;

  const { root, label } = target;
  useRootLog(deps, root);

  const outcome = await withCancellableProgress(
    "分かれた分を調べています…",
    async (progress, token) => {
      progress.report({ message: "GitHubの分を取りに行っています…" });
      await fetchRemote(root, run);
      if (token.isCancellationRequested) return undefined;

      const status = await readSyncStatus(root, run);
      if (status.kind !== "tracked") return { kind: "not_tracked" as const };
      if (status.ahead === 0 || status.behind === 0) {
        return { kind: "not_diverged" as const };
      }

      progress.report({ message: "合わせられるかを調べています…" });
      const preview = parseMergeTree(
        await run(mergeTreeArgs("HEAD", status.upstream), root, 60_000)
      );
      return { kind: "ready" as const, status, preview };
    }
  );
  if (!outcome) return;

  if (outcome.kind === "not_tracked") {
    void vscode.window.showInformationMessage(
      `${label} は、GitHubとつながっていません。`
    );
    return;
  }
  if (outcome.kind === "not_diverged") {
    void vscode.window.showInformationMessage(
      `${label} は分かれていません。「同期」でそのまま取り込めます。`
    );
    return;
  }

  const { status, preview } = outcome;
  if (preview.kind === "unsupported" || preview.kind === "failed") {
    void vscode.window.showWarningMessage(describeMergePreview(preview));
    logFailure("分岐の判定に失敗", { 置き場: label, 詳細: preview.detail ?? "" });
    return;
  }

  // **作者のものが衝突していても、もう行き止まりにしない**（設計書5.5.18）。
  // 何が起きるかを先に見せ、押されたら1件ずつ選んでもらう
  if (!(await confirm(label, status.behind, status.ahead, preview))) return;

  const result = await withCancellableProgress(
    "分かれた分を合わせています…",
    async (progress) =>
      foldDivergence(
        deps,
        { root, label, upstream: status.upstream },
        { progress }
      )
  );
  if (!result) return;

  await reportFold(deps, label, result, { sending: false });
}

/** どの置き場を畳むか。作品が指定されなければ、登録の先頭から根をたどる */
async function pickTarget(
  deps: ResolveDivergenceDeps,
  work: WorkEntry | undefined,
  run: GitCommandRunner
): Promise<{ root: string; label: string } | undefined> {
  const works = deps.registry.list();
  if (works.length === 0) {
    void vscode.window.showInformationMessage("登録されている作品がありません。");
    return undefined;
  }

  const chosen = work ?? works[0];
  const status = await readSyncStatus(chosen.folderPath, run);
  const root = "root" in status && status.root ? status.root : chosen.folderPath;
  return { root, label: buildSyncTarget(root, works).label };
}

/**
 * 押す前に見せる文面を組む。
 *
 * **画面から切り離してある**——出るかどうかは実機でしか見られないが、
 * 「取り込む件数」「こちらに残る件数」「作者が選ぶ件数」が本当に入って
 * いるかは、ここだけを呼べば機械で確かめられる。
 */
export function describeDivergenceConfirm(input: {
  label: string;
  behind: number;
  ahead: number;
  autoWritten: number;
  /** 追記型（履歴・提案・ロック）の件数。**両方の行を残す** */
  appendOnly?: number;
  /** 規則で揃える見込みの設定資料の件数 */
  settings?: number;
  /** 作者が1件ずつ選ぶことになる本文の件数 */
  manuscripts?: number;
}): { message: string; detail: string } {
  const lines = [
    `・GitHubの側にある${input.behind}件を取り込みます`,
    `・こちらの${input.ahead}件はそのまま残ります`,
  ];
  if (input.autoWritten > 0) {
    lines.push(
      `・食い違う${input.autoWritten}件（自動で書かれるもの）は、この端末の側を残します`
    );
  }
  if (input.appendOnly && input.appendOnly > 0) {
    lines.push(
      `・追記型${input.appendOnly}件（履歴・提案・ロック）は、両方の行を残します`
    );
  }
  if (input.settings && input.settings > 0) {
    lines.push(
      `・食い違う設定資料${input.settings}件は、` +
        "作者が書いた部分が同じなら新しいほうへ揃えます"
    );
  }
  if (input.manuscripts && input.manuscripts > 0) {
    lines.push(
      `・同じ箇所を両方で書き換えた本文${input.manuscripts}件は、1件ずつお選びいただきます`
    );
  }
  lines.push("・合わせる前に、未記録の変更を記録します");
  lines.push("・戻せるように、退避の枝を作ります");

  return {
    message: `${input.label} の分かれた分を合わせます。`,
    detail:
      `${lines.join("\n")}\n\n` +
      "GitHubへは送信しません。送信は「同期」から改めて行ってください。",
  };
}

/** 押す前に、何が起きるかを見せる */
async function confirm(
  label: string,
  behind: number,
  ahead: number,
  preview: MergePreview
): Promise<boolean> {
  const classified = classifyConflicts(preview.conflicts);
  const text = describeDivergenceConfirm({
    label,
    behind,
    ahead,
    autoWritten: classified.autoWritten.length,
    appendOnly: classified.appendOnly.length,
    settings: classified.settings.length,
    manuscripts: classified.manuscripts.length,
  });
  const answer = await vscode.window.showInformationMessage(
    text.message,
    { modal: true, detail: text.detail },
    "合わせる"
  );
  return answer === "合わせる";
}

/**
 * 実際に畳む。**検査に1つでも落ちたら戻す**
 *
 * **画面の確認は挟まない。** 同期の流れの中から呼ぶためである
 * （作者の指示、2026-09-10：「もう少し手軽にできないですか」）。
 * 作者に選んでもらうところ（`walk`）だけは、性質上どうしても画面が要る。
 */
export async function foldDivergence(
  deps: ResolveDivergenceDeps,
  target: FoldTarget,
  options: FoldOptions = {}
): Promise<FoldOutcome> {
  const run = deps.run ?? runGit;
  const { root, label, upstream } = target;
  useRootLog(deps, root);
  const report = (message: string) => options.progress?.report({ message });

  report("退避の枝を作っています…");
  const backup = backupBranchName();
  const branched = await run(["branch", backup], root, 15_000);
  if (branched.code !== 0) {
    return {
      ok: false,
      reason: `退避の枝を作れませんでした: ${branched.stderr.trim()}`,
    };
  }

  report("未記録の変更を記録しています…");
  const pending = await countTrackableFiles(root, run);
  if (pending > 0) {
    if (!(await hasCommitIdentity(root, run))) {
      return {
        ok: false,
        reason:
          "記録する人の名前が未設定です。「GitHubと同期」から一度設定してください。",
      };
    }
    const committed = await commitAll(
      root,
      `合わせる前の自動保存（${pending}件）`,
      run
    );
    if (!committed.ok) {
      return {
        ok: false,
        reason: `記録できませんでした: ${committed.detail ?? ""}`,
      };
    }
  }

  report("原稿の指紋を控えています…");
  const before = await fingerprints(root, run);

  report("合わせています…");
  // **確定させずに畳む。** 検査に落ちたときに戻せるようにするため
  const merged = await run(
    ["merge", "--no-commit", "--no-ff", upstream],
    root,
    120_000
  );

  // 規則で戻したファイル。**触ってよい側に数える**——
  // gitが書き戻すときに改行の自動変換が入るため、中身が同じでも
  // バイトは変わりうる（実際に試験で捕まえた）
  const resolved: string[] = [];
  const settingsAutoResolved: SettingsResolution[] = [];
  let manuscriptConflicts: string[] = [];
  let settingsBulkResolved = 0;

  const unresolved = await unmergedFiles(root, run);
  if (unresolved.length === 0 && merged.code !== 0) {
    await run(["merge", "--abort"], root, 15_000);
    return {
      ok: false,
      reason: `合わせられませんでした: ${(merged.stderr || merged.stdout).trim()}`,
    };
  }

  if (unresolved.length > 0) {
    report("食い違いを片づけています…");
    const classified = classifyConflicts(unresolved);

    // 1. 自動で書かれるもの。**作り直せるので、この端末の側を残す**
    for (const file of classified.autoWritten) {
      if (!(await keepSideOfConflict(root, file, "ours", run))) {
        return await abort(root, run, `${file} を確定できませんでした`);
      }
      resolved.push(file);
    }

    // 1'. 追記型（履歴・提案・ロック）。**どちらも捨てず、両方の行を残す**。
    // 片側を残すと、もう片方の環境で書かれた記録がそこで消える
    // （`core/editHistory.ts`）。作者に訊いても答えは「両方」しか無い
    for (const file of classified.appendOnly) {
      if (!(await mergeAppendOnly(root, file, run))) {
        return await abort(root, run, `${file} の行を混ぜられませんでした`);
      }
      resolved.push(file);
    }
    if (classified.appendOnly.length > 0) {
      logStep(
        `追記型の記録 ${classified.appendOnly.length}件は、両方の行を残しました`
      );
    }

    // 2. 設定資料のJSON。規則で決める（設計書5.5.18）
    const undecided: string[] = [];
    for (const file of classified.settings) {
      const decision = await decideForFile(root, file, run);
      if (decision.side === "conflict") {
        undecided.push(file);
        continue;
      }
      if (!(await keepSideOfConflict(root, file, decision.side, run))) {
        return await abort(root, run, `${file} を確定できませんでした`);
      }
      resolved.push(file);
      settingsAutoResolved.push({
        file,
        side: decision.side,
        reason: decision.reason,
      });
      // **黙って片方へ寄せたことにしない。** どちらを採ったかを1行ずつ残す
      logStep(
        `設定資料の衝突：${file} → ` +
          `${decision.side === "ours" ? "こちら" : "別環境"}（${decision.reason}）`
      );
    }

    // 3. 残りは作者が選ぶ。**同じ箇所を両方で書き換えたものだけ**が来る
    const forAuthor = [...undecided, ...classified.manuscripts];
    if (forAuthor.length > 0) {
      const walk = options.walk ?? defaultWalk;
      let walked: WalkConflictsResult;
      try {
        walked = await walk({ root, label, files: forAuthor, run });
      } catch (error) {
        return await abort(
          root,
          run,
          `見比べの途中で問題が起きました: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (walked.aborted) {
        await run(["merge", "--abort"], root, 15_000);
        return {
          ok: false,
          reason: describeAuthoredStop(forAuthor),
          authored: forAuthor,
        };
      }
      // 検査の白紙は「触ってよい側」なので、**一括で寄せた分もここへ足す**。
      // 落とすと、gitが書き戻したときの改行の違いだけで検査が落ちる
      resolved.push(...walked.resolved, ...walked.bulkResolved);
      manuscriptConflicts = [...walked.resolved];
      settingsBulkResolved = walked.bulkResolved.length;
    }

    // 選び終わっても未解決が残っているなら、こちらの読み違いである。
    // **中途半端に確定した状態で記録しない**
    const left = await unmergedFiles(root, run);
    if (left.length > 0) {
      return await abort(
        root,
        run,
        `まだ解決できていないファイルが残っています：${left.slice(0, 3).join("、")}`
      );
    }
  }

  report("取り込んだ中身を確かめています…");
  const incoming = await stagedFiles(root, run);
  const markers = await filesWithMarkers(root, incoming);
  const after = await fingerprints(root, run);
  const guard = guardResult(
    markers,
    unexpectedChanges(before, after, [...incoming, ...resolved])
  );

  if (!guard.ok) {
    await run(["merge", "--abort"], root, 15_000);
    return {
      ok: false,
      reason:
        "合わせた中身が検査に通らなかったため、元に戻しました。\n" +
        describeGuardFailure(guard),
    };
  }

  report("記録しています…");
  const committed = await run(["commit", "--no-edit"], root, 60_000);
  if (committed.code !== 0) {
    return {
      ok: false,
      reason: `合わせた分を記録できませんでした: ${(
        committed.stderr || committed.stdout
      ).trim()}`,
    };
  }

  await deps.monitor?.refreshAll({ fetch: false });
  return {
    ok: true,
    backup,
    incoming: incoming.length,
    settingsAutoResolved,
    settingsBulkResolved,
    manuscriptConflicts,
  };
}

/** 既定の見比べ。**画面が要るので、使うときだけ読み込む** */
const defaultWalk: ConflictWalker = async ({ root, label, files, run }) => {
  const { walkConflicts } = await import("./resolveConflicts.js");
  return walkConflicts(
    { id: root, title: label, folderPath: root },
    files,
    { run }
  );
};

/** 索引の3つの版を読んで、どちらを残すか決める */
async function decideForFile(
  root: string,
  file: string,
  run: GitCommandRunner
): Promise<{ side: "ours" | "theirs" | "conflict"; reason: string }> {
  const base = await showStage(root, file, 1, run);
  const ours = await showStage(root, file, 2, run);
  const theirs = await showStage(root, file, 3, run);
  if (ours === undefined || theirs === undefined) {
    // 片方にしか無い（追加と削除がぶつかった）。**中身を比べられない**
    return {
      side: "conflict",
      reason: "片方の版がありません",
    };
  }
  return decideSettingsConflict({ base, ours, theirs });
}

/**
 * 追記型の記録を、**両方の行を残す形**で確定させる。
 *
 * 1行1件の追記しかしないので、分岐で起きるのは「行が混ざった」だけである
 * （`core/editHistory.ts`）。混ぜるのは `mergeProposalJsonl`——提案を混ぜる
 * のに既に使っている純粋関数で、同じ行は `lineKey` で1つに畳み、gitが
 * 残した競合マーカーの行は落とす。**写しを作らずに、そちらへ任せる。**
 *
 * ここだけは `atomicWriteFile` を通さない。索引から書き戻すのではなく
 * **その場で組んだ中身を置く**ので、gitに任せる経路が無い。相手は
 * `.aiwriter/` の下の機械の記録であって原稿ではないため、
 * `writeTextFilePreservingFormat`（退避→新規作成）の対象でもない。
 * 巻き戻したいときは、この関数の外側の `merge --abort` と退避の枝が効く。
 */
async function mergeAppendOnly(
  root: string,
  file: string,
  run: GitCommandRunner
): Promise<boolean> {
  const ours = await showStage(root, file, 2, run);
  const theirs = await showStage(root, file, 3, run);
  // 片方にしか無い（追加と削除がぶつかった）。**消さずに、ある側を残す**
  const text =
    ours !== undefined && theirs !== undefined
      ? mergeProposalJsonl(ours, theirs).text
      : ours ?? theirs;
  if (text === undefined) return false;

  try {
    await vscode.workspace.fs.writeFile(
      paths.toUri(paths.join(root, file)),
      new TextEncoder().encode(text)
    );
  } catch (error) {
    logFailure("追記型の記録を混ぜられなかった", {
      ファイル: file,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  const added = await run(["add", "--", file], root, 15_000);
  return added.code === 0;
}

/** 途中でやめる。**原稿を元へ戻してから理由を返す** */
async function abort(
  root: string,
  run: GitCommandRunner,
  reason: string
): Promise<FoldOutcome> {
  await run(["merge", "--abort"], root, 15_000);
  return { ok: false, reason: `${reason}。元に戻しました。` };
}

/**
 * 作者が選ばずにやめたときの知らせ。
 *
 * **次にどうすれば続きへ行けるかまで書く。** 「戻しました」だけだと、
 * 作者は同じところへ戻ってくる道を持たない。
 */
export function describeAuthoredStop(files: readonly string[]): string {
  const listed = files.slice(0, 5).map((file) => baseNameOf(file));
  const more = files.length > 5 ? `、ほか${files.length - 5}件` : "";
  return (
    `本文と設定資料の ${files.length} 件が、同じ箇所で衝突しています` +
    `（${listed.join("、")}${more}）。` +
    "選ばれなかったので、元の状態へ戻しました。" +
    "もう一度同期すると、続きから選べます。"
  );
}

/**
 * 合わせた結果の知らせ（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：「競合解決があるかないかわからない。件数が出ない」。
 * **何件をどう片づけたかを、必ず数字で出す。**
 *
 * **一括で寄せた分と、1件ずつ選んだ分は分けて言う**（2026-09-11）。
 * 13件を「全部、新しいほうを採る」で片づけたのに
 * 「お選びいただきました」と出ていた。**やっていないことを、やったと言わない。**
 */
export function describeFoldSuccess(
  label: string,
  result: Extract<FoldOutcome, { ok: true }>,
  options: { sending: boolean } = { sending: false }
): string {
  const parts = [`取り込み ${result.incoming}件`];
  if (result.settingsAutoResolved.length > 0) {
    const theirs = result.settingsAutoResolved.filter(
      (one) => one.side === "theirs"
    ).length;
    const ours = result.settingsAutoResolved.length - theirs;
    parts.push(
      `設定資料 ${result.settingsAutoResolved.length}件は新しいほうに揃えました` +
        `（別環境 ${theirs}件・こちら ${ours}件）`
    );
  }
  if (result.settingsBulkResolved > 0) {
    parts.push(`設定資料 ${result.settingsBulkResolved}件は、まとめて新しいほうを採りました`);
  }
  if (result.manuscriptConflicts.length > 0) {
    parts.push(`本文など ${result.manuscriptConflicts.length}件はお選びいただきました`);
  }
  return (
    `${label} で別の環境の変更を合わせました（${parts.join("／")}）。` +
    `戻したいときは枝「${result.backup}」から戻せます。` +
    (options.sending ? "続けて送信します。" : "GitHubへ出すには「同期」で送信してください。")
  );
}

/** 済んだあとの知らせ（「分かれた分を合わせる」から呼ぶとき） */
async function reportFold(
  deps: ResolveDivergenceDeps,
  label: string,
  result: FoldOutcome,
  options: { sending: boolean }
): Promise<void> {
  if (!result.ok) {
    logFailure("分岐を合わせられなかった", { 置き場: label, 詳細: result.reason });
    const action = await vscode.window.showErrorMessage(
      `${label} の分かれた分を合わせられませんでした。`,
      { modal: true, detail: `${result.reason}\n\n原稿は元のままです。` },
      "ログを表示"
    );
    if (action === "ログを表示") showLog();
    return;
  }

  logStep(
    `分岐を合わせた（${label}／取り込み ${result.incoming}件` +
      `／設定資料 ${result.settingsAutoResolved.length}件` +
      `／一括で新しいほう ${result.settingsBulkResolved}件` +
      `／作者が選んだ ${result.manuscriptConflicts.length}件）`
  );
  await deps.monitor?.refreshAll({ fetch: false });
  void vscode.window.showInformationMessage(
    describeFoldSuccess(label, result, options)
  );
}

/** 退避の枝の名前。**日付で分かるようにする** */
function backupBranchName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `backup/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-合わせる前`
  );
}

/** まだ解決していないファイル */
async function unmergedFiles(
  root: string,
  run: GitCommandRunner
): Promise<string[]> {
  const result = await run(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    root,
    15_000
  );
  if (result.code !== 0) return [];
  return [
    ...new Set(result.stdout.split("\u0000").filter((name) => name !== "")),
  ];
}

/** 畳んだ結果として入ったファイル */
async function stagedFiles(
  root: string,
  run: GitCommandRunner
): Promise<string[]> {
  const result = await run(
    ["diff", "--cached", "--name-only", "-z"],
    root,
    30_000
  );
  if (result.code !== 0) return [];
  return result.stdout.split("\u0000").filter((name) => name !== "");
}

/**
 * 追跡している文章ファイルの指紋。
 *
 * **中身をそのまま読んで数える。** gitに聞くと改行の自動変換が入った後の姿を
 * 答えるので、**まさに確かめたい変化が見えなくなる**。
 */
async function fingerprints(
  root: string,
  run: GitCommandRunner
): Promise<Map<string, string>> {
  const listed = await run(["ls-files", "-z"], root, 30_000);
  const files = listed.stdout
    .split("\u0000")
    .filter((name) => name !== "")
    .filter((name) =>
      WATCHED_EXTENSIONS.some((extension) =>
        name.toLowerCase().endsWith(extension)
      )
    );

  const map = new Map<string, string>();
  for (const file of files) {
    const bytes = await readBytes(paths.join(root, file));
    if (bytes) map.set(file, sha256Bytes(bytes));
  }
  return map;
}

/** 競合マーカーが残っているファイル */
async function filesWithMarkers(
  root: string,
  files: readonly string[]
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    const bytes = await readBytes(paths.join(root, file));
    if (!bytes) continue;
    // 判定に要るのは行頭の記号だけなので、読めない文字は捨てて構わない
    if (containsConflictMarkers(new TextDecoder().decode(bytes))) found.push(file);
  }
  return found;
}

async function readBytes(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(paths.toUri(filePath));
  } catch {
    // 消えたファイルは「指紋なし」として扱う。`unexpectedChanges` が拾う
    return undefined;
  }
}

/** ファイル名だけを取り出す。**gitは常に `/` 区切りで返す** */
function baseNameOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

