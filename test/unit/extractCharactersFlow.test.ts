import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import { splitIntoChunks, type Chunk } from "../../src/core/chunker";
import type { WorkEntry } from "../../src/models/types";

const state = vi.hoisted(() => ({
  saveAll: vi.fn(),
  cacheSet: vi.fn(),
  cacheSave: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: { generate: state.generate },
    model: "test-model",
  })),
}));

vi.mock("../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: [
      {
        filePath: "001.txt",
        fileName: "001.txt",
        chapterStart: 1,
        chapterEnd: 1,
      },
    ],
  })),
}));

vi.mock("../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "灯が歩いた。",
    hasConflictMarkers: false,
  })),
}));

const chunks: Chunk[] = [
  {
    filePath: "001.txt",
    index: 0,
    text: "灯が歩いた。",
    hash: "chunk-1",
    chapterStart: 1,
    chapterEnd: 1,
  },
  {
    filePath: "001.txt",
    index: 1,
    text: "澪が歩いた。",
    hash: "chunk-2",
    chapterStart: 1,
    chapterEnd: 1,
  },
];

vi.mock("../../src/core/chunker", () => ({
  decideChunkSize: vi.fn(() => 1000),
  splitIntoChunks: vi.fn(() => chunks),
}));

vi.mock("../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: [], errors: [] };
    }
    async saveAll(characters: unknown[]) {
      return state.saveAll(characters);
    }
  },
}));

vi.mock("../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get() {
      return undefined;
    }
    async set(...args: unknown[]) {
      return state.cacheSet(...args);
    }
    async save() {
      return state.cacheSave();
    }
  },
}));

import { extractCharacters } from "../../src/features/extractCharacters";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

describe("人物抽出フロー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  test("chunkChars が正なら自動計算より優先して分割へ渡す", async () => {
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "chunkChars" ? 321 : defaultValue) as T,
    });
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn(),
          }
        )
      ),
    });
    state.generate.mockResolvedValue({
      text: JSON.stringify({ characters: [] }),
      truncated: false,
      elapsedMs: 1,
    });
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    expect(splitIntoChunks).toHaveBeenCalledWith(
      "001.txt",
      "灯が歩いた。",
      1,
      1,
      { maxChars: 321 }
    );
  });

  test("1未満の chunkChars は自動計算へ戻す", async () => {
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "chunkChars" ? 0.5 : defaultValue) as T,
    });
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate.mockResolvedValue({
      text: JSON.stringify({ characters: [] }),
      truncated: false,
      elapsedMs: 1,
    });
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    expect(splitIntoChunks).toHaveBeenCalledWith(
      "001.txt",
      "灯が歩いた。",
      1,
      1,
      { maxChars: 1000 }
    );
  });

  test("途中でキャンセルした場合はキャッシュだけを保存し人物JSONを変更しない", async () => {
    let cancel: (() => void) | undefined;
    let cancelled = false;
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          {
            get isCancellationRequested() {
              return cancelled;
            },
            onCancellationRequested(callback: () => void) {
              cancel = () => {
                cancelled = true;
                callback();
              };
            },
          }
        )
      ),
    });
    state.generate.mockImplementationOnce(async () => {
      cancel?.();
      return {
        text: JSON.stringify({ characters: [{ name: "灯" }] }),
        truncated: false,
        elapsedMs: 1,
      };
    });
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    expect(state.cacheSave).toHaveBeenCalledOnce();
    expect(state.saveAll).not.toHaveBeenCalled();
  });
});
