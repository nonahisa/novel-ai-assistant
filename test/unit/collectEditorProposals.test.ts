import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";

/**
 * 編集部の提案を取り込む（設計書5.6.11）。
 *
 * **確かめたいのは1つ——本文に触っていないこと。**
 *
 * 編集部は本文を書き換えない決まりで、直した案は提案として置かれる。
 * 取り込みがうっかり本文まで持ってきたら、その決まりが崩れる。
 * しかも**作者は気づかない**——提案パネルを見に行くので、本文が入れ替わって
 * いても、そこで初めて気づくのは何話か書いたあとになる。
 *
 * 実機確認リスト A-6 の「取り込んだあと、本文が変わっていないか」に当たる。
 *
 * **本物のファイルシステムで走らせる**（`shareWithEditor.test.ts` と同じ理由）。
 * 「何を書いたか」を見るのが目的なので、作り物の円盤では確かめたことにならない。
 */

vi.mock("../../src/core/git", () => ({
  // 取り寄せは通ったことにする。ここで見たいのは取り寄せの後である
  pullFastForward: vi.fn(async () => ({ ok: true, detail: "" })),
  runGit: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
}));

vi.mock("../../src/views/progress", () => ({
  withProgress: async <T>(_title: string, run: () => Promise<T>) => run(),
}));

const { collectEditorProposals } = await import(
  "../../src/features/shareWithEditor"
);

const PROPOSAL_RELATIVE = nodePath.join(
  ".aiwriter",
  "proposals",
  "proposals.jsonl"
);
const POINTER_RELATIVE = nodePath.join(".aiwriter", "cache", "editing.json");
const BODY_RELATIVE = nodePath.join("本文", "001.txt");

/** 提案1件ぶんの行 */
function proposal(id: string): string {
  return JSON.stringify({ id, kind: "typo", note: `直し${id}` });
}

describe("編集部の提案を取り込む", () => {
  let base = "";
  let root = "";
  let editing = "";
  let messages: string[] = [];

  const work = (): WorkEntry => ({
    id: "work_test",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-09-13T00:00:00.000Z",
  });

  const put = async (dir: string, relative: string, text: string) => {
    const target = nodePath.join(dir, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };

  const read = (dir: string, relative: string): Promise<string> =>
    fsp.readFile(nodePath.join(dir, relative), "utf8");

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-collect-"));
    root = nodePath.join(base, "氷の街");
    editing = nodePath.join(base, "氷の街-編集用");
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(editing, { recursive: true });
    messages = [];

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
    } as unknown as typeof workspace.fs;

    Object.assign(window, {
      showInformationMessage: vi.fn(async (text: string) => {
        messages.push(text);
        return "閉じる";
      }),
      showWarningMessage: vi.fn(async (text: string) => {
        messages.push(text);
        return undefined;
      }),
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
    });
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    try {
      await fsp.rm(base, { recursive: true, force: true });
    } catch {
      // 一時フォルダーなので、消せなくても結果に関わらない
    }
  });

  test("**本文は1バイトも変わらない**", async () => {
    const body = "　雪が降っていた。\r\n　彼女は黙っていた。\r\n";
    await put(root, BODY_RELATIVE, body);
    await put(root, POINTER_RELATIVE, JSON.stringify({ folderPath: editing }));
    await put(editing, PROPOSAL_RELATIVE, `${proposal("a")}\n`);

    await collectEditorProposals(work());

    // 提案は入っている（取り込み自体は動いている）
    expect(await read(root, PROPOSAL_RELATIVE)).toContain(proposal("a"));
    // **本文はそのまま。** 改行コードまで見る
    expect(await read(root, BODY_RELATIVE)).toBe(body);
  });

  test("**書くのは提案の台帳だけ**（ほかのファイルを増やさない）", async () => {
    await put(root, BODY_RELATIVE, "ゆき");
    await put(root, nodePath.join("設定", "characters", "c1.json"), "{}");
    await put(root, POINTER_RELATIVE, JSON.stringify({ folderPath: editing }));
    await put(editing, PROPOSAL_RELATIVE, `${proposal("a")}\n`);
    // 編集用フォルダーにだけ在るもの。取り込みで持ってこない
    await put(editing, nodePath.join("本文", "999.txt"), "編集部が足した話");

    await collectEditorProposals(work());

    const names = await fsp.readdir(nodePath.join(root, "本文"));
    expect(names).toEqual(["001.txt"]);
    expect(await read(root, nodePath.join("設定", "characters", "c1.json"))).toBe(
      "{}"
    );
  });

  test("まだ渡していない作品では、その旨を伝えて何もしない", async () => {
    await put(root, BODY_RELATIVE, "ゆき");
    // 行き先の記録が無い

    await collectEditorProposals(work());

    expect(messages.join("\n")).toContain("まだ編集部へ渡していません");
    // 台帳を作らない（空のファイルを置き去りにしない）
    await expect(read(root, PROPOSAL_RELATIVE)).rejects.toThrow();
  });

  test("提案がまだ無いときも、何も書かない", async () => {
    await put(root, BODY_RELATIVE, "ゆき");
    await put(root, POINTER_RELATIVE, JSON.stringify({ folderPath: editing }));
    await put(editing, PROPOSAL_RELATIVE, "");

    await collectEditorProposals(work());

    expect(messages.join("\n")).toContain("提案はまだありません");
    await expect(read(root, PROPOSAL_RELATIVE)).rejects.toThrow();
  });

  test("同じものを2回取り込んでも、二重にならない", async () => {
    await put(root, POINTER_RELATIVE, JSON.stringify({ folderPath: editing }));
    await put(editing, PROPOSAL_RELATIVE, `${proposal("a")}\n${proposal("b")}\n`);

    await collectEditorProposals(work());
    await collectEditorProposals(work());

    const lines = (await read(root, PROPOSAL_RELATIVE))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(messages.join("\n")).toContain("すべて取り込み済み");
  });
});
