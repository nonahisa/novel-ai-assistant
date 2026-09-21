/**
 * 開発と実機確認に要るものが揃っているかを調べる（作者の指示、2026-09-21）。
 *
 * **別の機械で作業を始めるときに、何が足りないかを一度に出す。**
 * ノートPCをテスト専用機にする話（引継ぎ書）から来ている。人に聞いて回るより、
 * 機械に言わせたほうが早く、抜けもない。
 *
 * **鍵の値は絶対に出さない。** 環境変数は「あるかどうか」だけを見る。
 * 作業の記録やチャットに貼られると、公開リポジトリへ写る道ができる
 * （2026-09-21 に実際に起きた——`docs/進捗と引継ぎ.md` の事故の記録）。
 *
 * 使い方：`node scripts/checkEnv.mjs`
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lines = [];
let missing = 0;
let warned = 0;

/** @param {"ok"|"ng"|"warn"} state */
function say(state, label, detail) {
  const mark = state === "ok" ? "○" : state === "warn" ? "△" : "×";
  if (state === "ng") missing += 1;
  if (state === "warn") warned += 1;
  lines.push(`${mark} ${label}${detail ? `：${detail}` : ""}`);
}

function version(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

// ── 土台 ──────────────────────────────────────────────
const node = process.versions.node;
const major = Number(node.split(".")[0]);
// 24系で動かしている。古いと `import.meta.dirname` のような新しい口が無い
say(major >= 22 ? "ok" : "ng", "Node.js", `${node}${major >= 22 ? "" : "（24系が要ります）"}`);

const git = version("git --version");
say(git ? "ok" : "ng", "Git", git ?? "見つかりません");

say(
  fs.existsSync(path.join(root, "node_modules")) ? "ok" : "ng",
  "依存パッケージ",
  fs.existsSync(path.join(root, "node_modules")) ? "入っています" : "`npm install` が要ります"
);

say(
  fs.existsSync(path.join(root, "dist", "extension.js")) ? "ok" : "warn",
  "ビルド済みの束",
  fs.existsSync(path.join(root, "dist", "extension.js"))
    ? "あります"
    : "まだです（F5 の前に `npm run build`）"
);

// ── 過去に踏んだ落とし穴 ──────────────────────────────
// 拡張機能ホストの環境変数を継ぐと、Electron 製のアプリ（LM Studio）が即終了し、
// 統合テストも「bad option」で落ちる（memory の2件）
say(
  process.env.ELECTRON_RUN_AS_NODE ? "ng" : "ok",
  "ELECTRON_RUN_AS_NODE",
  process.env.ELECTRON_RUN_AS_NODE
    ? "残っています。外してください（統合テストと LM Studio が落ちます）"
    : "外れています"
);

// ── AI の口 ───────────────────────────────────────────
async function probe(label, url, hint) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      say("warn", label, `繋がりましたが ${res.status} を返します`);
      return;
    }
    const body = await res.json();
    const models = body?.models ?? body?.data ?? [];
    say("ok", label, `${Array.isArray(models) ? models.length : "?"} モデル`);
  } catch {
    say("warn", label, hint);
  }
}

await probe(
  "Ollama（この機械）",
  "http://localhost:11434/api/tags",
  "繋がりません。別の機械のものを借りるなら設定 `novelai.ollamaUrl` を変えてください"
);
await probe(
  "LM Studio（この機械）",
  "http://localhost:1234/v1/models",
  "繋がりません（使わないなら気にしなくて構いません）"
);

// ── 鍵は「あるか」だけ ────────────────────────────────
for (const [name, label] of [
  ["SAKURA_AI_ACCOUNT_TOKEN", "さくらのAI のトークン"],
  ["NOVELAI_WORKS", "実接続テストに使う作品フォルダー"],
]) {
  const has = Boolean(process.env[name]);
  // **値は出さない。** 長さも出さない（当てる手がかりになる）
  say(has ? "ok" : "warn", label, has ? `環境変数 ${name} にあります` : `環境変数 ${name} が空です`);
}

// ── 確認用コピー ──────────────────────────────────────
const copies = path.join(path.dirname(root), "確認用コピー");
if (fs.existsSync(copies)) {
  const works = fs
    .readdirSync(copies, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith("_確認用"));
  say(works.length > 0 ? "ok" : "warn", "確認用コピー", `${works.length} 作品（${works.map((w) => w.name).join("・")}）`);
} else {
  say("warn", "確認用コピー", "ありません。GitHub 同期で取り寄せるか、写してください");
}

// ── 出す ──────────────────────────────────────────────
console.log("\n" + lines.join("\n"));
console.log(
  `\n足りないもの ${missing} 件 / 気になるもの ${warned} 件\n` +
    (missing === 0
      ? "**開発とテストは走ります。**\n"
      : "**× を埋めてから始めてください。**\n")
);
// **`process.exit()` を呼ばない。** `fetch` の時計がまだ生きている間に
// 落とすと、libuv が `!(handle->flags & UV_HANDLE_CLOSING)` で止まる
// （2026-09-21 に実際に踏んだ）。終了の値だけ置いて、自然に終わらせる
process.exitCode = missing === 0 ? 0 : 1;
