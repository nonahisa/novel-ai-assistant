// 束（MCPサーバー）を stdio で起こして、JSON-RPC を撃つための小さな部品。
//
// `scripts/smokeMcp.mjs` が中に持っていた spawn・行の配り・`send`／`notify` を
// そのまま切り出したもの。**測定の台本（`measure.mjs`）が同じ配線をもう一度
// 書かないため**にある——写しを2つ持つと、片方だけ直したときに
// 「smoke では通るのに measure では黙る」という差ができる。
//
// **smokeMcp.mjs はまだ触っていない**（置き換えは別の作業）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const BUNDLE_PATH = path.join(REPO_ROOT, "dist", "mcp-server.mjs");

/**
 * 束が無ければ止める。**ここからビルドを起こさない。**
 *
 * 測るのは「いま配ってある束」であって、台本が勝手に組み直した束ではない。
 * 組み直してから測ると、**何を測ったのかが分からなくなる**。
 */
export function assertBundleExists() {
  if (fs.existsSync(BUNDLE_PATH)) return;
  // 文言は smokeMcp.mjs と揃える（作者が同じ手順を思い出せるように）
  console.error(
    `${path.relative(REPO_ROOT, BUNDLE_PATH)} がありません。先に npm run build を実行してください。`
  );
  process.exit(1);
}

/**
 * 束を起こして、`initialize` まで済ませる。
 *
 * @param {{ clientName?: string, timeoutMs?: number }} options
 *   `clientName` は `initialize` の `clientInfo.name`。**これが接続元の名乗り**に
 *   なり、許可（`.aiwriter/external-access.json`）の見分けに使われる。
 *   `timeoutMs` は1回の応答を待つ上限。**測定では長く待つ**——推敲を3話ぶん
 *   回すと、遅いモデルでは10分を超えることがある。
 */
export async function connect({
  clientName = "measure",
  timeoutMs = 1_800_000,
} = {}) {
  assertBundleExists();

  const child = spawn(process.execPath, [BUNDLE_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

  /** 受け取った行を id ごとに配る */
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      }
    }
  });

  // 束が先に落ちたら、待っている全員に知らせる。**黙って待ち続けない**
  child.on("exit", (code) => {
    for (const [id, resolve] of waiting) {
      waiting.delete(id);
      resolve({
        id,
        error: {
          message: `MCPサーバーが終了しました（code ${code}）。stderr: ${stderr}`,
        },
      });
    }
  });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(
          new Error(
            `${method} の応答がありません（${Math.round(timeoutMs / 1000)}秒）。stderr: ${stderr}`
          )
        );
      }, timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  const initialize = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: clientName, version: "0" },
  });
  const serverInfo = initialize.result?.serverInfo;
  if (!serverInfo?.name) {
    child.kill();
    throw new Error(
      `initialize の応答が空です: ${JSON.stringify(initialize)}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`
    );
  }
  notify("notifications/initialized", {});

  /**
   * 道具を呼ぶ。
   *
   * **返事は中身まで開けて返す。** `tools/call` は本文を
   * `result.content[0].text` に JSON の文字列として入れて返すので、
   * 呼ぶ側が毎回それを剥がすと書き忘れが出る。
   *
   * **`isError` は例外にする**（本文を添えて）。許可で断られた回や
   * モデルが落ちた回を、成功と同じ顔で返さないため。
   */
  async function call(name, args) {
    const message = await send("tools/call", { name, arguments: args ?? {} });
    if (message.error) {
      throw new Error(
        `${name} が失敗しました: ${message.error.message ?? JSON.stringify(message.error)}`
      );
    }
    const text = message.result?.content?.[0]?.text ?? "";
    if (message.result?.isError) {
      throw new Error(`${name} が断られました: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `${name} の返事をJSONとして読めませんでした: ${text.slice(0, 2000)}`
      );
    }
  }

  async function listTools() {
    const message = await send("tools/list", {});
    return message.result?.tools ?? [];
  }

  function close() {
    child.kill();
  }

  return {
    serverInfo,
    call,
    listTools,
    close,
    /** 束が何か言っていたら読めるように（原因を追うときだけ使う） */
    stderrText: () => stderr,
  };
}
