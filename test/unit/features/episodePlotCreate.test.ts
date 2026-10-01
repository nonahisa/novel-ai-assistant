import * as path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  commands,
  FileSystemError,
  Uri,
  window,
  workspace,
} from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「単話プロットを作る」を**実際に動かして**、既にある単話プロットを
 * 上書きしないことを見る（設計書6.36.2。実機確認リスト F-31 の代わり）。
 *
 * `episodePlotNoOverwrite.test.ts` は書き方の形（`mode: "create"` だけ・
 * 先に有無を確かめる）を見ている。そちらの断り書きのとおり、**既存の
 * ファイルが実際に残るか**は動かさないと分からないので、ここで動かす。
 * 無いときに雛形ができることも見る——片方だけだと「何もしない」実装でも通る。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
}));

const { createEpisodePlot } = await import("../../../src/features/resumeWriting");

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const plotPath = Uri.file(
  path.join(work.folderPath, "設定", "episode-plots", "第3話.md")
).fsPath;

const disk = new Map<string, Uint8Array>();
let opened: unknown[][] = [];
let informed: string[] = [];
const originalExecute = commands.executeCommand;
const originalInfo = window.showInformationMessage;

const utf8 = (text: string) => new TextEncoder().encode(text);
const read = (key: string) => new TextDecoder().decode(disk.get(key));

beforeEach(() => {
  disk.clear();
  opened = [];
  informed = [];
  workspace.textDocuments = [];
  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
    readDirectory: async () => [],
  } as unknown as typeof workspace.fs;
  (commands as { executeCommand?: unknown }).executeCommand = async (
    ...args: unknown[]
  ) => {
    opened.push(args);
    return undefined;
  };
  window.showInformationMessage = (async (message: string) => {
    informed.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
});

afterEach(() => {
  (commands as { executeCommand?: unknown }).executeCommand = originalExecute;
  window.showInformationMessage = originalInfo;
});

/** 開いたファイル（`vscode.open` に渡した場所） */
function openedPaths(): string[] {
  return opened
    .filter((args) => args[0] === "vscode.open")
    .map((args) => (args[1] as { fsPath: string }).fsPath);
}

describe("単話プロットを作る", () => {
  test("既にあれば、1文字も変えずにそのまま開く", async () => {
    const written = "# 第3話\n\n- 視点：灯\n- 作者が書いた展開\n";
    disk.set(plotPath, utf8(written));

    const created = await createEpisodePlot(work, 3);

    expect(created).toBe(false);
    expect(read(plotPath)).toBe(written);
    expect(openedPaths()).toEqual([plotPath]);
    expect(informed.join("\n")).toContain(
      "第3話の単話プロットは既にあります。そのまま開きました。"
    );
    // 退避も新規作成もしていない（ファイルは1つのまま）
    expect([...disk.keys()]).toEqual([plotPath]);
  });

  test("無ければ、雛形を作って開く", async () => {
    const created = await createEpisodePlot(work, 3);

    expect(created).toBe(true);
    expect(disk.has(plotPath)).toBe(true);
    const body = read(plotPath);
    expect(body).toContain("第3話");
    expect(body).toContain("視点");
    expect(openedPaths()).toEqual([plotPath]);
  });
});

/**
 * plot.md の「あらすじ」のうち、その話に当たる所を「展開」の下書きとして
 * 引く（作者の裁定 2026-09-27「単話プロットの作成に、作品全体のプロットの
 * 共通部分を生かす」。設計書6.36.2）。
 *
 * 3つの形を動かす——幕ごと（字数から幕を出す）・話ごと（その行）・
 * 決められない（何も入れない）。最後の1つが無いと「何でも入れる」実装が通る。
 */
describe("単話プロットの展開に、あらすじのその話に当たる所を引く", () => {
  const settings = path.join(work.folderPath, "設定");
  const plotMd = Uri.file(path.join(settings, "plot.md")).fsPath;
  const goalsJson = Uri.file(
    path.join(work.folderPath, ".aiwriter", "goals.json")
  ).fsPath;
  const fourth = Uri.file(
    path.join(settings, "episode-plots", "第4話.md")
  ).fsPath;

  beforeEach(async () => {
    // 目標は作品ごとに覚えられる。前のテストの「無い」を持ち越さない
    const { invalidateWorkGoals } = await import(
      "../../../src/core/workGoalsStore"
    );
    invalidateWorkGoals();
  });

  const withOutline = (outline: string) =>
    disk.set(
      plotMd,
      utf8(`# 氷の街\n\n## 人称\n\n一人称\n\n## あらすじ\n\n${outline}\n`)
    );
  const withGoal = (perEpisodeChars: number) =>
    disk.set(
      goalsJson,
      utf8(
        JSON.stringify({ schemaVersion: "0.1", perEpisodeChars, contest: null })
      )
    );
  const itemsOf = async (body: string): Promise<string[]> => {
    const { parseEpisodePlot } = await import(
      "../../../src/core/episodePlotDoc"
    );
    return parseEpisodePlot(body).items.map((item) => item.text);
  };

  test("幕ごとのあらすじなら、1話の目標字数から、その話が入る幕の行だけを引く", async () => {
    withOutline(
      [
        "- 第一幕：灯が氷の街に着き、配管の異音を聞く（1.5万字）",
        "- 第二幕：班長の隠し事に気づき、通信が途絶える（3万字）",
        "- 第三幕：凍った配管の奥で真相と向き合う（1.5万字）",
      ].join("\n")
    );
    withGoal(5000);

    const created = await createEpisodePlot(work, 4);

    expect(created).toBe(true);
    const body = read(fourth);
    // 第4話は 15,001〜20,000字目 → 第二幕（15,001〜45,000字目）
    expect(await itemsOf(body)).toEqual([
      "第二幕：班長の隠し事に気づき、通信が途絶える（3万字）",
    ]);
    // どこから引いたかを1行添える（作者が書き換える下書きだと分かる形）
    expect(body).toMatch(/^（plot\.md の「あらすじ」から.*第4話.*）$/m);
  });

  test("話ごとのあらすじなら、その話の行を引く（範囲の行も）", async () => {
    withOutline(
      ["- 第1話：着任", "- 第2〜4話：異音の調査", "- 第5話：通信途絶"].join(
        "\n"
      )
    );

    await createEpisodePlot(work, 4);

    const body = read(fourth);
    expect(await itemsOf(body)).toEqual(["第2〜4話：異音の調査"]);
    expect(body).toMatch(/^（plot\.md の「あらすじ」から.*第4話.*）$/m);
  });

  test("当たる所を決められないときは、何も入れない（推測で入れない）", async () => {
    // 字数も話数も書いていない、文章のあらすじ
    withOutline("灯は氷の街で配管の異音を追い、班長の隠し事に行き当たる。");
    withGoal(5000);

    await createEpisodePlot(work, 4);

    const body = read(fourth);
    expect(await itemsOf(body)).toEqual([]);
    expect(body).not.toContain("plot.md");
    expect(body).not.toContain("異音");
  });

  test("幕ごとでも、1話の長さが分からなければ何も入れない", async () => {
    withOutline(["- 第一幕：着任（1.5万字）", "- 第二幕：調査（3万字）"].join("\n"));
    // 目標は無く、書いた話も無い

    await createEpisodePlot(work, 4);

    const body = read(fourth);
    expect(await itemsOf(body)).toEqual([]);
    expect(body).not.toContain("plot.md");
  });
});
