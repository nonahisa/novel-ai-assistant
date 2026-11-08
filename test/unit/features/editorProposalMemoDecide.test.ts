import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileSystemError,
  FileType,
  window,
  workspace,
} from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 校正・メモパネルの行から、編集者の提案を決める（作者の指示 2026-11-08
 * 「編集からの提案も校正メモにうつしてください」。設計書6.96.5・5.7.5.8）。
 *
 * 決める操作は提案パネルのころと同じ3つ——採る（本文を直す）／見送る／
 * 意見なら読んだ。**書く先も同じ台帳**（`proposals.jsonl` の decision の行）で、
 * 決め終えたら同じく自動で送り返す（`startReturnIfFinished`）。
 *
 * **本物のファイルシステムで走らせる**——確かめたいのは「台帳と本文に何が
 * 書かれたか」なので、作り物の円盤では確かめたことにならない。
 */

let editorMode = false;
vi.mock("../../../src/core/actorContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/actorContext")>();
  return { ...actual, isEditorMode: () => editorMode };
});

vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "Hisa Nonaka"),
}));

// 作者の GitHub の名前（決めた作者として採否の行に書き写す。0.138.0）
vi.mock("../../../src/features/authorGithubLogin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/features/authorGithubLogin")>();
  return { ...actual, authorGithubLogin: vi.fn(async () => "nonahisa") };
});

// 送り返しは git を使うので、ここでは「呼ばれたか」と「そのときの未決の数」だけを見る
const returnCalls: Array<{ workId: string; pending: number }> = [];
vi.mock("../../../src/features/editingAutomation", () => ({
  returnDecisionsIfFinished: vi.fn(async (work: WorkEntry) => {
    const { ProposalStore } = await import("../../../src/core/proposalStore");
    const pending = (await new ProposalStore(work).load()).filter(
      (view) => view.status === "pending"
    ).length;
    returnCalls.push({ workId: work.id, pending });
    return pending === 0 ? "sent" : "skipped";
  }),
}));

vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...actual, canRunProcesses: () => true };
});

const { decideEditorProposal, loadEditorProposalsForMemo } = await import(
  "../../../src/features/reviewProposals"
);
const { ProposalStore } = await import("../../../src/core/proposalStore");
const { ProposerLoginStore } = await import("../../../src/core/proposerLogins");
const { FileLockStore } = await import("../../../src/core/fileLockStore");

const BODY = nodePath.join("本文", "001.txt");

describe("校正・メモパネルの行から、編集者の提案を決める", () => {
  let base = "";
  let root = "";

  const work = (): WorkEntry => ({
    id: "work_memo",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-11-08T00:00:00.000Z",
  });

  const put = async (relative: string, text: string) => {
    const target = nodePath.join(root, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };

  const body = (): Promise<string> =>
    fsp.readFile(nodePath.join(root, BODY), "utf8");

  /** 台帳の decision の行（追記されたものだけ） */
  const decisions = async (): Promise<Array<Record<string, unknown>>> => {
    const raw = await fsp.readFile(
      nodePath.join(root, ".aiwriter", "proposals", "proposals.jsonl"),
      "utf8"
    );
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.kind === "decision");
  };

  /** 意見だけの提案は、行ぜんたいを `target` にして直した案を空にする（`handProposalTarget`） */
  const proposal = (id: string, line: number, original: string, target: string, suggestion: string, reason = "誤字") => ({
    id,
    time: "2026-11-08T01:00:00.000Z",
    proposer: "Kota Mizushima",
    file: "本文/001.txt",
    line,
    original,
    target,
    suggestion,
    reason,
    category: "誤字脱字",
  });

  beforeEach(async () => {
    editorMode = false;
    returnCalls.length = 0;
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-memo-proposal-"));
    root = nodePath.join(base, "氷の街");
    await fsp.mkdir(root, { recursive: true });

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        try {
          const stat = await fsp.stat(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            size: stat.size,
          };
        } catch {
          throw new FileSystemError(uri.fsPath, "FileNotFound");
        }
      },
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(await fsp.readFile(uri.fsPath));
        } catch {
          throw new FileSystemError(uri.fsPath, "FileNotFound");
        }
      },
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
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        await fsp.rename(from.fsPath, to.fsPath);
      },
      copy: async (from: { fsPath: string }, to: { fsPath: string }) => {
        await fsp.cp(from.fsPath, to.fsPath, { recursive: true, force: true });
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
    try {
      await fsp.rm(base, { recursive: true, force: true });
    } catch {
      // 一時フォルダーなので、消せなくても結果に関わらない
    }
  });

  /** 送り返しは待たずに走る（動的 import の先）ので、少し回して落ち着かせる */
  const settle = async () => {
    for (let round = 0; round < 20; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  test("並べる行：作者モードの未決だけ。理由に「（kmizu の提案）」を添える", async () => {
    await new ProposalStore(work()).propose([
      proposal("p1", 1, "　彼は走つた。", "走つた", "走った"),
      proposal("p2", 2, "　夜が明けた。", "　夜が明けた。", "", "間が長い"),
      proposal("p3", 3, "　三行目。", "三", "3"),
    ]);
    await new ProposalStore(work()).decide([
      { proposalId: "p3", time: "2026-11-08T02:00:00.000Z", decidedBy: "x", status: "rejected", note: "" },
    ]);
    await new ProposerLoginStore(work()).remember(["p1"], "kmizu");

    const rows = await loadEditorProposalsForMemo(work());

    expect(rows.map((row) => row.id)).toEqual(["p1", "p2"]);
    expect(rows[0].reason).toBe("誤字（kmizu の提案）");
    // 名前の覚えが無い提案には添えない。git の名前は出さない
    expect(rows[1].reason).toBe("間が長い");
    expect(rows.map((row) => row.reason).join("")).not.toContain("Kota Mizushima");
    expect(rows[1].opinionOnly).toBe(true);
    expect(rows[0].opinionOnly).toBe(false);
  });

  test("編集者モードでは並べない（編集者モードは今のまま提案パネルの側）", async () => {
    await new ProposalStore(work()).propose([proposal("p1", 1, "　彼は走つた。", "走つた", "走った")]);
    editorMode = true;

    expect(await loadEditorProposalsForMemo(work())).toEqual([]);
  });

  test("採る：本文のその1か所だけを直し、台帳へ accepted と決めた作者の GitHub 名を書く", async () => {
    await put(BODY, "　彼は走つた。\r\n　夜が明けた。\r\n");
    await new ProposalStore(work()).propose([
      proposal("p1", 1, "　彼は走つた。", "走つた", "走った"),
      proposal("p2", 2, "　夜が明けた。", "明けた", "明けてゆく"),
    ]);
    const [row] = await loadEditorProposalsForMemo(work());

    const outcome = await decideEditorProposal(work(), row, "accept");

    expect(outcome.ok).toBe(true);
    // 改行の形（CRLF）を保ったまま、その1か所だけ
    expect(await body()).toBe("　彼は走った。\r\n　夜が明けた。\r\n");
    const written = await decisions();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      proposalId: "p1",
      status: "accepted",
      decidedBy: "Hisa Nonaka",
      decidedByLogin: "nonahisa",
    });
  });

  test("見送る：本文に触らず、台帳へ rejected を書く", async () => {
    await put(BODY, "　彼は走つた。\n");
    await new ProposalStore(work()).propose([
      proposal("p1", 1, "　彼は走つた。", "走つた", "走った"),
      proposal("p2", 1, "　彼は走つた。", "彼", "かれ"),
    ]);
    const rows = await loadEditorProposalsForMemo(work());

    const outcome = await decideEditorProposal(work(), rows[0], "reject");

    expect(outcome.ok).toBe(true);
    expect(await body()).toBe("　彼は走つた。\n");
    expect(await decisions()).toEqual([
      expect.objectContaining({ proposalId: "p1", status: "rejected", decidedByLogin: "nonahisa" }),
    ]);
  });

  test("意見だけの提案は「読んだ」：本文に触らず、台帳へ read を書く", async () => {
    await put(BODY, "　夜が明けた。\n");
    await new ProposalStore(work()).propose([proposal("p1", 1, "　夜が明けた。", "　夜が明けた。", "", "ここは間が長い")]);
    const [row] = await loadEditorProposalsForMemo(work());

    const outcome = await decideEditorProposal(work(), row, "accept");

    expect(outcome.ok).toBe(true);
    expect(await body()).toBe("　夜が明けた。\n");
    expect(await decisions()).toEqual([
      expect.objectContaining({ proposalId: "p1", status: "read" }),
    ]);
  });

  test("提案が届いてから本文が変わっていたら、書き換えずに理由を返し、台帳にも書かない", async () => {
    await put(BODY, "　彼は駆けた。\n");
    await new ProposalStore(work()).propose([proposal("p1", 1, "　彼は走つた。", "走つた", "走った")]);
    const [row] = await loadEditorProposalsForMemo(work());

    const outcome = await decideEditorProposal(work(), row, "accept");

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("本文が変わっている");
    expect(await body()).toBe("　彼は駆けた。\n");
    expect(await decisions()).toEqual([]);
  });

  test("編集者が校閲中の話は採らない（提案パネルの［適用］と同じ関門）", async () => {
    await put(BODY, "　彼は走つた。\n");
    await new ProposalStore(work()).propose([proposal("p1", 1, "　彼は走つた。", "走つた", "走った")]);
    await new FileLockStore(work()).acquire(["本文/001.txt"], "kmizu", "editor", "校閲中");
    const [row] = await loadEditorProposalsForMemo(work());

    const outcome = await decideEditorProposal(work(), row, "accept");

    expect(outcome.ok).toBe(false);
    expect(await body()).toBe("　彼は走つた。\n");
    expect(await decisions()).toEqual([]);
    expect(vi.mocked(window.showWarningMessage)).toHaveBeenCalled();
  });

  test("最後の1件を決めると、送り返しが走る（決め終えた台帳で呼ばれる）", async () => {
    await put(BODY, "　彼は走つた。\n　夜が明けた。\n");
    await new ProposalStore(work()).propose([
      proposal("p1", 1, "　彼は走つた。", "走つた", "走った"),
      proposal("p2", 2, "　夜が明けた。", "　夜が明けた。", "", "間が長い"),
    ]);
    const rows = await loadEditorProposalsForMemo(work());

    await decideEditorProposal(work(), rows[0], "accept");
    await settle();
    expect(returnCalls.at(-1)).toEqual({ workId: "work_memo", pending: 1 });

    await decideEditorProposal(work(), rows[1], "accept");
    await settle();
    // 決め終えた（未決0）ところで呼ばれている＝送り返しの条件が揃う
    expect(returnCalls.at(-1)).toEqual({ workId: "work_memo", pending: 0 });
  });
});
