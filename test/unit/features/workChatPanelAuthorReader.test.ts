import { describe, expect, test, vi } from "vitest";
import type * as vscode from "vscode";
import {
  authorReaderProfileFromAnswers,
  type AuthorReaderProfile,
} from "../../../src/core/authorReaderType";
import { AuthorReaderTypeStore } from "../../../src/core/authorReaderTypeStore";
import type { WorkEntry } from "../../../src/models/types";

/**
 * **相談から、作者自身の読者タイプを推し量る**（設計書6.101。作者の裁定、
 * 2026-10-25「推定を作る」）。
 *
 * 規則そのもの（答えが勝つ・±0.5・表に無い値を捨てる）は
 * `core/authorReaderType.test.ts` が見ている。ここは本物のパネルで、
 *
 * 1. **頼む文は、9問に答えていない作者にだけ送る**（答えた作者の送る本文を増やさない）
 * 2. **答えの欄が届いたら、推定として保存庫へしまう**——答えた作者の値は動かさない
 * 3. 初めて推し量ったときも、相談パネルへ一言出す（黙って作らない）
 *
 * を確かめる。
 */

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

/** `vscode.Memento` の代役 */
function memento(): vscode.Memento {
  const box = new Map<string, unknown>();
  return {
    keys: () => [...box.keys()],
    get: <T>(key: string, fallback?: T) =>
      (box.has(key) ? box.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) box.delete(key);
      else box.set(key, value);
    },
  } as vscode.Memento;
}

const HEADING = "【authorReaderSignals";
const LIGHT = [0, 0, 0, 0, 0, 0, 0, 0, 0];

interface PanelPeek {
  buildSystemPrompt(
    work: WorkEntry | undefined,
    featureIndex: boolean,
    question: string
  ): Promise<{ systemPrompt: string }>;
  updateAuthorReaderType(signals: unknown): Promise<void>;
}

function openPanel(store: AuthorReaderTypeStore) {
  const posted: Array<{ type: string; message?: string }> = [];
  const panel = new WorkChatPanel(
    { list: () => [] } as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    {
      onDidChangeSelection: () => ({ dispose: () => undefined }),
      resolve: () => undefined,
    } as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    { run: async () => undefined } as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[2],
    undefined,
    undefined,
    store
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { type: string; message?: string }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as never);
  return { panel: panel as unknown as PanelPeek, posted };
}

describe("頼む文を送る相手", () => {
  test("9問に答えていない作者には、頼む文を足す", async () => {
    const { panel } = openPanel(new AuthorReaderTypeStore(memento()));
    const { systemPrompt } = await panel.buildSystemPrompt(
      undefined,
      false,
      "最近は短い話ばかり読んでいます"
    );
    expect(systemPrompt).toContain(HEADING);
  });

  test("9問に答えた作者には足さない（送る本文を増やさない）", async () => {
    const store = new AuthorReaderTypeStore(memento());
    await store.set(authorReaderProfileFromAnswers(LIGHT, new Date()));
    const { panel } = openPanel(store);
    const { systemPrompt } = await panel.buildSystemPrompt(
      undefined,
      false,
      "最近は短い話ばかり読んでいます"
    );
    expect(systemPrompt).not.toContain(HEADING);
  });
});

describe("答えの欄が届いたとき", () => {
  test("推定としてしまう（答えは持たない）", async () => {
    const store = new AuthorReaderTypeStore(memento());
    const { panel } = openPanel(store);

    await panel.updateAuthorReaderType({ craving: 1 });

    const saved = store.get();
    expect(saved?.source).toBe("estimated");
    expect(saved?.answers).toBeUndefined();
    expect(saved?.scores.craving).toBe(3.5);
  });

  test("9問に答えた作者の値は動かさない", async () => {
    const store = new AuthorReaderTypeStore(memento());
    const answered = authorReaderProfileFromAnswers(LIGHT, new Date());
    await store.set(answered);
    const { panel, posted } = openPanel(store);

    await panel.updateAuthorReaderType({ familiarity: 1, posture: 1, craving: 1 });

    expect(store.get()).toEqual(answered);
    expect(posted.some((message) => message.type === "note")).toBe(false);
  });

  test("層が見えたら「推し量りました」と相談パネルへ出す", async () => {
    const store = new AuthorReaderTypeStore(memento());
    const { panel, posted } = openPanel(store);

    // 3 → 5 まで上げると「高」に入り、雑食層から動く
    for (let i = 0; i < 4; i++) {
      await panel.updateAuthorReaderType({ craving: 1 });
    }

    const notes = posted
      .filter((message) => message.type === "note")
      .map((message) => message.message ?? "");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("推し量りました");
    expect(notes[0]).toContain("あなたが決めたものではありません");
    const saved = store.get() as AuthorReaderProfile;
    expect(saved.scores.craving).toBe(5);
  });
});
