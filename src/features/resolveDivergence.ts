import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  fetchRemote,
  readSyncStatus,
  runGit,
  type GitCommandRunner,
} from "../core/git";
import { commitAll, countTrackableFiles, hasCommitIdentity } from "../core/gitSetup";
import { buildSyncTarget } from "../core/syncTarget";
import {
  canFoldAutomatically,
  describeMergePreview,
  mergeTreeArgs,
  parseMergeTree,
  type MergePreview,
} from "../core/mergePreview";
import {
  containsConflictMarkers,
  describeGuardFailure,
  guardResult,
  unexpectedChanges,
} from "../core/mergeGuard";
import { sha256Bytes } from "../core/hash";
import { logFailure, logStep, showLog } from "../core/logger";
import { withCancellableProgress } from "../views/progress";

/**
 * 分岐したときに、畳めるものは畳む（設計書5.5.16）。
 *
 * 作者の指示（2026-08-26）：「重なっていないなら、マージは自動で行ってください」。
 *
 * ## これまでは行き止まりだった
 *
 * 別のPCとこちらの両方で書き進めると分岐する。取り込みは早送りできるときだけ
 * 行う決まりなので（5.5.1）、拡張機能は
 * 「Gitのクライアントで見比べてから解決してください」としか言えなかった。
 * **プログラマでない作者に、それは手渡せる道ではない。**
 *
 * ## 判定は名前ではなく、gitが畳めるかで行う
 *
 * 作者の置き場で実際に起きた分岐では、**重なった6件のうち5件は中身まで同じ**
 * （両方の環境で同じ原稿を取り込んだ）で、衝突したのは自動生成の1件だけだった。
 * **名前の重なりで見ていたら、畳める分岐が行き止まりになっていた。**
 *
 * ## 畳む前後で守ること
 *
 * 1. **未記録の変更を先に記録する**（汚れているとマージを始められない）
 * 2. **退避の枝を作る**（確定したあとに戻したくなることがある）
 * 3. `--no-commit` で畳み、**確定する前に検査する**
 * 4. 検査：競合マーカーが残っていないか／**取り込んでいないファイルが
 *    変わっていないか**（`core.autocrlf` が効く経路。目では気づけない）
 * 5. 1つでも落ちたら `merge --abort` で戻す
 *
 * **送信はしない。** 外へ出る操作は作者の操作のままにする（5.5.1）。
 */

export interface ResolveDivergenceDeps {
  registry: WorkRegistry;
  run?: GitCommandRunner;
  /** 済んだあとに状態表示を作り直す */
  monitor?: { refreshAll(options: { fetch: boolean }): Promise<void> };
}

/** 指紋を取る対象。**作者が書くもの**だけを見る */
const WATCHED_EXTENSIONS = [".txt", ".md", ".json", ".jsonl"];

export async function resolveDivergence(
  deps: ResolveDivergenceDeps,
  work?: WorkEntry
): Promise<void> {
  const run = deps.run ?? runGit;
  const target = await pickTarget(deps, work, run);
  if (!target) return;

  const { root, label } = target;

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

  // **作者のものが1件でも衝突していたら、機械は決めない**（設計書5.5.4）
  if (!canFoldAutomatically(preview)) {
    await reportAuthoredConflicts(label, preview);
    return;
  }

  if (!(await confirm(label, status.behind, status.ahead, preview))) return;

  await fold(deps, { root, label, upstream: status.upstream }, preview, run);
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

/** 作者のものが衝突しているときは、何が衝突したかを見せて手を引く */
async function reportAuthoredConflicts(
  label: string,
  preview: MergePreview
): Promise<void> {
  const listed = preview.authored.slice(0, 8).join("\n");
  const more =
    preview.authored.length > 8 ? `\nほか${preview.authored.length - 8}件` : "";
  const action = await vscode.window.showWarningMessage(
    `${label} は、同じファイルが両方で書き換えられています。`,
    {
      modal: true,
      detail:
        `${listed}${more}\n\n` +
        "どちらを残すかは、書いたご本人にしか分かりません。" +
        "こちらでは合わせません。" +
        "Gitのクライアントか「競合を解決する」で、1つずつお選びください。",
    },
    "ログを表示"
  );
  if (action === "ログを表示") showLog();
  logStep(`分岐：作者のものが衝突（${label}／${preview.authored.length}件）`);
}

/** 押す前に、何が起きるかを見せる */
async function confirm(
  label: string,
  behind: number,
  ahead: number,
  preview: MergePreview
): Promise<boolean> {
  const folding =
    preview.autoWritten.length > 0
      ? `\n・食い違う${preview.autoWritten.length}件（自動で書かれるもの）は、この端末の側を残します`
      : "";
  const answer = await vscode.window.showInformationMessage(
    `${label} の分かれた分を合わせます。`,
    {
      modal: true,
      detail:
        `・GitHubの側にある${behind}件を取り込みます\n` +
        `・こちらの${ahead}件はそのまま残ります${folding}\n` +
        "・合わせる前に、未記録の変更を記録します\n" +
        "・戻せるように、退避の枝を作ります\n\n" +
        "GitHubへは送信しません。送信は「同期」から改めて行ってください。",
    },
    "合わせる"
  );
  return answer === "合わせる";
}

/** 実際に畳む。**検査に1つでも落ちたら戻す** */
async function fold(
  deps: ResolveDivergenceDeps,
  target: { root: string; label: string; upstream: string },
  preview: MergePreview,
  run: GitCommandRunner
): Promise<void> {
  const { root, label, upstream } = target;

  const result = await withCancellableProgress(
    "分かれた分を合わせています…",
    async (progress) => {
      progress.report({ message: "退避の枝を作っています…" });
      const backup = backupBranchName();
      const branched = await run(["branch", backup], root, 15_000);
      if (branched.code !== 0) {
        return {
          ok: false as const,
          reason: `退避の枝を作れませんでした: ${branched.stderr.trim()}`,
        };
      }

      progress.report({ message: "未記録の変更を記録しています…" });
      const pending = await countTrackableFiles(root, run);
      if (pending > 0) {
        if (!(await hasCommitIdentity(root, run))) {
          return {
            ok: false as const,
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
            ok: false as const,
            reason: `記録できませんでした: ${committed.detail ?? ""}`,
          };
        }
      }

      progress.report({ message: "原稿の指紋を控えています…" });
      const before = await fingerprints(root, run);

      progress.report({ message: "合わせています…" });
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
      const unresolved = await unmergedFiles(root, run);
      if (unresolved.length > 0) {
        // 調べたときと同じ顔ぶれなら、規則で畳む。
        // **1件でも作者のものが混ざっていたら、そこでやめる**
        const authored = unresolved.filter(
          (file) => !preview.autoWritten.includes(file)
        );
        if (authored.length > 0) {
          await run(["merge", "--abort"], root, 15_000);
          return {
            ok: false as const,
            reason:
              "調べたときには無かった食い違いが出たため、元に戻しました：" +
              authored.slice(0, 3).join("、"),
          };
        }
        for (const file of unresolved) {
          await run(["checkout", "--ours", "--", file], root, 15_000);
          await run(["add", "--", file], root, 15_000);
          resolved.push(file);
        }
      } else if (merged.code !== 0) {
        await run(["merge", "--abort"], root, 15_000);
        return {
          ok: false as const,
          reason: `合わせられませんでした: ${(merged.stderr || merged.stdout).trim()}`,
        };
      }

      progress.report({ message: "取り込んだ中身を確かめています…" });
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
          ok: false as const,
          reason:
            "合わせた中身が検査に通らなかったため、元に戻しました。\n" +
            describeGuardFailure(guard),
        };
      }

      progress.report({ message: "記録しています…" });
      const committed = await run(["commit", "--no-edit"], root, 60_000);
      if (committed.code !== 0) {
        return {
          ok: false as const,
          reason: `合わせた分を記録できませんでした: ${(
            committed.stderr || committed.stdout
          ).trim()}`,
        };
      }

      return { ok: true as const, backup, incoming: incoming.length };
    }
  );
  if (!result) return;

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

  logStep(`分岐を合わせた（${label}／取り込み ${result.incoming}件）`);
  await deps.monitor?.refreshAll({ fetch: false });
  void vscode.window.showInformationMessage(
    `${label} の分かれた分を合わせました（${result.incoming}件を取り込みました）。` +
      `戻したいときは枝「${result.backup}」から戻せます。` +
      "GitHubへ出すには「同期」で送信してください。"
  );
}

/** 退避の枝の名前。**日付で分かるようにする** */
function backupBranchName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `backup/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}-合わせる前`
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
  return [...new Set(result.stdout.split("\0").filter((name) => name !== ""))];
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
  return result.stdout.split("\0").filter((name) => name !== "");
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
    .split("\0")
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
