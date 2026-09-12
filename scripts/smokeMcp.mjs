// 外から呼ぶ束（MCPサーバー）が、本当に stdio で立ち上がるか。
//
//   node scripts/smokeMcp.mjs
//
// **「ビルドが通った」は「動く」ではない**（CLAUDE.md の「繰り返し起きた
// 失敗」6）。束が組めても、`vscode` が混ざっていれば読み込んだ瞬間に落ちるし、
// 転送層の配線を間違えれば `initialize` に答えない。ここでは実際に
// `node dist/mcp-server.mjs` を起こして、**JSON-RPC を2往復**させる。
//
// 単体テスト（`test/unit/`）に入れていないのは、**`npm run build` の
// 結果を見るテストだから**である。テストはソースを直接読む建て付けなので、
// 束を要求すると「ビルドしないと落ちるテスト」ができてしまう。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "mcp-server.mjs");

if (!fs.existsSync(bundle)) {
  console.error(
    `${path.relative(root, bundle)} がありません。先に npm run build を実行してください。`
  );
  process.exit(1);
}

const child = spawn(process.execPath, [bundle], {
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

function send(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${method} の応答がありません（10秒）。stderr: ${stderr}`));
    }, 10000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

try {
  const initialize = await send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smokeMcp", version: "0" },
  });
  const info = initialize.result?.serverInfo;
  if (!info?.name) throw new Error(`initialize の応答が空です: ${JSON.stringify(initialize)}`);
  console.log(`initialize: ${info.name} ${info.version}`);

  notify("notifications/initialized", {});

  const list = await send(2, "tools/list", {});
  const tools = list.result?.tools ?? [];
  if (tools.length === 0) throw new Error("tools/list が空です。");
  console.log(`tools/list: ${tools.length}件`);
  for (const tool of tools) console.log(`  ${tool.name}`);

  const version = await send(3, "tools/call", {
    name: "mcp.version",
    arguments: {},
  });
  const text = version.result?.content?.[0]?.text ?? "";
  console.log(`mcp.version: ${text.replace(/\s+/g, " ")}`);
  if (!text.includes(info.version)) {
    throw new Error("mcp.version と server info の版が食い違っています。");
  }

  console.log("stdio の起動確認: 通りました");
  child.kill();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (stderr) console.error(`--- stderr ---\n${stderr}`);
  child.kill();
  process.exit(1);
}
