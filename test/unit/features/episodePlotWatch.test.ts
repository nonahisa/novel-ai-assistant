import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EpisodePlotFolderWatcher } from "../../../src/features/episodePlotWatch";
import { FolderWatchHub } from "../../../src/features/folderWatchHub";
import {
  fileSystemWatchers,
  resetFileSystemWatchers,
  type RelativePattern,
} from "../support/vscodeStub";
import { isSameLocation } from "../../../src/core/locationCompare";

/**
 * プロットモードの一覧が、**外から書き換えた単話プロット**に追いつく
 * （2026-09-23、ノートPCの実機確認）。
 *
 * **実機で見つかった不具合の再現。** 別のエディタや同期で単話プロットを
 * 作る・直す・消すと、プロットモードの一覧はパネルを開き直すまで古いまま
 * だった。一覧を作り直すきっかけが、VS Code での保存（`onDidSaveTextDocument`）
 * しか無かったためである。
 */

const SETTINGS = "C:/小説/作品/設定";
const PLOTS = `${SETTINGS}/episode-plots`;

beforeEach(() => {
  resetFileSystemWatchers();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("単話プロットの置き場の見張り", () => {
  it("外で作られた・変わった・消えたら、一覧を作り直す", () => {
    let reloads = 0;
    const watcher = new EpisodePlotFolderWatcher(() => {
      reloads++;
    });
    watcher.watch(PLOTS);
    expect(fileSystemWatchers).toHaveLength(1);
    const stub = fileSystemWatchers[0];

    stub.fireCreate(`${PLOTS}/第3話.md`);
    vi.runAllTimers();
    expect(reloads).toBe(1);

    stub.fireChange(`${PLOTS}/第3話.md`);
    vi.runAllTimers();
    expect(reloads).toBe(2);

    stub.fireDelete(`${PLOTS}/第3話.md`);
    vi.runAllTimers();
    expect(reloads).toBe(3);
  });

  it("続けて変わっても、少し待ってから1回だけ作り直す", () => {
    let reloads = 0;
    const watcher = new EpisodePlotFolderWatcher(() => {
      reloads++;
    });
    watcher.watch(PLOTS);
    const stub = fileSystemWatchers[0];

    // 同期で何話ぶんも一度に変わる
    for (let chapter = 1; chapter <= 10; chapter++) {
      stub.fireChange(`${PLOTS}/第${chapter}話.md`);
    }
    expect(reloads).toBe(0);
    vi.runAllTimers();
    expect(reloads).toBe(1);
  });

  it("置き場がまだ無くても見張れるよう、1つ上から見る", () => {
    // 単話プロットを1つも作っていない作品では `episode-plots` が無い。
    // 無いフォルダーを基点にすると、あとで作られても知らせが来ない
    const watcher = new EpisodePlotFolderWatcher(() => undefined);
    watcher.watch(PLOTS);
    const pattern = fileSystemWatchers[0].pattern as RelativePattern;
    expect(
      isSameLocation((pattern.base as { fsPath: string }).fsPath, SETTINGS)
    ).toBe(true);
    // 見張りは下すべてを見る1本（残課題 C2。作品フォルダーの見張りがあれば
    // そちらを分け合う）。置き場の直下の .md だけを、コードで絞る
    expect(pattern.pattern).toBe("**/*");
  });

  it("置き場の直下の .md だけを拾う（以前の glob「置き場／*.md」と同じ）", () => {
    let reloads = 0;
    const watcher = new EpisodePlotFolderWatcher(() => {
      reloads++;
    });
    watcher.watch(PLOTS);
    const stub = fileSystemWatchers[0];

    stub.fireChange(`${SETTINGS}/characters/c1.json`);
    stub.fireChange(`${PLOTS}/メモ.txt`);
    stub.fireChange(`${PLOTS}/古い/第1話.md`);
    vi.runAllTimers();
    expect(reloads).toBe(0);

    stub.fireChange(`${PLOTS}/第1話.md`);
    vi.runAllTimers();
    expect(reloads).toBe(1);
  });

  it("作品フォルダーの見張りがあれば、新しく張らずにそこから受け取る", () => {
    const hub = new FolderWatchHub();
    const body = hub.subscribe({
      root: "C:/小説/作品",
      accepts: () => true,
      onEvent: () => undefined,
    });
    expect(fileSystemWatchers).toHaveLength(1);

    let reloads = 0;
    const watcher = new EpisodePlotFolderWatcher(() => {
      reloads++;
    }, hub);
    watcher.watch(PLOTS);
    expect(fileSystemWatchers).toHaveLength(1);

    fileSystemWatchers[0].fireCreate(`${PLOTS}/第2話.md`);
    vi.runAllTimers();
    expect(reloads).toBe(1);

    // パネルを閉じても、作品フォルダーの見張りは残る
    watcher.dispose();
    expect(fileSystemWatchers[0].disposed).toBe(false);
    body.dispose();
    expect(fileSystemWatchers[0].disposed).toBe(true);
  });

  it("同じ置き場なら張り直さず、変わったら古い見張りを捨てる", () => {
    const watcher = new EpisodePlotFolderWatcher(() => undefined);
    watcher.watch(PLOTS);
    watcher.watch(PLOTS);
    expect(fileSystemWatchers).toHaveLength(1);

    watcher.watch("C:/小説/作品/資料/episode-plots");
    expect(fileSystemWatchers).toHaveLength(2);
    expect(fileSystemWatchers[0].disposed).toBe(true);
    expect(fileSystemWatchers[1].disposed).toBe(false);
  });

  it("捨てたあとは、待っていた作り直しも走らせない", () => {
    let reloads = 0;
    const watcher = new EpisodePlotFolderWatcher(() => {
      reloads++;
    });
    watcher.watch(PLOTS);
    fileSystemWatchers[0].fireChange(`${PLOTS}/第1話.md`);
    watcher.dispose();
    vi.runAllTimers();

    expect(fileSystemWatchers[0].disposed).toBe(true);
    expect(reloads).toBe(0);
  });

  it("捨てたあとに呼ばれても張り直さない（閉じたときに読み込みが走っていた場合）", () => {
    const watcher = new EpisodePlotFolderWatcher(() => undefined);
    watcher.watch(PLOTS);
    watcher.dispose();
    watcher.watch(PLOTS);
    expect(fileSystemWatchers).toHaveLength(1);
  });
});

describe("プロットモードのパネルへの配線", () => {
  const source = readFileSync("src/features/plotModePanel.ts", "utf8");

  it("置き場を読んだら見張りを張る", () => {
    expect(source).toContain("new EpisodePlotFolderWatcher(");
    const load = source.indexOf("private async load(");
    expect(load).toBeGreaterThan(-1);
    expect(source.slice(load, load + 1500)).toContain(
      "this.plotWatcher.watch(this.episodePlotsDir)"
    );
  });

  it("パネルを閉じたら見張りを捨てる", () => {
    const at = source.indexOf("this.panel.onDidDispose(");
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 300)).toContain("this.plotWatcher.dispose()");
  });
});
