import * as vscode from "vscode";
import * as path from "../core/paths";
import type { GitCommandRunner } from "../core/git";
import {
  CACHE_UNIGNORE_RULE,
  IGNORED_PATHS,
  isEditorCopyFolder,
  ON_USE_IGNORED_PATHS,
} from "../core/workRegistry";
import { logStep, useLogFile } from "../core/logger";

/**
 * 編集者へ渡した写しで、拡張機能が自分で足した `.gitignore` の行を戻す
 * （編集者役の実機 2026-11-01。設計書5.7.5.9）。
 *
 * **起きたこと**：0.120.0 までは「編集者として参加」の登録の時点（まだ作者モード）で、
 * 写しの `.gitignore` に `.aiwriter/cache/` を足していた（作者の `novelai.git.syncCache: true`
 * が送った `!.aiwriter/cache/` を、編集者の既定が打ち消そうとした）。「校閲を終えて返す」は
 * `.aiwriter/` しか記録しないので、この変更は**永久に未記録のまま**残り、開いたときの点検が
 * 「未記録があるので取り込まない」（`planHandoff` の `dirty`）で止まり続け、作者の採否が
 * 編集者の手元へ入らなかった。0.120.2 からは写しの `.gitignore` を書かない（`isEditorCopyFolder`）。
 * ここは**すでに足してしまった写し**を立ち直らせる。
 *
 * **戻すのは、拡張機能が足した形と言い切れるときだけ。** 記録済みの中身（`HEAD`）の
 * 末尾に、拡張機能の除外の行だけが足されている。1行でも知らない差があれば触らない
 * （編集者が手で書いたかもしれない。理由は開いたときの点検が「記録していない変更」で知らせる）。
 */

/** 拡張機能が `.gitignore` へ足しうる行 */
function knownRules(): Set<string> {
  return new Set<string>([...IGNORED_PATHS, ...ON_USE_IGNORED_PATHS, CACHE_UNIGNORE_RULE]);
}

/**
 * 作業木の `.gitignore`（`current`）が、記録済みの中身（`head`）の末尾へ拡張機能の行を
 * 足しただけのものか。**純粋関数。**
 *
 * 改行の形（CRLF・LF）は問わない。`head` の末尾に改行が無いときも、足すときに
 * 改行を挟んでいるので同じに見る。足した行が1つも無ければ（差が無い）false。
 */
export function isOnlyAppendedIgnoreRules(
  head: string,
  current: string,
  rules: ReadonlySet<string> = knownRules()
): boolean {
  // 記録済みの中身は LF、作業木は CRLF ということがある（autocrlf）。揃えてから比べる
  const lf = (text: string): string => text.replace(/\r\n?/g, "\n");
  const base = lf(head);
  const now = lf(current);
  if (!now.startsWith(base)) return false;
  const added = now
    .slice(base.length)
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (added.length === 0) return false;
  return added.every((line) => rules.has(line));
}

export type GitignoreRescue =
  /** 写しではない・`.gitignore` に未記録の変更が無い・読めなかった */
  | "none"
  /** 拡張機能が足した行だけだったので、記録済みの中身へ戻した */
  | "restored"
  /** 知らない差があるので触らなかった */
  | "foreign";

/**
 * 写しの `.gitignore` を立ち直らせる。**例外は外へ出さない**（点検そのものを止めない）。
 *
 * @param root 置き場（リポジトリ）の根
 * @param workFolders その置き場にある作品フォルダー（写しかどうかは作品の印で見る）
 */
export async function rescueEditorGitignore(
  root: string,
  workFolders: readonly string[],
  run: GitCommandRunner
): Promise<GitignoreRescue> {
  try {
    let isCopy = false;
    for (const folder of workFolders) {
      if (await isEditorCopyFolder(folder)) {
        isCopy = true;
        break;
      }
    }
    if (!isCopy) return "none";

    // 作業木で変わっているかを先に見る（変わっていなければ、何も読まない）
    const status = await run(["status", "--porcelain", "--", ".gitignore"], root, 10_000);
    if (status.code !== 0 || !/^ M /m.test(status.stdout)) return "none";

    const head = await run(["show", "HEAD:.gitignore"], root, 10_000);
    if (head.code !== 0) return "none";
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(path.join(root, ".gitignore"))
    );
    const current = new TextDecoder().decode(bytes);
    if (!isOnlyAppendedIgnoreRules(head.stdout, current)) return "foreign";

    const restored = await run(["checkout", "--", ".gitignore"], root, 10_000);
    if (restored.code !== 0) return "none";
    // 記録の直前に書き先を写しの作品へ向ける（ほかの作品のログへ紛れさせない）
    useLogFile(root);
    logStep(
      "編集者へ渡した写しの .gitignore に拡張機能が足した行を戻しました" +
        "（記録されない変更が、取り込みを止めていたため）"
    );
    return "restored";
  } catch {
    return "none";
  }
}
