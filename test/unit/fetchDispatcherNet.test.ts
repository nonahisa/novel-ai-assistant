import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * **AIを呼ぶ道が、素の fetch で長い生成を投げていない**ことを留める網
 * （設計書6.63。2026-09-23）。
 *
 * ## なぜ網が要るか
 *
 * Node の通信部品（undici）は「応答の頭を待つ上限」を既定300秒で持つ。
 * 0.29.13 で `fetchTimeouts.ts` の `timeoutDispatcher` を作ってこちらの
 * 待ち時間へ揃えたが、**入れたのは `httpClient.ts` だけだった。**
 * Ollama は自前の `fetch` を持っていて、一度も渡していなかった
 * ——ノートPCの実機で、台帳1800秒・設定900秒なのに約300秒で
 * `UND_ERR_HEADERS_TIMEOUT` になった。
 *
 * 流す道でも同じ。Ollama は本文を読み終えて1字目を出すまで応答の頭を
 * 返さないので、CPUで長い本文を読めば300秒を超える。
 *
 * **新しい fetch が増えるたびに同じ穴が開く**ので、ソースを読んで止める。
 *
 * ## 何を許すか
 *
 * 起動確認・モデル一覧（`/api/tags`・`/api/show`・`/models`・`/`）は
 * 短い呼び出しで300秒に当たらないので、渡さなくてよい。
 * **それ以外（宛先が変数で決まるものを含む）は必ず渡す。** 宛先が
 * `${path}` のような変数だと、生成の口へ投げているかを字面で決められない
 * ——決められないものは危ない側に倒す。
 */

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/ai", "src/mcp"];

/** 短い呼び出しと分かる宛先。1つ目の引数の字面がこれに当たれば見逃す */
const SHORT_ENDPOINTS: RegExp[] = [
  /\/api\/tags[`"']/,
  /\/api\/show[`"']/,
  /\/models[`"']/,
  // 手元のAIが起きているかを根元へ聞くだけ（otherLocalAi.ts）
  /new URL\(\s*"\/"\s*,/,
];

interface FetchSite {
  where: string;
  target: string;
  passesDispatcher: boolean;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `fetch(...)` と `globalThis.fetch(...)` を拾う。`this.fetchJson` などは別物 */
function isBareFetch(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "fetch";
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      expr.name.text === "fetch" &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "globalThis"
    );
  }
  return false;
}

/**
 * 2つ目の引数に `dispatcher` が入っているか。
 * `{ dispatcher }`・`dispatcher: x`・`...(dispatcher ? { dispatcher } : {})`
 * のどれでもよい。**コメントは見ない**（ASTの上で見るので、
 * 注釈に「dispatcher」と書いただけでは通らない）。
 */
function initHasDispatcher(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  let inner: ts.Expression = init;
  // `{ ... } as RequestInit` の形を剥がす
  while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  if (!ts.isObjectLiteralExpression(inner)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "dispatcher"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(inner);
  return found;
}

function collectFetchSites(): FetchSite[] {
  const sites: FetchSite[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of listTsFiles(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isBareFetch(node.expression)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          sites.push({
            where: `${rel}:${line}`,
            target: node.arguments[0]?.getText(source) ?? "",
            passesDispatcher: initHasDispatcher(node.arguments[1]),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return sites;
}

describe("AIを呼ぶ道は、Nodeの待ち時間（既定300秒）をこちらへ揃えて投げる", () => {
  const sites = collectFetchSites();

  test("網そのものが fetch を拾えている（空振りで満点にしない）", () => {
    // 拾えなくなったら、この網は何も見ていないことになる
    expect(sites.some((s) => s.where.startsWith("src/ai/httpClient.ts"))).toBe(true);
    expect(sites.some((s) => s.where.startsWith("src/ai/ollamaProvider.ts"))).toBe(true);
    expect(sites.some((s) => s.where.startsWith("src/mcp/tools/ollama.ts"))).toBe(true);
  });

  test("短い呼び出し以外の fetch は、必ず dispatcher を渡している", () => {
    const offenders = sites
      .filter((s) => !s.passesDispatcher)
      .filter((s) => !SHORT_ENDPOINTS.some((re) => re.test(s.target)))
      .map((s) => `${s.where}  ${s.target}`);
    expect(offenders).toEqual([]);
  });

  test("dispatcher を渡すファイルは、fetchTimeouts の部品から取っている", () => {
    // 自前で undici を静的 import すると、ブラウザ版が起動の瞬間に落ちる（規則7）
    const files = new Set(
      sites.filter((s) => s.passesDispatcher).map((s) => s.where.replace(/:\d+$/, ""))
    );
    const missing = [...files].filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      return !/import\s*\{[^}]*\btimeoutDispatcher\b[^}]*\}\s*from\s*"[^"]*fetchTimeouts"/.test(
        text
      );
    });
    expect(missing).toEqual([]);
  });
});
