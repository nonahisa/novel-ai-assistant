import { beforeEach, describe, expect, test, vi } from "vitest";

// ログの書き先の作品は在るものとして扱う（作り物の道はディスクに無い）。無い作品へ書かない決まりは
// `core/logMissingWork.test.ts` が見る（2026-11-14）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));
import * as vscode from "vscode";
import { workspace } from "../support/vscodeStub";
import { setFallbackLogRoot, useLogFile } from "../../../src/core/logger";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談パネルの失敗の記録が、その作品の操作の記録（`.aiwriter/logs/actions.log`）へ入る
 * （2026-11-05 の洗い出し）。
 *
 * 書き先の共有の値（`useLogFile`）は、AIの応答を待つあいだや別の窓の操作で別の作品へ
 * 向け直される。0.127.3 からは命令の入口で保管庫へ外されるので、書き先を決めずに書く
 * 失敗の行は作品の記録に残らなくなっていた。ここでは共有の書き先を**わざと別の作品へ
 * 向けておいて**、失敗の行が相談の作品のほうへ入ることを見る。
 */

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));
vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(async () => undefined),
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_chat",
  title: "春の庭",
  folderPath: "C:/works/春の庭",
  registeredAt: "2026-11-05T00:00:00.000Z",
};
const OTHER = "C:/works/別の作品";
const EPISODE = "C:/works/春の庭/第1話.txt";

let written: { path: string; text: string }[] = [];

function logPath(raw: string): string {
  return raw.replace(/\\/g, "/").toLowerCase();
}

/** 書き込みは順番待ちの列に乗るので、何周か待ってから読む */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function linesIn(folder: string): string {
  const target = logPath(`${folder}/.aiwriter/logs/actions.log`);
  return written
    .filter((entry) => logPath(entry.path) === target)
    .map((entry) => entry.text)
    .join("");
}

function makePanel(runner: Record<string, unknown>) {
  const registry = { list: () => [WORK] };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => undefined,
  };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = panel as any;
  internal.postAll = () => undefined;
  internal.postError = () => undefined;
  return internal;
}

beforeEach(() => {
  written = [];
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async (uri: { path?: string; fsPath?: string }, data: Uint8Array) => {
        written.push({
          path: uri.fsPath ?? uri.path ?? "",
          text: new TextDecoder().decode(data),
        });
      },
    },
  });
  setFallbackLogRoot("C:/storage");
  // 共有の書き先は、相談の作品とは別の作品を向いている
  useLogFile(OTHER);
});

describe("相談パネルの失敗は、その作品の記録へ入る", () => {
  test("機能起動（runFeature）の失敗", async () => {
    const panel = makePanel({
      run: async () => {
        throw new Error("起動に失敗した試し");
      },
    });
    panel.pendingRuns.set("run-1", {
      kind: "checkTypos",
      work: WORK,
      filePath: undefined,
    });
    await panel.runFeature("run-1");
    await settle();

    expect(linesIn(WORK.folderPath)).toContain("相談からの機能起動");
    expect(linesIn(WORK.folderPath)).toContain("起動に失敗した試し");
    expect(linesIn(OTHER)).not.toContain("相談からの機能起動");
  });

  test("再読込（reloadRecord）の失敗", async () => {
    const panel = makePanel({
      reload: async () => {
        throw new Error("再読込に失敗した試し");
      },
    });
    panel.pendingReloads.set("reload-1", {
      work: WORK,
      kind: "character",
      recordId: "c1",
      name: "ミナ",
      notes: "",
    });
    await panel.reloadRecord("reload-1");
    await settle();

    expect(linesIn(WORK.folderPath)).toContain("相談からの再読込");
    expect(linesIn(OTHER)).not.toContain("相談からの再読込");
  });

  test("「そこを見せて」で開けなかった失敗", async () => {
    const panel = makePanel({ revealInManuscript: async () => true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.workspace as any).openTextDocument = vi.fn(async () => {
      throw new Error("開けない試し");
    });
    panel.pendingLocates.set("locate-1", {
      locate: { label: "そこ", text: "走つた" },
      work: WORK,
      fallbackPath: EPISODE,
    });
    await panel.showLocation("locate-1");
    await settle();

    expect(linesIn(WORK.folderPath)).toContain("相談の「そこを見せて」：開けなかった");
    expect(linesIn(OTHER)).not.toContain("そこを見せて");
  });
});
