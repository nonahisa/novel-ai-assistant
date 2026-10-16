import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workspace } from "../support/vscodeStub";
import { installFakeDisk, openFakeDocument, type FakeDisk } from "../support/openDocumentFake";
import { writePlotSections } from "../../../src/core/plotFile";
import { consumeOwnPlotSave } from "../../../src/core/ownPlotSave";
import type { WorkEntry } from "../../../src/models/types";

/**
 * プロットの節を書く口（`writePlotSections`。生成・形式とジャンル・作品の作成・ZIPの取り込み・
 * 相談の決まったこと）も、plot.md がエディターで開いていれば**文書へ当てて保存する**。
 *
 * ディスクを「退避 → 消して作り直す」で書くと、開いたままのエディターが読み直す前に作者が打ったとき、
 * Ctrl+S が「The content of the file is newer」で断られる（プロットモードの［入れる］で起きた。
 * 作者の裁定「両方直す」、2026-10-16）。
 */

const work: WorkEntry = {
  id: "work_plot_open",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work_plot_open"),
  registeredAt: "2026-10-16T00:00:00.000Z",
};
const plotFile = nodePath.join(work.folderPath, "設定", "plot.md");
const INITIAL = "# 氷の街\n\n## ログライン\n\n## テーマ\n裏方の仕事\n";

let disk: FakeDisk;

beforeEach(() => {
  disk = installFakeDisk();
  workspace.textDocuments.length = 0;
});

afterEach(() => {
  workspace.textDocuments.length = 0;
  workspace.applyEdit = async () => true;
});

describe("writePlotSections：plot.md が開いているとき", () => {
  test("ディスクを消して作り直さず、文書へ変わった所だけを当てて保存する", async () => {
    disk.write(plotFile, INITIAL);
    const document = openFakeDocument(disk, plotFile, INITIAL);

    await writePlotSections(work, { logline: "新人が地下の配線を守る" });

    expect(disk.deleted).toEqual([]);
    expect(document.applied.join("")).toContain("新人が地下の配線を守る");
    // 作者の書いたテーマには触れない（変わった所だけ）
    expect(document.applied.join("")).not.toContain("裏方の仕事");
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(disk.read(plotFile)).toContain("## ログライン\n新人が地下の配線を守る");
    // こちらの保存では「保存からの反映」を走らせない（覚え書きが当たる）
    expect(consumeOwnPlotSave(plotFile, document.text)).toBe(true);
  });

  test("未保存の変更があれば書かずに止める（書きかけを巻き込まない・消さない）", async () => {
    disk.write(plotFile, INITIAL);
    const document = openFakeDocument(disk, plotFile, INITIAL + "書きかけ", { dirty: true });

    await expect(writePlotSections(work, { logline: "新しい案" })).rejects.toThrow(/保存していない/);
    expect(document.applied).toEqual([]);
    expect(document.save).not.toHaveBeenCalled();
    expect(disk.read(plotFile)).toBe(INITIAL);
  });

  test("開いていなければ、今までどおりディスクへ書く（改行は元のまま）", async () => {
    disk.write(plotFile, INITIAL.replace(/\n/g, "\r\n"));

    await writePlotSections(work, { logline: "新人が地下の配線を守る" });

    expect(disk.read(plotFile)).toBe(
      "# 氷の街\r\n\r\n## ログライン\r\n新人が地下の配線を守る\r\n\r\n## テーマ\r\n裏方の仕事\r\n"
    );
  });

  test("ファイルが無ければ作る", async () => {
    await writePlotSections(work, { format: "長編" });

    expect(disk.read(plotFile)).toContain("長編");
  });
});
