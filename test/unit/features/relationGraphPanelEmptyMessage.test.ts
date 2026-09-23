import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { window } from "../support/vscodeStub";

/**
 * 人物相関図の「空のとき」の案内（設計書6.38。`relationGraphPanel.ts` の
 * `emptyMessage()`）。
 *
 * 人物が0件（資料をまだ抽出していない）と、人物はいるが関係が0件
 * （抽出はしたが関係・呼称を誰も書いていない）とでは、次にすることが違う。
 * 同じ文言のままだと、絞り込みを戻せば済む人にまで「まとめて抽出」を
 * やり直させてしまう（ソースのコメントより）。
 *
 * この判断は画面（WebView）ではなく拡張機能側にある
 * （`relationGraphPanelHtml.test.ts` の「材料が無いときの案内は、
 * 拡張機能側から受け取る」で守られている）。`RelationGraphPanel` は
 * 外へ出していない private なクラスなので、公開されている
 * `openRelationGraph` を通し、WebView へ届いた `emptyMessage` を見る。
 */

const state = vi.hoisted(() => ({
  characters: [] as Character[],
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: [] };
    }
  },
}));

const { openRelationGraph } = await import(
  "../../../src/features/relationGraphPanel"
);

let nextWorkId = 0;

/** 作品ごとに1枚しか開かない仕組みがあるので、呼ぶたびに別作品にする */
function work(): WorkEntry {
  nextWorkId += 1;
  return {
    id: `w_${nextWorkId}`,
    title: "氷の街",
    folderPath: "C:\\novels\\w_a",
    registeredAt: "2026-09-05T00:00:00.000Z",
  };
}

interface Posted {
  type: string;
  [key: string]: unknown;
}

/** WebViewパネルの代役。届いたものをここへ積む */
function stubPanel(): Posted[] {
  const posted: Posted[] = [];
  Object.assign(window, {
    createWebviewPanel: () => ({
      webview: {
        html: "",
        cspSource: "vscode-webview:",
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        postMessage: (message: Posted) => {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    }),
  });
  return posted;
}

/** 与えた人物で相関図を開き、画面へ送られた「空のとき」の文言を返す */
async function emptyMessageFor(characters: Character[]): Promise<string> {
  state.characters = characters;
  const posted = stubPanel();
  const context = { subscriptions: [] as unknown[] };
  await openRelationGraph(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context as any,
    work(),
    { openSettingsRecord: async () => undefined }
  );
  const graph = posted.find((message) => message.type === "graph");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (graph?.data as any).emptyMessage as string;
}

beforeEach(() => {
  state.characters = [];
});

describe("人物相関図：空のときの案内の出し分け", () => {
  test("人物が0件なら、まとめて抽出を勧める", async () => {
    const message = await emptyMessageFor([]);
    expect(message).toContain("まだ関係が抽出されていません。");
    expect(message).toContain("まとめて抽出 を実行してください。");
  });

  test("人物はいるが関係が0件なら、関係・呼称が無いことを伝える（抽出のやり直しではなく書き足しを勧める）", async () => {
    const message = await emptyMessageFor([emptyCharacter("char_001", "灯")]);
    expect(message).toContain(
      "人物は見つかりましたが、関係も呼称も資料にありません。"
    );
    expect(message).toContain("設定資料パネルで関係を書き足してください。");
    // 人物0件のときの文言（抽出をやり直させる案内）とは違う
    expect(message).not.toContain("まだ関係が抽出されていません。");
  });
});
