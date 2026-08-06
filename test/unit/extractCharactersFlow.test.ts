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
  cachedResults: new Map<string, unknown>(),
  providerId: "ollama" as "ollama" | "claude",
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: { id: state.providerId, generate: state.generate },
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
    get(hash: string) {
      return state.cachedResults.get(hash);
    }
    async set(hash: string, key: unknown, value: unknown) {
      state.cachedResults.set(hash, value);
      return state.cacheSet(hash, key, value);
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
    state.cachedResults.clear();
    state.providerId = "ollama";
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

  test("全チャンクがキャッシュ済みでもAPIを呼ばず人物JSONへ再反映する", async () => {
    state.cachedResults.set("chunk-1", {
      characters: [{ name: "灯" }],
    });
    state.cachedResults.set("chunk-2", {
      characters: [{ name: "澪" }],
    });
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    expect(state.generate).not.toHaveBeenCalled();
    expect(state.saveAll).toHaveBeenCalledOnce();
    expect(
      state.saveAll.mock.calls[0][0].map((character: { name: string }) =>
        character.name
      )
    ).toEqual(["灯", "澪"]);
  });

  test("キャッシュの生出力も再検証して人物でない候補を除外する", async () => {
    state.cachedResults.set("chunk-1", {
      characters: [
        { name: "灯" },
        { name: "先生", evidence: "灯が歩いた" },
      ],
    });
    state.cachedResults.set("chunk-2", { characters: [] });
    const showInformationMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage,
      showWarningMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    expect(
      state.saveAll.mock.calls[0][0].map((character: { name: string }) =>
        character.name
      )
    ).toEqual(["灯"]);
    expect(showInformationMessage.mock.calls.at(-1)?.[0]).toContain(
      "AI出力から除外 1 件"
    );
  });

  test("検証前の解析結果をキャッシュして後の規則変更で再評価できるようにする", async () => {
    const rawResult = {
      characters: [
        { name: "灯" },
        { name: "先生", evidence: "灯が歩いた" },
      ],
    };
    state.generate
      .mockResolvedValueOnce({
        text: JSON.stringify(rawResult),
        truncated: false,
        elapsedMs: 1,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ characters: [] }),
        truncated: false,
        elapsedMs: 1,
      });
    Object.assign(window, {
      showInformationMessage: vi.fn(
        async (_message: string, ...actions: string[]) =>
          actions.includes("実行") ? "実行" : undefined
      ),
      showWarningMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    expect(state.cachedResults.get("chunk-1")).toEqual(rawResult);
    expect(
      state.saveAll.mock.calls[0][0].map((character: { name: string }) =>
        character.name
      )
    ).toEqual(["灯"]);
  });

  test("Claudeの実行確認に保守的な入出力トークン量と課金注意を表示する", async () => {
    state.providerId = "claude";
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "claude.maxOutputTokens" ? 4096 : defaultValue) as T,
    });
    const showInformationMessage = vi.fn(
      async (_message: string, ...actions: string[]) =>
        actions.includes("実行") ? "実行" : undefined
    );
    Object.assign(window, {
      showInformationMessage,
      showWarningMessage: vi.fn(async () => undefined),
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

    const confirmation = showInformationMessage.mock.calls.find((call) =>
      call.slice(1).includes("実行")
    )?.[0];
    expect(confirmation).toMatch(/入力: 約 [\d,]+ トークン/);
    expect(confirmation).toContain(
      "出力: 最大 8,192 トークン（設定上限 4,096 × 2 回）"
    );
    expect(confirmation).toContain("Claude APIは実行すると課金が発生します");
    expect(confirmation).toContain("Anthropicの現行料金");
  });

  test("Ollamaの実行確認は無料のローカル実行と示し課金を予告しない", async () => {
    const showInformationMessage = vi.fn(
      async (_message: string, ...actions: string[]) =>
        actions.includes("実行") ? "実行" : undefined
    );
    Object.assign(window, {
      showInformationMessage,
      showWarningMessage: vi.fn(async () => undefined),
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

    const confirmation = showInformationMessage.mock.calls.find((call) =>
      call.slice(1).includes("実行")
    )?.[0];
    expect(confirmation).toContain("無料・ローカル実行（API課金なし）");
    expect(confirmation).not.toContain("課金が発生します");
    expect(confirmation).not.toContain("Anthropic");
  });
});
