import {
  classifyGithubApiError,
  GITHUB_API_BASE,
  GITHUB_USER_AGENT,
  suggestRepositoryName,
  type GithubApiErrorKind,
} from "./gitSetup";
import type { GithubRepoRef } from "./githubRepoRef";

/**
 * 編集部の招待・受諾に使う GitHub API（設計書5.7.5）。
 *
 * **`vscode` にも `node:` にも触れない。** 通信は `fetchImpl` を差し込める形にして、
 * 招待（201／204／404／422）と受諾（一致あり／一致なしでリポジトリが見える／見えない）を
 * 単体テストで測る。トークンを得る部分（VS Code のアカウント）は呼ぶ側の仕事。
 *
 * 失敗は**状態の番号で分ける**（実装ルール5「エラー文から原因を当てにいかない」）。
 */

const API_VERSION = "2022-11-28";

/** 編集部へ渡すリポジトリの名前の末尾 */
const EDITING_REPOSITORY_SUFFIX = "-editing";

/**
 * 編集用リポジトリの名前の元（作者に訊かない。作者の裁定、2026-10-28）。
 *
 * 書庫と同じ決め方（`suggestRepositoryName`。英数字の題はそのまま、日本語の題は
 * `novel-YYYYMMDD`）に `-editing` を付ける。同じ名前があれば呼ぶ側が `-2`… を試す。
 */
export function editingRepositoryBaseName(
  workTitle: string,
  now: Date = new Date()
): string {
  return `${suggestRepositoryName(workTitle, now)}${EDITING_REPOSITORY_SUFFIX}`;
}

/** リポジトリのウェブページ */
export function repositoryWebUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`;
}

/** 招待を受ける側が開くページ（編集部へ伝えるリンク） */
export function invitationsUrl(ref: GithubRepoRef): string {
  return `${repositoryWebUrl(ref)}/invitations`;
}

/** 取り寄せ（clone）用のURL。`rememberGithubCredential` はこの形しか読まない */
export function cloneUrlOf(ref: GithubRepoRef): string {
  return `${repositoryWebUrl(ref)}.git`;
}

type CallMethod = "GET" | "PUT" | "PATCH" | "DELETE";

type CallResult =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      status: number;
      kind: GithubApiErrorKind | "network";
      detail: string;
    };

async function callGithub(
  token: string,
  method: CallMethod,
  endpoint: string,
  fetchImpl: typeof fetch,
  body?: unknown
): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": GITHUB_USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      kind: "network",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    // 204 は本文が空。読めなくても状態の番号で扱う
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const classified = classifyGithubApiError(response.status, parsed);
    return {
      ok: false,
      status: response.status,
      kind: classified.kind,
      detail: classified.detail,
    };
  }
  return { ok: true, status: response.status, body: parsed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** サインインしているアカウントの名前（リポジトリの持ち主になる） */
export async function fetchAuthenticatedLogin(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; login: string } | { ok: false; detail: string }> {
  const result = await callGithub(token, "GET", "/user", fetchImpl);
  if (!result.ok) return { ok: false, detail: result.detail };
  const login = asRecord(result.body).login;
  if (typeof login !== "string" || login.length === 0) {
    return { ok: false, detail: "GitHubの応答にアカウント名が含まれていません。" };
  }
  return { ok: true, login };
}

/** 招けなかった理由。番号から決められる分だけ分ける */
export type InviteFailureReason =
  | "userNotFound"
  | "noPermission"
  | "unauthorized"
  | "invalid"
  | "network"
  | "other";

export type InviteResult =
  | {
      ok: true;
      /** `invited`＝招待した（201）／`alreadyCollaborator`＝すでに共同編集者（204） */
      outcome: "invited" | "alreadyCollaborator";
    }
  | { ok: false; reason: InviteFailureReason; detail: string };

/**
 * 編集部を共同編集者として招く（`PUT /repos/{owner}/{repo}/collaborators/{username}`）。
 *
 * **201＝招待した、204＝すでに共同編集者**。どちらも成功である。
 * 権限は `push`（読み書き）。編集部が書くのは提案の台帳だけだが、書き込めないと
 * 提案を返せない。読み取りだけの権限（`pull`）では足りない。
 */
export async function inviteCollaborator(
  token: string,
  ref: GithubRepoRef,
  username: string,
  fetchImpl: typeof fetch = fetch
): Promise<InviteResult> {
  const result = await callGithub(
    token,
    "PUT",
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}` +
      `/collaborators/${encodeURIComponent(username)}`,
    fetchImpl,
    { permission: "push" }
  );
  if (result.ok) {
    if (result.status === 204) return { ok: true, outcome: "alreadyCollaborator" };
    // 201。ほかの 2xx も「招待は通った」とみなす
    return { ok: true, outcome: "invited" };
  }
  switch (result.kind) {
    case "notFound":
      return {
        ok: false,
        reason: "userNotFound",
        detail: `GitHubに「${username}」という名前の人が見つかりませんでした。綴りを確かめてください。`,
      };
    case "forbidden":
      return {
        ok: false,
        reason: "noPermission",
        detail:
          "このリポジトリへ人を招く権限がありません（GitHubのアカウントを確かめてください）。",
      };
    case "unauthorized":
      return { ok: false, reason: "unauthorized", detail: result.detail };
    case "validation":
      return {
        ok: false,
        reason: "invalid",
        detail: `「${username}」さんは招待できませんでした（持ち主自身は招けません）。${result.detail}`,
      };
    case "network":
      return { ok: false, reason: "network", detail: result.detail };
    default:
      return { ok: false, reason: "other", detail: result.detail };
  }
}

/** 権利を外せなかった理由。番号から決められる分だけ分ける */
export type RevokeFailureReason =
  | "noPermission"
  | "unauthorized"
  | "network"
  | "other";

export type RevokeResult =
  | {
      ok: true;
      /**
       * `removed`＝共同編集者から外した（204）／`invitationCancelled`＝まだ受けていない
       * 招待を取り消した／`notCollaborator`＝もう共同編集者ではなかった（404）
       */
      outcome: "removed" | "invitationCancelled" | "notCollaborator";
    }
  | { ok: false; reason: RevokeFailureReason; detail: string };

function repoEndpoint(ref: GithubRepoRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

/**
 * 編集部の書き込みの権利を外す（作者の側からの連携の解除。作者の裁定、2026-10-28）。
 *
 * **招待を先に探す。** まだ受けていない招待は、共同編集者を外す口では消えず、
 * あとで受けられてしまう。見つかれば `DELETE /repos/{owner}/{repo}/invitations/{id}`、
 * 無ければ `DELETE /repos/{owner}/{repo}/collaborators/{login}`（204）。
 * 失敗は状態の番号で分ける。
 */
export async function revokeEditorAccess(
  token: string,
  ref: GithubRepoRef,
  login: string,
  fetchImpl: typeof fetch = fetch
): Promise<RevokeResult> {
  const wanted = login.toLowerCase();
  const listed = await callGithub(
    token,
    "GET",
    `${repoEndpoint(ref)}/invitations?per_page=100`,
    fetchImpl
  );
  // **招待の一覧が読めなければ、外せたと言わない。** まだ受けていない招待が残っていれば、
  // あとで受けられてしまう。読めなかった理由は番号で返す
  if (!listed.ok) return revokeFailure(listed);
  if (Array.isArray(listed.body)) {
    for (const row of listed.body) {
      const record = asRecord(row);
      const invitee = asRecord(record.invitee).login;
      if (
        typeof record.id === "number" &&
        typeof invitee === "string" &&
        invitee.toLowerCase() === wanted
      ) {
        const cancelled = await callGithub(
          token,
          "DELETE",
          `${repoEndpoint(ref)}/invitations/${record.id}`,
          fetchImpl
        );
        if (cancelled.ok) return { ok: true, outcome: "invitationCancelled" };
        return revokeFailure(cancelled);
      }
    }
  }

  const removed = await callGithub(
    token,
    "DELETE",
    `${repoEndpoint(ref)}/collaborators/${encodeURIComponent(login)}`,
    fetchImpl
  );
  if (removed.ok) return { ok: true, outcome: "removed" };
  // 404 は「その人はもう共同編集者ではない」とは限らない（GitHub は、見えないリポジトリにも
  // 404 を返す）。**リポジトリが見える（200）と確かめたあとだけ**、外す対象が無いとみなす。
  // 見えなければ、鍵のアカウントが違う見込みなので、失敗にして手で外す案内へ落とす
  if (removed.kind === "notFound") {
    const seen = await callGithub(token, "GET", repoEndpoint(ref), fetchImpl);
    if (seen.ok) return { ok: true, outcome: "notCollaborator" };
    return {
      ok: false,
      reason: "other",
      detail:
        "リポジトリを確かめられませんでした（別のGitHubアカウントでサインインしている見込みです）。",
    };
  }
  return revokeFailure(removed);
}

function revokeFailure(result: Extract<CallResult, { ok: false }>): RevokeResult {
  switch (result.kind) {
    case "forbidden":
      return {
        ok: false,
        reason: "noPermission",
        detail: "このリポジトリの権利を外す権限がありません（GitHubのアカウントを確かめてください）。",
      };
    case "unauthorized":
      return { ok: false, reason: "unauthorized", detail: result.detail };
    case "network":
      return { ok: false, reason: "network", detail: result.detail };
    default:
      return { ok: false, reason: "other", detail: result.detail };
  }
}

/**
 * リポジトリが非公開かを GitHub に訊く（`GET /repos/{owner}/{repo}` の `private`）。
 * 確かめられなければ `isPrivate` は付かない——呼ぶ側は送らない側へ倒す。
 */
export async function fetchRepositoryPrivacy(
  token: string,
  ref: GithubRepoRef,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; isPrivate: boolean } | { ok: false; detail: string }> {
  const result = await callGithub(token, "GET", repoEndpoint(ref), fetchImpl);
  if (!result.ok) return { ok: false, detail: result.detail };
  const value = asRecord(result.body).private;
  if (typeof value !== "boolean") {
    return { ok: false, detail: "GitHubの応答に非公開かどうかが含まれていません。" };
  }
  return { ok: true, isPrivate: value };
}

/** 自分宛ての招待の1件 */
export interface RepositoryInvitation {
  id: number;
  /** `owner/repo` */
  fullName: string;
}

/** 自分宛ての、まだ受けていない招待（`GET /user/repository_invitations`） */
export async function listRepositoryInvitations(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<
  | { ok: true; invitations: RepositoryInvitation[] }
  | { ok: false; kind: GithubApiErrorKind | "network"; detail: string }
> {
  const result = await callGithub(
    token,
    "GET",
    "/user/repository_invitations?per_page=100",
    fetchImpl
  );
  if (!result.ok) return { ok: false, kind: result.kind, detail: result.detail };
  const rows = Array.isArray(result.body) ? result.body : [];
  const invitations: RepositoryInvitation[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const fullName = asRecord(record.repository).full_name;
    if (typeof record.id === "number" && typeof fullName === "string") {
      invitations.push({ id: record.id, fullName });
    }
  }
  return { ok: true, invitations };
}

/** 招待を受ける（`PATCH /user/repository_invitations/{id}`。204） */
export async function acceptRepositoryInvitation(
  token: string,
  invitationId: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await callGithub(
    token,
    "PATCH",
    `/user/repository_invitations/${invitationId}`,
    fetchImpl
  );
  return result.ok ? { ok: true } : { ok: false, detail: result.detail };
}

export type AcceptEditorResult =
  | {
      ok: true;
      /** `accepted`＝いま受けた／`alreadyMember`＝受け済みで、もう見える */
      outcome: "accepted" | "alreadyMember";
    }
  | {
      ok: false;
      /** `notInvited`＝招待が届いていない（または別のアカウントでサインインしている） */
      reason: "notInvited" | "acceptFailed" | "network" | "other";
      detail: string;
    };

/**
 * 編集部として、リポジトリへの招待を受ける。
 *
 * 1. 自分宛ての招待に、このリポジトリがあれば受ける
 * 2. **一致が無ければ、リポジトリが見えるかを確かめる**（200 なら受け済み。続ける）。
 *    既に招待を受けた編集部のアカウントで、もう一度押された場合である
 * 3. 見えない（404）なら、「招待がまだ届いていないか、別のGitHubアカウントで
 *    サインインしている」。**GitHub は権限の無い非公開リポジトリにも 404 を返す**ので、
 *    どちらかは分からない。両方を言う
 */
export async function acceptEditorInvitation(
  token: string,
  ref: GithubRepoRef,
  fetchImpl: typeof fetch = fetch
): Promise<AcceptEditorResult> {
  const listed = await listRepositoryInvitations(token, fetchImpl);
  if (!listed.ok) {
    return {
      ok: false,
      reason: listed.kind === "network" ? "network" : "other",
      detail: listed.detail,
    };
  }

  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase();
  const found = listed.invitations.find(
    (invitation) => invitation.fullName.toLowerCase() === wanted
  );
  if (found) {
    const accepted = await acceptRepositoryInvitation(token, found.id, fetchImpl);
    if (!accepted.ok) {
      return { ok: false, reason: "acceptFailed", detail: accepted.detail };
    }
    return { ok: true, outcome: "accepted" };
  }

  const seen = await callGithub(
    token,
    "GET",
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
    fetchImpl
  );
  if (seen.ok) return { ok: true, outcome: "alreadyMember" };
  if (seen.kind === "notFound") {
    return {
      ok: false,
      reason: "notInvited",
      detail:
        "招待がまだ届いていないか、別のGitHubアカウントでサインインしています。" +
        "作者に招待を送り直してもらうか、VS Code のアカウント（GitHub）を確かめてください。",
    };
  }
  return {
    ok: false,
    reason: seen.kind === "network" ? "network" : "other",
    detail: seen.detail,
  };
}
