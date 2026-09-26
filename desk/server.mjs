/**
 * 内蔵ブラウザの原稿エディター・読み書き役（試作。設計書 6.112）。
 *
 * 原稿エディター（設計書 6.25・6.34）の画面を**そのまま**配り、
 * 拡張機能の代わりに「開く」「保存する」を受ける。VS Code を開かずに、
 * Claude のアプリの右の枠で書くための道。
 *
 * ## 決まり
 *
 * - **書き込むのは作者が打った文字だけ。** AI や MCP からの書き込み口は作らない
 *   （外部AIは原稿を書き換えない決まり）
 * - **保存は拡張機能と同じ `writeTextFilePreservingFormat` を通す**（実装ルール1）。
 *   読み込み時のハッシュ照合・文字コードと改行の保持・変わった所だけの書き戻し・
 *   回復先への退避。ほかで書き換えられていたら上書きせず止める
 * - **localhost だけ**で待ち受ける
 *
 * このファイルは desk/build.mjs が src/ と一緒に束ね（`vscode` は
 * desk/vscodeShim.mjs に差し替える）、desk/start.mjs が起こす。
 */
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { decodeBytes } from "../src/core/textDecode";
import { writeTextFilePreservingFormat } from "../src/core/textFile";
import { toLf } from "../src/core/eolSpace";
import { buildManuscriptEditorHtml } from "../src/views/manuscriptEditorHtml";
import { notationModeFor, renderTermMarks } from "../src/core/manuscriptRender";
import { resolveInitialAppearance } from "../src/core/manuscriptAppearance";
import { markFontFor } from "../src/core/markFont";
import { memoColorVars } from "../src/core/sceneMemo";
import { TERM_COLORS } from "../src/core/termColors";
import { copyEmphasisFor } from "../src/core/postingCopyTargets";
import { DESK_PAGE_SHIM } from "./pageShim.mjs";

/** 起動の引数 `--work <作品フォルダー> --port <番号>` を読む */
function readArgs(argv) {
  const args = { work: "", port: 4870 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--work") args.work = argv[i + 1] ?? "";
    if (argv[i] === "--port") args.port = Number(argv[i + 1]);
  }
  return args;
}

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);
/** 本文ではないもの。回復先や設定資料を話の一覧へ出さない */
const SKIP_DIRECTORIES = new Set(["node_modules", "設定", "資料"]);

/**
 * 話の一覧。`本文/` があればその下だけ、無ければ作品フォルダーの下を見る。
 * 試作なので作品の登録（scanWork）は使わず、.txt / .md を並べるだけにする。
 */
async function listEpisodes(workRoot) {
  const bodyRoot = nodePath.join(workRoot, "本文");
  const start = (await isDirectory(bodyRoot)) ? bodyRoot : workRoot;
  const found = [];
  async function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(full, depth + 1);
      } else if (TEXT_EXTENSIONS.has(nodePath.extname(entry.name).toLowerCase())) {
        found.push(nodePath.relative(workRoot, full).replace(/\\/g, "/"));
      }
    }
  }
  await walk(start, 0);
  return found.sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 画面から来た相対の場所を、作品フォルダーの中の実際の場所へ。
 * **作品フォルダーの外へは出さない**（`..` や絶対の場所を断る）。
 */
function resolveInside(workRoot, relative) {
  if (typeof relative !== "string" || relative === "") return undefined;
  const full = nodePath.resolve(workRoot, relative);
  const back = nodePath.relative(workRoot, full);
  if (back.startsWith("..") || nodePath.isAbsolute(back)) return undefined;
  if (!TEXT_EXTENSIONS.has(nodePath.extname(full).toLowerCase())) return undefined;
  return full;
}

/** 失敗の理由を、作者に読める言葉へ */
const SAVE_FAILURE_TEXT = {
  modified_externally:
    "ほかの所でこのファイルが書き換えられたため、保存しませんでした（上書きしていません）。",
  conflict_markers: "競合の印（<<<<<<<）があるため、保存しませんでした。",
  unsaved_changes: "保存できませんでした（未保存の変更があります）。",
  encoding_error: "このファイルの文字コードで表せない文字があるため、保存しませんでした。",
  path_conflict: "保存の途中で場所がぶつかったため、保存しませんでした。",
};

/** 開くときに拡張機能が送る `update` と同じ形を作る（用語の色分けは試作では無し） */
function buildUpdate(fileName, text, saved) {
  const colors = memoColorVars(false);
  for (const [kind, pair] of Object.entries(TERM_COLORS)) colors[kind] = pair.light;
  return {
    type: "update",
    text,
    noteLike: false,
    notation: notationModeFor(fileName),
    copyEmphasis: copyEmphasisFor([]),
    marks: renderTermMarks(text),
    terms: [],
    hasTerms: false,
    colors,
    fontFamily: "",
    markFontFamily: markFontFor("", ""),
    readAloudRate: 1,
    initialAppearance: resolveInitialAppearance({
      saved: saved && typeof saved === "object" ? saved : undefined,
      verticalDefault: true,
    }),
  };
}

/**
 * 原稿エディターの画面に、VS Code の代わりを差し込む。
 *
 * - CSP に `connect-src 'self'` を足す（元は `default-src 'none'` で、読み書き役へ
 *   問い合わせられない）
 * - 画面のスクリプトより**前に**代役（acquireVsCodeApi）を置く
 */
function buildPage() {
  const nonce = randomBytes(16).toString("hex");
  let html = buildManuscriptEditorHtml(nonce, "'self'");
  const csp = "default-src 'none';";
  if (!html.includes(csp)) throw new Error("原稿エディターの CSP の形が変わっています（desk/server.mjs を直す）");
  html = html.replace(csp, "default-src 'none'; connect-src 'self';");
  const mainScript = `<script nonce="${nonce}">`;
  const at = html.indexOf(mainScript);
  if (at < 0) throw new Error("原稿エディターのスクリプトが見つかりません（desk/server.mjs を直す）");
  html = html.slice(0, at) + DESK_PAGE_SHIM.replace(/__NONCE__/g, nonce) + html.slice(at);
  return html.replace(/<body([^>]*)>/, `<body$1>\n<div id="desk-strip"></div>`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error("大きすぎます");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function startDeskServer(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  if (!args.work || !(await isDirectory(args.work))) {
    throw new Error("作品フォルダーを --work で渡してください（見つかりません: " + args.work + "）");
  }
  const workRoot = nodePath.resolve(args.work);
  /** 開いた話ごとの「読み込んだときの形」。保存のハッシュ照合に使う */
  const opened = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      /*
        **ほかのサイトからの呼び出しを断る。** localhost で待ち受けていても、
        ブラウザで開いた別のページが手元へ送ることはできる。Host と Origin が
        この読み書き役自身であること、書き込みは JSON で来ること（別サイトから
        JSON を送ると事前確認が要り、こちらは許可を返さない）を確かめる。
      */
      const host = String(request.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(response, 403, { error: "host" });
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) return send(response, 403, { error: "origin" });
      const url = new URL(request.url ?? "/", `http://${host}`);

      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(buildPage());
        return;
      }
      if (request.method !== "POST" || !String(request.headers["content-type"] ?? "").startsWith("application/json")) {
        return send(response, 404, { error: "not found" });
      }
      const body = await readJson(request);

      if (url.pathname === "/api/episodes") {
        return send(response, 200, { work: nodePath.basename(workRoot), episodes: await listEpisodes(workRoot) });
      }

      if (url.pathname === "/api/open") {
        const full = resolveInside(workRoot, body.file);
        if (!full) return send(response, 400, { error: "作品フォルダーの中の .txt / .md だけを開けます" });
        const content = decodeBytes(new Uint8Array(await fs.readFile(full)));
        opened.set(full, content);
        return send(response, 200, {
          update: buildUpdate(full, toLf(content.text), body.saved),
          encoding: content.encoding,
          eol: content.eol,
          // 競合の印のあるファイルは、開くだけで書かない
          readOnly: content.hasConflictMarkers,
        });
      }

      if (url.pathname === "/api/save") {
        const full = resolveInside(workRoot, body.file);
        const original = full ? opened.get(full) : undefined;
        if (!full || !original) return send(response, 400, { ok: false, message: "先に開いてください" });
        if (typeof body.text !== "string") return send(response, 400, { ok: false, message: "本文がありません" });
        if (original.hasConflictMarkers) {
          return send(response, 409, { ok: false, reason: "conflict_markers", message: SAVE_FAILURE_TEXT.conflict_markers });
        }
        const result = await writeTextFilePreservingFormat(full, body.text, original, original.hash);
        if (!result.ok) {
          console.error(`[desk] 保存しませんでした: ${body.file} (${result.reason}) ${result.detail ?? ""}`);
          return send(response, 409, {
            ok: false,
            reason: result.reason,
            message: SAVE_FAILURE_TEXT[result.reason] ?? "保存できませんでした。",
          });
        }
        // 次の保存の照合は、いま書いた内容に対して行う
        opened.set(full, decodeBytes(new Uint8Array(await fs.readFile(full))));
        console.log(`[desk] 保存しました: ${body.file}`);
        return send(response, 200, { ok: true });
      }

      if (url.pathname === "/api/log") {
        console.log("[desk:画面]", JSON.stringify(body).slice(0, 2000));
        return send(response, 200, { ok: true });
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      console.error("[desk]", error);
      return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  console.log(`[desk] 原稿エディター http://127.0.0.1:${port}/  作品: ${workRoot}`);
  return { server, port };
}
