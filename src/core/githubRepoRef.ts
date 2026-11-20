import { EXAMPLE_REPO } from "./exampleNames";

/**
 * GitHubのリポジトリの指し方を1つにそろえる（設計書5.8.12）。
 *
 * **作者は、そのとき手元にあるものを貼る。** ブラウザのアドレス欄
 * （`https://vscode.dev/github/nonahisa/HisasNovels`）、GitHubのページ
 * （`https://github.com/nonahisa/HisasNovels`）、`git clone` 用のURL、
 * あるいは `nonahisa/HisasNovels` とだけ書くこともある。
 * **どれで来ても同じ場所を指せるようにする。**
 *
 * VS Code APIにもNodeにも依存しない（ブラウザ版で動かすため）。
 */

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/**
 * GitHubの名前に使える文字。
 *
 * 持ち主の名前は本当はもっと狭い（`-` だけ）が、**狭く判定して弾くより、
 * 広く受けて実際に読めるか試すほうがよい。** 名前の規則はGitHub側の
 * 都合で変わりうるし、間違っていれば「読めません」で分かる。
 */
const NAME = /^[A-Za-z0-9._-]+$/;

/** `.git` と、そのあとに続く枝やパスを落とす */
function cleanRepoName(raw: string): string {
  return raw.replace(/\.git$/i, "");
}

/**
 * 貼られた文字列から持ち主とリポジトリ名を取り出す。読めなければ `undefined`。
 *
 * 受ける形：
 * - `nonahisa/HisasNovels`
 * - `https://github.com/nonahisa/HisasNovels`（`.git` や `/tree/main/...` が付いていてもよい）
 * - `git@github.com:nonahisa/HisasNovels.git`
 * - `https://vscode.dev/github/nonahisa/HisasNovels`
 * - `https://github.dev/nonahisa/HisasNovels`
 * - `vscode-vfs://github/nonahisa/HisasNovels`
 */
export function parseGithubRepoRef(input: string): GithubRepoRef | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;

  // 問い合わせや位置指定は場所と関係ない
  const withoutTail = trimmed.split(/[?#]/)[0].replace(/\/+$/, "");

  const segments = pickSegments(withoutTail);
  if (!segments) return undefined;

  const [owner, repoRaw] = segments;
  const repo = cleanRepoName(repoRaw);
  if (!NAME.test(owner) || !NAME.test(repo)) return undefined;
  // `.` と `..` はパスとして特別な意味を持つ。名前としては受けない
  if (repo === "." || repo === "..") return undefined;
  return { owner, repo };
}

/** 形ごとに、持ち主とリポジトリ名の2つが並んでいる位置を取り出す */
function pickSegments(value: string): [string, string] | undefined {
  // git@github.com:owner/repo
  const ssh = /^(?:ssh:\/\/)?git@[^:/\s]+[:/]([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (ssh) return [ssh[1], ssh[2]];

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    // scheme://host/……
    const withoutScheme = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    const parts = withoutScheme.split("/").filter((part) => part.length > 0);
    if (parts.length < 3) return undefined;
    const host = parts[0].toLowerCase();

    // **`github` が1つ挟まる形がある。** vscode.dev と、仮想ファイル
    // システムのURI（`vscode-vfs://github/owner/repo`）がこれにあたる
    const rest =
      parts[1].toLowerCase() === "github" && host !== "github.com"
        ? parts.slice(2)
        : parts.slice(1);
    if (rest.length < 2) return undefined;
    return [rest[0], rest[1]];
  }

  // owner/repo
  const parts = value.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) return undefined;
  return [parts[0], parts[1]];
}

/**
 * **github.com の**リポジトリを指す URL か。指していれば持ち主と名前、違えば `undefined`。
 *
 * `parseGithubRepoRef` は作者が貼った値を広く受けるため、**ホストを見ない**
 * （`https://evil.example/a/b` も `a/b` と読む）。GitHub の鍵を渡す先を決めるときは
 * これを使う——同期される作品フォルダーの記録（`.aiwriter/editing.json`）が
 * 書き換えられていても、鍵を別のホストへ送らないため（セキュリティ点検 2026-11-21）。
 *
 * 受けるのは `https://github.com/owner/repo(.git)` と `git@github.com:owner/repo(.git)` だけ。
 * 鍵やパスワードの入った URL・`http`・ポート付きは受けない。
 */
export function githubComRepoRef(url: string): GithubRepoRef | undefined {
  const trimmed = url.trim();
  const ssh = /^git@github\.com:([^/\s]+\/[^/\s]+)$/i.exec(trimmed);
  if (ssh) return parseGithubRepoRef(ssh[1]);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
  if (parsed.username || parsed.password || parsed.port) return undefined;
  if (parsed.search || parsed.hash) return undefined;
  // 2段（owner/repo）のほかは受けない。`/tree/main` などの付いた値は取り寄せ先ではない
  const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter((part) => part.length > 0);
  if (segments.length !== 2) return undefined;
  return parseGithubRepoRef(segments.join("/"));
}

/** 入力欄に出す、直し方の分かる言い方。問題なければ `undefined` */
export function describeRepoRefProblem(input: string): string | undefined {
  if (input.trim().length === 0) {
    return `リポジトリを入力してください（例：${EXAMPLE_REPO}）`;
  }
  if (parseGithubRepoRef(input)) return undefined;
  return "「持ち主/リポジトリ名」か、GitHubのURLを入力してください";
}

/**
 * ブラウザのVS Codeが、GitHubの中身を読むときに使う場所。
 *
 * **取り寄せない。** ブラウザにはファイルを置く場所も `git` も無いので、
 * GitHubの中身を直に読み書きする仕組み（仮想ファイルシステム）を指す。
 */
export function githubVfsLocation(ref: GithubRepoRef): string {
  return `vscode-vfs://github/${ref.owner}/${ref.repo}`;
}

/** そのリポジトリを、ブラウザのVS Codeで開くためのアドレス */
export function vscodeDevUrl(ref: GithubRepoRef): string {
  return `https://vscode.dev/github/${ref.owner}/${ref.repo}`;
}

/** 画面に出す短い名前 */
export function describeRepoRef(ref: GithubRepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}
