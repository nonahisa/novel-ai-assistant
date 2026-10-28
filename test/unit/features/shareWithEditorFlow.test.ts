import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "../support/vscodeStub";
import {
  inviteEditor,
  setUpAndPush,
  shareNoticeFor,
} from "../../../src/features/shareWithEditor";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集部へ渡す流れ（作者の裁定、2026-10-28「1回で済ませる」）。
 *
 * 確かめるのは次の分かれ目。
 * - **非公開と確かめられなければ送らない**（原稿が公開リポジトリへ出る事故の防波堤）
 * - VS Code のアカウントの道が先、使えなければ gh、どちらも無ければ送らずに名乗る
 * - 自動の送り返しは、リポジトリを作らない
 */

const work: WorkEntry = {
  id: "work_share",
  title: "氷の街",
  folderPath: "C:\\Novels\\氷の街",
  registeredAt: "2026-09-21T00:00:00.000Z",
};
const destination = "C:\\Novels\\編集部\\氷の街-編集用";

/** 送り先の登録だけを覚えている、作り物の git */
function fakeGit() {
  const calls: string[][] = [];
  let origin: string | undefined;
  const ok = { code: 0, stdout: "", stderr: "" };
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "remote" && args[1] === "add") {
      origin = args[3];
      return ok;
    }
    if (args[0] === "remote" && args[1] === "remove") {
      origin = undefined;
      return ok;
    }
    if (args[0] === "remote" && args[1] === "get-url") {
      return origin
        ? { code: 0, stdout: `${origin}\n`, stderr: "" }
        : { code: 2, stdout: "", stderr: "no remote" };
    }
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n", stderr: "" };
    return ok;
  });
  return {
    run,
    calls,
    setOrigin: (url: string) => {
      origin = url;
    },
    pushed: () => calls.some((args) => args[0] === "push"),
    removedOrigin: () =>
      calls.some((args) => args[0] === "remote" && args[1] === "remove"),
  };
}

describe("編集用リポジトリの作り方と、送る前の非公開の確認", () => {
  beforeEach(() => {
    // `.git` が無い＝初回の共有
    workspace.fs = {
      stat: async () => {
        throw new Error("無い");
      },
    } as unknown as typeof workspace.fs;
  });
  afterEach(() => {
    workspace.fs = {} as typeof workspace.fs;
  });

  test("VS Code のアカウントの道：非公開と確かめて、鍵を覚えさせてから送る", async () => {
    const git = fakeGit();
    const remember = vi.fn(async () => true);
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      getToken: async () => "token",
      createViaAccount: async () => ({
        ok: true,
        cloneUrl: "https://github.com/me/novel-20261028-editing.git",
        name: "novel-20261028-editing",
        isPrivate: true,
      }),
      rememberCredential: remember,
      ghAvailable: async () => {
        throw new Error("アカウントの道が通るなら gh は見ない");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("pushed");
    expect(result.viaAccount).toBe(true);
    expect(result.ref).toEqual({ owner: "me", repo: "novel-20261028-editing" });
    expect(remember).toHaveBeenCalledOnce();
    expect(git.pushed()).toBe(true);
  });

  test.each([
    ["非公開ではない（false）", false],
    ["答えに非公開かどうかが無い（undefined）", undefined],
  ])("**%s ときは送らない**。送り先の登録も外す", async (_label, isPrivate) => {
    const git = fakeGit();
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      getToken: async () => "token",
      createViaAccount: async () => ({
        ok: true,
        cloneUrl: "https://github.com/me/x-editing.git",
        name: "x-editing",
        isPrivate,
      }),
      rememberCredential: async () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("非公開");
    expect(git.pushed()).toBe(false);
    // 残すと、次の送信が確かめなしで通ってしまう
    expect(git.removedOrigin()).toBe(true);
  });

  test("アカウントの道が使えないときは gh で作り、非公開を読んでから送る", async () => {
    const git = fakeGit();
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      getToken: async () => undefined,
      ghAvailable: async () => true,
      createViaGh: async () => {
        git.setOrigin("https://github.com/me/ice-editing.git");
        return { ok: true, name: "ice-editing" };
      },
      ghIsPrivate: async () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("pushed");
    expect(result.viaAccount).toBe(false);
    expect(git.pushed()).toBe(true);
  });

  test("gh の道でも、非公開と読めなければ送らない", async () => {
    const git = fakeGit();
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      getToken: async () => undefined,
      ghAvailable: async () => true,
      createViaGh: async () => {
        git.setOrigin("https://github.com/me/ice-editing.git");
        return { ok: true, name: "ice-editing" };
      },
      ghIsPrivate: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(git.pushed()).toBe(false);
    expect(git.removedOrigin()).toBe(true);
  });

  test("どちらの道も無いときは、送らずに「フォルダーは用意した」と名乗る", async () => {
    const git = fakeGit();
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      getToken: async () => undefined,
      ghAvailable: async () => false,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("noRoute");
    expect(git.pushed()).toBe(false);
    const notice = shareNoticeFor("noRoute", work.title);
    expect(notice.message).toContain("用意しました");
    expect(notice.message).toContain("gh");
    expect(notice.actions).not.toContain("GitHubで開く");
  });

  test("名前の空きは作り手に任せる：同じ名前が埋まっていれば失敗をそのまま返す", async () => {
    const git = fakeGit();
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      getToken: async () => "token",
      createViaAccount: async () => ({ ok: false, detail: "回線がありません" }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("回線がありません");
    expect(git.pushed()).toBe(false);
  });

  test("自動の送り返し（allowCreate: false）は、リポジトリを作らずに止まる", async () => {
    const git = fakeGit();
    const createViaAccount = vi.fn();
    const result = await setUpAndPush(work, destination, {
      run: git.run,
      allowCreate: false,
      getToken: async () => "token",
      createViaAccount,
    });
    expect(result.ok).toBe(false);
    expect(createViaAccount).not.toHaveBeenCalled();
    expect(git.pushed()).toBe(false);
  });
});

describe("渡し終わったときの知らせ", () => {
  test("招待したときは、名前とリンクを言い、リンクを写せる", () => {
    const notice = shareNoticeFor("pushed", "氷の街", {
      kind: "invited",
      login: "octocat",
      link: "https://github.com/me/repo/invitations",
    });
    expect(notice.message).toContain("「氷の街」を編集部へ渡し、octocatさんを招待しました");
    expect(notice.message).toContain("https://github.com/me/repo/invitations");
    expect(notice.actions).toContain("リンクを写す");
    expect(notice.link).toBe("https://github.com/me/repo/invitations");
  });

  test("すでに共同編集者なら、そう言う", () => {
    const notice = shareNoticeFor("pushed", "氷の街", {
      kind: "already",
      login: "octocat",
    });
    expect(notice.message).toContain("すでに共同編集者");
    expect(notice.actions).not.toContain("リンクを写す");
  });

  test("招待に失敗しても渡したことは成功として言い、手で招く案内を出す", () => {
    const notice = shareNoticeFor("pushed", "氷の街", {
      kind: "failed",
      login: "octocat",
      detail: "GitHubに「octocat」という名前の人が見つかりませんでした。",
    });
    expect(notice.message).toContain("編集部へ渡しました");
    expect(notice.message).toContain("Collaborators");
    expect(notice.actions).toContain("GitHubで開く");
  });

  test("送り直しは、招待には触れない", () => {
    const notice = shareNoticeFor("pushed", "氷の街");
    expect(notice.message).toContain("送り直しました");
    expect(notice.message).not.toContain("招待");
  });
});

describe("編集部の招待に使う鍵（gh だけの作者にも招待まで自動）", () => {
  const ref = { owner: "hisa", repo: "novel-20261028-editing" };
  const invited = vi.fn(async () => ({ ok: true as const, outcome: "invited" as const }));

  beforeEach(() => invited.mockClear());

  test("VS Code のサインインが無ければ、gh の鍵を借りて招く（新しい窓は出さない）", async () => {
    const accountToken = vi.fn(async () => "account");
    const result = await inviteEditor("kmizu", ref, false, {
      token: accountToken,
      hasSession: async () => false,
      ghToken: async () => "gh-token",
      invite: invited as never,
    });
    expect(accountToken).not.toHaveBeenCalled();
    expect(invited).toHaveBeenCalledWith("gh-token", ref, "kmizu");
    expect(result.kind).toBe("invited");
  });

  test("サインインがあれば、その鍵で招く（gh の鍵は使わない）", async () => {
    const ghToken = vi.fn(async () => "gh-token");
    await inviteEditor("kmizu", ref, false, {
      token: async () => "account",
      hasSession: async () => true,
      ghToken,
      invite: invited as never,
    });
    expect(ghToken).not.toHaveBeenCalled();
    expect(invited).toHaveBeenCalledWith("account", ref, "kmizu");
  });

  test("どちらの鍵も無ければ、招かずに手で招く案内へ落とす", async () => {
    const result = await inviteEditor("kmizu", ref, false, {
      hasSession: async () => false,
      ghToken: async () => undefined,
      invite: invited as never,
    });
    expect(invited).not.toHaveBeenCalled();
    expect(result.kind).toBe("skipped");
  });
});
