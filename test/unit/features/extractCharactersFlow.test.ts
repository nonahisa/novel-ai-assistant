import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  commands,
  FileSystemError,
  window,
  workspace,
  type StubMessage,
} from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import { splitIntoChunks, type Chunk } from "../../../src/core/chunker";
import type { WorkEntry } from "../../../src/models/types";
import {
  AIError,
  recoveryForAIError,
} from "../../../src/ai/types";

const state = vi.hoisted(() => ({
  saveAll: vi.fn(),
  cacheSet: vi.fn(),
  cacheSave: vi.fn(),
  dirtyDocumentPaths: vi.fn(),
  generate: vi.fn(),
  cachedResults: new Map<string, unknown>(),
  /** キャッシュを引いたときの鍵（JSON）。引いた順に積む */
  cacheGetKeys: [] as string[],
  mergeResult: undefined as unknown,
  providerId: "ollama" as "ollama" | "claude",
  configured: true,
  testConnection: vi.fn(),
  savedAbilities: [] as unknown[],
  savedLocations: [] as unknown[],
  savedOrganizations: [] as unknown[],
  savedWorldItems: [] as unknown[],
  /** 既定のチャンク列を上書きしたいテストだけが設定する */
  chunks: undefined as unknown[] | undefined,
  /**
   * `CharacterStore.loadAll` が返す既存の人物。既定は空（新規のみのテストが多い）。
   * 「承認待ちがあるとき」を確かめるテストだけが、既存人物を積む。
   */
  loadedCharacters: [] as unknown[],
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
      readonly kind:
        | "modified_externally"
        | "path_conflict"
        | "unsaved_changes"
        | "io_error",
      options?: {
        persistenceState?: "not_saved" | "ambiguous";
        recoveryPaths?: string[];
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
      this.persistenceState = options?.persistenceState ?? "not_saved";
      this.recoveryPaths = options?.recoveryPaths ?? [];
    }
    readonly persistenceState: "not_saved" | "ambiguous";
    readonly recoveryPaths: string[];
  },
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () =>
    state.configured
      ? {
          provider: {
            id: state.providerId,
            isPaid: state.providerId !== "ollama",
            generate: state.generate,
            testConnection: state.testConnection,
          },
          model: "test-model",
        }
      : undefined
  ),
}));

/**
 * 記録（`core/logger.ts`）は本物を通さず、書かれた行だけを受け取る。
 *
 * **抽出が終わったことと件数の内訳は、知らせ（通知）だけでなく記録にも
 * 残す**（作者の裁定、2026-09-19）。知らせは消えるので、「新規0名・
 * 更新0名」で終わった回に、除外や失敗のせいなのか、本当に増えるものが
 * 無かったのかを、あとから区別できなかった。
 */
const loggedSteps = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../../../src/core/logger", () => ({
  logStep: vi.fn((message: string) => loggedSteps.lines.push(message)),
  logLine: vi.fn((message: string) => loggedSteps.lines.push(message)),
  logFailure: vi.fn(),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
}));

vi.mock("../../../src/core/scanner", () => ({
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

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "灯が歩いた。",
    hasConflictMarkers: false,
  })),
  // チャンクを分け直すときにハッシュを取り直す。
  // 中身が違えば違う値になること（キャッシュが誤って当たらないこと）だけ守る
  hashText: (text: string) => `hash-${text.length}-${text.slice(0, 1)}`,
}));

// `startLine`（元ファイルの何行目から始まるか。0始まり）は、人物抽出では
// 使われない——AIに行番号を言わせるのは誤字脱字と推敲だけである。
// ただしチャンクの型としては必須なので、**1チャンク＝1行として辻褄の合う値**
// （連番と一致させた行番号）を置いておく
const chunks: Chunk[] = [
  {
    filePath: "001.txt",
    index: 0,
    text: "灯が歩いた。",
    hash: "chunk-1",
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
  },
  {
    filePath: "001.txt",
    index: 1,
    text: "澪が歩いた。",
    hash: "chunk-2",
    startLine: 1,
    chapterStart: 1,
    chapterEnd: 1,
  },
];

/** 追加のチャンクを要するテスト（接続断の打ち切り等）だけが差し替える */
function chunkFixture(count: number): Chunk[] {
  return Array.from({ length: count }, (_, index) => ({
    filePath: "001.txt",
    index,
    text: `本文${index + 1}。`,
    hash: `chunk-${index + 1}`,
    // 上の固定チャンクと同じく、1チャンク＝1行として連番に合わせる
    startLine: index,
    chapterStart: 1,
    chapterEnd: 1,
  }));
}

vi.mock("../../../src/core/chunker", async (importOriginal) => {
  // 結合と分け直しは本物を使う。テストで作った固定チャンクが
  // 実際にどうまとめられるかまで見たいため
  const actual = await importOriginal<typeof import("../../../src/core/chunker")>();
  return {
    ...actual,
    decideChunkSize: vi.fn(() => 1000),
    /**
     * **自動で決まる分だけを、テスト用の小さな値に置き換える。**
     *
     * `decideChunkSize` を差し替えるだけでは効かない。`resolveChunkChars`
     * は同じファイルの中から呼んでおり、モジュールの外から差し替えた
     * 輸出は通らないためである（2026-08-23、6.23の作業で判明）。
     * 設定で指定した値（`from: "setting"`）はそのまま通す——
     * そこを潰すと、設定が効くことを確かめるテストが意味を失う。
     */
    resolveChunkChars: vi.fn(
      (options: Parameters<typeof actual.resolveChunkChars>[0]) => {
        const resolved = actual.resolveChunkChars(options);
        return resolved.from === "setting"
          ? resolved
          : { ...resolved, chars: 1000 };
      }
    ),
    splitIntoChunks: vi.fn(() => state.chunks ?? chunks),
  };
});

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStoreError: state.CharacterStoreError,
  CharacterStore: class {
    async loadAll() {
      return { characters: state.loadedCharacters, errors: [] };
    }
    async dirtyDocumentPaths() {
      return state.dirtyDocumentPaths();
    }
    async saveAll(characters: unknown[]) {
      return state.saveAll(characters);
    }
  },
}));

vi.mock("../../../src/core/characterMerge", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/core/characterMerge")
  >();
  return {
    ...actual,
    mergeExtractedCharacters: (
      ...args: Parameters<typeof actual.mergeExtractedCharacters>
    ) =>
      state.mergeResult ?? actual.mergeExtractedCharacters(...args),
  };
});

// 能力・場所の保存はこのテストの対象外。人物フローに集中させる。
// 収集した件数だけ state に残し、必要なテストから参照する。
vi.mock("../../../src/core/abilityStore", () => ({
  AbilitySystemStore: class {
    async load() {
      return {
        schemaVersion: "0.1",
        abilityTerm: "能力",
        description: null,
        rules: [],
        authorNotes: "",
        autoGenerated: true,
        updatedAt: "",
      };
    }
    async save() {}
  },
  createAbilityStore: () => ({
    async loadAll() {
      return { records: [], errors: [] };
    },
    async saveAll(records: unknown[]) {
      state.savedAbilities.push(...records);
    },
  }),
  createLocationStore: () => ({
    async loadAll() {
      return { records: [], errors: [] };
    },
    async saveAll(records: unknown[]) {
      state.savedLocations.push(...records);
    },
  }),
  createOrganizationStore: () => ({
    async loadAll() {
      return { records: [], errors: [] };
    },
    async saveAll(records: unknown[]) {
      state.savedOrganizations.push(...records);
    },
  }),
  createWorldStore: () => ({
    async loadAll() {
      return { records: [], errors: [] };
    },
    async saveAll(records: unknown[]) {
      state.savedWorldItems.push(...records);
    },
  }),
}));

vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get(hash: string, key?: unknown) {
      // 引いた鍵を控える（人物の顔ぶれで鍵が変わらないことを見るテストが使う）
      state.cacheGetKeys.push(JSON.stringify(key));
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

/**
 * 完了の知らせの「提案を見る」が、どの提案パネルへ渡したかを覗く口。
 *
 * **既定では本物へそのまま通す**（ほかの試験の振る舞いを変えない）。
 * `intercept` を立てた試験だけが、渡された引数を控えて本物を呼ばない。
 */
const pendingApply = vi.hoisted(() => ({
  intercept: false,
  calls: [] as unknown[][],
}));
vi.mock("../../../src/features/applyPendingUpdates", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/features/applyPendingUpdates")
  >();
  return {
    ...actual,
    applyPendingCharacterUpdates: async (
      ...args: Parameters<typeof actual.applyPendingCharacterUpdates>
    ) => {
      if (!pendingApply.intercept) {
        return actual.applyPendingCharacterUpdates(...args);
      }
      pendingApply.calls.push(args);
    },
  };
});

import {
  characterExtractCacheKey,
  extractCharacters,
  saveDirtyDocumentsBeforeExtraction,
} from "../../../src/features/extractCharacters";
import { CharacterStoreError } from "../../../src/core/characterStore";
import { emptyCharacter } from "../../../src/models/character";
import {
  bridgeConfirmsToMessages,
  type ConfirmPicker,
} from "../support/confirmPicker";

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
    text: JSON.stringify({
      characters: [{ name, evidence: `${name}が歩いた。` }],
    }),
    truncated: false,
    elapsedMs: 1,
  };
}

describe("AI失敗後の復旧案内", () => {
  test.each([
    ["not_running", "AIを起動し、接続先設定を確認してください。"],
    ["model_not_found", "利用可能なモデルを選び直してください。"],
    [
      "timeout",
      // **秒数を当てさせない道も示す**（設計書6.49、2026-08-30）。
      // 何秒あれば足りるかはモデルと本文で変わるので、測れることを伝える。
      // **サービス名は書かない**ので、料金も「有料のAIでは」に留める
      // **既定を「180秒」と断定しない。** Claudeだけ300秒であり、
      // 使っているのがClaudeのときは事実と違う案内になる
      // （サービス名を書かない方針なので、幅で言う）
      "拡張機能の設定で、お使いのAIの「タイムアウト」の秒数を延ばしてください" +
        "（既定は180秒。AIによっては300秒です。長い本文では足りないことがあります）。" +
        "それでも切れるなら「1チャンクの文字数」を小さくしてください。" +
        "「AIチューニング」を実行すると、このモデルに合った待ち時間を測って設定できます" +
        "（AIを呼ぶので、有料のAIでは料金がかかります）。",
    ],
    ["bad_response", "出力上限とモデル設定を確認してください。"],
    // 使っているのがGeminiでも「Claudeの…」と出て混乱させたため、
    // 案内文にサービス名を書かない
    ["authentication_failed", "APIキーを確認して再登録してください。"],
    ["permission_denied", "APIキーの利用権限または請求設定を確認してください。"],
    // 手元で動くAIがモデルを載せられなかったとき。待っても直らないので、
    // 再試行ではなく「小さいモデル」「文脈を短くする」「メモリを空ける」を示す。
    // **ここもサービス名を書かない。** 以前はLM Studio決め打ちで設定名まで
    // 出しており、Ollamaが同じ種別を返すようになったとき（0.28.1）、
    // Ollamaを使っているのに「LM Studioの設定で…」と出ていた。
    // サービスごとの具体策は、投げる側が message に添える
    [
      "model_load_failed",
      "より小さいモデルを選ぶか、読み込むときの文脈の長さを短くしてください。" +
        "ほかのアプリを閉じてメモリを空けると載ることもあります。",
    ],
    ["rate_limited", "しばらく待ってから、必要な場合に手動で再実行してください。"],
    ["aborted", "必要なら抽出をもう一度実行してください。"],
    ["unknown", "AI設定と拡張機能のログを確認してください。"],
  ] as const)("%s に具体的な復旧操作を1つ示す", (kind, expected) => {
    const error = new AIError("provider payload", kind, "secret detail");

    expect(recoveryForAIError(error)).toBe(expected);
  });
});

describe("人物抽出フロー", () => {
  /*
    実行の確認は画面上部の選択窓で出る（A4、2026-09-23）。このファイルは
    確認で何を押すかを `showInformationMessage` の差し替えで決めている
    （60か所近い）ので、選択窓に出た確認をそこへ橋渡しする
  */
  let confirmBridge: ConfirmPicker | undefined;

  beforeEach(() => {
    confirmBridge?.restore();
    confirmBridge = bridgeConfirmsToMessages();
    vi.clearAllMocks();
    state.generate.mockReset();
    state.saveAll.mockReset().mockResolvedValue(undefined);
    state.cacheSet.mockReset();
    state.cacheSave.mockReset();
    state.dirtyDocumentPaths.mockReset().mockResolvedValue([]);
    state.cachedResults.clear();
    state.mergeResult = undefined;
    state.providerId = "ollama";
    state.configured = true;
    state.chunks = undefined;
    state.savedAbilities.length = 0;
    state.savedLocations.length = 0;
    state.savedOrganizations.length = 0;
    state.savedWorldItems.length = 0;
    state.loadedCharacters = [];
    // 既定では疎通できている状態にする。接続断は個別テストで再現する
    state.testConnection
      .mockReset()
      .mockResolvedValue({ ok: true, message: "接続しました", modelCount: 1 });
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
    workspace.textDocuments = [];
    // 既定は空（`PendingUpdateStore` を使わないテストがほとんど）。
    // 承認待ちを確かめるテストだけが、下で偽ディスクへ差し替える
    workspace.fs = {} as unknown as typeof workspace.fs;
  });

  test("保存に失敗した文書がある場合はunsafe continueを提示せず中止する", async () => {
    const save = vi.fn(async () => false);
    workspace.textDocuments = [{
      uri: { fsPath: "c:\\NOVELS\\WORK\\本文\\001.txt" },
      isDirty: true,
      getText: () => "未保存本文",
      save,
    }];
    // 通知の代役には、**本当の呼ばれ方**（`(文言, ...押せる操作)`）の型を
    // 付ける（`StubMessage`）。引数なしの関数として書くと mock.calls の
    // 中身が空の組になり、「何番目の引数に何を渡したか」を見る
    // このファイルの検査がどれも型で引けなくなる
    const showWarningMessage = vi.fn<StubMessage>(async () => "保存して実行");
    Object.assign(window, { showWarningMessage });

    await expect(saveDirtyDocumentsBeforeExtraction(work)).resolves.toBe(false);

    expect(save).toHaveBeenCalledOnce();
    expect(showWarningMessage.mock.calls[0]?.slice(1)).toEqual([
      "保存して実行",
      "中止",
    ]);
    expect(showWarningMessage.mock.calls.flat()).not.toContain("そのまま実行");
  });

  test("saveがtrueでもdirtyのままなら再検査で中止する", async () => {
    const document = {
      uri: { fsPath: "C:\\novels\\work\\設定\\characters\\char_001_灯.json" },
      isDirty: true,
      getText: () => "未保存設定",
      save: vi.fn(async () => true),
    };
    workspace.textDocuments = [document];
    Object.assign(window, {
      showWarningMessage: vi.fn(async () => "保存して実行"),
      showErrorMessage: vi.fn(async () => undefined),
    });

    await expect(saveDirtyDocumentsBeforeExtraction(work)).resolves.toBe(false);
  });

  test("モデル情報を取得できないまま既定値で分割せず中止する", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => "中止");
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
    // 疎通はできるがモデル情報だけ取れない（モデルが削除された等）
    const registry = {
      resolveModelInfo: vi.fn(async () => undefined),
    } as unknown as AIRegistry;

    await extractCharacters(work, registry);

    // 既定の8192で細かく刻んでキャッシュを無効化してしまうより、止める
    expect(state.generate).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "これまでの処理済みキャッシュが使えなくなります"
    );
  });

  test("接続断でモデル情報が取れない場合は疎通回復後に取り直す", async () => {
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => "再試行"),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    // 1回目はOllamaが落ちていて取得失敗、疎通回復後は本来の値が返る
    const resolveModelInfo = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ contextWindow: 131072 });
    state.testConnection
      .mockResolvedValueOnce({ ok: false, message: "Ollamaに接続できません" })
      .mockResolvedValue({ ok: true, message: "接続しました", modelCount: 1 });
    state.generate.mockResolvedValue(successfulResult("灯"));

    await extractCharacters(work, {
      resolveModelInfo,
    } as unknown as AIRegistry);

    // 取り直した本来のコンテキスト長で処理が進む
    expect(resolveModelInfo).toHaveBeenCalledTimes(2);
    expect(state.generate).toHaveBeenCalled();
  });

  test("AIへ接続できないときはAIを呼ばずに警告して中止する", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => "中止");
    const showInformationMessage = vi.fn<StubMessage>(async () => "実行");
    Object.assign(window, {
      showInformationMessage,
      showWarningMessage,
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.testConnection.mockResolvedValue({
      ok: false,
      message:
        "Ollamaに接続できません（http://localhost:11434）。Ollamaが起動しているか確認してください。",
    });

    await extractCharacters(work, testRegistry());

    // 接続前に止まるので、AI呼び出しも保存も発生しない
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.saveAll).not.toHaveBeenCalled();
    // 処理量の確認ダイアログまで到達しない
    expect(showInformationMessage).not.toHaveBeenCalled();

    const warning = showWarningMessage.mock.calls.at(-1);
    expect(warning?.[0]).toContain("AIに接続できないため");
    expect(warning?.[0]).toContain("Ollamaが起動しているか確認してください");
    // 既定の接続先はローカルなので、起動ボタンも提示される
    expect(warning?.slice(1)).toEqual([
      "Ollamaを起動",
      "再試行",
      "設定を開く",
      "中止",
    ]);
  });

  test("ローカルOllamaが落ちているときは起動ボタンを提示する", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => "中止");
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
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        key === "ollama.endpoint"
          ? ("http://localhost:11434" as unknown as T)
          : defaultValue,
    });
    state.testConnection.mockResolvedValue({
      ok: false,
      message: "Ollamaに接続できません",
    });

    await extractCharacters(work, testRegistry());

    expect(showWarningMessage.mock.calls.at(-1)?.slice(1)).toEqual([
      "Ollamaを起動",
      "再試行",
      "設定を開く",
      "中止",
    ]);
  });

  test("別マシンのOllamaには起動ボタンを出さない", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => "中止");
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
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        key === "ollama.endpoint"
          ? ("http://gpu-server:11434" as unknown as T)
          : defaultValue,
    });
    state.testConnection.mockResolvedValue({
      ok: false,
      message: "Ollamaに接続できません",
    });

    await extractCharacters(work, testRegistry());

    // 別マシンのプロセスは起動できないので提案しない
    expect(showWarningMessage.mock.calls.at(-1)?.slice(1)).toEqual([
      "再試行",
      "設定を開く",
      "中止",
    ]);
  });

  test("Claudeには起動ボタンを出さない", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => "中止");
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
    state.providerId = "claude";
    state.testConnection.mockResolvedValue({
      ok: false,
      message: "Claudeに接続できません。ネットワーク接続を確認してください。",
    });

    await extractCharacters(work, testRegistry());

    expect(showWarningMessage.mock.calls.at(-1)?.slice(1)).toEqual([
      "再試行",
      "設定を開く",
      "中止",
    ]);
  });

  test("接続失敗の警告で設定を開くとプロバイダの設定画面へ誘導する", async () => {
    const executeCommand = vi.fn(async () => undefined);
    Object.assign(commands, { executeCommand });
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => "設定を開く"),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.providerId = "claude";
    state.testConnection.mockResolvedValue({
      ok: false,
      message: "ClaudeのAPIキーが未設定です。",
    });

    await extractCharacters(work, testRegistry());

    expect(executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "novelai.claude"
    );
    expect(state.generate).not.toHaveBeenCalled();
  });

  test("再試行を選ぶと接続を確認し直し、回復すれば処理を続行する", async () => {
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => "再試行"),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.testConnection
      .mockResolvedValueOnce({ ok: false, message: "Ollamaに接続できません" })
      .mockResolvedValue({ ok: true, message: "接続しました", modelCount: 1 });
    state.generate.mockResolvedValue(successfulResult("灯"));

    await extractCharacters(work, testRegistry());

    expect(state.testConnection).toHaveBeenCalledTimes(2);
    expect(state.generate).toHaveBeenCalled();
  });

  test("実行中に接続が連続で切れたら残りを試さず中断を伝える", async () => {
    state.chunks = chunkFixture(10);
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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
    // 1件成功したあとにOllamaが落ちた状況
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockRejectedValue(
        new AIError("Ollamaに接続できません", "not_running")
      );

    await extractCharacters(work, testRegistry());

    // 成功1回 + 連続失敗3回で打ち切る。10チャンク全部は試さない
    expect(state.generate).toHaveBeenCalledTimes(4);
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "AIへ接続できなくなったため、残りのチャンクを中断しました"
    );
  });

  test("出力上限で切り詰められたら小さくして試し直し、残りも先に分ける", async () => {
    // 実データで、39チャンク中33件が同じ理由（出力上限）で失敗した。
    // 1件ずつ捨てていくと、その回数だけ呼び出しが無駄になる
    const body = (mark: string) =>
      `${mark.repeat(3000)}\n\n${mark.repeat(3000)}`;
    state.chunks = ["あ", "い", "う"].map((mark, index) => ({
      filePath: "001.txt",
      index,
      text: body(mark),
      hash: `chunk-${index + 1}`,
      chapterStart: 1,
      chapterEnd: 1,
    }));

    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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
    // 1件目だけ切り詰められ、以降は通る
    state.generate
      .mockResolvedValueOnce({ text: "", truncated: true, elapsedMs: 1 })
      .mockResolvedValue(successfulResult("灯"));

    await extractCharacters(work, testRegistry());

    const lengths = state.generate.mock.calls.map(
      (call) => (call[0] as { userPrompt: string }).userPrompt.length
    );

    // 2回目以降は半分の大きさで送られる
    expect(lengths[0]).toBeGreaterThan(lengths[1]);
    // 1回目（切り詰め）＋ 3件を半分にした6回。
    // **同じ失敗を3回繰り返さない**のが要点（実データでは33回繰り返した）
    expect(state.generate).toHaveBeenCalledTimes(7);
    // 分け直して処理できたので、失敗として数えない
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "失敗 0チャンク"
    );
  });

  test("まとめたチャンクを先に分けるときも、半分ではなく話ごとに戻す", async () => {
    // 切り詰められた本人は話ごとに戻していたのに、
    // 「同じ大きさの残り」だけが半分に割られていた。
    // 半分に割ると内訳（どこからどこまでが何話か）が消え、
    // **第4話にしか出ない人物が「第4〜6話に登場」になる**
    state.chunks = ["あ", "い", "う", "え", "お", "か"].map((mark, index) => ({
      filePath: `00${index + 1}.txt`,
      index: 0,
      text: mark.repeat(300),
      hash: `chunk-${index + 1}`,
      chapterStart: index + 1,
      chapterEnd: index + 1,
      // 1ファイルまるごと。これがないとまとめられない
      wholeFile: true,
    }));

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
    // 1件目（第1〜3話をまとめたもの）だけ切り詰められる。
    // これで残りの「第4〜6話をまとめたもの」が先に分けられる
    state.generate
      .mockResolvedValueOnce({ text: "", truncated: true, elapsedMs: 1 })
      .mockResolvedValue(successfulResult("灯"));

    await extractCharacters(work, testRegistry());

    const prompts = state.generate.mock.calls.map(
      (call) => (call[0] as { userPrompt: string }).userPrompt
    );
    // 指示文にも「あ」「い」等は出るので、まとまった本文だけを数える
    const marksIn = (prompt: string) =>
      ["え", "お", "か"].filter((mark) => prompt.includes(mark.repeat(100)));

    // 先に分けた残りが、2話ぶんをまたいだまま送られていない
    expect(prompts.filter((prompt) => marksIn(prompt).length > 1)).toEqual([]);
    // 第4〜6話が、それぞれ1話まるごととして送られている
    for (const mark of ["え", "お", "か"]) {
      expect(prompts.some((prompt) => prompt.includes(mark.repeat(300)))).toBe(
        true
      );
    }
  });

  test("接続失敗が連続しなければ打ち切らず最後まで処理する", async () => {
    state.chunks = chunkFixture(6);
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
    // 一時的な揺らぎ（失敗と成功が交互）では中断しない
    state.generate
      .mockRejectedValueOnce(new AIError("timeout", "timeout"))
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockRejectedValueOnce(new AIError("timeout", "timeout"))
      .mockResolvedValueOnce(successfulResult("澪"))
      .mockRejectedValueOnce(new AIError("timeout", "timeout"))
      .mockResolvedValueOnce(successfulResult("灯"));

    await extractCharacters(work, testRegistry());

    expect(state.generate).toHaveBeenCalledTimes(6);
  });

  test("キャッシュだけで完結する場合は接続を確認しない", async () => {
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.cachedResults.set("chunk-1", {
      characters: [{ name: "灯", evidence: "灯が歩いた。" }],
    });
    state.cachedResults.set("chunk-2", {
      characters: [{ name: "澪", evidence: "澪が歩いた。" }],
    });

    await extractCharacters(work, testRegistry());

    // Ollamaが落ちていてもキャッシュからの再反映はできるべき
    expect(state.testConnection).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  // 抽出のあと資料Markdownを作り直してよいかを、呼び出し側がこの戻り値で決める。
  // 中止したのに資料まで作り直すと、作者は何が起きたのか分からなくなる。
  test("保存まで進んだらtrueを返す", async () => {
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
    state.generate.mockResolvedValue(successfulResult("灯"));

    await expect(extractCharacters(work, testRegistry())).resolves.toBe(true);
  });

  test("確認で中止したらfalseを返す", async () => {
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "中止"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });

    await expect(extractCharacters(work, testRegistry())).resolves.toBe(false);
    expect(state.generate).not.toHaveBeenCalled();
  });

  test("1回のAI応答から人物・能力・場所をまとめて保存する", async () => {
    // 種別ごとにAIを呼ぶと同じ本文を3回読ませることになるため、
    // 1チャンク1回の応答を3種類に振り分ける。
    const showInformationMessage = vi.fn<StubMessage>(async () => "実行");
    Object.assign(window, {
      showInformationMessage,
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    // 能力名・場所名も本文に実在しなければ捏造として弾かれる。
    // 3種類とも根拠を満たす本文を用意する。
    const line = "灯が灯火を唱え、図書塔へ入った。";
    state.chunks = [
      {
        filePath: "001.txt",
        index: 0,
        text: line,
        hash: "chunk-1",
        chapterStart: 1,
        chapterEnd: 1,
      },
    ];
    state.generate.mockResolvedValue({
      text: JSON.stringify({
        characters: [{ name: "灯", evidence: line }],
        abilities: [{ name: "灯火", evidence: line }],
        locations: [{ name: "図書塔", evidence: line }],
        abilitySystem: { abilityTerm: "神術" },
      }),
      truncated: false,
      elapsedMs: 1,
    });

    await extractCharacters(work, testRegistry());

    expect(state.saveAll).toHaveBeenCalled();
    expect(state.savedAbilities).toHaveLength(1);
    expect(state.savedLocations).toHaveLength(1);
    // 総称は作品の呼称を使う（「能力」ではなく「神術」）
    expect(showInformationMessage.mock.calls.at(-1)?.[0]).toContain("神術");
  });

  test("能力・場所が無い作品では該当行を出さない", async () => {
    const showInformationMessage = vi.fn<StubMessage>(async () => "実行");
    Object.assign(window, {
      showInformationMessage,
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
      text: JSON.stringify({
        characters: [{ name: "灯", evidence: "灯が歩いた。" }],
        abilities: [],
        locations: [],
        abilitySystem: { abilityTerm: null },
      }),
      truncated: false,
      elapsedMs: 1,
    });

    await extractCharacters(work, testRegistry());

    expect(state.savedAbilities).toHaveLength(0);
    expect(state.savedLocations).toHaveLength(0);
    // 「能力 0件」のような意味のない行を出さない
    const message = String(showInformationMessage.mock.calls.at(-1)?.[0] ?? "");
    expect(message).not.toContain("場所:");
    expect(message).not.toContain("能力:");
  });

  test("切り詰め応答を保存せず出力上限かチャンク縮小を案内する", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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

  test("人物JSONに未保存変更がある場合はAI処理を開始しない", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
    Object.assign(window, {
      showWarningMessage,
      showInformationMessage: vi.fn(async () => "実行"),
    });
    state.dirtyDocumentPaths.mockResolvedValue([
      "C:\\NOVELS\\WORK\\設定\\characters\\char_001_灯.json",
    ]);

    await extractCharacters(work, testRegistry());

    expect(state.generate).not.toHaveBeenCalled();
    expect(state.saveAll).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "未保存の人物設定"
    );
  });

  test("AI処理中に人物JSONがdirtyになった場合は保存直前に再検査して拒否する", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.dirtyDocumentPaths
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["C:\\novels\\work\\設定\\characters\\char_001_灯.json"]);
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockResolvedValueOnce(successfulResult("澪"));

    await extractCharacters(work, testRegistry());

    expect(state.saveAll).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls.at(-1)?.[0]).toContain(
      "保存直前に未保存の人物設定"
    );
  });

  test("キャッシュ保存失敗を警告して有効な人物結果の保存を続ける", async () => {
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(
        async (_message: string, ...actions: string[]) =>
          actions.includes("実行") ? "実行" : undefined
      ),
      showWarningMessage,
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
    state.cacheSave.mockRejectedValueOnce(
      new Error("cache path credential=secret-value")
    );

    await extractCharacters(work, testRegistry());

    expect(state.saveAll).toHaveBeenCalledOnce();
    const summary = showWarningMessage.mock.calls.at(-1)?.[0];
    expect(summary).toContain("キャッシュ保存警告 1件");
    expect(summary).toContain("保存済み 2名");
    expect(summary).not.toContain("secret-value");
  });

  test.each([
    [
      "timeout",
      // **秒数を当てさせない道も示す**（設計書6.49、2026-08-30）。
      // 何秒あれば足りるかはモデルと本文で変わるので、測れることを伝える。
      // **サービス名は書かない**ので、料金も「有料のAIでは」に留める
      // **既定を「180秒」と断定しない。** Claudeだけ300秒であり、
      // 使っているのがClaudeのときは事実と違う案内になる
      // （サービス名を書かない方針なので、幅で言う）
      "拡張機能の設定で、お使いのAIの「タイムアウト」の秒数を延ばしてください" +
        "（既定は180秒。AIによっては300秒です。長い本文では足りないことがあります）。" +
        "それでも切れるなら「1チャンクの文字数」を小さくしてください。" +
        "「AIチューニング」を実行すると、このモデルに合った待ち時間を測って設定できます" +
        "（AIを呼ぶので、有料のAIでは料金がかかります）。",
    ],
    ["aborted", "必要なら抽出をもう一度実行してください。"],
  ] as const)("%s を失敗チャンクとして復旧案内する", async (kind, recovery) => {
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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
            { name: "灯", evidence: "灯が歩いた。" },
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
      const showErrorMessage = vi.fn<StubMessage>(async () => undefined);
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
    const showErrorMessage = vi.fn<StubMessage>(async () => undefined);
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

  test("重複IDが含まれても未分類の未保存人数を水増ししない", async () => {
    const showErrorMessage = vi.fn<StubMessage>(async () => undefined);
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
    const duplicate = emptyCharacter("char_001", "灯");
    state.mergeResult = {
      characters: [duplicate, structuredClone(duplicate)],
      added: ["灯"],
      updated: [],
      changedIds: ["char_001"],
      conflicts: [],
      folded: [],
      heldChanges: [],
    };
    state.generate
      .mockResolvedValueOnce(successfulResult("灯"))
      .mockResolvedValueOnce(successfulResult("澪"));
    state.saveAll.mockRejectedValueOnce(
      new CharacterStoreError("legacy progress", "path_conflict", {
        batchProgress: {
          completedIds: [],
          ambiguousIds: [],
          remainingIds: [],
        },
      })
    );

    await extractCharacters(work, testRegistry());

    const summary = showErrorMessage.mock.calls.at(-1)?.[0];
    expect(summary).toContain("保存競合による未保存 1名");
    expect(summary).not.toContain("保存競合による未保存 2名");
  });

  test("配置後の退避失敗は保存済みとも未保存とも数えず手動照合を促す", async () => {
    const showErrorMessage = vi.fn<StubMessage>(async () => undefined);
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

  test("曖昧な保存失敗は型付きの保存先と回復パスだけを詳細表示する", async () => {
    const destination = "C:\\novels\\work\\設定\\characters\\char_001_灯.json";
    const recovery = "C:\\novels\\work\\設定\\characters\\.novelai-recovery\\safe.bak";
    let detailContent = "";
    Object.assign(workspace, {
      openTextDocument: vi.fn(async (options: { content: string }) => {
        detailContent = options.content;
        return { uri: { fsPath: "recovery-details" } };
      }),
    });
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(
        async (_message: string, ...actions: string[]) =>
          actions.includes("回復パスを表示") ? "回復パスを表示" : undefined
      ),
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
      .mockResolvedValueOnce(successfulResult("澪"));
    state.saveAll.mockRejectedValueOnce(
      new CharacterStoreError("raw prompt credential=secret-value", "path_conflict", {
        persistenceState: "ambiguous",
        recoveryPaths: [destination, recovery],
        batchProgress: {
          completedIds: [],
          ambiguousIds: ["char_001"],
          remainingIds: ["char_002"],
        },
      })
    );

    await extractCharacters(work, testRegistry());

    expect(detailContent).toContain(destination);
    expect(detailContent).toContain(recovery);
    expect(detailContent).not.toContain("secret-value");
    expect(detailContent).not.toContain("灯が歩いた");
  });

  test.each([
    [
      "permission_denied",
      "APIキーの利用権限または請求設定を確認してください。",
      "設定を開く",
    ],
    [
      "rate_limited",
      "しばらく待ってから、必要な場合に手動で再実行してください。",
      undefined,
    ],
  ] as const)("Claudeの%sを一般応答エラーへ潰さず即停止する", async (
    kind,
    recovery,
    expectedAction
  ) => {
    state.providerId = "claude";
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "実行"),
      showWarningMessage,
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
      ),
    });
    state.generate.mockRejectedValue(
      new AIError("provider payload", kind, "credential=secret-value")
    );

    await extractCharacters(work, testRegistry());

    expect(state.generate).toHaveBeenCalledOnce();
    const call = showWarningMessage.mock.calls.at(-1);
    expect(call?.[0]).toContain(recovery);
    if (expectedAction) expect(call?.slice(1)).toContain(expectedAction);
    expect(call?.[0]).not.toContain("secret-value");
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
    // 復旧案内が詳細にも入っていること（文言そのものではなく、
    // 作者が触る場所を指しているかを見る）
    expect(detailContent).toContain("「1チャンクの文字数」を小さくしてください。");
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
    const showInformationMessage = vi.fn<StubMessage>(async () => undefined);
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
    const showErrorMessage = vi.fn<StubMessage>(async () => undefined);
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
    const showWarningMessage = vi.fn<StubMessage>(async () => undefined);
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

  /**
   * **「文字数を指定する」を選んだときだけ効く**（設計書6.23）。
   * 既定は「モデルによって可変」で、そのときは字数の指定を見ない。
   */
  test("字数を指定する設定なら、その値を分割へ渡す", async () => {
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "chunkChars"
          ? 321
          : key === "chunkSizeMode"
            ? "文字数を指定する"
            : defaultValue) as T,
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

  test("字数を指定するのに1未満なら、モデルから決め直す", async () => {
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "chunkChars"
          ? 0.5
          : key === "chunkSizeMode"
            ? "文字数を指定する"
            : defaultValue) as T,
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
      characters: [{ name: "灯", evidence: "灯が歩いた。" }],
    });
    state.cachedResults.set("chunk-2", {
      characters: [{ name: "澪", evidence: "澪が歩いた。" }],
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

  /*
    実機確認リスト F-10 の「分けたあと、設定資料を抽出をもう一度実行して、
    AIが呼ばれないか」（2026-09-07 の実機では呼ばれたが、版が上がって鍵が
    外れた回と切り分けられなかった）。

    **2026-09-24 夜から、答えが逆になった。** 作者の裁定「人物が増えたら
    読み直す」で、使い回しの鍵に**既に分かっている人物の顔ぶれ**（本名）が
    入った（`promptVersionWithKnownCast`）。分けると「お嬢様」という人物が
    増えるので、分けたあとの抽出は**分けた顔ぶれで読み直す**——同一人物の
    判定に使う名前がプロンプトへ渡るようになり、分けた判断が次の読みに効く。

    ここでは、同じ顔ぶれなら鍵が変わらないこと、分けたら鍵が変わること、
    鍵に名前そのものは入らない（要約のハッシュだけ）ことを見る。
    読み直しで実際に未処理へ数えられることは、本物のキャッシュで
    `cross/characterExtractCastKey.test.ts` が確かめている（この模擬は鍵を見ずに返す）。
  */
  test("人物を分けたら、分けた顔ぶれで読み直す鍵になる", async () => {
    state.cachedResults.set("chunk-1", {
      characters: [{ name: "文佳", evidence: "灯が歩いた。" }],
    });
    state.cachedResults.set("chunk-2", {
      characters: [{ name: "お嬢様", evidence: "澪が歩いた。" }],
    });
    const showInformationMessage = vi.fn(
      async (_message: string, ..._items: unknown[]) => undefined
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
    const registry = {
      resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
    } as unknown as AIRegistry;

    // 分ける前：「お嬢様」は「文佳」の別名の1つだった
    const beforeSplit = [
      { ...emptyCharacter("char_001", "文佳"), aliases: ["お嬢様"] },
    ];
    state.loadedCharacters = beforeSplit;
    state.cacheGetKeys.length = 0;
    await extractCharacters(work, registry);
    const keysBeforeSplit = [...state.cacheGetKeys];

    // 同じ顔ぶれでもう一度：鍵は変わらない（読み直さない）
    state.loadedCharacters = beforeSplit;
    state.cacheGetKeys.length = 0;
    await extractCharacters(work, registry);
    expect(state.cacheGetKeys.length).toBeGreaterThan(0);
    expect(state.cacheGetKeys).toEqual(keysBeforeSplit);

    // 分けたあと：別人の印つきの元の人物と、中身が空の新しい人物
    const afterSplit = [
      {
        ...emptyCharacter("char_001", "文佳"),
        autoGenerated: false,
        distinctFrom: [{ name: "お嬢様", id: "char_022" }],
      },
      { ...emptyCharacter("char_022", "お嬢様"), autoGenerated: true },
    ];
    state.loadedCharacters = afterSplit;
    state.cacheGetKeys.length = 0;
    showInformationMessage.mockClear();
    await extractCharacters(work, registry);

    // 引いた鍵は分ける前と違う＝分けた顔ぶれで読み直す
    expect(state.cacheGetKeys.length).toBeGreaterThan(0);
    expect(state.cacheGetKeys).not.toEqual(keysBeforeSplit);
    const expected = JSON.stringify(
      characterExtractCacheKey("ollama", "test-model", afterSplit)
    );
    expect(new Set(state.cacheGetKeys)).toEqual(new Set([expected]));
    // 鍵に入るのは顔ぶれの要約だけで、名前そのものは入らない
    expect(state.cacheGetKeys.join("\n")).not.toContain("お嬢様");
  });

  test("キャッシュの生出力も再検証して人物でない候補を除外する", async () => {
    state.cachedResults.set("chunk-1", {
      characters: [
        { name: "灯", evidence: "灯が歩いた。" },
        { name: "先生", evidence: "灯が歩いた" },
      ],
    });
    state.cachedResults.set("chunk-2", { characters: [] });
    const showInformationMessage = vi.fn<StubMessage>(async () => undefined);
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
    // 「先生」は語り手ではないので、語り手の断り書きは出さない
    // （毎回出る断り書きは読まれなくなる）
    expect(showInformationMessage.mock.calls.at(-1)?.[0]).not.toContain(
      "地の文の語り手らしき人物"
    );
  });

  test("名前が決められずに落とした語り手らしき人物を、完了報告で知らせる", async () => {
    // 一人称の作品では、AIが外見まで読み取っていても「僕」としか呼べず、
    // レコードごと捨てられる。**捨てるのは正しいが、件数だけでは伝わらない**
    // （作者の報告、2026-09-24）
    state.cachedResults.set("chunk-1", {
      characters: [
        { name: "灯", evidence: "灯が歩いた。" },
        { name: "僕", appearance: "背が高い", evidence: "灯が歩いた" },
      ],
    });
    state.cachedResults.set("chunk-2", { characters: [] });
    const showInformationMessage = vi.fn<StubMessage>(async () => undefined);
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

    const message = String(showInformationMessage.mock.calls.at(-1)?.[0]);
    expect(message).toContain(
      "地の文の語り手らしき人物を1件、名前が決められないため登録しませんでした。"
    );
    expect(message).toContain(
      "AIは「僕」という名前で返しています（外見：背が高い）。"
    );
    // 原稿を直せとは言わない。手で書き足せることだけを伝える
    expect(message).toContain(
      "人物一覧の誰かに当たるなら、その人の資料へ手で書き足してください。"
    );
  });

  test("検証前の解析結果をキャッシュして後の規則変更で再評価できるようにする", async () => {
    const rawResult = {
      characters: [
        { name: "灯", evidence: "灯が歩いた。" },
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
    expect(confirmation).toContain("Claude APIは実行すると利用量が加算されます");
    expect(confirmation).toContain("各社の現行料金");
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
    expect(confirmation).toContain("無料・手元で実行（API課金なし）");
    expect(confirmation).not.toContain("課金が発生します");
    expect(confirmation).not.toContain("Anthropic");
  });

  /*
    **ノートPCの実機で見つかった3件**（2026-09-23、0.75.17）。

    詳細メニューの「場所を抽出」が、作品一覧で誤って選ばれていた**作者の
    本物の作品**で確認画面まで進んだ。①確認画面に作品名が無く、件数の
    違いでやっと気づいた。②キャンセルしたのに、その作品のログに「抽出を
    開始」が残った。③完了の知らせを閉じるまで、同じ抽出を押しても
    「いま動いています」と断られた。
  */
  describe("実機で見つかった確認と記録と完了の知らせ", () => {
    const realTitle = "こちら冒険者ギルド生活保護課!!";
    const realWork: WorkEntry = { ...work, title: realTitle };

    function installWindow(
      answerConfirm: string | undefined,
      completion: () => Promise<string | undefined> = async () => undefined
    ): { showInformationMessage: ReturnType<typeof vi.fn<StubMessage>> } {
      const showInformationMessage = vi.fn<StubMessage>(
        async (_message: string, ...actions: unknown[]) =>
          // 確認はモーダル（第2引数が { modal: true }）。それ以外は完了の知らせ
          typeof actions[0] === "object" && actions[0] !== null
            ? answerConfirm
            : completion()
      );
      Object.assign(window, {
        showInformationMessage,
        showWarningMessage: vi.fn<StubMessage>(async () => completion()),
        showErrorMessage: vi.fn(async () => undefined),
        withProgress: vi.fn(async (_options, task) =>
          task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() }
          )
        ),
      });
      return { showInformationMessage };
    }

    function confirmationOf(
      showInformationMessage: ReturnType<typeof vi.fn<StubMessage>>
    ): string | undefined {
      const call = showInformationMessage.mock.calls.find(
        (args) => typeof args[1] === "object" && args[1] !== null
      );
      return call?.[0];
    }

    test("確認画面の文に作品名が入る", async () => {
      const { showInformationMessage } = installWindow(undefined);

      await extractCharacters(realWork, testRegistry());

      expect(confirmationOf(showInformationMessage)).toContain(realTitle);
    });

    test("確認でキャンセルしたら、作品のログに「開始」を書かない", async () => {
      loggedSteps.lines = [];
      installWindow(undefined);

      await expect(extractCharacters(realWork, testRegistry())).resolves.toBe(
        false
      );

      expect(
        loggedSteps.lines.filter((line) => line.includes("抽出を開始"))
      ).toEqual([]);
    });

    test("実行を押したときは「開始」を書く（書かない実装で満点にしない）", async () => {
      loggedSteps.lines = [];
      installWindow("実行");
      state.generate.mockResolvedValue(successfulResult("灯"));

      await extractCharacters(realWork, testRegistry());

      expect(
        loggedSteps.lines.some(
          (line) => line.includes("抽出を開始") && line.includes(realTitle)
        )
      ).toBe(true);
    });

    test("完了の知らせのボタンを押さないままでも、抽出は戻る（動いている札が外れる）", async () => {
      // ボタンが押されない知らせ＝いつまでも返事が来ない
      installWindow("実行", () => new Promise<string | undefined>(() => {}));
      state.generate.mockResolvedValue(successfulResult("灯"));

      const outcome = await Promise.race([
        extractCharacters(realWork, testRegistry()),
        new Promise<"待ったまま">((resolve) =>
          setTimeout(() => resolve("待ったまま"), 2000)
        ),
      ]);

      expect(outcome).toBe(true);
    });

    test("戻ったあとで押されたボタンも、ちゃんと効く", async () => {
      let press: (label: string | undefined) => void = () => undefined;
      const pressed = new Promise<string | undefined>((resolve) => {
        press = resolve;
      });
      installWindow("実行", () => pressed);
      state.generate.mockResolvedValue(successfulResult("灯"));
      const executeCommand = vi.fn(async () => undefined);
      const original = commands.executeCommand;
      commands.executeCommand = executeCommand;
      try {
        await extractCharacters(realWork, testRegistry());
        expect(executeCommand).not.toHaveBeenCalledWith(
          "novelai.openSettingsPanel",
          expect.anything()
        );

        press("設定資料を見る");
        await vi.waitFor(() =>
          expect(executeCommand).toHaveBeenCalledWith(
            "novelai.openSettingsPanel",
            { type: "work", work: realWork }
          )
        );
      } finally {
        commands.executeCommand = original;
      }
    });
  });

  describe("終わったことと件数の内訳を、記録にも残す", () => {
    /** 抽出をひと通り走らせる。返すのは記録に出た「設定資料の抽出」の行 */
    async function runAndReadLog(): Promise<string | undefined> {
      loggedSteps.lines = [];
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
      state.generate.mockResolvedValue({
        text: JSON.stringify({ characters: [] }),
        truncated: false,
        elapsedMs: 1,
      });

      await extractCharacters(work, {
        resolveModelInfo: vi.fn(async () => ({ contextWindow: 8192 })),
      } as unknown as AIRegistry);

      return loggedSteps.lines.find((line) =>
        line.startsWith("設定資料の抽出 → ")
      );
    }

    test("件数の内訳が1行で残る", async () => {
      const line = await runAndReadLog();

      expect(line).toBeDefined();
      expect(line).toContain("新規 0名");
      expect(line).toContain("更新 0名");
      expect(line).toContain("除外 0件");
      expect(line).toContain("失敗 0チャンク");
    });

    test("1件も増えなかった回は、その理由まで残す", async () => {
      // **「できました」だけの記録では、今回の困りごとが解けない。**
      // なぜ増えなかったのかが分からないと、作者は不具合を疑う
      const line = await runAndReadLog();

      expect(line).toContain("資料は増えていません");
      // 出ないことの確認。増えていないのに「できました」とは書かない
      expect(line).not.toContain("できました");
    });
  });

  /*
    **承認待ちがあるなら、完了の知らせの先頭ボタンが「提案を見る」になる**
    （`extractCharacters.ts`、作者の指摘、2026-09-01）。

    抽出のあとに作者が決めるのは「全部反映するか、1件ずつ選ぶか」で、それを
    引き受けるのは提案パネルである。以前は `proposalPanel` を渡し忘れており、
    このボタンが無いままダイアログを閉じるとパネルへ辿り着けなかった。

    ある場合・無い場合の両方を見る——片方だけでは「常に出る／出ない」
    実装でも満点になってしまう。
  */
  describe("承認待ちがあるときの完了の知らせ", () => {
    const disk = new Map<string, Uint8Array>();

    beforeEach(() => {
      // `PendingUpdateStore.stage` が実際に書き込めるよう、偽ディスクを敷く
      // （`pendingUpdateSource.test.ts` と同じ形）
      disk.clear();
      workspace.fs = {
        createDirectory: async () => undefined,
        readFile: async (uri: { fsPath: string }) => {
          const bytes = disk.get(uri.fsPath);
          if (!bytes) throw new FileSystemError("missing", "FileNotFound");
          return bytes;
        },
        writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
          disk.set(uri.fsPath, bytes);
        },
        rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
          const bytes = disk.get(from.fsPath);
          if (!bytes) throw new FileSystemError("missing", "FileNotFound");
          disk.set(to.fsPath, bytes);
          disk.delete(from.fsPath);
        },
        delete: async (uri: { fsPath: string }) => {
          disk.delete(uri.fsPath);
        },
      } as unknown as typeof workspace.fs;
    });

    function installWindow(): { showInformationMessage: ReturnType<typeof vi.fn> } {
      const showInformationMessage = vi.fn<StubMessage>(
        async (_message: string, ...actions: unknown[]) =>
          actions.includes("実行") ? "実行" : undefined
      );
      Object.assign(window, {
        showInformationMessage,
        showWarningMessage: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(async () => undefined),
        withProgress: vi.fn(async (_options, task) =>
          task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() }
          )
        ),
      });
      return { showInformationMessage };
    }

    test("既存人物への更新が承認待ちに回ったら、先頭が「提案を見る」になる", async () => {
      // 「灯」は既存の人物。抽出結果がその更新として扱われるようにする
      state.loadedCharacters = [emptyCharacter("char_001", "灯")];
      state.mergeResult = {
        characters: [
          { ...emptyCharacter("char_001", "灯"), summary: "新しい要約" },
        ],
        added: [],
        updated: ["灯"],
        changedIds: ["char_001"],
        conflicts: [],
        folded: [],
        heldChanges: [],
      };
      const { showInformationMessage } = installWindow();
      state.generate.mockResolvedValue(successfulResult("灯"));

      await extractCharacters(work, testRegistry());

      // 完了の知らせは最後に呼ばれたもの。その先頭ボタンを見る
      const completion = showInformationMessage.mock.calls.at(-1);
      expect(completion?.slice(1)[0]).toBe("提案を見る");
    });

    test("承認待ちが無ければ、「提案を見る」は出ない", async () => {
      // 既存人物が無いので、抽出結果はすべて新規として扱われる
      // （承認待ちへ回るのは「既存人物への更新」だけ）
      const { showInformationMessage } = installWindow();
      state.generate.mockResolvedValue(successfulResult("灯"));

      await extractCharacters(work, testRegistry());

      const completion = showInformationMessage.mock.calls.at(-1);
      expect(completion?.slice(1)).not.toContain("提案を見る");
    });

    /*
      実機確認リスト（0.83.7）の「設定資料の抽出をかけ直しても、退けた関係が戻らず、
      完了の知らせに「退けた関係を1件足しませんでした」と出るか」。
      マージそのものは `rejectedRelations.test.ts` が見ている。ここでは**本物の
      マージを通した抽出の流れ**で、知らせの文まで届くことを見る。
    */
    test("退けた関係はかけ直しても足さず、完了の知らせに件数と中身を出す", async () => {
      state.loadedCharacters = [
        {
          ...emptyCharacter("char_001", "灯"),
          relations: [{ name: "澪", relation: "妹" }],
          rejectedRelations: [
            {
              target: "澪",
              relation: "姉",
              rejectedAt: "2026-09-24T00:00:00.000Z",
              via: "external",
            },
          ],
          appearedChapters: [1],
        },
        { ...emptyCharacter("char_002", "澪"), appearedChapters: [1] },
      ];
      const shown: string[] = [];
      const { showInformationMessage } = installWindow();
      showInformationMessage.mockImplementation(
        async (message: string, ...actions: unknown[]) => {
          shown.push(message);
          return actions.includes("実行") ? "実行" : undefined;
        }
      );
      Object.assign(window, {
        showWarningMessage: vi.fn(async (message: string) => {
          shown.push(message);
          return undefined;
        }),
      });
      // AIは、作者が退けた「澪=姉」をまた読んでくる
      state.generate.mockResolvedValue({
        text: JSON.stringify({
          characters: [
            {
              name: "灯",
              evidence: "灯が歩いた。",
              relations: [{ name: "澪", relation: "姉" }],
            },
          ],
        }),
        truncated: false,
        elapsedMs: 1,
      });

      await extractCharacters(work, testRegistry());

      const summary = shown.find((message) => message.includes("新規")) ?? "";
      expect(summary).toContain("退けた関係を 1件足しませんでした（灯 の「澪=姉」）");
      // 取り消し方も同じ知らせで言う
      expect(summary).toContain("取り消すときは設定資料パネルの関係欄の下から");
      // 退けた関係は、承認待ちにも積まれない（台帳へ戻る道が無い）
      const staged = [...disk.values()].map((bytes) => new TextDecoder().decode(bytes));
      expect(staged.some((text) => text.includes("\"姉\"") && !text.includes("rejectedRelations"))).toBe(false);
    });

    /*
      **押したら、渡した提案パネルへ出す**（実機確認リスト F-51 の代わり）。

      上の2つは「ボタンが出るか」まで。押した先が**別のダイアログ**
      （パネルを渡さない道＝「内容を確認／すべて反映／選んで反映」の確認）へ
      落ちると、窓口が2つに分かれる。抽出の入口から受け取ったパネルを、
      そのまま反映の口へ渡しているかを見る。
    */
    test("「提案を見る」を押すと、抽出の入口で渡された提案パネルへ出す", async () => {
      state.loadedCharacters = [emptyCharacter("char_001", "灯")];
      state.mergeResult = {
        characters: [
          { ...emptyCharacter("char_001", "灯"), summary: "新しい要約" },
        ],
        added: [],
        updated: ["灯"],
        changedIds: ["char_001"],
        conflicts: [],
        folded: [],
        heldChanges: [],
      };
      const { showInformationMessage } = installWindow();
      // 完了の知らせでだけ「提案を見る」を押す
      showInformationMessage.mockImplementation(
        async (_message: string, ...actions: unknown[]) =>
          actions.includes("実行")
            ? "実行"
            : actions.includes("提案を見る")
              ? "提案を見る"
              : undefined
      );
      state.generate.mockResolvedValue(successfulResult("灯"));
      const panel = { name: "提案パネルの代役" };
      pendingApply.calls = [];
      pendingApply.intercept = true;
      try {
        await extractCharacters(work, testRegistry(), {
          proposalPanel: panel as never,
        });

        await vi.waitFor(() => expect(pendingApply.calls).toHaveLength(1));
        const [passedWork, passedPanel] = pendingApply.calls[0];
        expect(passedWork).toBe(work);
        // **パネルを渡している**＝確認のダイアログの道へ落ちない
        expect(passedPanel).toBe(panel);
      } finally {
        pendingApply.intercept = false;
      }
    });
  });

  /*
    **作者が別人と決めた呼び名が付いた場面を取り込まなかったら、完了報告で
    言う**（設計書6.5.8。実機確認リスト F-20 の代わり）。

    どの候補を弾くかは `characterMerge.test.ts`「別人と決めた呼び名が付いた
    候補」が見ている。ここは、その件数が**作者の目に届く文**になるか。
    黙って捨てると、作者には「なぜか資料が増えなかった」としか見えない。
  */
  describe("別人と決めた呼び名で弾いた場面の報告", () => {
    function installWindow(): { shown: string[] } {
      const shown: string[] = [];
      const record = async (message: string, ...actions: unknown[]) => {
        shown.push(message);
        return actions.includes("実行") ? "実行" : undefined;
      };
      Object.assign(window, {
        showInformationMessage: vi.fn(record),
        showWarningMessage: vi.fn(record),
        showErrorMessage: vi.fn(async () => undefined),
        withProgress: vi.fn(async (_options, task) =>
          task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() }
          )
        ),
      });
      return { shown };
    }

    function mergedWith(rejectedDistinct: unknown[]): unknown {
      return {
        characters: [],
        added: [],
        updated: [],
        changedIds: [],
        conflicts: [],
        folded: [],
        heldChanges: [],
        rejectedDistinct,
      };
    }

    test("弾いた件数と、誰に付いたどの呼び名かを完了報告に出す", async () => {
      state.mergeResult = mergedWith([
        { characterName: "アジャーノ", blockedName: "殿下", chapters: [12] },
      ]);
      const { shown } = installWindow();
      // 本文に居る名前で返させる（本文に根拠の無い候補は、突き合わせの前に落ちる）。
      // 突き合わせの結果は上の `mergedWith` で決めている
      state.generate.mockResolvedValue(successfulResult("灯"));

      await extractCharacters(work, testRegistry());

      const report = shown.join("\n");
      expect(report).toContain(
        "作者が別人と決めた呼び名が付いた場面を 1件、取り込みませんでした"
      );
      expect(report).toContain("アジャーノ に付いた「殿下」");
    });

    test("弾いたものが無ければ、その行は出さない", async () => {
      state.mergeResult = mergedWith([]);
      const { shown } = installWindow();
      state.generate.mockResolvedValue(successfulResult("灯"));

      await extractCharacters(work, testRegistry());

      expect(shown.join("\n")).not.toContain("別人と決めた呼び名");
    });
  });
});
