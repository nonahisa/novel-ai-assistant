import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileSystemError,
  Uri,
  commands,
  window,
  workspace,
} from "./support/vscodeStub";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";
import type { WorkChatTurn } from "../../src/prompts/workChat";

/**
 * 相談から設定資料への書き込み（設計書6.72、P-32）。
 *
 * **相談で作者が決めたことを、承認待ちへ積むだけ**の機能である。
 * 資料を直接書き換える経路は無い——積んだものは、これまでどおり
 * 「更新分を反映」で作者が承認したときにだけ台帳へ入る。
 *
 * ここで見張るのは次の3つ。
 *   1. AIの答えの根拠（引用）が、本当に会話の中にあるか
 *   2. 突合の守り（作者確定・複数一致）が、プロット反映と同じであること
 *   3. 同じ会話を二度積まないこと
 */

const state = vi.hoisted(() => ({
  characters: [] as unknown[],
  loadErrors: [] as unknown[],
  stage: vi.fn(async () => undefined),
  logged: [] as unknown[],
}));

vi.mock("../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: state.loadErrors };
    }
  },
}));

vi.mock("../../src/core/pendingUpdates", () => ({
  PendingUpdateStore: class {
    stage = state.stage;
  },
}));

vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: (_work: unknown, entry: unknown) => {
    state.logged.push(entry);
  },
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

vi.mock("../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
}));

/** 中止ボタン付きの進捗。ここでは中止しないので、そのまま実行する */
vi.mock("../../src/views/progress", () => ({
  withCancellableProgress: async (
    _title: string,
    task: (
      progress: { report: (value: unknown) => void },
      token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (listener: () => void) => void;
      }
    ) => Promise<unknown>
  ) =>
    task(
      { report: () => undefined },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      }
    ),
}));

const {
  chatHistoryDigest,
  formatChatConversation,
  trimChatHistory,
  verifyChatDecisions,
} = await import("../../src/core/chatSettingsSync");
const { applyChatToSettings } = await import(
  "../../src/features/chatSettingsSync"
);

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const statePath = Uri.file(
  nodePath.join(work.folderPath, ".aiwriter", "chat-sync.json")
).fsPath;

function turn(role: "author" | "assistant", text: string): WorkChatTurn {
  return { role, text };
}

/** 「灯の年齢は17歳にする」と作者が決めた、ごく短い相談 */
const CONVERSATION: WorkChatTurn[] = [
  turn("author", "灯の年齢を決めたいのですが、どうしましょう"),
  turn("assistant", "16歳か17歳が収まりがよさそうです。どちらにしますか。"),
  turn("author", "灯の年齢は17歳にします。故郷は港町ということで行きます。"),
  turn("assistant", "承知しました。17歳・港町の出身で進めます。"),
];

function character(id: string, name: string, summary: string): Character {
  return { ...emptyCharacter(id, name), summary };
}

describe("会話のダイジェスト", () => {
  test("同じ会話なら同じ値になる", () => {
    expect(chatHistoryDigest(CONVERSATION)).toBe(
      chatHistoryDigest([...CONVERSATION])
    );
  });

  test("発言が1つ増えれば変わる", () => {
    expect(chatHistoryDigest(CONVERSATION)).not.toBe(
      chatHistoryDigest([...CONVERSATION, turn("author", "ありがとう")])
    );
  });

  test("並べ替えると変わる（相談は流れなので、順番が意味を持つ）", () => {
    const swapped = [
      CONVERSATION[1],
      CONVERSATION[0],
      CONVERSATION[2],
      CONVERSATION[3],
    ];
    expect(chatHistoryDigest(CONVERSATION)).not.toBe(
      chatHistoryDigest(swapped)
    );
  });
});

describe("会話をAIへ渡す形にする", () => {
  test("どちらの発言かが分かる形にする", () => {
    const text = formatChatConversation(CONVERSATION);
    expect(text).toContain("作者: 灯の年齢を決めたいのですが");
    expect(text).toContain("AI: 16歳か17歳が");
  });

  test("長すぎるときは古い往復から削り、削った数を返す", () => {
    const long: WorkChatTurn[] = [
      turn("author", "あ".repeat(500)),
      turn("assistant", "い".repeat(500)),
      turn("author", "灯の年齢は17歳にします"),
      turn("assistant", "承知しました"),
    ];
    const trimmed = trimChatHistory(long, 200);

    expect(trimmed.dropped).toBeGreaterThan(0);
    // 残すのは新しいほう。直近の決定が落ちては意味がない
    expect(trimmed.turns[trimmed.turns.length - 1].text).toBe("承知しました");
    expect(formatChatConversation(trimmed.turns)).not.toContain("あああ");
  });
});

describe("P-32の答えを検証する", () => {
  const conversation = formatChatConversation(CONVERSATION);

  test("会話にある引用なら通す", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "灯",
          decided: "年齢は17歳。故郷は港町。",
          evidence: "灯の年齢は17歳にします",
        },
      ],
      conversation
    );

    expect(result.rejected).toEqual([]);
    expect(result.entries).toEqual([
      { name: "灯", summary: "年齢は17歳。故郷は港町。" },
    ]);
  });

  test("会話に無い引用は、根拠が確かめられないので捨てる", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "澪",
          decided: "剣術の達人ということにする",
          evidence: "澪は剣術の達人にしましょう",
        },
      ],
      conversation
    );

    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual([{ name: "澪", reason: "ungrounded" }]);
  });

  test("「該当なし」のような言い換えは、中身として扱わない", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "灯",
          decided: "該当なし",
          evidence: "灯の年齢は17歳にします",
        },
      ],
      conversation
    );

    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯", reason: "placeholder" }]);
  });
});

/** P-32 の応答を作る */
function answer(
  decisions: Array<{ name: string; decided: string; evidence: string }>
): string {
  return JSON.stringify({ decisions });
}

interface TestAi {
  deps: { ai: { resolve: () => unknown } };
  generate: ReturnType<typeof vi.fn>;
}

function testAi(text: string, isPaid = false): TestAi {
  const generate = vi.fn(async () => ({ text }));
  const provider = {
    id: "ollama",
    displayName: "Ollama",
    isPaid,
    generate,
  };
  return {
    deps: {
      ai: { resolve: () => ({ provider, model: "gemma4:e4b" }) },
    },
    generate,
  };
}

/** 型の都合を1か所に閉じ込める（テスト用のAIは generate しか持たない） */
function run(ai: TestAi, turns: WorkChatTurn[] = CONVERSATION) {
  return applyChatToSettings(
    work,
    turns,
    ai.deps as unknown as Parameters<typeof applyChatToSettings>[2]
  );
}

describe("相談を資料へ反映する", () => {
  const disk = new Map<string, Uint8Array>();
  let announced: string[] = [];
  let executeCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disk.clear();
    announced = [];
    state.logged = [];
    state.stage.mockClear();
    state.loadErrors = [];
    state.characters = [character("char_001", "灯", "主人公")];

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

    executeCommand = vi.fn(async () => undefined);
    Object.assign(commands, { executeCommand });
    window.showInformationMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
    window.showWarningMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
  });

  test("決まったことを、承認待ちへ「相談から」の印つきで積む", async () => {
    const ai = testAi(
      answer([
        {
          name: "灯",
          decided: "年齢は17歳。故郷は港町。",
          evidence: "灯の年齢は17歳にします",
        },
      ])
    );

    const result = await run(ai);

    expect(result.staged).toBe(1);
    expect(state.stage).toHaveBeenCalledTimes(1);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string },
    ];
    expect(staged[0].id).toBe("char_001");
    expect(staged[0].summary).toBe("年齢は17歳。故郷は港町。");
    expect(options).toEqual({ source: "chat" });
    expect(announced.join("")).toContain("相談から人物1件");
    // 覚え書きは `.aiwriter` へ（作者が読む「設定」を散らかさない）
    expect(disk.has(statePath)).toBe(true);
    // AIは1回だけ呼ぶ（会話は12往復までなのでチャンクに割らない）
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  test("同じ会話をもう一度押しても、積み直さない", async () => {
    await run(
      testAi(
        answer([
          {
            name: "灯",
            decided: "年齢は17歳。",
            evidence: "灯の年齢は17歳にします",
          },
        ])
      )
    );
    state.stage.mockClear();
    announced = [];

    const again = testAi(answer([]));
    const result = await run(again);

    expect(result.unchanged).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
    // **AIを呼ぶ前に止める。** 同じ会話にもう一度料金を払わせない
    expect(again.generate).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("反映済み");
  });

  test("資料にまだ無い名前は、新規の人物案として積む", async () => {
    const ai = testAi(
      answer([
        {
          name: "澪",
          decided: "灯の親友。港町の出身。",
          evidence: "故郷は港町ということで行きます",
        },
      ])
    );

    const result = await run(ai);

    expect(result.staged).toBe(0);
    expect(result.creations).toEqual(["澪"]);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string },
    ];
    expect(staged[0].name).toBe("澪");
    expect(staged[0].status).toBe("未登場");
    expect(options).toEqual({ source: "chat", kind: "creation" });
  });

  test("作者が確定させた人物は変えず、その旨を添える", async () => {
    state.characters = [
      { ...character("char_001", "灯", "主人公"), autoGenerated: false },
    ];
    const ai = testAi(
      answer([
        {
          name: "灯",
          decided: "年齢は17歳。",
          evidence: "灯の年齢は17歳にします",
        },
      ])
    );

    const result = await run(ai);

    expect(result.staged).toBe(0);
    expect(result.skipped).toEqual([{ name: "灯", reason: "authorConfirmed" }]);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("作者が確定させた人物");
  });

  test("同じ呼び名の人物が複数居るときは、当てずに見送る", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      { ...character("char_002", "澪", "親友"), aliases: ["灯"] },
    ];
    const ai = testAi(
      answer([
        {
          name: "灯",
          decided: "年齢は17歳。",
          evidence: "灯の年齢は17歳にします",
        },
      ])
    );

    const result = await run(ai);

    expect(result.skipped).toEqual([{ name: "灯", reason: "ambiguous" }]);
    expect(state.stage).not.toHaveBeenCalled();
  });

  test("根拠が会話に無いものは積まず、見送った件数を伝える", async () => {
    const ai = testAi(
      answer([
        {
          name: "灯",
          decided: "実は王家の血を引いている",
          evidence: "灯は王家の血を引いていることにしましょう",
        },
      ])
    );

    const result = await run(ai);

    expect(result.staged).toBe(0);
    expect(result.rejected).toEqual([{ name: "灯", reason: "ungrounded" }]);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("根拠が確認できず");
  });

  test("決まったことが1つも無ければ、そう伝える", async () => {
    const ai = testAi(answer([]));

    const result = await run(ai);

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("見つかりませんでした");
  });

  test("積んだら「承認待ちを確認」から反映画面へ進める", async () => {
    window.showInformationMessage = (async (message: string) => {
      announced.push(message);
      return "承認待ちを確認";
    }) as typeof window.showInformationMessage;

    await run(
      testAi(
        answer([
          {
            name: "灯",
            decided: "年齢は17歳。",
            evidence: "灯の年齢は17歳にします",
          },
        ])
      )
    );

    expect(executeCommand).toHaveBeenCalledWith(
      "novelai.applyPendingUpdates",
      { type: "work", work }
    );
  });

  test("人物設定が読めないときは、積まずに止める", async () => {
    state.loadErrors = [{ file: "char_001_灯.json", message: "壊れています" }];
    const ai = testAi(answer([]));

    const result = await run(ai);

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    // 覚え書きも残さない（直したあとにやり直せるようにする）
    expect(disk.has(statePath)).toBe(false);
    expect(ai.generate).not.toHaveBeenCalled();
  });

  test("何をしたかを相談ログへ1件残す", async () => {
    await run(
      testAi(
        answer([
          {
            name: "灯",
            decided: "年齢は17歳。",
            evidence: "灯の年齢は17歳にします",
          },
        ])
      )
    );

    expect(state.logged).toHaveLength(1);
    const entry = state.logged[0] as { panel: string; reply: string };
    expect(entry.panel).toBe("相談パネル");
    expect(entry.reply).toContain("灯");
  });
});
