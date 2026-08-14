import { runGit, type GitCommandRunner } from "./git";
import { runCommand, type CommandRunner } from "./gitSetup";

/**
 * GitHubにある作品を、この環境へ取り寄せる（設計書5.5.11）。
 *
 * 新しいPCで続きを書き始めるときの入口。ここが無いと、作者は
 * コマンドラインで `git clone` を打つことになる。
 */

/** 取り寄せの上限。作品によっては画像も入るので長めに取る */
export const CLONE_TIMEOUT_MS = 300_000;

export interface CloneResult {
  ok: boolean;
  detail?: string;
  /** 認証で断られたか。案内の出し分けに使う */
  needsAuth?: boolean;
}

/**
 * URLから作るフォルダー名を決める。
 *
 * **URLの最後の部分をそのまま使う。** 作品名は日本語でも、リポジトリ名は
 * 英数字であることが多い。あとから作品名は変えられるので、ここでは
 * 元の名前を保つほうが対応を追いやすい。
 */
export function folderNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  // `/` だけで切る。`git@github.com:user/repo` も最後は `/` の後ろにある。
  // `:` でも切ると、パスに `:` が混ざったとき手前が丸ごと落ちる
  const lastSegment = trimmed.split("/").pop() ?? "";
  // フォルダー名に使えない文字は落とす。空になったら呼び出し側で聞く
  return lastSegment.replace(/[\\:*?"<>|]/g, "").trim();
}

/**
 * 取り寄せる。
 *
 * 認証を聞かれても待ち続けない設定（`runGit`）で動くため、非公開の
 * リポジトリでは失敗する。そのときは `needsAuth` を立てて返し、
 * 呼び出し側が `gh` を使う道を案内する。
 */
export async function cloneRepository(
  url: string,
  destination: string,
  run: GitCommandRunner = runGit
): Promise<CloneResult> {
  const result = await run(
    ["clone", url, destination],
    // クローン先はまだ無いので、作業ディレクトリには親を渡せない。
    // gitは絶対パスで受け取れるため、実行位置はどこでもよい
    process.cwd(),
    CLONE_TIMEOUT_MS
  );
  if (result.code === 0) return { ok: true };

  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return {
    ok: false,
    detail: detail.length > 0 ? detail : "gitが理由を返しませんでした。",
    needsAuth: looksLikeAuthFailure(detail),
  };
}

/** GitHub CLI（gh）で取り寄せる。非公開のリポジトリはこちらなら通る */
export async function cloneWithGh(
  url: string,
  destination: string,
  run: CommandRunner = runCommand
): Promise<CloneResult> {
  const result = await run(
    "gh",
    ["repo", "clone", url, destination],
    undefined,
    CLONE_TIMEOUT_MS
  );
  if (result.code === 0) return { ok: true };
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return {
    ok: false,
    detail: detail.length > 0 ? detail : "ghが理由を返しませんでした。",
  };
}

/**
 * 認証で断られたか。
 *
 * **文言で判定するしかない。** gitは終了コードで理由を区別しない。
 * 判定を外しても案内が1つ増えるだけで、原稿には影響しない。
 */
export function looksLikeAuthFailure(detail: string): boolean {
  return /authentication|could not read Username|Permission denied|403|terminal prompts disabled|repository not found/i.test(
    detail
  );
}
