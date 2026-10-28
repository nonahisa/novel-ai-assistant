import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 校閲の範囲＝鍵の集合（作者の裁定、2026-10-28）。
 *
 * - 範囲の話は、作者の送り直しで**消えず・写らず・作者の側で消えていても消えない**
 * - 鍵の台帳は両方向に流れ、acquire も release も作者の側へ届く
 * - 本文への書き込みの共通の入口は、編集部の鍵がかかった話を断る
 * - 提案の台帳への書き込みは1本ずつ通り、取り込みと採否が重なっても行が消えない
 *
 * 本物のファイルシステムで走らせる（`shareWithEditor.test.ts` と同じ理由）。
 */

vi.mock("../../../src/core/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/git")>()),
  // 取り寄せは通ったことにする。ここで見たいのは取り込みの後である
  pullFastForward: vi.fn(async () => ({ ok: true })),
}));

const { copyForEditor, importEditorProposalsQuietly } = await import(
  "../../../src/features/shareWithEditor"
);
const { installEditorLockGuard } = await import("../../../src/features/editorLockGuard");
const { writeTextFilePreservingFormat, readTextFile, setBodyWriteGuard } = await import(
  "../../../src/core/textFile"
);
const { workPaths } = await import("../../../src/core/workRegistry");
const { FileLockStore, editorLockOf } = await import("../../../src/core/fileLockStore");
const { ProposalStore } = await import("../../../src/core/proposalStore");

const LOCKS = nodePath.join(".aiwriter", "locks", "locks.jsonl");
const PROPOSALS = nodePath.join(".aiwriter", "proposals", "proposals.jsonl");
const POINTER = nodePath.join(".aiwriter", "cache", "editing.json");

function lockLine(
  kind: "acquire" | "release",
  file: string,
  holderKind: "editor" | "author",
  time: string
): string {
  return JSON.stringify({ kind, file, holder: "編集部", holderKind, time, note: "" });
}

describe("校閲の範囲", () => {
  let base = "";
  let root = "";
  let editing = "";

  const work = (): WorkEntry => ({
    id: "work_lock",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-10-28T00:00:00.000Z",
  });

  const put = async (dir: string, relative: string, text: string) => {
    const target = nodePath.join(dir, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };
  const read = (dir: string, relative: string): Promise<string> =>
    fsp.readFile(nodePath.join(dir, relative), "utf8");
  const has = async (dir: string, relative: string): Promise<boolean> => {
    try {
      await fsp.stat(nodePath.join(dir, relative));
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-lock-"));
    root = nodePath.join(base, "氷の街");
    editing = nodePath.join(base, "編集用");
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(editing, { recursive: true });

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
      copy: async (source: { fsPath: string }, target: { fsPath: string }) => {
        await fsp.cp(source.fsPath, target.fsPath, { recursive: true, force: true });
      },
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });
  });

  afterEach(async () => {
    setBodyWriteGuard(undefined);
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  const share = () => copyForEditor(workPaths(work()), editing, undefined, undefined);
  const editorHolds = (file: string) =>
    put(editing, LOCKS, `${lockLine("acquire", file, "editor", "2026-10-28T10:00:00.000Z")}\n`);

  describe("送り直し（copyForEditor）", () => {
    beforeEach(async () => {
      // 前回渡した状態：編集用に 001〜003 がある
      for (const name of ["001", "002", "003"]) {
        await put(editing, nodePath.join("本文", `${name}.txt`), `前回-${name}`);
      }
      await editorHolds("本文/002.txt");
    });

    test("範囲内は写らない・消えない。範囲外は写る", async () => {
      await put(root, nodePath.join("本文", "001.txt"), "新-001");
      await put(root, nodePath.join("本文", "002.txt"), "新-002");
      await put(root, nodePath.join("本文", "003.txt"), "新-003");

      const result = await share();

      expect(await read(editing, nodePath.join("本文", "001.txt"))).toBe("新-001");
      // 校閲中の話は、作者の版で上書きしない
      expect(await read(editing, nodePath.join("本文", "002.txt"))).toBe("前回-002");
      expect(await read(editing, nodePath.join("本文", "003.txt"))).toBe("新-003");
      expect(result.skippedLocked).toEqual(["本文/002.txt"]);
    });

    test("範囲内の話が作者の側で消えていても、編集用からは消さない", async () => {
      await put(root, nodePath.join("本文", "001.txt"), "新-001");
      // 002 は作者の側に無い。003 も無い

      await share();

      expect(await has(editing, nodePath.join("本文", "002.txt"))).toBe(true);
      // 範囲外の 003 は今までどおり、作者の側で消えれば消える
      expect(await has(editing, nodePath.join("本文", "003.txt"))).toBe(false);
    });

    test("鍵の解除の行を送ると、その話は次の送り直しから写る", async () => {
      await put(root, nodePath.join("本文", "002.txt"), "新-002");
      // 作者が連携を解除した行（作者の側の台帳にだけある）
      await put(
        root,
        LOCKS,
        `${lockLine("release", "本文/002.txt", "author", "2026-10-28T11:00:00.000Z")}\n`
      );

      const result = await share();

      expect(await read(editing, nodePath.join("本文", "002.txt"))).toBe("新-002");
      expect(result.skippedLocked).toEqual([]);
      // 鍵の台帳は両方向に流れる（編集部の取得の行も、作者の解除の行も残る）
      const ledger = await read(editing, LOCKS);
      expect(ledger).toContain('"kind":"acquire"');
      expect(ledger).toContain('"kind":"release"');
    });

    test("鍵が無い（範囲なし）ときは、今までどおり本文をまるごと置き換える", async () => {
      await fsp.rm(nodePath.join(editing, LOCKS));
      await put(root, nodePath.join("本文", "001.txt"), "新-001");

      await share();

      expect(await has(editing, nodePath.join("本文", "002.txt"))).toBe(false);
      expect(await read(editing, nodePath.join("本文", "001.txt"))).toBe("新-001");
    });
  });

  describe("鍵の取り込み", () => {
    beforeEach(async () => {
      await put(root, POINTER, JSON.stringify({ folderPath: editing }));
    });

    test("編集部の acquire が届き、解除（release）も届く", async () => {
      await put(
        editing,
        LOCKS,
        [
          lockLine("acquire", "本文/002.txt", "editor", "2026-10-28T10:00:00.000Z"),
          lockLine("acquire", "本文/003.txt", "editor", "2026-10-28T10:00:01.000Z"),
        ].join("\n") + "\n"
      );

      const first = await importEditorProposalsQuietly(work());
      expect(first.status).toBe("done");
      if (first.status !== "done") return;
      expect([...first.locksAcquired].sort()).toEqual(["本文/002.txt", "本文/003.txt"]);
      expect(first.locksReleased).toEqual([]);
      expect((await editorLockOf(work(), nodePath.join(root, "本文", "002.txt")))?.holderKind).toBe(
        "editor"
      );

      // 編集部が校閲を終えて返した（release の行が足された）
      await put(
        editing,
        LOCKS,
        [
          lockLine("acquire", "本文/002.txt", "editor", "2026-10-28T10:00:00.000Z"),
          lockLine("acquire", "本文/003.txt", "editor", "2026-10-28T10:00:01.000Z"),
          lockLine("release", "本文/002.txt", "editor", "2026-10-28T12:00:00.000Z"),
          lockLine("release", "本文/003.txt", "editor", "2026-10-28T12:00:01.000Z"),
        ].join("\n") + "\n"
      );
      const second = await importEditorProposalsQuietly(work());
      if (second.status !== "done") throw new Error("取り込めていない");
      expect([...second.locksReleased].sort()).toEqual(["本文/002.txt", "本文/003.txt"]);
      expect(await editorLockOf(work(), nodePath.join(root, "本文", "002.txt"))).toBeUndefined();
    });

    test("同じ内容をもう一度取り込んでも、鍵は動いたことにならない", async () => {
      await put(
        editing,
        LOCKS,
        `${lockLine("acquire", "本文/002.txt", "editor", "2026-10-28T10:00:00.000Z")}\n`
      );
      await importEditorProposalsQuietly(work());
      const again = await importEditorProposalsQuietly(work());
      if (again.status !== "done") throw new Error("取り込めていない");
      expect(again.locksAcquired).toEqual([]);
      expect(again.locksReleased).toEqual([]);
    });
  });

  describe("本文への書き込みの共通の入口", () => {
    test("編集部が校閲中の話への書き込みは断る。ほかの話は断らない", async () => {
      await put(root, nodePath.join("本文", "001.txt"), "ゆき");
      await put(root, nodePath.join("本文", "002.txt"), "あめ");
      await put(
        root,
        LOCKS,
        `${lockLine("acquire", "本文/002.txt", "editor", "2026-10-28T10:00:00.000Z")}\n`
      );
      const guard = installEditorLockGuard({ list: () => [work()] });

      const locked = nodePath.join(root, "本文", "002.txt");
      const lockedContent = await readTextFile(locked);
      const refused = await writeTextFilePreservingFormat(
        locked,
        "あめ、のち雪",
        lockedContent,
        lockedContent.hash
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toBe("editor_locked");
        expect(refused.detail).toContain("編集部が校閲中");
      }
      // ファイルは1バイトも変わらない
      expect(await read(root, nodePath.join("本文", "002.txt"))).toBe("あめ");

      const free = nodePath.join(root, "本文", "001.txt");
      const freeContent = await readTextFile(free);
      const allowed = await writeTextFilePreservingFormat(
        free,
        "ゆき、のち雨",
        freeContent,
        freeContent.hash
      );
      expect(!allowed.ok && allowed.reason === "editor_locked").toBe(false);
      guard.dispose();
    });

    test("作者の台帳に自分の鍵があっても（holderKind が author）、断らない", async () => {
      await put(root, nodePath.join("本文", "001.txt"), "ゆき");
      await put(
        root,
        LOCKS,
        `${lockLine("acquire", "本文/001.txt", "author", "2026-10-28T10:00:00.000Z")}\n`
      );
      const guard = installEditorLockGuard({ list: () => [work()] });
      const target = nodePath.join(root, "本文", "001.txt");
      const content = await readTextFile(target);
      const result = await writeTextFilePreservingFormat(target, "ゆき。", content, content.hash);
      expect(!result.ok && result.reason === "editor_locked").toBe(false);
      guard.dispose();
    });
  });

  describe("台帳への書き込みの鎖", () => {
    test("取り込みと採否の書き込みが重なっても、両方の行が残る", async () => {
      const proposals = new ProposalStore(work());
      const incoming = Array.from({ length: 10 }, (_, index) =>
        JSON.stringify({
          kind: "proposal",
          id: `in-${index}`,
          time: "2026-10-28T09:00:00.000Z",
          proposer: "編集部",
          file: "本文/001.txt",
          line: 1,
          original: "あ",
          target: "あ",
          suggestion: "い",
          reason: "",
          category: "",
        })
      ).join("\n");

      // 採否の書き込み（追記）と取り込み（混ぜる）を、順番を入り交ぜて同時に走らせる
      const decisions = Array.from({ length: 10 }, (_, index) =>
        proposals.decide([
          {
            proposalId: `in-${index}`,
            time: "2026-10-28T09:30:00.000Z",
            decidedBy: "作者",
            status: "accepted",
            note: "",
          },
        ])
      );
      await Promise.all([proposals.mergeIncoming(incoming), ...decisions]);
      await Promise.all([proposals.mergeIncoming(incoming)]);

      const lines = (await read(root, PROPOSALS)).split("\n").filter((line) => line.trim().length > 0);
      const kinds = lines.map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds.filter((kind) => kind === "proposal")).toHaveLength(10);
      expect(kinds.filter((kind) => kind === "decision")).toHaveLength(10);
    });

    test("鍵の台帳も同じ鎖：複数の acquire と取り込みが重なっても行が消えない", async () => {
      const store = new FileLockStore(work());
      const incoming = lockLine("acquire", "本文/009.txt", "editor", "2026-10-28T08:00:00.000Z");
      await Promise.all([
        store.mergeIncoming(incoming),
        store.acquire(["本文/001.txt"], "作者", "author", ""),
        store.acquire(["本文/002.txt"], "作者", "author", ""),
        store.mergeIncoming(incoming),
      ]);
      const locks = await store.load();
      expect([...locks.keys()].sort()).toEqual(["本文/001.txt", "本文/002.txt", "本文/009.txt"]);
    });
  });
});
