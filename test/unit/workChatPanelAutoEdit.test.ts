import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../src/models/types";

/**
 * 頼まれた書き込みは、確認を出さずに書く（作者の裁定 2026-09-21）。
 *
 * **実機で困ったこと**：「これで書いてください」と打ってから実際に書かれる
 * までに関門が2つあった。(1) 答えの下の「ほかにできること（1件）を見る」を
 * 開いてボタンを押す (2) VS Code の確認ダイアログ。作者の言葉は
 * 「頼んでいるのだから、書き込みはした上で次へ行くべきでは？
 * もう一度書き込むかどうか聞くのは意味がわからない」。
 *
 * **`edit` が返ってきたこと自体が「頼まれた」の印である**——`prompts/workChat.ts`
 * が「`edit` を付けてよいのは作業を頼まれたとき」「頼まれていない作業を
 * 勧めない」と歯止めを掛けている。
 *
 * 確認を外すぶん、**取り消せる道をその場に出す**。ここではその両方を見る。
 */

const applied = vi.hoisted(
  () => [] as Array<{ workId: string; target: unknown; content: string }>
);
/** 書き込み先にいま入っている値（取り消しの照合に使う） */
const currentValue = vi.hoisted(() => ({ text: "" }));
const confirmed = vi.hoisted(() => [] as string[]);

vi.mock("../../src/features/applyChatEdit", () => ({
  applyChatEdit: async (
    work: { id: string },
    edit: { target: unknown; content: string }
  ) => {
    applied.push({
      workId: work.id,
      target: edit.target,
      content: edit.content,
    });
    // 書けば、いま入っている値は書いた中身になる
    currentValue.text = edit.content;
    return "設定/plot.md";
  },
  readChatEditTarget: async () => currentValue.text,
}));

vi.mock("../../src/views/notify", () => ({
  // **呼ばれたら試験は落ちる。** 作者へ訊く確認はもう出さない
  confirmRun: async (message: string) => {
    confirmed.push(message);
    return true;
  },
  notifyDone: () => undefined,
  warnWithLog: () => undefined,
}));

vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const WRITTEN = "灯は、消えた姉の足跡を追って氷の街へ入る。";

interface Posted {
  type: string;
  message?: string;
  id?: string;
  edit?: unknown;
}

function fakeView(posted: Posted[]) {
  return {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Posted) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/** 「書きます」と言って `edit` を返すAI */
function editingAi() {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({
          text: JSON.stringify({
            reply: "ログラインを書きました。",
            edit: {
              target: "plot.logline",
              content: WRITTEN,
              label: "ログラインを書く",
            },
          }),
        }),
      },
      model: "gemma4:e4b",
    }),
  };
}

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
}

function harness(): Harness {
  const posted: Posted[] = [];
  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    editingAi() as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).findRelated = async () => ({
    reference: [],
    searchTerms: [],
    materials: [],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).resolveContext = async () => ({
    work: WORK,
    kind: "workOnly",
    filePath: WORK.folderPath,
    label: WORK.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });
  return { panel, posted };
}

async function ask(h: Harness, question: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (h.panel as any).ask(question);
}

function find(posted: Posted[], type: string): Posted | undefined {
  return posted.find((message) => message.type === type);
}

beforeEach(() => {
  applied.length = 0;
  confirmed.length = 0;
  currentValue.text = "（まだ書かれていません）";
});

describe("頼んだ書き込みは、訊かずに書く", () => {
  test("確認ダイアログを出さない", async () => {
    const h = harness();

    await ask(h, "ログラインはこれで書いてください");

    expect(confirmed, "確認を出している").toEqual([]);
    expect(applied).toEqual([
      { workId: "w_a", target: { kind: "plot", section: "logline" }, content: WRITTEN },
    ]);
  });

  test("畳んだボタン（ほかにできること）へ入れない", async () => {
    const h = harness();

    await ask(h, "ログラインはこれで書いてください");

    const answer = find(h.posted, "answer");
    expect(answer, "答えが出ていない").toBeTruthy();
    // ここに `edit` が入ると、画面は「ほかにできること（1件）を見る」を出す。
    // 押させる段階はもう無い
    expect(answer!.edit).toBeUndefined();
  });

  test("書き換えた結果と、取り消す道をその場に出す", async () => {
    const h = harness();

    await ask(h, "ログラインはこれで書いてください");

    const done = find(h.posted, "editDone");
    expect(done, "結果が出ていない").toBeTruthy();
    expect(done!.message).toContain("書き換えました");
    expect(done!.message).toContain("ログライン");
    // 取り消しの口（id）が無いと、画面はボタンを出せない
    expect(typeof done!.id).toBe("string");
  });
});

describe("取り消し", () => {
  test("元の値へ戻す", async () => {
    const h = harness();
    await ask(h, "ログラインはこれで書いてください");
    const id = find(h.posted, "editDone")!.id!;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.panel as any).undoEdit(id);

    expect(applied[1]).toEqual({
      workId: "w_a",
      target: { kind: "plot", section: "logline" },
      content: "（まだ書かれていません）",
    });
    expect(find(h.posted, "undoDone")).toBeTruthy();
  });

  test("作者が手で直したあとなら、戻さない", async () => {
    const h = harness();
    await ask(h, "ログラインはこれで書いてください");
    const id = find(h.posted, "editDone")!.id!;

    // 書いたあとに作者が自分で書き直した
    currentValue.text = "灯は、姉を捜して氷の街へ向かう。";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.panel as any).undoEdit(id);

    // **作者が書いたものを、取り消しで消さない**（実装ルール2）
    expect(applied.length, "戻してしまっている").toBe(1);
    const failed = find(h.posted, "undoFailed");
    expect(failed, "断る理由を出していない").toBeTruthy();
  });
});
