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

/**
 * 送る直前に割り込む口。
 *
 * 費用の確認は作者がダイアログを読むぶんだけ待つので、**その間に会話が
 * 伸びる**ことが実際にありうる（A-4の再現に使う）。
 */
const hooks = vi.hoisted(() => ({ beforeSend: () => undefined as void }));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => {
    hooks.beforeSend();
    return true;
  },
}));

/** 失敗の記録は覗ける形にする（読めなかった応答が残っているかを見る） */
const failures = vi.hoisted(
  () => [] as Array<{ context: string; detail: Record<string, unknown> }>
);
vi.mock("../../src/core/logger", () => ({
  logFailure: (context: string, detail: Record<string, unknown>) => {
    failures.push({ context, detail });
  },
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
const { parseChatSettingsSync } = await import(
  "../../src/prompts/chatSettingsSync"
);
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
  test("会話にある引用なら通す", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "灯",
          decided: "年齢は17歳。故郷は港町。",
          evidence: "灯の年齢は17歳にします",
        },
      ],
      CONVERSATION
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
      CONVERSATION
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
      CONVERSATION
    );

    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯", reason: "placeholder" }]);
  });

  /**
   * **「作者が決めた」の根拠は、作者の発言でなければならない**
   * （0.32.6のレビュー）。
   *
   * 照合の母材が会話全体だったので、AIが自分の提案文を引用すれば逐語一致で
   * 通った。それは「AIがそう言った」ことの証拠でしかなく、作者が受け入れた
   * かどうかは何も言っていない。**AIの案が、作者の決定として資料に入る。**
   */
  test("AIの発言にしか無い引用は、作者が決めた証拠にならない", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "灯",
          decided: "年齢は16歳",
          // 会話には確かにある。ただしAI側の提案文である
          evidence: "16歳か17歳が収まりがよさそうです",
        },
      ],
      CONVERSATION
    );

    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯", reason: "ungrounded" }]);
  });

  test("作者の発言を含む引用なら、AIの発言が混ざっていても通す", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "灯",
          decided: "年齢は17歳。",
          evidence: "16歳か17歳が収まりがよさそうです。灯の年齢は17歳にします",
        },
      ],
      CONVERSATION
    );

    expect(result.rejected).toEqual([]);
    expect(result.entries).toEqual([{ name: "灯", summary: "年齢は17歳。" }]);
  });

  test("作者が一度も喋っていない会話からは、何も拾わない", () => {
    const result = verifyChatDecisions(
      [
        {
          name: "灯",
          decided: "年齢は16歳",
          evidence: "16歳が収まりがよさそうです",
        },
      ],
      [turn("assistant", "16歳が収まりがよさそうです。")]
    );

    expect(result.entries).toEqual([]);
  });
});

/**
 * AIの答えが読めなかった回（0.32.6のレビュー）。
 *
 * 壊れたJSONは黙って空配列になっていたので、「読めなかった」と
 * 「読めたが決定は0件だった」の区別が付かなかった。**前者でダイジェストを
 * 書くと、以後その会話は「反映済み」になり、二度と試せなくなる。**
 */
describe("応答が読めたかどうかを返す", () => {
  test("決定が0件でも、読めていれば読めたと言う", () => {
    expect(parseChatSettingsSync('{"decisions": []}')).toEqual({
      decisions: [],
      malformed: false,
    });
  });

  test("JSONが見つからなければ、読めなかったと言う", () => {
    expect(parseChatSettingsSync("すみません、判断できませんでした。")).toEqual(
      { decisions: [], malformed: true }
    );
  });

  test("途中で切れたJSONも、読めなかったと言う", () => {
    const cut = '{"decisions": [{"name": "灯", "decided": "年齢は17歳"';
    expect(parseChatSettingsSync(cut).malformed).toBe(true);
  });

  test("decisions が配列でなければ、読めなかったと言う", () => {
    expect(parseChatSettingsSync('{"decisions": "なし"}').malformed).toBe(true);
  });

  test("読めた分は、これまでどおり取り出す", () => {
    const text = JSON.stringify({
      decisions: [
        { name: "灯", decided: "年齢は17歳", evidence: "17歳にします" },
      ],
    });
    expect(parseChatSettingsSync(text)).toEqual({
      malformed: false,
      decisions: [
        { name: "灯", decided: "年齢は17歳", evidence: "17歳にします" },
      ],
    });
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
    failures.length = 0;
    hooks.beforeSend = () => undefined;
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

  /**
   * 読めなかった回（0.32.6のレビュー）。
   *
   * **ダイジェストを書かない。** 書くと以後その会話は「反映済み」になり、
   * 作者はもう一度試すことができない（同じ会話は二度と送れない）。
   */
  test("答えが読めなかったら、覚え書きを残さずに、もう一度試せる", async () => {
    const broken = testAi("すみません、判断できませんでした。");

    const result = await run(broken);

    expect(result.failed).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
    // 覚え書きが無いので、次に押せば同じ会話をもう一度送れる
    expect(disk.has(statePath)).toBe(false);
    expect(announced.join("")).toContain("読み取れませんでした");

    const retry = testAi(
      answer([
        {
          name: "灯",
          decided: "年齢は17歳。",
          evidence: "灯の年齢は17歳にします",
        },
      ])
    );
    const second = await run(retry);

    expect(retry.generate).toHaveBeenCalledTimes(1);
    expect(second.staged).toBe(1);
  });

  test("読めなかった応答の中身を、記録に残す", async () => {
    // **捨てると、なぜ読めなかったのかを誰も追えない**（実装ルール5）
    await run(testAi("```\nおかしな答え\n```"));

    const logged = failures.find((entry) => entry.context.includes("相談"));
    expect(logged, "読めなかった応答が記録に残っていない").toBeTruthy();
    expect(String(logged!.detail["応答"])).toContain("おかしな答え");
  });

  test("読めて0件だったときは、これまでどおり覚え書きを残す", async () => {
    const result = await run(testAi(answer([])));

    expect(result.failed).toBe(false);
    expect(disk.has(statePath)).toBe(true);
    expect(announced.join("")).toContain("見つかりませんでした");
  });

  /**
   * 反映の途中で会話が伸びる（0.32.6のレビュー）。
   *
   * 費用の確認は作者がダイアログを読むぶんだけ待つ。その間に相談を続けると、
   * **覚え書き（ダイジェスト）は押した時点の会話、送る中身は伸びたあとの
   * 会話**になり、次に押したときに「反映済み」と言われて新しい発言が
   * 永久に反映されなくなる。押した時点の写しだけで進める。
   */
  test("押した時点の会話だけを送る（途中で伸びても混ぜない）", async () => {
    const turns = [...CONVERSATION];
    hooks.beforeSend = () => {
      turns.push(turn("author", "澪は剣術の達人ということにします"));
    };
    const ai = testAi(answer([]));

    await run(ai, turns);

    const sent = ai.generate.mock.calls[0][0] as { userPrompt: string };
    expect(sent.userPrompt).toContain("灯の年齢は17歳にします");
    expect(sent.userPrompt).not.toContain("澪は剣術の達人ということにします");
  });

  test("伸びたあとの会話は、次に押せばちゃんと送れる", async () => {
    const turns = [...CONVERSATION];
    hooks.beforeSend = () => {
      turns.push(turn("author", "澪は剣術の達人ということにします"));
    };
    await run(testAi(answer([])), turns);

    hooks.beforeSend = () => undefined;
    const again = testAi(answer([]));
    const result = await run(again, turns);

    // 覚え書きは「押した時点の会話」のものなので、伸びた会話は別物になる
    expect(result.unchanged).toBe(false);
    expect(again.generate).toHaveBeenCalledTimes(1);
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
