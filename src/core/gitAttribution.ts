import { canRunProcesses } from "./runtime";

/**
 * ローカルのgit設定から「誰が書いたか」を取る（編集履歴・提案の記名に使う）。
 *
 * **`git.ts` を直接importしない。** `git.ts` は先頭で
 * `node:child_process` を読み込んでおり、ブラウザ版のVS Codeでは
 * それだけでビルドが壊れる（原理的に外部プロセスを起動できないため）。
 * このファイル自身は何もimportしないので、browser向けの束にも
 * 安全に含められる。呼ばれたときだけ、実行できる環境かを確かめてから
 * 動的importする（設計書5.8）。
 *
 * **取れなければ `undefined`。** ブラウザ版や、gitが使えない環境では
 * 「誰が分からない」より「記録が無い」ほうが困るので、記名なしで続行する。
 */
export async function tryGitUserName(
  folderPath: string
): Promise<string | undefined> {
  if (!canRunProcesses()) return undefined;
  try {
    const { gitUserName } = await import("./git.js");
    return await gitUserName(folderPath);
  } catch {
    return undefined;
  }
}
