import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";
import { emptyCharacter } from "../../../src/models/character";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkChatTurn } from "../../../src/prompts/workChat";
import { AIError, type GenerateParams } from "../../../src/ai/types";
import { cancelRunningTask } from "../../../src/views/progress";

/**
 * 「相談を資料へ反映」を、AIを待っている最中に中止ボタンで止める
 * （実機確認リスト F-77「実行中に中止ボタンで止められるか」。
 * 2026-10-11 作者の指示「機械でできる実機確認」）。
 *
 * `chatSettingsSync.test.ts` は進捗を作り物にして中止しない。ここでは
 * **進捗と中止ボタンは本物**（`views/progress.ts` の `withCancellableProgress` と、
 * ステータスバーの［中止］が呼ぶ `cancelRunningTask`）を通し、
 * 作り物にするのは AI と保存先だけにする。
 *
 * 見張ること：
 * 1. 中止の合図が AI への送信（`signal`）まで届く
 * 2. 止めたら何も積まない（承認待ちへ入れない）
 * 3. 覚え書きを残さない——残すと、その会話は「反映済み」になり二度と送れない
 * 4. 作者が自分で止めたことを、失敗の警告として出し直さない
 */

const state = vi.hoisted(() => ({
  stage: vi.fn(async () => undefined),
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return {
        characters: [{ ...emptyCharacter("char_001", "灯"), summary: "主人公" }],
        errors: [],
      };
    }
    async saveOrUpdate() {
      return undefined;
    }
  },
}));

vi.mock("../../../src/core/pendingUpdates", () => ({
  PendingUpdateStore: class {
    stage = state.stage;
    async loadAll() {
      return { updates: [], errors: [] };
    }
  },
}));

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { applyChatToSettings } = await import(
  "../../../src/features/chatSettingsSync"
);

const work: WorkEntry = {
  id: "work_cancel",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "cancel"),
  registeredAt: "2026-10-11T00:00:00.000Z",
};

const statePath = Uri.file(
  nodePath.join(work.folderPath, ".aiwriter", "chat-sync.json")
).fsPath;

const CONVERSATION: WorkChatTurn[] = [
  { role: "author", text: "灯の年齢は17歳にします。" },
  { role: "assistant", text: "承知しました。17歳で進めます。" },
];

describe("相談を資料へ反映：実行中の中止", () => {
  const disk = new Map<string, Uint8Array>();
  let warned: string[] = [];

  beforeEach(() => {
    disk.clear();
    warned = [];
    state.stage.mockClear();
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
    window.showWarningMessage = (async (message: string) => {
      warned.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
    window.showInformationMessage = (async () => undefined) as typeof window.showInformationMessage;
  });

  test("AIの答えを待っている間に［中止］を押すと、送信が止まり、何も積まず、覚え書きも警告も残さない", async () => {
    let seenSignal: AbortSignal | undefined;
    // 本物のAIと同じく、合図が来たら「中止」で返す。来なければ答えない（＝止めないと終わらない）
    const generate = vi.fn(
      (params: GenerateParams) =>
        new Promise((_resolve, reject) => {
          seenSignal = params.signal;
          params.signal?.addEventListener("abort", () =>
            reject(new AIError("中止しました。", "aborted"))
          );
          // 待っている最中に、作者がステータスバーの［中止］を押す
          void cancelRunningTask();
        })
    );
    const provider = { id: "ollama", displayName: "Ollama", isPaid: false, generate };

    const result = await applyChatToSettings(
      work,
      CONVERSATION,
      { ai: { resolve: () => ({ provider, model: "gemma4:e4b" }) } } as unknown as Parameters<
        typeof applyChatToSettings
      >[2]
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
    expect(result.failed).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
    // 覚え書きが無いので、次に押せば同じ会話をもう一度送れる
    expect(disk.has(statePath)).toBe(false);
    // 自分で止めたことを「反映できませんでした」と言い直さない
    expect(warned).toEqual([]);
  });
});
