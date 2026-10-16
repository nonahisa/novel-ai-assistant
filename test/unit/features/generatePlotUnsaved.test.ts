import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import { installFakeDisk, openFakeDocument, type FakeDisk } from "../support/openDocumentFake";
import type { WorkEntry } from "../../../src/models/types";

/**
 * プロット逆算（`generatePlot`）は、AIを呼んでから plot.md へ書く。
 *
 * 書く口（`rewritePlotFile`）は plot.md に未保存の変更があると止まる。それ自体は正しいが、
 * **AIを呼んだあとで断ると、処理量（有料なら料金）を使ってから何も残らない。**
 * 未保存かどうかは呼ぶ前に分かるので、AIの設定を確かめるより前に止める。
 */

const state = vi.hoisted(() => ({
  ensureConfigured: vi.fn(),
}));

vi.mock("../../../src/features/formatFitPrompt", () => ({
  confirmFormatFit: async () => true,
}));
vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: state.ensureConfigured,
}));

import { generatePlot } from "../../../src/features/generatePlot";
import type { AIRegistry } from "../../../src/ai/registry";

const work: WorkEntry = {
  id: "work_plot_unsaved",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work_plot_unsaved"),
  registeredAt: "2026-10-16T00:00:00.000Z",
};
const plotFile = nodePath.join(work.folderPath, "設定", "plot.md");
const INITIAL = "# 氷の街\n\n## ログライン\n\n";

let disk: FakeDisk;
const originalWarning = window.showWarningMessage;

beforeEach(() => {
  disk = installFakeDisk();
  workspace.textDocuments.length = 0;
  state.ensureConfigured.mockReset();
  state.ensureConfigured.mockResolvedValue(undefined);
});

afterEach(() => {
  workspace.textDocuments.length = 0;
  workspace.applyEdit = async () => true;
  window.showWarningMessage = originalWarning;
});

describe("generatePlot：plot.md に未保存の変更があるとき", () => {
  test("AIの設定を確かめる前に止め、保存を頼む", async () => {
    disk.write(plotFile, INITIAL);
    const document = openFakeDocument(disk, plotFile, INITIAL + "書きかけ", { dirty: true });
    const warnings: string[] = [];
    window.showWarningMessage = (async (message: string) => {
      warnings.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;

    await generatePlot(work, {} as AIRegistry);

    expect(state.ensureConfigured).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toMatch(/保存していない/);
    expect(document.applied).toEqual([]);
    expect(disk.read(plotFile)).toBe(INITIAL);
  });

  test("未保存でなければ先へ進む（AIの設定を確かめる）", async () => {
    disk.write(plotFile, INITIAL);
    openFakeDocument(disk, plotFile, INITIAL);

    await generatePlot(work, {} as AIRegistry);

    expect(state.ensureConfigured).toHaveBeenCalledTimes(1);
  });
});
