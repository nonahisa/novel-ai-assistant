import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildWorkChatPanelHtml } from "../../../src/views/workChatPanelHtml";
import { BACKUP_DROP_MAX_BYTES } from "../../../src/core/backupFileKinds";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談パネルの、バックアップの受け口（作者の依頼、2026-09-23）。
 *
 * 判断そのもの（どの作品か・何を足すか）は `backupDrop.test.ts` が見る。
 * ここで見るのは**受け口の形**——画面から届いたものを確かめてから渡すこと、
 * 結果を会話の中に出すこと、画面の側で大きすぎるものを送る前に止めること。
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

const received: Array<{ fileName: string; bytes: Uint8Array; works: number }> = [];
let lastDeps: Record<string, unknown> | undefined;
const receivedSource: Array<{ sourcePath?: string }> = [];
let result: { message: string; recordPath?: string } | undefined;
vi.mock("../../../src/features/backupDrop", () => ({
  receiveBackup: async (
    source: { fileName: string; bytes: Uint8Array; sourcePath?: string },
    deps: { works: readonly unknown[] }
  ) => {
    const { sourcePath, ...rest } = source;
    received.push({ ...rest, works: deps.works.length });
    receivedSource.push({ sourcePath });
    lastDeps = deps as Record<string, unknown>;
    return result;
  },
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const posted: Array<Record<string, unknown>> = [];

function makePanel(): InstanceType<typeof WorkChatPanel> {
  const registry = { list: () => [WORK] };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: { id: "ollama", displayName: "Ollama", isPaid: false },
      model: "m",
    }),
  };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    { run: async () => undefined } as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Record<string, unknown>) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return panel;
}

async function send(panel: InstanceType<typeof WorkChatPanel>, message: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handle(message, { postMessage: () => Promise.resolve(true) });
}

beforeEach(() => {
  received.length = 0;
  posted.length = 0;
  result = { message: "「氷の街」へ取り込みました：章2" };
});

describe("拡張機能の側", () => {
  test("落とされたバイト列を、登録済みの作品と一緒に判断へ渡し、結果を会話に出す", async () => {
    const panel = makePanel();
    const bytes = new Uint8Array([80, 75, 3, 4]);

    await send(panel, { type: "backupFile", name: "N5078JI.zip", bytes });

    expect(received).toEqual([{ fileName: "N5078JI.zip", bytes, works: 1 }]);
    expect(posted).toContainEqual({
      type: "backupResult",
      message: "「氷の街」へ取り込みました：章2",
      canOpenRecord: false,
    });
  });

  test("**提案パネルへ並べる口を渡されたら、判断へそのまま渡す**（設計書6.99.7）", async () => {
    const panel = makePanel();
    const show = () => undefined;
    panel.setBackupProposals(show);

    await send(panel, { type: "backupFile", name: "N5078JI.zip", bytes: new Uint8Array([1]) });

    expect(lastDeps?.showProposals).toBe(show);
  });

  test("話を足したあとの後始末の口（一覧の読み直し・執筆量の基準）も渡す", async () => {
    const panel = makePanel();
    const after = async () => undefined;
    panel.setEpisodesAdded(after);

    await send(panel, { type: "backupFile", name: "N5078JI.zip", bytes: new Uint8Array([1]) });

    expect(lastDeps?.afterEpisodesAdded).toBe(after);
  });

  test("エクスプローラーから落とされたときは、場所も判断へ渡す（Word 原稿の照合の手掛かり）", async () => {
    const panel = makePanel();
    const { workspace } = await import("../support/vscodeStub");
    const saved = workspace.fs;
    workspace.fs = {
      ...saved,
      stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 4 }),
      readFile: async () => new Uint8Array([80, 75, 3, 4]),
    } as unknown as typeof workspace.fs;
    try {
      await send(panel, { type: "backupUri", uri: "file:///c:/novels/w_a/原稿.docx" });
    } finally {
      workspace.fs = saved;
    }

    expect(received.at(-1)?.fileName).toBe("原稿.docx");
    expect(String(receivedSource.at(-1)?.sourcePath)).toMatch(/novels[\\/]w_a[\\/]原稿\.docx$/);
  });

  test("ArrayBuffer で届いても受け取る", async () => {
    const panel = makePanel();

    await send(panel, {
      type: "backupFile",
      name: "a.txt",
      bytes: new Uint8Array([1, 2]).buffer,
    });

    expect(received[0].bytes).toEqual(new Uint8Array([1, 2]));
  });

  test("**バイト列でないものは判断へ渡さない**（数の配列などは読み違えのもと）", async () => {
    const panel = makePanel();

    await send(panel, { type: "backupFile", name: "a.zip", bytes: [80, 75] });

    expect(received).toEqual([]);
    expect(posted.some((message) => message.type === "note")).toBe(true);
  });

  test("本文の違いを書き出せたら、「違いを見る」を出せると伝える", async () => {
    const panel = makePanel();
    result = { message: "本文の違い1話", recordPath: "C:\\novels\\w_a\\記録.md" };

    await send(panel, { type: "backupFile", name: "a.zip", bytes: new Uint8Array([1]) });

    expect(posted).toContainEqual({
      type: "backupResult",
      message: "本文の違い1話",
      canOpenRecord: true,
    });
  });

  test("作者が取りやめたら、取りやめたことだけを言う", async () => {
    const panel = makePanel();
    result = undefined;

    await send(panel, { type: "backupFile", name: "a.zip", bytes: new Uint8Array([1]) });

    expect(posted).toContainEqual({
      type: "note",
      message: "バックアップの取り込みを取りやめました。",
    });
  });

  test("画面の側で大きすぎると止めたものは、理由だけを会話に出す", async () => {
    const panel = makePanel();

    await send(panel, { type: "backupTooLarge", name: "動画.zip" });

    expect(received).toEqual([]);
    expect(String(posted.at(-1)?.message)).toContain("大きすぎる");
  });
});

describe("画面の側", () => {
  for (const large of [false, true]) {
    const html = buildWorkChatPanelHtml("n", "vscode-resource:", { large });
    const script = (() => {
      const found = html.match(/<script nonce="n">([\s\S]*?)<\/script>/);
      if (!found) throw new Error("スクリプトが見つかりません");
      return found[1];
    })();
    const where = large ? "大きい画面" : "横のパネル";

    test(`${where}：スクリプトが壊れていない`, () => {
      expect(() => new Function(script)).not.toThrow();
    });

    test(`${where}：中身はバイト列のまま送り、大きすぎるものは送る前に止める`, () => {
      expect(script).toContain("new Uint8Array(buffer)");
      expect(script).toContain(`const MAX_BACKUP_BYTES = ${BACKUP_DROP_MAX_BYTES};`);
      expect(script).toContain("'backupTooLarge'");
    });

    test(`${where}：エクスプローラーから落とされた Word 原稿（.docx）も受け取る`, () => {
      const line = script.match(/const BACKUP_NAME_PATTERN = (\/.*\/i);/);
      expect(line).toBeTruthy();
      const pattern = new Function(`return ${line?.[1]};`)() as RegExp;
      expect(pattern.test("file:///c%3A/小説/原稿.docx")).toBe(true);
      expect(pattern.test("file:///c%3A/N5078JI.zip")).toBe(true);
      expect(pattern.test("file:///c%3A/N5078JI.txt")).toBe(true);
      expect(pattern.test("file:///c%3A/絵.png")).toBe(false);
      // 古い形式の .doc は受けない（既存の Word 変換も読めない）
      expect(pattern.test("file:///c%3A/原稿.doc")).toBe(false);
    });

    test(`${where}：落とせないときのためのボタンがある`, () => {
      expect(html).toContain('id="pick-backup"');
      expect(script).toContain("'pickBackup'");
    });
  }
});
