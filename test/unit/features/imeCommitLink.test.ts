import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { env, window, workspace } from "../support/vscodeStub";
import { startImeCommitLink, type ImeCommitLinkHandle } from "../../../src/features/imeCommitLink";

/**
 * 六徳 IME の確定の知らせを、焦点のある原稿エディターへだけ渡すか（設計書6.13.8・6.42.2）。
 *
 * 偽の IME を本物の名前付きパイプで立て、`RITTOKU_LINK_PIPE` で向ける（エンジンと同じ
 * 試しの道）。**本物の六徳 IME にはつながない。** 名前付きパイプは Windows だけなので、
 * ほかの OS では飛ばす。
 */

const onWindows = process.platform === "win32";

let server: net.Server | undefined;
let sockets: net.Socket[] = [];
let handle: ImeCommitLinkHandle | undefined;
let focused = true;
let front: { filePath: string; active: boolean } | undefined;
let enabled = true;
let configListener: ((event: { affectsConfiguration(key: string): boolean }) => void) | undefined;
const savedPipe = process.env.RITTOKU_LINK_PIPE;
const saved = { getConfiguration: workspace.getConfiguration };

function listen(name: string): Promise<void> {
  sockets = [];
  server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.write(`${JSON.stringify({ welcome: { grants: ["commit"], denied: [] } })}\n`);
    });
  });
  return new Promise((resolve) => server?.listen(name, () => resolve()));
}

const send = (text: string, reading: string): void => {
  sockets.at(-1)?.write(`${JSON.stringify({ commit: { text, reading, at: "2026-11-18T09:00:00+09:00" } })}\n`);
};

beforeEach(() => {
  focused = true;
  enabled = true;
  front = { filePath: "C:/作品/本文/001.txt", active: true };
  Object.assign(window, {
    state: {
      get focused() {
        return focused;
      },
    },
  });
  Object.assign(env, { remoteName: undefined });
  Object.assign(workspace, {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "ime.notifyCurrentWork" ? enabled : defaultValue) as T,
    }),
    onDidChangeConfiguration: (listener: typeof configListener) => {
      configListener = listener;
      return { dispose() {} };
    },
  });
});

afterEach(async () => {
  handle?.dispose();
  handle = undefined;
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  Object.assign(workspace, { getConfiguration: saved.getConfiguration });
  if (savedPipe === undefined) delete process.env.RITTOKU_LINK_PIPE;
  else process.env.RITTOKU_LINK_PIPE = savedPipe;
});

describe.skipIf(!onWindows)("六徳 IME の確定の知らせを受ける", () => {
  test("焦点のある原稿エディターの確定だけを渡し、ほかは捨てる。姓と名はつないで渡す", async () => {
    const name = `\\\\.\\pipe\\novelai-test-commit-${Math.random().toString(16).slice(2)}`;
    process.env.RITTOKU_LINK_PIPE = name;
    await listen(name);
    const got: Array<{ filePath: string; reading: string; text: string; previous?: unknown }> = [];
    let calls = 0;
    handle = startImeCommitLink({ subscriptions: [] } as never, {
      frontManuscript: () => {
        calls++;
        return front;
      },
      onCommit: (filePath, reading, text, previous) => got.push({ filePath, reading, text, previous }),
    });
    expect(handle).toBeDefined();
    await vi.waitFor(() => expect(handle?.granted()).toBe(true), { timeout: 5000 });

    // 変換を通らない確定（読みが空）は控えへ渡さず捨て、つながりは許されたまま
    send("abc", "");
    send("。", "");
    send("白樺", "しらかば");
    send("灯", "あかり");
    await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: 5000 });
    expect(got[0]).toEqual({ filePath: "C:/作品/本文/001.txt", reading: "しらかば", text: "白樺", previous: undefined });
    expect(got[1].previous).toEqual({ kana: "しらかば", committed: "白樺" });
    expect(got.some((one) => one.text === "abc" || one.text === "。")).toBe(false);
    expect(handle?.granted()).toBe(true);

    // 窓に焦点が無い・原稿エディターが前に無いときの確定は捨てる
    // 届くのは書いたあと。確定のたびに前の原稿エディターを1回読むので、その回数で届いたことを待つ
    // （時間で待つと、遅い機械で捨てるはずの確定が状態を替えたあとに届いて落ちる）
    let asked = calls;
    const settle = async (): Promise<void> => {
      const target = asked + 1;
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(target), { timeout: 5000 });
      asked = calls;
    };
    focused = false;
    send("森", "もり");
    await settle();
    focused = true;
    front = { filePath: "C:/作品/本文/001.txt", active: false };
    send("湖", "みずうみ");
    await settle();
    front = undefined;
    send("空", "そら");
    await settle();
    front = { filePath: "C:/作品/本文/001.txt", active: true };
    send("海", "うみ");
    await vi.waitFor(() => expect(got).toHaveLength(3), { timeout: 5000 });
    expect(got[2].text).toBe("海");
    // 捨てた確定は「前の確定」にも残らない
    expect(got[2].previous).toEqual({ kana: "あかり", committed: "灯" });

    // 読みが空の確定が間に入ったら、前の確定とつながない
    await settle();
    send("。", "");
    await settle();
    send("森", "もり");
    await vi.waitFor(() => expect(got).toHaveLength(4), { timeout: 5000 });
    expect(got[3]).toMatchObject({ text: "森", previous: undefined });
    expect(handle?.granted()).toBe(true);
  });

  test("設定を切ったら切り、入れたらつなぎ直す", async () => {
    const name = `\\\\.\\pipe\\novelai-test-commit-${Math.random().toString(16).slice(2)}`;
    process.env.RITTOKU_LINK_PIPE = name;
    await listen(name);
    handle = startImeCommitLink({ subscriptions: [] } as never, {
      frontManuscript: () => front,
      onCommit: () => undefined,
    });
    await vi.waitFor(() => expect(handle?.granted()).toBe(true), { timeout: 5000 });
    enabled = false;
    configListener?.({ affectsConfiguration: (key) => key === "novelai.ime.notifyCurrentWork" });
    expect(handle?.granted()).toBe(false);
    enabled = true;
    configListener?.({ affectsConfiguration: (key) => key === "novelai.ime.notifyCurrentWork" });
    await vi.waitFor(() => expect(handle?.granted()).toBe(true), { timeout: 5000 });
    expect(sockets.length).toBe(2);
  });

  test("設定がオフならつながない", async () => {
    const name = `\\\\.\\pipe\\novelai-test-commit-${Math.random().toString(16).slice(2)}`;
    process.env.RITTOKU_LINK_PIPE = name;
    await listen(name);
    enabled = false;
    handle = startImeCommitLink({ subscriptions: [] } as never, {
      frontManuscript: () => front,
      onCommit: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sockets).toHaveLength(0);
  });

  test("リモートではつながない", () => {
    Object.assign(env, { remoteName: "ssh-remote" });
    handle = startImeCommitLink({ subscriptions: [] } as never, {
      frontManuscript: () => front,
      onCommit: () => undefined,
    });
    expect(handle).toBeUndefined();
    Object.assign(env, { remoteName: undefined });
  });
});
