import { describe, expect, test, vi } from "vitest";
import {
  acceptEditorInvitation,
  cloneUrlOf,
  editingRepositoryBaseName,
  fetchAuthenticatedLogin,
  fetchRepositoryPrivacy,
  invitationsUrl,
  inviteCollaborator,
  revokeEditorAccess,
} from "../../../src/core/githubCollaboration";
import { parseGithubRepoRef } from "../../../src/core/githubRepoRef";

/**
 * 編集部の招待・受諾（設計書5.7.5）。通信は `fetchImpl` で差し替えて測る。
 * 失敗は**状態の番号で分ける**（エラー文から原因を当てない）。
 */

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ref = { owner: "hisa", repo: "novel-editing" };

describe("招待（PUT /repos/{owner}/{repo}/collaborators/{username}）", () => {
  test("201 は「招待した」。権限は push で送る", async () => {
    const fetchImpl = vi.fn(async () => json(201, { id: 1 }));
    const result = await inviteCollaborator("t", ref, "octocat", fetchImpl);

    expect(result).toEqual({ ok: true, outcome: "invited" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/hisa/novel-editing/collaborators/octocat"
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ permission: "push" });
  });

  test("204 は「すでに共同編集者」。これも成功", async () => {
    const result = await inviteCollaborator("t", ref, "octocat", async () => json(204));
    expect(result).toEqual({ ok: true, outcome: "alreadyCollaborator" });
  });

  test("404 は「その名前の人がいない」", async () => {
    const result = await inviteCollaborator("t", ref, "nobody", async () =>
      json(404, { message: "Not Found" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("userNotFound");
      expect(result.detail).toContain("nobody");
    }
  });

  test("422 は招待できない相手（理由は番号で分け、GitHub の文を添える）", async () => {
    const result = await inviteCollaborator("t", ref, "hisa", async () =>
      json(422, { message: "Validation Failed" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  test("403 は権限が無い、401 はサインイン切れ、回線の失敗は network", async () => {
    const forbidden = await inviteCollaborator("t", ref, "a", async () => json(403, {}));
    const unauthorized = await inviteCollaborator("t", ref, "a", async () => json(401, {}));
    const offline = await inviteCollaborator("t", ref, "a", async () => {
      throw new Error("ECONNRESET");
    });
    expect(forbidden.ok === false && forbidden.reason).toBe("noPermission");
    expect(unauthorized.ok === false && unauthorized.reason).toBe("unauthorized");
    expect(offline.ok === false && offline.reason).toBe("network");
  });
});

describe("招待の受諾", () => {
  const invitations = [
    { id: 11, repository: { full_name: "someone/else" } },
    { id: 22, repository: { full_name: "Hisa/Novel-Editing" } },
  ];

  test("招待に一致があれば受ける（綴りの大小は問わない）", async () => {
    const calls: Array<[string, string]> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url]);
      if (url.includes("/user/repository_invitations?")) return json(200, invitations);
      return json(204);
    });
    const result = await acceptEditorInvitation("t", ref, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, outcome: "accepted" });
    expect(calls).toContainEqual([
      "PATCH",
      "https://api.github.com/user/repository_invitations/22",
    ]);
  });

  test("一致が無くても、リポジトリが見える（200）なら受け済みとして続ける", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/user/repository_invitations") ? json(200, []) : json(200, { id: 1 })
    );
    const result = await acceptEditorInvitation("t", ref, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, outcome: "alreadyMember" });
  });

  test("一致が無く、リポジトリも見えない（404）なら、止めて理由を言う", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/user/repository_invitations")
        ? json(200, [])
        : json(404, { message: "Not Found" })
    );
    const result = await acceptEditorInvitation("t", ref, fetchImpl as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("notInvited");
      expect(result.detail).toContain("招待がまだ届いていないか");
      expect(result.detail).toContain("別のGitHubアカウント");
    }
  });

  test("受諾そのものが断られたら、取り寄せへ進まない", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? json(404, { message: "Not Found" })
        : json(200, invitations)
    );
    const result = await acceptEditorInvitation("t", ref, fetchImpl as unknown as typeof fetch);
    expect(result.ok === false && result.reason).toBe("acceptFailed");
  });
});

describe("編集部の権利を外す（作者の側からの解除）", () => {
  test("共同編集者なら DELETE collaborators。204 で成功", async () => {
    const calls: Array<[string, string]> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url]);
      // 受けていない招待は無い
      if (url.includes("/invitations")) return json(200, []);
      return json(204);
    });
    const result = await revokeEditorAccess("t", ref, "octocat", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, outcome: "removed" });
    expect(calls).toContainEqual([
      "DELETE",
      "https://api.github.com/repos/hisa/novel-editing/collaborators/octocat",
    ]);
  });

  test("404 でも、リポジトリが見える（200）と確かめたあとだけ「もう共同編集者ではない」とみなす", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/invitations")) return json(200, []);
      if (init?.method === "DELETE") return json(404, { message: "Not Found" });
      return json(200, { id: 1 }); // GET /repos/{owner}/{repo}
    });
    const result = await revokeEditorAccess("t", ref, "octocat", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, outcome: "notCollaborator" });
  });

  test("404 で、リポジトリも見えないなら、外せたと言わない（鍵のアカウント違いの見込み）", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/invitations") ? json(200, []) : json(404, { message: "Not Found" })
    );
    const result = await revokeEditorAccess("t", ref, "octocat", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("別のGitHubアカウント");
  });

  test("招待の一覧が読めなければ、外せたと言わない（受けていない招待が残りうる）", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/invitations")) return json(403, { message: "Forbidden" });
      return json(204);
    });
    const result = await revokeEditorAccess("t", ref, "octocat", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    // 共同編集者の口へ進んで「成功」にしない
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  test("招待を受ける前なら、招待を探して DELETE invitations（共同編集者の口は叩かない）", async () => {
    const calls: Array<[string, string]> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url]);
      if ((init?.method ?? "GET") === "GET") {
        return json(200, [
          { id: 5, invitee: { login: "someone" } },
          { id: 9, invitee: { login: "Octocat" } },
        ]);
      }
      return json(204);
    });
    const result = await revokeEditorAccess("t", ref, "octocat", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, outcome: "invitationCancelled" });
    expect(calls).toContainEqual([
      "DELETE",
      "https://api.github.com/repos/hisa/novel-editing/invitations/9",
    ]);
    expect(calls.some(([, url]) => url.includes("/collaborators/"))).toBe(false);
  });

  test("403 は権限が無い、401 はサインイン切れ、回線の失敗は network（番号で分ける）", async () => {
    const make = (status: number) =>
      (async (url: string) =>
        url.includes("/invitations") ? json(200, []) : json(status, { message: "x" })) as unknown as typeof fetch;
    const forbidden = await revokeEditorAccess("t", ref, "a", make(403));
    const unauthorized = await revokeEditorAccess("t", ref, "a", make(401));
    const offline = await revokeEditorAccess("t", ref, "a", (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    expect(forbidden.ok === false && forbidden.reason).toBe("noPermission");
    expect(unauthorized.ok === false && unauthorized.reason).toBe("unauthorized");
    // 招待の一覧が読めなくても、共同編集者の口へ進む（そちらも回線で落ちる）
    expect(offline.ok === false && offline.reason).toBe("network");
  });

  test("リポジトリの非公開の確認：private を読む。読めなければ付けない", async () => {
    expect(
      await fetchRepositoryPrivacy("t", ref, async () => json(200, { private: true }))
    ).toEqual({ ok: true, isPrivate: true });
    expect(
      await fetchRepositoryPrivacy("t", ref, async () => json(200, { private: false }))
    ).toEqual({ ok: true, isPrivate: false });
    const unknown = await fetchRepositoryPrivacy("t", ref, async () => json(200, {}));
    expect(unknown.ok).toBe(false);
    const missing = await fetchRepositoryPrivacy("t", ref, async () => json(404, { message: "Not Found" }));
    expect(missing.ok).toBe(false);
  });
});

describe("名前とリンク", () => {
  test("アカウント名は GET /user の login", async () => {
    const result = await fetchAuthenticatedLogin("t", async () => json(200, { login: "hisa" }));
    expect(result).toEqual({ ok: true, login: "hisa" });
  });

  test("リポジトリの名前は、英数字の題はそのまま・日本語の題は日付に -editing を付ける", () => {
    expect(editingRepositoryBaseName("Ice Town")).toBe("Ice-Town-editing");
    expect(editingRepositoryBaseName("氷の街", new Date(2026, 9, 28))).toBe(
      "novel-20261028-editing"
    );
  });

  test("招待のリンクと取り寄せ用URLの形", () => {
    expect(invitationsUrl(ref)).toBe("https://github.com/hisa/novel-editing/invitations");
    expect(cloneUrlOf(ref)).toBe("https://github.com/hisa/novel-editing.git");
  });

  test.each([
    "https://github.com/hisa/novel-editing",
    "https://github.com/hisa/novel-editing/invitations",
    "https://github.com/hisa/novel-editing.git",
    "hisa/novel-editing",
    " https://github.com/hisa/novel-editing/invitations \n",
  ])("貼られたリンク「%s」から持ち主とリポジトリ名を読む", (input) => {
    expect(parseGithubRepoRef(input)).toEqual(ref);
  });

  test("リポジトリが読めない文字列は断る", () => {
    expect(parseGithubRepoRef("https://github.com/hisa")).toBeUndefined();
    expect(parseGithubRepoRef("こんにちは")).toBeUndefined();
  });
});
