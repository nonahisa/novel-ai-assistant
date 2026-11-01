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

const { proposeByHand, proposeEditFromCommand } = await import(
  "../../../src/features/handProposal"
);
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

  test("原稿エディターから選ばずに頼まれたら、選び方を案内する", async () => {
    const said: string[] = [];
    window.showWarningMessage = async (text: string) => {
      said.push(text);
      return undefined;
    };
    // 画面は選んでいないとき -1 を送り、受け口で 0〜0 の空の範囲になる
    const placed = await proposeByHand(work, fakeDocument(body), range(0, 0, 0, 0), "edit");
    expect(placed).toBe(false);
    expect(said).toEqual([
      "直したい所を本文で選んでから押してください（右クリックからも出せます）。",
    ]);
  });
});

/**
 * 詳細メニュー（作品管理 → 編集部連携）からも「直しを提案する」を押せる
 * （作者の決定 2026-11-01）。メニューを押した時点では選んでいる所が本文の側にしか無いので、
 * 前面の原稿エディターへ頼み返すか、素のエディターの選択を使う。
 */
describe("コマンド（詳細メニュー・コマンドパレット）からの「直しを提案する」", () => {
  function commandDeps(over: Partial<Parameters<typeof proposeEditFromCommand>[0]> = {}) {
    const proposed: unknown[] = [];
    return {
      proposed,
      deps: {
        askManuscript: () => false,
        activeEditor: () => undefined,
        propose: async (document: unknown, picked: unknown) => {
          proposed.push({ document, picked });
        },
        ...over,
      },
    };
  }

  function listenInfo(): string[] {
    const said: string[] = [];
    window.showInformationMessage = async (text: string) => {
      said.push(text);
      return undefined;
    };
    return said;
  }

  test("作者モードでは置かずに、編集者モードの操作だと理由を出す", async () => {
    editorMode = false;
    const said = listenInfo();
    let asked = false;
    const { deps, proposed } = commandDeps({
      askManuscript: () => {
        asked = true;
        return true;
      },
    });
    expect(await proposeEditFromCommand(deps)).toBe("notEditor");
    expect(asked).toBe(false);
    expect(proposed).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("編集者モード");
  });

  test("前面に原稿エディターがあれば、その画面の選択で進む", async () => {
    const { deps, proposed } = commandDeps({ askManuscript: () => true });
    expect(await proposeEditFromCommand(deps)).toBe("manuscript");
    expect(proposed).toEqual([]);
  });

  test("素のエディターで選んでいれば、そのまま入力へ進む", async () => {
    const document = fakeDocument(body);
    const selection = range(0, 2, 0, 5);
    const { deps, proposed } = commandDeps({
      activeEditor: () => ({ document, selection }),
    });
    expect(await proposeEditFromCommand(deps)).toBe("proposed");
    expect(proposed).toEqual([{ document, picked: selection }]);
  });

  test("選んでいなければ、本文で選んでから押すよう案内する", async () => {
    const said = listenInfo();
    const document = fakeDocument(body);
    const { deps, proposed } = commandDeps({
      activeEditor: () => ({ document, selection: range(0, 2, 0, 2) }),
    });
    expect(await proposeEditFromCommand(deps)).toBe("noSelection");
    expect(proposed).toEqual([]);
    expect(said).toEqual([
      "直したい所を本文で選んでから押してください（右クリックからも出せます）。",
    ]);
  });

  test("本文が開いていなくても、同じ案内を出す", async () => {
    const said = listenInfo();
    const { deps } = commandDeps();
    expect(await proposeEditFromCommand(deps)).toBe("noSelection");
    expect(said).toEqual([
      "直したい所を本文で選んでから押してください（右クリックからも出せます）。",
    ]);
  });
});
