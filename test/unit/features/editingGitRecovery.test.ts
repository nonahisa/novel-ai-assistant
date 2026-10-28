import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import { runGit } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集用リポジトリの立ち直り（レビュー指摘 B1・B2・B9、2026-10-28）。
 *
 * **本物の git で走らせる。** 「断られたあとに分かれたまま止まる」「上流が無いと取り寄せで
 * 止まる」は、git の状態そのものの問題で、作り物の実行口では確かめにならない。
 */

const {
  prepareEditingFolder,
  reconcileDiverged,
  pushWasRejected,
  verifyKnownDestination,
  cloneWithCredential,
  importEditorProposalsQuietly,
  rememberRegisteredWorks,
} = await import("../../../src/features/shareWithEditor");
const { publishLedger } = await import("../../../src/features/finishReview");

const PROPOSALS = nodePath.join(".aiwriter", "proposals", "proposals.jsonl");
const LOCKS = nodePath.join(".aiwriter", "locks", "locks.jsonl");

const git = async (cwd: string, ...args: string[]) => {
  const result = await runGit(args, cwd, 60_000);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} が失敗: ${result.stderr}`);
  }
  return result.stdout.trim();
};

describe("編集用リポジトリの立ち直り", () => {
  let base = "";
  let remote = "";

  const put = async (dir: string, relative: string, text: string) => {
    const target = nodePath.join(dir, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };
  const read = (dir: string, relative: string) =>
    fsp.readFile(nodePath.join(dir, relative), "utf8");
  const lines = async (dir: string, relative: string) =>
    (await read(dir, relative)).split("\n").filter((line) => line.trim().length > 0);

  /** remote から clone して、記録する人の名前を設定する */
  const cloneInto = async (name: string): Promise<string> => {
    const dir = nodePath.join(base, name);
    await git(base, "clone", remote, dir);
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", name);
    return dir;
  };
  const commitAll = async (dir: string, message: string) => {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", message);
  };

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-recover-"));
    remote = nodePath.join(base, "remote.git");
    await git(base, "init", "--bare", "-b", "main", remote);
    // 最初の1件（空の remote では clone した枝に上流が付かないので、先に1件置く）
    const seed = nodePath.join(base, "seed");
    await git(base, "clone", remote, seed);
    await git(seed, "config", "user.email", "t@example.com");
    await git(seed, "config", "user.name", "seed");
    await git(seed, "checkout", "-b", "main");
    await put(seed, "本文/001.txt", "はじまり");
    await commitAll(seed, "最初");
    await git(seed, "push", "-u", "origin", "main");

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      },
      readFile: async (uri: { fsPath: string }) =>
        new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
      readDirectory: async (uri: { fsPath: string }) => {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? FileType.Directory : FileType.File,
        ]);
      },
      delete: async (uri: { fsPath: string }, options?: { recursive?: boolean }) => {
        await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
      },
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  test("B1：上流がまだ無い（初回の送信が止まった）フォルダーは、取り寄せで止まらない", async () => {
    // 送り先は登録してあるが、一度も push していない
    const stuck = nodePath.join(base, "stuck");
    await git(base, "init", "-b", "main", stuck);
    await git(stuck, "config", "user.email", "t@example.com");
    await git(stuck, "config", "user.name", "stuck");
    await put(stuck, "本文/001.txt", "あ");
    await commitAll(stuck, "記録");
    await git(stuck, "remote", "add", "origin", remote);

    const result = await prepareEditingFolder(stuck, runGit);

    // 失敗として返さない（push -u に任せる）
    expect(result).toBeUndefined();
  });

  test("B2：分かれていても、両方の台帳の行を残したまま相手の最新に合わせられる", async () => {
    const author = await cloneInto("author");
    const editor = await cloneInto("editor");

    // 編集部が先に提案と鍵を送った
    await put(editor, PROPOSALS, '{"kind":"proposal","id":"e1"}\n');
    await put(editor, LOCKS, '{"kind":"acquire","file":"本文/001.txt","holderKind":"editor","time":"2026-10-28T10:00:00.000Z"}\n');
    await commitAll(editor, "編集部の提案");
    await git(editor, "push");

    // 作者の側にも、送っていない記録がある（別の提案の採否と、本文の書き換え）
    await put(author, PROPOSALS, '{"kind":"decision","proposalId":"a1"}\n');
    await put(author, "本文/001.txt", "作者が書き換えた");
    await commitAll(author, "作者の採否");

    expect(await pushWasRejected(author, runGit)).toBe(true);

    const prepared = await prepareEditingFolder(author, runGit);
    expect(prepared).toBeUndefined();

    // 台帳は両方の行がある。本文は相手の側（作者の側は写し直す）
    const proposals = await lines(author, PROPOSALS);
    expect(proposals).toContain('{"kind":"proposal","id":"e1"}');
    expect(proposals).toContain('{"kind":"decision","proposalId":"a1"}');
    expect((await lines(author, LOCKS)).length).toBe(1);
    expect(await read(author, "本文/001.txt")).toBe("はじまり");

    // 記録してもう一度送れる
    await commitAll(author, "合わせ直し");
    await git(author, "push");
    const shared = await git(base, "--git-dir", remote, "show", "main:.aiwriter/proposals/proposals.jsonl");
    expect(shared).toContain('"id":"e1"');
    expect(shared).toContain('"proposalId":"a1"');
  });

  test("B2：reconcileDiverged を直に呼んでも、未記録の台帳の行まで残る", async () => {
    const author = await cloneInto("author");
    const editor = await cloneInto("editor");
    await put(editor, PROPOSALS, '{"kind":"proposal","id":"e1"}\n');
    await commitAll(editor, "編集部");
    await git(editor, "push");
    // 作者の台帳は未記録のまま
    await put(author, PROPOSALS, '{"kind":"decision","proposalId":"a1"}\n');
    await put(author, "本文/002.txt", "要らない新規");
    await commitAll(author, "作者の記録");
    await put(author, PROPOSALS, '{"kind":"decision","proposalId":"a1"}\n{"kind":"decision","proposalId":"a2"}\n');

    const result = await reconcileDiverged(author, runGit);

    expect(result.ok).toBe(true);
    const proposals = await lines(author, PROPOSALS);
    expect(proposals).toEqual(
      expect.arrayContaining([
        '{"kind":"proposal","id":"e1"}',
        '{"kind":"decision","proposalId":"a1"}',
        '{"kind":"decision","proposalId":"a2"}',
      ])
    );
  });

  test("B2（編集部の側）：返す送信が断られたら、台帳を混ぜて記録し直して送る", async () => {
    const author = await cloneInto("author");
    const editor = await cloneInto("editor");
    const editorWork: WorkEntry = {
      id: "w",
      title: "氷の街",
      folderPath: editor,
      registeredAt: "2026-10-28T00:00:00.000Z",
    };

    // 作者が先に採否を送り返した（本文も変わっている）
    await put(author, PROPOSALS, '{"kind":"decision","proposalId":"a1"}\n');
    await put(author, "本文/001.txt", "作者の新しい版");
    await commitAll(author, "作者");
    await git(author, "push");

    // 編集部は自分の台帳を足している（まだ送っていない）
    await put(editor, PROPOSALS, '{"kind":"proposal","id":"e1"}\n');
    await put(editor, LOCKS, '{"kind":"release","file":"本文/001.txt","holderKind":"editor","time":"2026-10-28T12:00:00.000Z"}\n');

    const failure = await publishLedger(editorWork, "校閲を終えて返す", runGit);

    expect(failure).toBeUndefined();
    const shared = await git(base, "--git-dir", remote, "show", "main:.aiwriter/proposals/proposals.jsonl");
    expect(shared).toContain('"proposalId":"a1"');
    expect(shared).toContain('"id":"e1"');
    const sharedLocks = await git(base, "--git-dir", remote, "show", "main:.aiwriter/locks/locks.jsonl");
    expect(sharedLocks).toContain('"kind":"release"');
    // 本文は相手の側（作者の新しい版）のまま。編集部は本文を書かない
    expect(await git(base, "--git-dir", remote, "show", "main:本文/001.txt")).toBe(
      "作者の新しい版"
    );
  });

  describe("B9：覚えている送り先と違う origin は、非公開と確かめるまで送らない", () => {
    const withOrigin = async (url: string): Promise<string> => {
      const dir = nodePath.join(base, "picked");
      await git(base, "init", "-b", "main", dir);
      await git(dir, "remote", "add", "origin", url);
      return dir;
    };

    test("覚えている送り先と同じなら、問い合わせない", async () => {
      const dir = await withOrigin("https://github.com/me/x-editing.git");
      const fetchImpl = vi.fn();
      const result = await verifyKnownDestination(
        dir,
        { remoteUrl: "https://github.com/ME/x-editing" },
        runGit,
        { fetchImpl: fetchImpl as unknown as typeof fetch, token: async () => "t", hasSession: async () => true }
      );
      expect(result).toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test("違う送り先が非公開なら通る。公開なら止める", async () => {
      const dir = await withOrigin("https://github.com/me/other.git");
      const deps = (isPrivate: boolean) => ({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ private: isPrivate }), { status: 200 })) as unknown as typeof fetch,
        token: async () => "t",
        hasSession: async () => true,
      });
      expect(await verifyKnownDestination(dir, {}, runGit, deps(true))).toBeUndefined();
      const refused = await verifyKnownDestination(dir, {}, runGit, deps(false));
      expect(refused?.ok).toBe(false);
      expect(refused?.detail).toContain("公開のリポジトリです");
    });

    test("確かめられない（鍵が無い・応答が読めない）なら止める", async () => {
      const dir = await withOrigin("https://github.com/me/other.git");
      const noToken = await verifyKnownDestination(dir, {}, runGit, {
        hasSession: async () => false,
        ghToken: async () => undefined,
      });
      expect(noToken?.ok).toBe(false);

      const broken = await verifyKnownDestination(dir, {}, runGit, {
        token: async () => "t",
        hasSession: async () => true,
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      });
      expect(broken?.ok).toBe(false);
    });

    test("GitHub のリポジトリとして読めない送り先も止める", async () => {
      const dir = await withOrigin("https://example.com/not-github.git");
      const refused = await verifyKnownDestination(dir, {}, runGit, {
        token: async () => "t",
        hasSession: async () => true,
      });
      expect(refused?.ok).toBe(false);
      expect(refused?.detail).toContain("GitHub のリポジトリとして読めません");
    });
  });

  describe("レビュー2回目の指摘", () => {
    const workIn = (folder: string): WorkEntry => ({
      id: `w_${nodePath.basename(folder)}`,
      title: nodePath.basename(folder),
      folderPath: folder,
      registeredAt: "2026-10-29T00:00:00.000Z",
    });

    test("1：取り寄せの宛先が既にあれば断り、中身を消さない", async () => {
      const existing = nodePath.join(base, "作者のフォルダー");
      await put(existing, "大事な原稿.txt", "消してはいけない");

      const result = await cloneWithCredential(
        undefined,
        nodePath.join(base, "存在しない.git"),
        existing
      );

      expect(result.ok).toBe(false);
      expect(await read(existing, "大事な原稿.txt")).toBe("消してはいけない");
    });

    test("1：自分で作る宛先なら、失敗したあとに途中のフォルダーが残らない", async () => {
      const fresh = nodePath.join(base, "編集部", "x-editing");
      const result = await cloneWithCredential(undefined, nodePath.join(base, "存在しない.git"), fresh);
      expect(result.ok).toBe(false);
      await expect(fsp.stat(fresh)).rejects.toThrow();
    });

    test("3：台帳以外の変更が残っていれば、reset せずに止める（編集部の側）", async () => {
      const editor = await cloneInto("editor");
      const author = await cloneInto("author");
      await put(author, PROPOSALS, '{"kind":"decision","proposalId":"a1"}\n');
      await commitAll(author, "作者");
      await git(author, "push");
      // 編集部の作業フォルダーに、台帳でない未記録の変更がある
      await put(editor, "本文/メモ.txt", "消えてはいけない書きかけ");
      await put(editor, PROPOSALS, '{"kind":"proposal","id":"e1"}\n');
      await commitAll(editor, "ledger");

      const result = await reconcileDiverged(editor, runGit, { ledgerOnly: true });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toContain("GitHubと同期");
      expect(await read(editor, "本文/メモ.txt")).toBe("消えてはいけない書きかけ");
    });

    test("3：台帳以外に触れた「送れていない記録」があっても止める", async () => {
      const editor = await cloneInto("editor");
      const author = await cloneInto("author");
      await put(author, PROPOSALS, '{"kind":"decision","proposalId":"a1"}\n');
      await commitAll(author, "作者");
      await git(author, "push");
      await put(editor, "本文/001.txt", "編集部の送れていない記録");
      await commitAll(editor, "本文に触れた記録");

      const result = await reconcileDiverged(editor, runGit, { ledgerOnly: true });

      expect(result.ok).toBe(false);
      expect(await read(editor, "本文/001.txt")).toBe("編集部の送れていない記録");
    });

    test("3：publishLedger は、頭で本文などの未記録の変更を見つけたら何も送らない", async () => {
      const editor = await cloneInto("editor");
      await put(editor, "本文/001.txt", "書きかけ");
      await put(editor, PROPOSALS, '{"kind":"proposal","id":"e1"}\n');

      const failure = await publishLedger(workIn(editor), "テスト", runGit);

      expect(failure).toContain("未記録の変更");
      const log = await git(editor, "log", "--oneline", "origin/main..HEAD");
      expect(log).toBe("");
    });

    test("8：置き場が書庫そのもの（作品を含む）なら、reset を走らせない", async () => {
      // 書庫そのものがリポジトリで、作品フォルダーを含む。分かれている
      const library = await cloneInto("書庫");
      const editor = await cloneInto("editor");
      await put(editor, "本文/002.txt", "別の機械の書き込み");
      await commitAll(editor, "別の機械");
      await git(editor, "push");
      await put(library, "作品A/本文/001.txt", "作者が書いた未送信の原稿");
      await commitAll(library, "作者の原稿");

      const result = await reconcileDiverged(library, runGit, {
        registeredWorks: [workIn(nodePath.join(library, "作品A"))],
      });

      expect(result.ok).toBe(false);
      // 原稿は消えていない。HEAD も動いていない
      expect(await read(library, "作品A/本文/001.txt")).toBe("作者が書いた未送信の原稿");
      expect(await git(library, "log", "--oneline", "origin/main..HEAD")).not.toBe("");
    });

    test("8：作品の中の置き場にも走らせない", async () => {
      const inside = await cloneInto("作品A");
      const result = await reconcileDiverged(inside, runGit, {
        registeredWorks: [workIn(inside)],
      });
      expect(result.ok).toBe(false);
    });

    test("7：分かれたままの編集用フォルダーでも、取り込みは相手の最新の鍵を読む", async () => {
      const editingX = await cloneInto("editing");
      const editor = await cloneInto("editor");
      const workRoot = nodePath.join(base, "作品");
      await put(workRoot, nodePath.join(".aiwriter", "cache", "editing.json"), JSON.stringify({ folderPath: editingX }));
      const acquire =
        '{"kind":"acquire","file":"本文/001.txt","holder":"編集部","holderKind":"editor","time":"2026-10-29T10:00:00.000Z","note":""}';
      const release =
        '{"kind":"release","file":"本文/001.txt","holder":"編集部","holderKind":"editor","time":"2026-10-29T12:00:00.000Z","note":""}';

      // 作者の写しが送れていない（ahead）間に、編集部が鍵を取って解いて先に送った（behind）
      await put(editingX, LOCKS, `${acquire}\n`);
      await put(editingX, "本文/003.txt", "作者の写し");
      await commitAll(editingX, "作者の写し");
      await put(editor, LOCKS, `${acquire}\n${release}\n`);
      await commitAll(editor, "編集部");
      await git(editor, "push");

      rememberRegisteredWorks([workIn(workRoot)]);
      const result = await importEditorProposalsQuietly(workIn(workRoot), runGit);

      expect(result.status).toBe("done");
      const ledger = await read(workRoot, LOCKS);
      expect(ledger).toContain('"kind":"release"');
      rememberRegisteredWorks([]);
    });

    test("7：合わせ直せないとき（置き場が書庫を含む）も、上流の鍵を混ぜて読む", async () => {
      const editingX = await cloneInto("editing");
      const editor = await cloneInto("editor");
      const workRoot = nodePath.join(editingX, "作品");
      await fsp.mkdir(workRoot, { recursive: true });
      // 編集用フォルダーが、登録済みの作品を含んでいる（reset を走らせてはいけない形）
      await put(workRoot, nodePath.join(".aiwriter", "cache", "editing.json"), JSON.stringify({ folderPath: editingX }));
      const acquire =
        '{"kind":"acquire","file":"本文/001.txt","holder":"編集部","holderKind":"editor","time":"2026-10-29T10:00:00.000Z","note":""}';
      const release =
        '{"kind":"release","file":"本文/001.txt","holder":"編集部","holderKind":"editor","time":"2026-10-29T12:00:00.000Z","note":""}';
      await put(editingX, LOCKS, `${acquire}\n`);
      await put(editingX, "作品/原稿.txt", "作者の未送信の原稿");
      await commitAll(editingX, "作者");
      await put(editor, LOCKS, `${acquire}\n${release}\n`);
      await commitAll(editor, "編集部");
      await git(editor, "push");

      rememberRegisteredWorks([workIn(workRoot)]);
      await importEditorProposalsQuietly(workIn(workRoot), runGit);
      rememberRegisteredWorks([]);

      // reset は走っていない（原稿は残る）
      expect(await read(editingX, "作品/原稿.txt")).toBe("作者の未送信の原稿");
      // それでも上流の解除は読めている
      expect(await read(workRoot, LOCKS)).toContain('"kind":"release"');
    });
  });
});

