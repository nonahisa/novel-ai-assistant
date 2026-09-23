import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 作品フォルダーの本文を見張って、外の変更で作品一覧を数え直す
 * （実機確認 2026-09-07、A-10 の観測「作品一覧の字数が外の変更に追随しない」）。
 */
const created: Array<{ base: string; pattern: string; fire: (kind: string, path: string) => void; disposed: boolean }> = [];

vi.mock("vscode", () => {
  class RelativePattern {
    constructor(
      readonly base: { fsPath: string },
      readonly pattern: string
    ) {}
  }
  return {
    RelativePattern,
    Uri: { file: (p: string) => ({ fsPath: p, scheme: "file", path: p }) },
    workspace: {
      createFileSystemWatcher: (rp: RelativePattern) => {
        const handlers: Record<string, Array<(uri: { fsPath: string }) => void>> = {
          change: [],
          create: [],
          delete: [],
        };
        const entry = {
          base: rp.base.fsPath,
          pattern: rp.pattern,
          fire: (kind: string, path: string) => {
            for (const handler of handlers[kind]) handler({ fsPath: path });
          },
          disposed: false,
        };
        created.push(entry);
        return {
          onDidChange: (h: (uri: { fsPath: string }) => void) => handlers.change.push(h),
          onDidCreate: (h: (uri: { fsPath: string }) => void) => handlers.create.push(h),
          onDidDelete: (h: (uri: { fsPath: string }) => void) => handlers.delete.push(h),
          dispose: () => {
            entry.disposed = true;
          },
        };
      },
    },
  };
});

import { WorkFolderWatchers, isManuscriptPath } from "../../../src/features/workFolderWatch";
import { FolderWatchHub } from "../../../src/features/folderWatchHub";
import type { WorkEntry } from "../../../src/models/types";

const work = (id: string, folder: string): WorkEntry => ({
  id,
  title: id,
  folderPath: folder,
  registeredAt: "2026-09-08T00:00:00.000Z",
});

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
});

describe("作品フォルダーの監視", () => {
  test("登録されている作品ごとに1本張り、外れた作品の監視は捨てる", () => {
    const watchers = new WorkFolderWatchers(() => undefined);
    watchers.sync([work("a", "C:/小説/A"), work("b", "C:/小説/B")]);
    expect(created.map((entry) => entry.base)).toEqual(["C:/小説/A", "C:/小説/B"]);
    // 見張りは作品フォルダーの下すべてを見る1本（同期・設定資料と分け合う。
    // 残課題 C2）。本文かどうかはコードで絞る（下の「本文以外は数えない」）
    expect(created[0].pattern).toBe("**/*");

    watchers.sync([work("b", "C:/小説/B")]);
    expect(created[0].disposed).toBe(true);
    expect(created[1].disposed).toBe(false);
    // 同じ作品には張り直さない
    expect(created.length).toBe(2);
  });

  test("続けて変わっても、少し待ってから1回だけ数え直す", () => {
    const changed: string[] = [];
    const watchers = new WorkFolderWatchers((w) => changed.push(w.id));
    watchers.sync([work("a", "C:/小説/A")]);

    created[0].fire("change", "C:/小説/A/episode_0001.md");
    created[0].fire("change", "C:/小説/A/episode_0002.md");
    created[0].fire("create", "C:/小説/A/episode_0003.md");
    expect(changed).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(changed).toEqual(["a"]);
  });

  test("拡張機能の作業フォルダーと退避の中は数えない", () => {
    const changed: string[] = [];
    const watchers = new WorkFolderWatchers((w) => changed.push(w.id));
    watchers.sync([work("a", "C:/小説/A")]);
    created[0].fire("change", "C:/小説/A/.aiwriter/logs/x.md");
    created[0].fire("change", "C:/小説/A/.novelai-recovery/y.md");
    vi.advanceTimersByTime(600);
    expect(changed).toEqual([]);
  });

  test("本文以外（.txt/.md でないもの）は数えない（以前の glob と同じ絞り込み）", () => {
    const changed: string[] = [];
    const watchers = new WorkFolderWatchers((w) => changed.push(w.id));
    watchers.sync([work("a", "C:/小説/A")]);
    created[0].fire("change", "C:/小説/A/設定/characters/c1.json");
    created[0].fire("change", "C:/小説/A/表紙.png");
    vi.advanceTimersByTime(600);
    expect(changed).toEqual([]);

    // 深い階層の本文は数える（`**` は何段でも）
    created[0].fire("change", "C:/小説/A/本文/第1章/episode_0001.txt");
    vi.advanceTimersByTime(600);
    expect(changed).toEqual(["a"]);
  });

  test("ほかの機能と同じハブを渡すと、同じ作品フォルダーに2本目を張らない", () => {
    const hub = new FolderWatchHub();
    const first = new WorkFolderWatchers(() => undefined, hub);
    const second = new WorkFolderWatchers(() => undefined, hub);
    first.sync([work("a", "C:/小説/A")]);
    second.sync([work("a", "C:/小説/A")]);
    expect(created).toHaveLength(1);

    // 片方が手を引いても、もう片方が使っている間は外さない
    first.dispose();
    expect(created[0].disposed).toBe(false);
    second.dispose();
    expect(created[0].disposed).toBe(true);
  });

  test("本文の場所の判定", () => {
    expect(isManuscriptPath("C:\小説\A\episode_0001.md")).toBe(true);
    expect(isManuscriptPath("C:/小説/A/.aiwriter/generated/x.md")).toBe(false);
    expect(isManuscriptPath("C:/小説/A/.git/x.txt")).toBe(false);
  });
});
