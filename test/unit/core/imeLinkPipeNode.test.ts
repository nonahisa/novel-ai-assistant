import * as net from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  readWindowsUserSid,
  startImeLinkClient,
  type ImeLinkClient,
  type ImeLinkState,
} from "../../../src/core/imeLinkPipeNode";
import type { ImeLinkCommit } from "../../../src/core/imeAppLink";

/**
 * 本物の名前付きパイプで、偽の六徳 IME に客としてつなぐ（設計書6.13.8）。
 *
 * 偽の IME はエンジンの `link::serve_client` と同じ順で答える：hello の1行を読み、
 * welcome を返し、許したなら確定を1行ずつ送る。許さなければ少し待って切る。
 * **名前付きパイプは Windows だけ**なので、Mac・Linux の CI では飛ばす。
 * 本物の六徳 IME にはつながない（パイプの名前は試しごとに乱数）。
 */

const onWindows = process.platform === "win32";

interface FakeIme {
  server: net.Server;
  hellos: string[];
  sockets: net.Socket[];
  close(): Promise<void>;
}

function fakeIme(pipeName: string, grant: () => boolean, commits: () => string[]): Promise<FakeIme> {
  const hellos: string[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end < 0 || hellos.length > sockets.indexOf(socket)) return;
      hellos.push(buffered.slice(0, end));
      const granted = grant();
      socket.write(
        `${JSON.stringify({ welcome: { grants: granted ? ["commit"] : [], denied: granted ? [] : ["commit"] } })}\n`
      );
      if (!granted) {
        setTimeout(() => socket.destroy(), 50);
        return;
      }
      for (const line of commits()) socket.write(`${line}\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(pipeName, () =>
      resolve({
        server,
        hellos,
        sockets,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      })
    );
  });
}

let client: ImeLinkClient | undefined;
let ime: FakeIme | undefined;

afterEach(async () => {
  client?.stop();
  client = undefined;
  await ime?.close();
  ime = undefined;
});

describe.skipIf(!onWindows)("パイプの客（本物の名前付きパイプ）", () => {
  const pipeName = (): string =>
    `\\\\.\\pipe\\novelai-test-link-${Math.random().toString(16).slice(2)}`;

  test("hello → welcome（許す）→ 確定2つ → 切断 → つなぎ直し", async () => {
    const name = pipeName();
    const commits: ImeLinkCommit[] = [];
    const states: ImeLinkState[] = [];
    ime = await fakeIme(
      name,
      () => true,
      () => [
        JSON.stringify({ commit: { text: "白樺", reading: "しらかば", at: "2026-11-18T09:00:00+09:00" } }),
        // 形の違う行・読みでない読みは捨てる
        "壊れた行",
        JSON.stringify({ commit: { text: "灯", reading: "灯" } }),
        JSON.stringify({ commit: { text: "灯", reading: "あかり" } }),
      ]
    );
    client = startImeLinkClient({
      pipeName: name,
      onCommit: (commit) => commits.push(commit),
      onState: (state) => states.push(state),
      delay: () => 50,
    });
    await vi.waitFor(() => expect(commits).toHaveLength(2), { timeout: 5000 });
    expect(JSON.parse(ime.hellos[0])).toEqual({
      hello: { appId: "novel-ai-assistant", wants: ["commit"] },
    });
    expect(commits).toEqual([
      { text: "白樺", reading: "しらかば" },
      { text: "灯", reading: "あかり" },
    ]);
    expect(client.granted()).toBe(true);

    // IME の側が切る（エンジンが起き直した）→ 間をおいてつなぎ直し、もう一度 hello を送る
    ime.sockets[0].destroy();
    await vi.waitFor(() => expect(states).toContain("lost"), { timeout: 5000 });
    await vi.waitFor(() => expect(ime?.hellos.length).toBe(2), { timeout: 5000 });
    await vi.waitFor(() => expect(commits).toHaveLength(4), { timeout: 5000 });
    expect(states.filter((state) => state === "granted").length).toBeGreaterThanOrEqual(2);
  });

  test("許されなければ確定を受けず、許されていない間は granted にならない", async () => {
    const name = pipeName();
    const commits: ImeLinkCommit[] = [];
    const states: ImeLinkState[] = [];
    const delays: string[] = [];
    ime = await fakeIme(name, () => false, () => []);
    client = startImeLinkClient({
      pipeName: name,
      onCommit: (commit) => commits.push(commit),
      onState: (state) => states.push(state),
      delay: (end) => {
        delays.push(end);
        return 60_000;
      },
    });
    await vi.waitFor(() => expect(delays).toContain("denied"), { timeout: 5000 });
    expect(states).toEqual(["denied"]);
    expect(client.granted()).toBe(false);
    expect(commits).toEqual([]);
  });

  test("IME が居なければ静かに待ち（例外を投げない）、あとから立った IME へつながる", async () => {
    const name = pipeName();
    const commits: ImeLinkCommit[] = [];
    const states: ImeLinkState[] = [];
    const ends: string[] = [];
    client = startImeLinkClient({
      pipeName: name,
      onCommit: (commit) => commits.push(commit),
      onState: (state) => states.push(state),
      delay: (end) => {
        ends.push(end);
        return 50;
      },
    });
    await vi.waitFor(() => expect(ends.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(states).toEqual(["absent"]);
    ime = await fakeIme(
      name,
      () => true,
      () => [JSON.stringify({ commit: { text: "灯", reading: "あかり" } })]
    );
    await vi.waitFor(() => expect(commits).toHaveLength(1), { timeout: 5000 });
    expect(states).toEqual(["absent", "granted"]);
  });

  test("止めたあとはつなぎ直さない", async () => {
    const name = pipeName();
    ime = await fakeIme(name, () => true, () => []);
    const states: ImeLinkState[] = [];
    client = startImeLinkClient({
      pipeName: name,
      onCommit: () => undefined,
      onState: (state) => states.push(state),
      delay: () => 20,
    });
    await vi.waitFor(() => expect(states).toContain("granted"), { timeout: 5000 });
    client.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ime.hellos).toHaveLength(1);
    expect(states.at(-1)).toBe("stopped");
  });

  test("いまのユーザーの SID を読める", async () => {
    expect(await readWindowsUserSid()).toMatch(/^S-1-\d+(?:-\d+)+$/);
  });
});
