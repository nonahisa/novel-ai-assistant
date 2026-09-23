import { beforeEach, describe, expect, it } from "vitest";
import {
  fileSystemWatchers,
  resetFileSystemWatchers,
  type RelativePattern,
} from "../support/vscodeStub";
import {
  FolderWatchHub,
  sharedFolderWatchHub,
  type FolderChangeKind,
} from "../../../src/features/folderWatchHub";
import { isSameLocation } from "../../../src/core/locationCompare";

/**
 * 作品フォルダーの見張りを1本へ束ねる部品（残課題 C2、0.84.4）。
 *
 * VS Code 本体は、開いているフォルダーの外に再帰の見張りを1本張るたびに
 * `files.watcherExclude` の警告をログへ出す。作品16で42件出ていたのを、
 * 作品フォルダーごとに1本（＝作品数）へ減らす。
 *
 * **性能と取りこぼしが最優先**なので、ここで押さえるのは
 * - 本数：同じ根・入れ子の根で2本目を張らない
 * - 取りこぼし：張り替えの間も知らせが届く／根の外の知らせを配らない
 * - 後始末：受け取り手が居なくなれば外れる／`dispose` で全部外れる
 */

function baseOf(index: number): string {
  const pattern = fileSystemWatchers[index].pattern as RelativePattern;
  return (pattern.base as { fsPath: string }).fsPath;
}

/** 受け取った知らせを並べて覗けるようにする */
function recorder(): {
  events: Array<{ kind: FolderChangeKind; filePath: string }>;
  onEvent: (kind: FolderChangeKind, _uri: unknown, filePath: string) => void;
} {
  const events: Array<{ kind: FolderChangeKind; filePath: string }> = [];
  return {
    events,
    onEvent: (kind, _uri, filePath) => events.push({ kind, filePath }),
  };
}

beforeEach(() => {
  resetFileSystemWatchers();
});

describe("見張りの本数", () => {
  it("根ごとに1本だけ、下すべてを見る形で張る", () => {
    const hub = new FolderWatchHub();
    hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    hub.subscribe({ root: "C:/小説/B", accepts: () => true, onEvent: () => undefined });

    expect(fileSystemWatchers).toHaveLength(2);
    expect((fileSystemWatchers[0].pattern as RelativePattern).pattern).toBe("**/*");
    expect(isSameLocation(baseOf(0), "C:/小説/A")).toBe(true);
    expect(isSameLocation(baseOf(1), "C:/小説/B")).toBe(true);
  });

  it("入れ子の根は、外側の1本で受ける", () => {
    const hub = new FolderWatchHub();
    hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    hub.subscribe({
      root: "C:/小説/A/設定",
      accepts: () => true,
      onEvent: () => undefined,
    });
    expect(fileSystemWatchers).toHaveLength(1);
    expect(hub.watchedRoots).toEqual(["C:/小説/A"]);
  });

  it("書庫の隣り合う作品は、作品ごとに1本（親フォルダーへはまとめない）", () => {
    // 親には作品以外のもの（別のリポジトリ・依存の山）も入りうる。
    // 見る範囲を「登録した作品フォルダーの和」から広げない
    const hub = new FolderWatchHub();
    hub.subscribe({ root: "C:/書庫/甲", accepts: () => true, onEvent: () => undefined });
    hub.subscribe({ root: "C:/書庫/乙", accepts: () => true, onEvent: () => undefined });
    expect(hub.watchedRoots).toEqual(["C:/書庫/甲", "C:/書庫/乙"]);
  });
});

describe("知らせの配り方", () => {
  it("自分の根の下で、条件に合うものだけを配る", () => {
    const hub = new FolderWatchHub();
    const body = recorder();
    const settings = recorder();
    hub.subscribe({
      root: "C:/小説/A",
      accepts: (filePath) => filePath.endsWith(".txt"),
      onEvent: body.onEvent,
    });
    hub.subscribe({
      root: "C:/小説/A",
      accepts: (filePath) => filePath.endsWith(".json"),
      onEvent: settings.onEvent,
    });

    fileSystemWatchers[0].fireChange("C:/小説/A/第1話.txt");
    fileSystemWatchers[0].fireCreate("C:/小説/A/設定/c1.json");
    fileSystemWatchers[0].fireDelete("C:/小説/A/第2話.txt");

    expect(body.events.map((event) => event.kind)).toEqual(["change", "delete"]);
    expect(settings.events.map((event) => event.kind)).toEqual(["create"]);
  });

  it("外側の1本で受けていても、内側の根の外の知らせは配らない", () => {
    const hub = new FolderWatchHub();
    const inner = recorder();
    hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    hub.subscribe({ root: "C:/小説/A/設定", accepts: () => true, onEvent: inner.onEvent });

    fileSystemWatchers[0].fireChange("C:/小説/A/第1話.txt");
    fileSystemWatchers[0].fireChange("C:/小説/A/設定/c1.json");

    // ドライブ文字は `Uri` が小文字にするので、場所として比べる
    expect(inner.events).toHaveLength(1);
    expect(isSameLocation(inner.events[0].filePath, "C:/小説/A/設定/c1.json")).toBe(true);
  });

  it("外側の根があとから来たら、先に張ってから内側を外す（間の知らせを落とさない）", () => {
    const hub = new FolderWatchHub();
    const inner = recorder();
    hub.subscribe({ root: "C:/小説/A/設定", accepts: () => true, onEvent: inner.onEvent });
    expect(fileSystemWatchers).toHaveLength(1);

    hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    expect(fileSystemWatchers).toHaveLength(2);
    expect(fileSystemWatchers[0].disposed).toBe(true);
    expect(fileSystemWatchers[1].disposed).toBe(false);

    // 外した見張りに遅れて届いた知らせは配らない（2度配らない）
    fileSystemWatchers[0].fireChange("C:/小説/A/設定/c1.json");
    // 外側の1本から届く
    fileSystemWatchers[1].fireChange("C:/小説/A/設定/c2.json");
    expect(inner.events).toHaveLength(1);
    expect(isSameLocation(inner.events[0].filePath, "C:/小説/A/設定/c2.json")).toBe(true);
  });

  it("外側の受け取り手が居なくなったら、内側の根に張り直して受け取り続ける", () => {
    const hub = new FolderWatchHub();
    const inner = recorder();
    const outer = hub.subscribe({
      root: "C:/小説/A",
      accepts: () => true,
      onEvent: () => undefined,
    });
    hub.subscribe({ root: "C:/小説/A/設定", accepts: () => true, onEvent: inner.onEvent });
    outer.dispose();

    expect(fileSystemWatchers).toHaveLength(2);
    expect(fileSystemWatchers[0].disposed).toBe(true);
    expect(isSameLocation(baseOf(1), "C:/小説/A/設定")).toBe(true);
    fileSystemWatchers[1].fireChange("C:/小説/A/設定/c1.json");
    expect(inner.events).toHaveLength(1);
  });

  it("配っている最中に受け取りをやめても、ほかの受け取り手へは届く", () => {
    const hub = new FolderWatchHub();
    const second = recorder();
    const first = hub.subscribe({
      root: "C:/小説/A",
      accepts: () => true,
      onEvent: () => first.dispose(),
    });
    hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: second.onEvent });

    fileSystemWatchers[0].fireChange("C:/小説/A/第1話.txt");
    expect(second.events).toHaveLength(1);
  });
});

describe("後始末", () => {
  it("受け取り手が居なくなった根の見張りは外す", () => {
    const hub = new FolderWatchHub();
    const a = hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    const b = hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: () => undefined });
    a.dispose();
    expect(fileSystemWatchers[0].disposed).toBe(false);
    b.dispose();
    expect(fileSystemWatchers[0].disposed).toBe(true);
    // 2度呼んでも崩れない
    b.dispose();
    expect(hub.watchedRoots).toEqual([]);
  });

  it("dispose で全部外れ、そのあとは張らない・配らない", () => {
    const hub = new FolderWatchHub();
    const seen = recorder();
    const kept = hub.subscribe({ root: "C:/小説/A", accepts: () => true, onEvent: seen.onEvent });
    hub.subscribe({ root: "C:/小説/B", accepts: () => true, onEvent: () => undefined });
    hub.dispose();

    expect(fileSystemWatchers.every((watcher) => watcher.disposed)).toBe(true);
    fileSystemWatchers[0].fireChange("C:/小説/A/第1話.txt");
    expect(seen.events).toHaveLength(0);

    hub.subscribe({ root: "C:/小説/C", accepts: () => true, onEvent: () => undefined });
    expect(fileSystemWatchers).toHaveLength(2);
    // 捨てたあとに受け取り口を捨てても崩れない（終わるときの順番は決まっていない）
    kept.dispose();
  });

  it("見張りを張れない環境では、何も配らずに動き続ける", () => {
    const hub = new FolderWatchHub(() => {
      throw new Error("張れない");
    });
    const subscription = hub.subscribe({
      root: "C:/小説/A",
      accepts: () => true,
      onEvent: () => undefined,
    });
    expect(hub.watchedRoots).toEqual([]);
    subscription.dispose();
  });

  it("共有の1つは、捨てたあとに呼ぶと作り直す（起動し直したとき）", () => {
    const first = sharedFolderWatchHub();
    expect(sharedFolderWatchHub()).toBe(first);
    first.dispose();
    const second = sharedFolderWatchHub();
    expect(second).not.toBe(first);
    second.dispose();
  });
});
