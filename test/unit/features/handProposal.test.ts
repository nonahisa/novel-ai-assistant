import { beforeEach, describe, expect, test, vi } from "vitest";
import { Position, Range, Uri, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集部の手書きの直し（設計書5.6.1.1。作者の指示 2026-11-01「作る」）。
 *
 * 編集部役の実機確認で「校閲開始」のあと、どうやって校閲するのか分からず
 * 止まった。手で書く道を足したので、**本文が変わらないこと**と、**検知の
 * ［適用］と同じ台帳へ置かれること**を確かめる。
 */

/** 偽の本文（ディスクの側）。書き込みが起きればここが変わるはずだが、変わらない */
let diskText = "";
/** 偽のディスク（`proposals.jsonl` はここに溜まる） */
const files = new Map<string, Uint8Array>();
let editorMode = true;

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => editorMode,
  manualActor: () => (editorMode ? "editor" : "author"),
  recordEdit: vi.fn(async () => undefined),
}));

vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "編集部"),
}));

vi.mock("../../../src/views/notify", () => ({
  notifyDone: vi.fn(),
}));

// **本文の書き込みは `writeTextFilePreservingFormat` だけを通る**（実装ルール1）。
// この機能では1回も呼ばれないことを、このモックで確かめる
vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: diskText,
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  writeTextFilePreservingFormat: vi.fn(async () => ({ ok: true })),
}));

const { proposeByHand } = await import("../../../src/features/handProposal");
const { writeTextFilePreservingFormat } = await import("../../../src/core/textFile");
const { ProposalStore } = await import("../../../src/core/proposalStore");

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-06T00:00:00.000Z",
};
const filePath = "C:/小説/いじめられっ子/本文/003.txt";
const body = "　彼女が走った。彼は走つた。\n　夜が明けた。\n";

function fakeDocument(text: string) {
  const lines = text.split("\n");
  return {
    uri: Uri.file(filePath),
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  } as unknown as Parameters<typeof proposeByHand>[1];
}

function range(line: number, start: number, endLine: number, end: number) {
  return new Range(
    new Position(line, start),
    new Position(endLine, end)
  ) as unknown as Parameters<typeof proposeByHand>[2];
}

/** 入力欄に順に答える */
function answer(...values: Array<string | undefined>): void {
  const queue = [...values];
  window.showInputBox = async () => queue.shift();
}

function ledger(): string {
  const found = [...files.entries()].find(([key]) =>
    key.replace(/\\/g, "/").endsWith("proposals/proposals.jsonl")
  );
  return found ? new TextDecoder().decode(found[1]) : "";
}

beforeEach(() => {
  diskText = body;
  editorMode = true;
  files.clear();
  vi.mocked(writeTextFilePreservingFormat).mockClear();
  window.showWarningMessage = async () => undefined;
  window.showInformationMessage = async () => undefined;
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new Error("FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(uri.fsPath, bytes);
    },
    createDirectory: async () => undefined,
  } as unknown as typeof workspace.fs;
});

describe("編集部の手書きの直しは、本文を書き換えず提案として置く", () => {
  test("選んだ所の直した案と理由が台帳へ積まれ、本文は変わらない", async () => {
    answer("走った", "促音の誤り");
    const at = body.indexOf("走つた");

    const placed = await proposeByHand(
      work,
      fakeDocument(body),
      range(0, at, 0, at + 3),
      "edit"
    );

    expect(placed).toBe(true);
    expect(writeTextFilePreservingFormat).not.toHaveBeenCalled();
    expect(diskText).toBe(body);

    const [proposal] = await new ProposalStore(work).load();
    expect(proposal).toMatchObject({
      line: 1,
      target: "走つた",
      suggestion: "走った",
      reason: "促音の誤り",
      category: "編集部の直し",
      proposer: "編集部",
      status: "pending",
    });
  });

  test("直した案を空にすると、意見だけの提案になる", async () => {
    answer("", "ここは言い切らないほうが余韻が出ます");
    const at = body.indexOf("走つた");

    await proposeByHand(work, fakeDocument(body), range(0, at, 0, at + 3), "edit");

    const [proposal] = await new ProposalStore(work).load();
    expect(proposal.suggestion).toBe("");
    expect(proposal.reason).toBe("ここは言い切らないほうが余韻が出ます");
  });

  test("編集者モードのメモは、その行への意見として置かれる（行は挿さない）", async () => {
    answer("この行の情景をもう少し");

    await proposeByHand(work, fakeDocument(body), range(1, 2, 1, 2), "memo");

    expect(writeTextFilePreservingFormat).not.toHaveBeenCalled();
    const [proposal] = await new ProposalStore(work).load();
    expect(proposal).toMatchObject({
      line: 2,
      original: "　夜が明けた。",
      target: "　夜が明けた。",
      suggestion: "",
      category: "編集部のメモ",
    });
  });

  test("保存されている本文と合わなければ置かない（実在の確認）", async () => {
    // 画面の文書には保存していない変更が乗っている体にする
    diskText = "　彼女は歩いた。\n";
    answer("走った", "促音");
    const at = body.indexOf("走つた");

    const placed = await proposeByHand(
      work,
      fakeDocument(body),
      range(0, at, 0, at + 3),
      "edit"
    );

    expect(placed).toBe(false);
    expect(ledger()).toBe("");
  });

  test("行をまたいだ選択は断る", async () => {
    answer("x", "y");
    const placed = await proposeByHand(work, fakeDocument(body), range(0, 2, 1, 3), "edit");
    expect(placed).toBe(false);
    expect(ledger()).toBe("");
  });

  test("作者モードでは置かない（作者は本文をそのまま直せる）", async () => {
    editorMode = false;
    answer("走った", "促音");
    const at = body.indexOf("走つた");

    const placed = await proposeByHand(
      work,
      fakeDocument(body),
      range(0, at, 0, at + 3),
      "edit"
    );

    expect(placed).toBe(false);
    expect(ledger()).toBe("");
  });
});
