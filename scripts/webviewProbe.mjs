// ブラウザ版の実動テスト（`npm run test:web`）で、**パネル（WebView）の中身**を覗く口。
//
// 拡張機能ホストの側からは、パネルが「作られた」ことまでしか分からない
// （`window.tabGroups` にタブが出る）。**中身が描かれたかは分からない**——
// Claude の内蔵ブラウザでは Service Worker の登録に失敗して、タブは出るのに
// 中身が空のままだった（2026-09-23）。それでは「開けた」と言えない。
//
// そこで、見えない Chromium を `--remote-debugging-port` 付きで起こし
// （`runWebTests.mjs`）、ここから Chrome DevTools Protocol で各フレームの
// 見出しと文字を読む。拡張機能ホストの検査（`test/web/index.ts`）は
// この口へ `fetch` して、欲しい見出しが描かれるまで待つ。
//
// **新しい依存を増やさない。** Playwright は `@vscode/test-web` の中で
// 使われているが、この作品の依存としては宣言していない。Node 24 の
// 組み込みの `WebSocket` と `fetch` だけで話す。
import http from "node:http";

/** WebView のフレームの目印。VS Code の WebView はこの下から配られる */
const WEBVIEW_PATH_MARK = "/webview/browser/pre/";

/**
 * 覗く口を立てる。
 *
 * @param {{ cdpPort: number, listenPort: number }} options
 * @returns {{ close: () => Promise<void> }}
 */
export function startWebviewProbe({ cdpPort, listenPort }) {
  const server = http.createServer(async (request, response) => {
    // 拡張機能ホストは別の origin（`*.localhost:3111` の iframe の中の Worker）から来る
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url && request.url.startsWith("/statusbar")) {
      try {
        const text = await readStatusBar(cdpPort);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ text }));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
      }
      return;
    }
    if (!request.url || !request.url.startsWith("/webview-frames")) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const frames = await collectWebviewFrames(cdpPort);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ frames }));
    } catch (error) {
      // **理由を返す。** 検査の側が「覗けなかった」のか「描かれていない」のかを
      // 取り違えないように
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
    }
  });
  server.listen(listenPort, "127.0.0.1");
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * WebView のフレームを全部集めて、見出しと表示されている文字を返す。
 *
 * **ページの中の iframe と、別プロセスの iframe の両方を見る。**
 * WebView は `{uuid}.localhost` から配られるので、Chromium のサイト分離の
 * 判断しだいで、親ページのフレームにも、独立した `iframe` の標的にもなる。
 * どちらでも拾えるように、標的をすべて回ってフレームの木をたどる。
 */
async function collectWebviewFrames(cdpPort) {
  const listResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = await listResponse.json();
  const found = [];
  const seen = new Set();
  for (const target of targets) {
    if (target.type !== "page" && target.type !== "iframe") continue;
    if (!target.webSocketDebuggerUrl) continue;
    let frames;
    try {
      frames = await framesOfTarget(target.webSocketDebuggerUrl);
    } catch {
      // 閉じかけの標的などは読めないことがある。ほかの標的は続けて見る
      continue;
    }
    for (const frame of frames) {
      if (seen.has(frame.id)) continue;
      seen.add(frame.id);
      found.push({ url: frame.url, title: frame.title, text: frame.text });
    }
  }
  return found;
}

/** 1つの標的の中の、WebView のフレームを読む */
async function framesOfTarget(webSocketUrl) {
  const session = await CdpSession.open(webSocketUrl);
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const frames = [];
    flatten(frameTree, frames);
    const result = [];
    for (const frame of frames) {
      if (!frame.url.includes(WEBVIEW_PATH_MARK)) continue;
      try {
        // **ページの側の変数に触れない別の世界で読む**（画面の動きを変えない）
        const { executionContextId } = await session.send("Page.createIsolatedWorld", {
          frameId: frame.id,
          worldName: "novelai-web-probe",
        });
        const { result: value } = await session.send("Runtime.evaluate", {
          contextId: executionContextId,
          returnByValue: true,
          expression:
            "({ title: document.title, text: document.body ? document.body.innerText : '' })",
        });
        const read = value && value.value ? value.value : { title: "", text: "" };
        result.push({ id: frame.id, url: frame.url, title: read.title, text: read.text });
      } catch {
        // 別プロセスのフレームは、この標的からは読めない（その標的の番で読む）
      }
    }
    return result;
  } finally {
    session.close();
  }
}

/**
 * 画面の下の欄（ステータスバー）に出ている文字（2026-09-24）。
 *
 * **拡張機能の側からは、自分で出したステータスバーの文字も読めない**
 * （`StatusBarItem` は書くだけの口）。ブラウザ版で「本文を開いても種類の
 * 目安が出ない」を実機で踏んだので、画面に出た文字そのものを読む。
 * 見つからなければ null（読めなかったことを「空」と取り違えない）。
 */
async function readStatusBar(cdpPort) {
  const listResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = await listResponse.json();
  for (const target of targets) {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
    let session;
    try {
      session = await CdpSession.open(target.webSocketDebuggerUrl);
      const { frameTree } = await session.send("Page.getFrameTree");
      // **ページの側の変数に触れない別の世界で読む**（パネルを読むときと同じ）
      const { executionContextId } = await session.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "novelai-web-probe",
      });
      const { result: value } = await session.send("Runtime.evaluate", {
        contextId: executionContextId,
        returnByValue: true,
        expression:
          "(() => { const bar = document.getElementById('workbench.parts.statusbar');" +
          " return bar ? bar.innerText : null; })()",
      });
      if (value && typeof value.value === "string") return value.value;
    } catch {
      // 閉じかけの標的などは読めないことがある。ほかの標的を見る
    } finally {
      session?.close();
    }
  }
  return null;
}

function flatten(tree, out) {
  out.push(tree.frame);
  for (const child of tree.childFrames ?? []) flatten(child, out);
}

/** Chrome DevTools Protocol の最小の話し手 */
class CdpSession {
  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`DevTools に繋がりません: ${url}`));
      }, 5000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`DevTools に繋がりません: ${url}`));
      });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("DevTools との接続が切れました"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} が返りません`));
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}
