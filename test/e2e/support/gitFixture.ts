/**
 * 作り物の作品フォルダーを、本物の git の置き場にする（設計書6.113）。
 *
 * **GitHub は呼ばない。** 送り先の無い置き場（`no_remote`）にして、記録（コミット）だけを試す。
 * 起こす前（`LaunchOptions.prepareWork`）に呼ぶ——起きている VS Code の下で
 * `.git` を作ると、同期の見張りが途中の形を読む。
 *
 * 利用者の `~/.gitconfig` に頼らない：この置き場だけに名前と宛先を書き、
 * 改行の自動変換も切る（本文の改行をテストが読み返すため）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 置き場で git を走らせる。失敗は投げる（準備が崩れたまま試験を進めない） */
export async function git(folder: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd: folder, windowsHide: true });
  return stdout;
}

/**
 * `folder` を git の置き場にして、いまある中身を最初の記録として残す。
 * 以後に足したもの・変えたものが「記録待ち」になる
 */
export async function initRepoWithFirstCommit(folder: string): Promise<void> {
  await git(folder, ["init", "--quiet", "--initial-branch=main"]);
  await git(folder, ["config", "user.name", "画面テスト"]);
  await git(folder, ["config", "user.email", "e2e@example.invalid"]);
  await git(folder, ["config", "core.autocrlf", "false"]);
  await git(folder, ["add", "-A"]);
  await git(folder, ["commit", "--quiet", "-m", "最初の記録"]);
}
