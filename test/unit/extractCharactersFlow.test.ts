import { beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import { splitIntoChunks, type Chunk } from "../../src/core/chunker";
import type { WorkEntry } from "../../src/models/types";
import {
  AIError,
  recoveryForAIError,
} from "../../src/ai/types";

const state = vi.hoisted(() => ({
  saveAll: vi.fn(),
  cacheSet: vi.fn(),
  cacheSave: vi.fn(),
  generate: vi.fn(),
  cachedResults: new Map<string, unknown>(),
  providerId: "ollama" as "ollama" | "claude",
  configured: true,
  CharacterStoreError: class CharacterStoreError extends Error {
    readonly batchProgress:
      | {
          completedIds: string[];
          ambiguousIds: string[];
          remainingIds: string[];
        }
      | undefined;

    constructor(
      message: string,
      readonly kind: "modified_externally" | "path_conflict",
      options?: {
        batchProgress?: {
          completedIds: string[];
          ambiguousIds: string[];
          remainingIds: string[];
        };
      }
    ) {
      super(message);
      this.name = "CharacterStoreError";
      this.batchProgress = options?.batchProgress;
    }
  },
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () =>
    state.configured
      ? {
          provider: { id: state.providerId, generate: state.generate },
          model: "test-model",
        }
      : undefined
  ),
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
  CharacterStoreError: state.CharacterStoreError,
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
import { CharacterStoreError } from "../../src/core/characterStore";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

function testRegistry(): AIRegistry {
  return {
    resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
  } as unknown as AIRegistry;
}

function successfulResult(name: string): {
  text: string;
  truncated: false;
  elapsedMs: number;
} {
  return {
    text: JSON.stringify({ characters: [{ name }] }),
    truncated: false,
    elapsedMs: 1,
  };
}

describe("AI失敗後の復旧案内", () => {
  test.each([
    ["not_running", "AIを起動し、接続先設定を確認してください。"],
    ["model_not_found", "利用可能なモデルを選び直してください。"],
    ["timeout", "チャンクを小さくして、もう一度実行してください。"],
    ["bad_response", "出力上限とモデル設定を確認してください。"],
    ["aborted", "必要なら抽出をもう一度実行してください。"],
    ["unknown", "AI設定と拡張機能のログを確認してください。"],
  ] as const)("%s に具体的な復旧操作を1つ示す", (kind, expected) => {
    const error = new AIError("provider payload", kind, "secret detail");

    expect(recoveryForAIError(error)).toBe(expected);
  });
});

describe("人物抽出フロー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.generate.mockReset();
    state.saveAll.mockReset().mockResolvedValue(undefined);
    state.cacheSet.mockReset();
    state.cacheSave.mockReset();
    state.cachedResults.clear();
    state.providerId = "ollama";
    state.configured = true;
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  test("切り詰め応答を保存せず出力上限かチャンク縮小を案内する", async () => {
    const showWarningMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate.mockResolvedValue({
      text: JSON.stringify({ characters: [{ name: "灯" }] }),
      truncated: true,
      elapsedMs: 1,
    });

    await extractCharacters(work, testRegistry());

    expect(state.saveAll).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "出力上限を増やすかチャンクを小さくしてください"
    );
  });

  test.each([
    ["timeout", "チャンクを小さくして、もう一度実行してください。"],
    ["aborted", "必要なら抽出をもう一度実行してください。"],
  ] as const)("%s を失敗チャンクとして復旧案内する", async (kind, recovery) => {
    const showWarningMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate.mockRejectedValue(
      new AIError("provider payload", kind, "secret detail")
    );

    await extractCharacters(work, testRegistry());

    expect(state.saveAll).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(recovery);
  });

  test.each([
    ["空応答", "", "AIの応答が空でした"],
    ["不正JSON", "not-json", "応答をJSONとして解析できませんでした"],
  ])("%s を保存せず安全な復旧案内を表示する", async (_label, text, expected) => {
    const showWarningMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate.mockResolvedValue({
      text,
      truncated: false,
      elapsedMs: 1,
    });

    await extractCharacters(work, testRegistry());

    expect(state.saveAll).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(expected);
  });

  test("最終サマリーに新規・更新・除外・競合・失敗・保存競合未保存の全件数を示す", async () => {
    const showWarningMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate
      .mockResolvedValueOnce({
        text: JSON.stringify({
          characters: [
            { name: "灯" },
            { name: "先生", evidence: "灯が歩いた" },
          ],
        }),
        truncated: false,
        elapsedMs: 1,
      })
      .mockRejectedValueOnce(
        new AIError("provider payload", "timeout", "secret detail")
      );

    await extractCharacters(work, testRegistry());

    const summary = showWarningMessage.mock.calls.at(-1)?.[0];
    expect(summary).toContain("新規 1名");
    expect(summary).toContain("更新 0名");
    expect(summary).toContain("除外 1件");
    expect(summary).toContain("競合 0件");
    expect(summary).toContain("失敗 1チャンク");
    expect(summary).toContain("保存競合による未保存 0名");
  });

  test.each([
    ["modified_externally", "人物設定が読み込み後に変更されました"],
    ["path_conflict", "人物設定の保存先が競合しました"],
  ] as const)(
    "saveAll の %s では作者変更を保護し抽出結果を全件未保存と報告する",
    async (kind, classification) => {
      const showErrorMessage = vi.fn(async () => undefined);
      Object.assign(window, {
        showInformationMessage: vi.fn(async () => "実行"),
        showWarningMessage: vi.fn(async () => undefined),
        showErrorMessage,
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
      state.generate
        .mockResolvedValueOnce(successfulResult("灯"))
        .mockResolvedValueOnce(successfulResult("澪"));
      state.saveAll.mockRejectedValueOnce(
        new CharacterStoreError("changed by author", kind)
      );

      await extractCharacters(work, testRegistry());

      const summary = showErrorMessage.mock.calls.at(-1)?.[0];
      expect(summary).toContain(
        "作者の変更を保護するため保存しませんでした"
      );
      expect(summary).toContain(classification);
      expect(summary).toContain("保存済み 0名");
      expect(summary).toContain("手動確認が必要 0名");
      expect(summary).toContain("新規 2名");
      expect(summary).toContain("更新 0名");
      expect(summary).toContain("除外 0件");
      expect(summary).toContain("競合 0件");
      expect(summary).toContain("失敗 0チャンク");
      expect(summary).toContain("保存競合による未保存 2名");
    }
  );

  test("後続保存競合では先に完了した件数だけを保存済みと報告する", async () => {
    const showErrorMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage,
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockResolvedValueOnce(successfulResult("澪"));
    state.saveAll.mockRejectedValueOnce(
      new CharacterStoreError("changed by author", "modified_externally", {
        batchProgress: {
          completedIds: ["char_001"],
          ambiguousIds: [],
          remainingIds: ["char_002"],
        },
      })
    );

    await extractCharacters(work, testRegistry());

    const summary = showErrorMessage.mock.calls.at(-1)?.[0];
    expect(summary).toContain("保存済み 1名");
    expect(summary).toContain("手動確認が必要 0名");
    expect(summary).toContain("保存競合による未保存 1名");
    expect(summary).not.toContain("保存済み 0名");
    expect(summary).not.toContain("保存競合による未保存 2名");
  });

  test("配置後の退避失敗は保存済みとも未保存とも数えず手動照合を促す", async () => {
    const showErrorMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage,
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockResolvedValueOnce({
        text: JSON.stringify({ characters: [] }),
        truncated: false,
        elapsedMs: 1,
      });
    state.saveAll.mockRejectedValueOnce(
      new CharacterStoreError("manual recovery", "path_conflict", {
        batchProgress: {
          completedIds: [],
          ambiguousIds: ["char_001"],
          remainingIds: [],
        },
      })
    );

    await extractCharacters(work, testRegistry());

    const summary = showErrorMessage.mock.calls.at(-1)?.[0];
    expect(summary).toContain("保存済み 0名");
    expect(summary).toContain("手動確認が必要 1名");
    expect(summary).toContain("保存競合による未保存 0名");
    expect(summary).toContain("保存先と回復ファイルを手動で照合してください");
    expect(summary).not.toContain("保存済み 1名");
    expect(summary).not.toContain("保存競合による未保存 1名");
  });

  test("AI失敗後に保存競合しても無害化した失敗詳細を表示できる", async () => {
    let detailContent = "";
    const showErrorMessage = vi.fn(
      async (_message: string, ...actions: string[]) =>
        actions.includes("詳細を表示") ? "詳細を表示" : undefined
    );
    Object.assign(workspace, {
      openTextDocument: vi.fn(async (options: { content: string }) => {
        detailContent = options.content;
        return { uri: { fsPath: "failure-details" } };
      }),
    });
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage,
      showTextDocument: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockRejectedValueOnce(
        new AIError("secret provider payload", "timeout", "raw prompt")
      );
    state.saveAll.mockRejectedValueOnce(
      new CharacterStoreError("changed by author", "modified_externally")
    );

    await extractCharacters(work, testRegistry());

    expect(showErrorMessage.mock.calls.at(-1)?.slice(1)).toContain(
      "詳細を表示"
    );
    expect(detailContent).toContain("第1話(2)");
    expect(detailContent).toContain(
      "チャンクを小さくして、もう一度実行してください。"
    );
    expect(detailContent).not.toContain("secret provider payload");
    expect(detailContent).not.toContain("raw prompt");
  });

  test("失敗詳細は章ラベルと無害化した案内だけを表示する", async () => {
    let detailContent = "";
    const showWarningMessage = vi.fn(
      async (_message: string, ...actions: string[]) =>
        actions.includes("詳細を表示") ? "詳細を表示" : undefined
    );
    Object.assign(workspace, {
      openTextDocument: vi.fn(async (options: { content: string }) => {
        detailContent = options.content;
        return { uri: { fsPath: "failure-details" } };
      }),
    });
    Object.assign(window, {
      showInformationMessage: vi.fn(
        async (_message: string, ...actions: string[]) =>
          actions.includes("実行") ? "実行" : undefined
      ),
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      showTextDocument: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockRejectedValueOnce(
        new AIError(
          "sk-ant-secret provider payload 澪が歩いた。",
          "bad_response",
          "raw prompt"
        )
      );

    await extractCharacters(work, testRegistry());

    expect(showWarningMessage.mock.calls.at(-1)?.slice(1)).toContain(
      "詳細を表示"
    );
    expect(detailContent).toContain("第1話(2)");
    expect(detailContent).toContain(
      "出力上限とモデル設定を確認してください。"
    );
    expect(detailContent).not.toContain("sk-ant-secret");
    expect(detailContent).not.toContain("provider payload");
    expect(detailContent).not.toContain("澪が歩いた");
    expect(detailContent).not.toContain("raw prompt");
  });

  test.each(["ollama", "claude"] as const)(
    "AI接続失敗から選択中の %s 設定を開ける",
    async (providerId) => {
      state.providerId = providerId;
      const executeCommand = vi.fn(async () => undefined);
      const showWarningMessage = vi.fn(
        async (_message: string, ...actions: string[]) =>
          actions.includes("設定を開く") ? "設定を開く" : undefined
      );
      Object.assign(commands, { executeCommand });
      Object.assign(window, {
        showInformationMessage: vi.fn(async () => "実行"),
        showWarningMessage,
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
      state.generate.mockRejectedValue(
        new AIError("connection payload", "not_running")
      );

      await extractCharacters(work, testRegistry());

      expect(executeCommand).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        `novelai.${providerId}`
      );
    }
  );

  test("セットアップのキャンセルは通知を増やさず何も保存しない", async () => {
    state.configured = false;
    const showInformationMessage = vi.fn(async () => undefined);
    const showWarningMessage = vi.fn(async () => undefined);
    const showErrorMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage,
      showWarningMessage,
      showErrorMessage,
    });

    await extractCharacters(work, testRegistry());

    expect(state.generate).not.toHaveBeenCalled();
    expect(state.saveAll).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  test("失敗チャンクを自動再試行せず別プロバイダへフォールバックしない", async () => {
    const showWarningMessage = vi.fn(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate
      .mockRejectedValueOnce(new AIError("timed out", "timeout"))
      .mockResolvedValueOnce(successfulResult("澪"));

    await extractCharacters(work, testRegistry());

    expect(state.generate).toHaveBeenCalledTimes(2);
    expect(
      state.generate.mock.calls.filter(([params]) =>
        (params as { userPrompt: string }).userPrompt.includes("灯が歩いた。")
      )
    ).toHaveLength(1);
    expect(
      state.generate.mock.calls.filter(([params]) =>
        (params as { userPrompt: string }).userPrompt.includes("澪が歩いた。")
      )
    ).toHaveLength(1);
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "失敗 1チャンク"
    );
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
