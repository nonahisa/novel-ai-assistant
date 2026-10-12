/**
 * 作り物の作品フォルダーを、本物の git の置き場にする（設計書6.113）。
 *
 * **GitHub は呼ばない。** 送り先の無い置き場（`no_remote`）にして記録（コミット）だけを試すか、
 * **同じ一時フォルダーの中に裸の置き場（`git init --bare`）を作って送り先にする**
 * （`addLocalRemote`。送信・取り込みは手元のフォルダーどうしで済み、ネットワークへ出ない）。
 * 起こす前（`LaunchOptions.prepareWork`）に呼ぶ——起きている VS Code の下で
 * `.git` を作ると、同期の見張りが途中の形を読む。
 *
 * 利用者の `~/.gitconfig` に頼らない：この置き場だけに名前と宛先を書き、
 * 改行の自動変換も切る（本文の改行をテストが読み返すため）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAutoWrittenLine } from "../../../src/core/git";

const run = promisify(execFile);

/** 置き場で git を走らせる。失敗は投げる（準備が崩れたまま試験を進めない） */
export async function git(folder: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd: folder, windowsHide: true });
  return stdout;
}

/**
 * VS Code が起きている間に git を走らせる（記録・送信の準備や、状態の読み取り）。
 *
 * **製品の見張りも同じ置き場で git を走らせている**ので、`index.lock` の取り合いで一瞬だけ
 * 失敗することがある。少し待って5回まで試し、それでも駄目なら最後の失敗を投げる
 */
export async function gitWhileRunning(folder: string, args: readonly string[]): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await git(folder, args);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
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

/**
 * 手元の裸の置き場 `remoteFolder` を作り、`folder` の送り先（origin）にして、いまの main を送る。
 * 送ったあとは上流が決まった置き場（製品の `tracked`）になり、「未送信」「すべて同期」の送信まで試せる。
 * **送り先は手元のフォルダー**なので、送っても外へは何も出ない
 */
export async function addLocalRemote(folder: string, remoteFolder: string): Promise<void> {
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", remoteFolder], { windowsHide: true });
  await git(folder, ["remote", "add", "origin", remoteFolder]);
  await git(folder, ["push", "--quiet", "-u", "origin", "main"]);
}

/**
 * `git status --porcelain` の行のうち、製品が「未記録」に数えるもの（空なら記録待ちは無い）。
 *
 * **執筆量の記録（`.aiwriter/stats/`）は除く**——保存のたびに製品が書き換えるので、製品は数えない
 * （設計書5.5.13。`src/core/git.ts` の `isAutoWrittenLine`。数えないだけで記録には入る）。
 * 判定は写さず、製品の関数をそのまま使う（片方だけ直って食い違わないように）
 */
export async function porcelainLines(folder: string): Promise<string[]> {
  return (await gitWhileRunning(folder, ["status", "--porcelain", "--untracked-files=all"]))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !isAutoWrittenLine(line));
}
