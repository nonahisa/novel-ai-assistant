import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, window, workspace } from "../support/vscodeStub";
import * as paths from "../../../src/core/paths";
import type { WorkEntry } from "../../../src/models/types";
import type { ReaderProfile } from "../../../src/models/readerProfile";

/**
 * 「助言を作る」の流れ（設計書6.108.4 の第3段、P-46）。
 *
 * 動いたと言える条件：
 * 1. 割り当てたAI（生成系）へ1回だけ頼み、検算を通った答えを
 *    `設定/ターゲットシート/助言.json` に残す
 * 2. **材料が前回と同じなら、AIを呼ばずに前回のままにできる**
 * 3. 狙いが無い・点数が無いときは、AIを呼ばずに止める
 * 4. 前の記録が壊れていたら、上から書かずに止める（実装ルール2）
 * 5. 料金の確認を通す（既存と同じ口）
 */

const state = vi.hoisted(() => ({
  generate: vi.fn(),
  paid: vi.fn(async () => true),
  reachable: vi.fn(async () => true),
}));

vi.mock("../../../src/ai/registry", () => ({
  AIRegistry: class {},
  ensureConfigured: vi.fn(async (_registry: unknown, feature: string) => {
    // 生成系の割当で呼ぶこと（P-38・P-41 と同じ鍵。設計書6.28.9）
    if (feature !== "generate") throw new Error(`割当キーが違う：${feature}`);
    return {
      provider: { id: "ollama", displayName: "Ollama", generate: state.generate },
      model: "gemma4:e4b",
    };
  }),
}));
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: state.paid,
  confirmProviderReachable: state.reachable,
}));
vi.mock("../../../src/features/reportAIError", () => ({ reportAIError: vi.fn() }));
vi.mock("../../../src/views/progress", () => ({
  withCancellableProgress: async <T>(
    _title: string,
    task: (progress: unknown, token: unknown) => Promise<T>
  ) =>
    task(
      { report: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }
    ),
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  responseExcerptForLog: (text: string) => text,
  useLogFile: vi.fn(),
}));

const { makeTargetSheetAdvice } = await import("../../../src/features/targetSheetAdvice");

const FOLDER = paths.normalize("c:/小説/鉛の海");
const SETTINGS = paths.join(FOLDER, "設定");
const RECORD = paths.join(SETTINGS, "ターゲットシート", "助言.json");

const WORK: WorkEntry = {
  id: "w1",
  title: "鉛の海",
  folderPath: FOLDER,
  registeredAt: "2026-09-01T00:00:00.000Z",
};

const PROFILE: ReaderProfile = {
  schemaVersion: "1",
  actual: {
    scores: { familiarity: 2, posture: 5, craving: 1 },
    evidence: [],
    basis: "第1〜3話",
    model: "gemma4:e4b",
    updatedAt: "2026-10-04T00:00:00.000Z",
  },
};
const BLOCK = "狙い：考察層\n理由：伏線を拾って読み返してくれる人に";

const ANSWER = JSON.stringify({
  overall: "読み慣れの軸が狙いから離れています。",
  keep: ["読む姿勢の高さが、腰を据えて読む考察層に合っています。"],
  advice: [
    {
      axis: "familiarity",
      direction: "up",
      text: "伏線を拾う人に届けたいなら、お約束の説明を減らして読み尽くした人へ寄せられます。",
    },
  ],
});

const files = new Map<string, Uint8Array>();
const original = {
  fs: workspace.fs,
  showQuickPick: window.showQuickPick,
  showWarningMessage: window.showWarningMessage,
};
const warnings: string[] = [];
let picks: Array<(items: Array<{ label: string }>) => unknown>;

beforeEach(() => {
  files.clear();
  warnings.length = 0;
  picks = [];
  state.generate.mockReset();
  state.generate.mockResolvedValue({ text: ANSWER });
  state.paid.mockClear();
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new FileSystemError(uri.fsPath, "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(uri.fsPath, bytes);
    },
    stat: async (uri: { fsPath: string }) => {
      if (files.has(uri.fsPath)) return { type: 1 };
      throw new FileSystemError(uri.fsPath, "FileNotFound");
    },
    createDirectory: async () => undefined,
    rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
      const bytes = files.get(from.fsPath);
      if (!bytes) throw new FileSystemError(from.fsPath, "FileNotFound");
      files.delete(from.fsPath);
      files.set(to.fsPath, bytes);
    },
    delete: async (uri: { fsPath: string }) => {
      files.delete(uri.fsPath);
    },
  } as unknown as typeof workspace.fs;
  window.showQuickPick = (async (items: Array<{ label: string }>) => {
    const next = picks.shift();
    if (!next) throw new Error("想定より多く選択画面が出た");
    return next(items);
  }) as unknown as typeof window.showQuickPick;
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as unknown as typeof window.showWarningMessage;
});

afterEach(() => {
  workspace.fs = original.fs;
  window.showQuickPick = original.showQuickPick;
  window.showWarningMessage = original.showWarningMessage;
});

function recordText(): string | undefined {
  const bytes = files.get(RECORD);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

const input = { settings: SETTINGS, authorBlock: BLOCK, profile: PROFILE };

describe("助言を作る", () => {
  test("割り当てたAIへ1回頼み、検算を通った答えを記録に残す", async () => {
    const outcome = await makeTargetSheetAdvice(WORK, {} as never, input);

    expect(outcome).toBe("done");
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.paid).toHaveBeenCalledTimes(1);
    // 送る材料に作者の理由が入っている
    const request = state.generate.mock.calls[0][0] as { userPrompt: string };
    expect(request.userPrompt).toContain("伏線を拾って読み返してくれる人に");
    const record = JSON.parse(recordText() ?? "{}");
    expect(record.aims).toEqual(["lore_deep"]);
    expect(record.reasonGiven).toBe(true);
    expect(record.advice).toHaveLength(1);
    expect(record.model).toBe("gemma4:e4b");
  });

  test("材料が前回と同じなら、AIを呼ばずに前回のままにできる", async () => {
    await makeTargetSheetAdvice(WORK, {} as never, input);
    const first = recordText();
    picks = [(items) => items.find((item) => item.label === "前回の助言のまま開く")];

    const outcome = await makeTargetSheetAdvice(WORK, {} as never, input);

    expect(outcome).toBe("done");
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(recordText()).toBe(first);
  });

  test("理由を変えたら、材料が変わったので確かめずに作り直す", async () => {
    await makeTargetSheetAdvice(WORK, {} as never, input);

    await makeTargetSheetAdvice(WORK, {} as never, {
      ...input,
      authorBlock: "狙い：考察層\n理由：",
    });

    expect(state.generate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(recordText() ?? "{}").reasonGiven).toBe(false);
  });

  test("狙いが無ければ、AIを呼ばずに止める", async () => {
    const outcome = await makeTargetSheetAdvice(WORK, {} as never, {
      ...input,
      authorBlock: "狙い：\n理由：",
    });

    expect(outcome).toBe("failed");
    expect(state.generate).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("1 狙いを選ぶ");
  });

  test("点数が無ければ、AIを呼ばずに止める", async () => {
    const outcome = await makeTargetSheetAdvice(WORK, {} as never, {
      ...input,
      profile: { schemaVersion: "1" },
    });

    expect(outcome).toBe("failed");
    expect(state.generate).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("3 本文の実像を読む");
  });

  test("前の記録が壊れていたら、上から書かずに止める", async () => {
    const broken = new TextEncoder().encode("{ 書きかけ");
    files.set(RECORD, broken);

    const outcome = await makeTargetSheetAdvice(WORK, {} as never, input);

    expect(outcome).toBe("failed");
    expect(state.generate).not.toHaveBeenCalled();
    expect(files.get(RECORD)).toBe(broken);
  });

  test("載せられる中身が無い答えは、記録を作らない", async () => {
    state.generate.mockResolvedValue({
      text: JSON.stringify({ overall: "特になし", keep: [], advice: [] }),
    });

    const outcome = await makeTargetSheetAdvice(WORK, {} as never, input);

    expect(outcome).toBe("failed");
    expect(recordText()).toBeUndefined();
  });
});
