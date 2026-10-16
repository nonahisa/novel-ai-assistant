import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "../support/vscodeStub";
import { installFakeDisk, openFakeDocument, type FakeDisk } from "../support/openDocumentFake";
import type { WorkEntry } from "../../../src/models/types";

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
}));

const { renumberEpisodePlotHeadings } = await import("../../../src/features/episodePlotFiles");

/**
 * 単話プロットの見出しの付け替え（話の並べ替え・差し込みのあと）も、ファイルがエディターで
 * 開いていれば**文書へ当てて保存する**。名前の変更（`WorkspaceEdit`）で開いていたタブは新しい名前へ
 * ついて行くので、そのあと見出しをディスクへ「退避 → 消して作り直す」で書くと、plot.md と同じく
 * Ctrl+S が「ファイルのほうが新しい」で断られる（作者の裁定「両方直す」、2026-10-16）。
 */

const work: WorkEntry = {
  id: "work_episode_plot_open",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work_episode_plot_open"),
  registeredAt: "2026-10-16T00:00:00.000Z",
};
const directory = nodePath.join(work.folderPath, "設定", "単話プロット");
const target = nodePath.join(directory, "第3話.md");
const BEFORE = "# 第2話「港」の単話プロット\n\n- 船が着く\n";

let disk: FakeDisk;

beforeEach(() => {
  disk = installFakeDisk();
  workspace.textDocuments.length = 0;
});

afterEach(() => {
  workspace.textDocuments.length = 0;
  workspace.applyEdit = async () => true;
});

describe("単話プロットの見出しの付け替え：開いているとき", () => {
  test("ディスクを消して作り直さず、文書へ当てて保存する", async () => {
    disk.write(target, BEFORE);
    const document = openFakeDocument(disk, target, BEFORE);

    const failures = await renumberEpisodePlotHeadings(work, directory, [{ from: 2, to: 3 }]);

    expect(failures).toEqual([]);
    expect(disk.deleted).toEqual([]);
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(disk.read(target)).toBe("# 第3話「港」の単話プロット\n\n- 船が着く\n");
  });

  test("未保存の変更があれば書かず、直せなかったファイルとして返す", async () => {
    disk.write(target, BEFORE);
    const document = openFakeDocument(disk, target, BEFORE + "書きかけ", { dirty: true });

    const failures = await renumberEpisodePlotHeadings(work, directory, [{ from: 2, to: 3 }]);

    expect(failures).toEqual(["第3話.md"]);
    expect(document.applied).toEqual([]);
    expect(disk.read(target)).toBe(BEFORE);
  });

  test("開いていなければ、今までどおりディスクへ書く", async () => {
    disk.write(target, BEFORE);

    const failures = await renumberEpisodePlotHeadings(work, directory, [{ from: 2, to: 3 }]);

    expect(failures).toEqual([]);
    expect(disk.read(target)).toBe("# 第3話「港」の単話プロット\n\n- 船が着く\n");
  });
});
