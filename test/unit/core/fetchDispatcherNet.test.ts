import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import {
  LOCAL_PROVIDER_IDS,
  isLocalProviderId,
} from "../../../src/core/localProviders";

/**
 * **AIを呼ぶ道が、どちらの口で投げているか**を留める網（設計書6.63。2026-09-23）。
 *
 * ## なぜ網が要るか
 *
 * Node の通信部品（undici）は「応答の頭を待つ上限」を既定300秒で持つ。
 * `fetchTimeouts.ts` がこちらの待ち時間で待ち受け役（dispatcher）を作るが、
 * **VS Code が差し替えた `globalThis.fetch` は、渡した役を捨てる**
 * （1.138 で実測。`createFetchPatch` が自前の Agent に置き換える）。
 *
 * 前の網は「dispatcher を渡しているか」を字面で見ており、**それで通ったのに
 * 実物では効かなかった**——渡してはいたのである。捨てられていただけで。
 * だからこの網は「どの口で投げているか」を見る。
 *
 * - **手元のAI（Ollama・LM Studio）は `localFetch`**（npm の undici で直接投げる）
 * - **クラウドのAIは `cloudFetch`**（`globalThis.fetch`。プロキシと証明書を保つ）
 * - 素の `fetch` は、口そのもの（`fetchTimeouts.ts`）と、短い呼び出しだけ
 *
 * **網は口の選び方しか見ない。** その口が本当に差し替えを避けて待ち時間を
 * 効かせるかは、`localFetchBypassesPatch.test.ts` が偽の差し替えと本物の
 * HTTP サーバーで見る。
 *
 * ## 何を許すか
 *
 * 起動確認・モデル一覧（`/api/tags`・`/api/show`・`/models`・`/`）は
 * 短い呼び出しで300秒に当たらないので、素の `fetch` でよい。
 * **それ以外（宛先が変数で決まるものを含む）は口を通す。** 宛先が
 * `${path}` のような変数だと、生成の口へ投げているかを字面で決められない
 * ——決められないものは危ない側に倒す。
 */

const ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIRS = ["src/ai", "src/mcp"];

/** 口そのもの。ここだけは素の fetch を持ってよい */
const GATE_FILE = "src/ai/fetchTimeouts.ts";
/** 口を選ぶ部品。`local` の印で2つの口を振り分ける */
const JSON_CLIENT_FILE = "src/ai/httpClient.ts";

/**
 * 手元のAIを呼ぶファイル。**`localFetch` を直接呼ぶ**か、
 * **`fetchJson` に必ず `local: true` を付ける**かのどちらか。
 */
const LOCAL_FILES = new Set([
  "src/ai/ollamaProvider.ts",
  "src/ai/ollamaEmbedding.ts",
  "src/ai/lmstudioProvider.ts",
  "src/mcp/tools/ollama.ts",
]);

/** クラウドのAIを呼ぶファイル。`localFetch` も `local: true` も使わない */
const CLOUD_FILES = new Set([
  "src/ai/claudeProvider.ts",
  "src/ai/geminiProvider.ts",
  "src/ai/openaiProvider.ts",
  "src/ai/sakuraProvider.ts",
]);

/** 短い呼び出しと分かる宛先。1つ目の引数の字面がこれに当たれば見逃す */
const SHORT_ENDPOINTS: RegExp[] = [
  /\/api\/tags[`"']/,
  /\/api\/show[`"']/,
  /\/models[`"']/,
  // 読み込み中のモデルを聞くだけ（手元のAIの負荷の見張り。設計書6.76.2）
  /\/api\/ps[`"']/,
  // 手元のAIが起きているかを根元へ聞くだけ（otherLocalAi.ts）
  /new URL\(\s*"\/"\s*,/,
];

interface CallSite {
  file: string;
  where: string;
  target: string;
}

interface FetchJsonSite extends CallSite {
  /** `local: true` を字面で付けているか */
  local: boolean;
}

interface Scan {
  bareFetch: CallSite[];
  localFetch: CallSite[];
  cloudFetch: CallSite[];
  fetchJson: FetchJsonSite[];
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

/** 呼んでいる関数の名前（識別子のときだけ）。`this.fetchJson` は拾わない */
function calleeName(expr: ts.Expression): string | undefined {
  return ts.isIdentifier(expr) ? expr.text : undefined;
}

/**
 * `fetchJson({ ... })` の引数に `local: true` があるか。
 * **コメントは見ない**（ASTの上で見るので、注釈に書いただけでは通らない）。
 */
function hasLocalTrue(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  let inner: ts.Expression = arg;
  while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  if (!ts.isObjectLiteralExpression(inner)) return false;
  return inner.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "local" &&
      p.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

function scan(): Scan {
  const result: Scan = { bareFetch: [], localFetch: [], cloudFetch: [], fetchJson: [] };
  for (const dir of SCAN_DIRS) {
    for (const full of listTsFiles(path.join(ROOT, dir))) {
      const text = fs.readFileSync(full, "utf8");
      const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
      const file = path.relative(ROOT, full).split(path.sep).join("/");
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const site: CallSite = {
            file,
            where: `${file}:${line}`,
            target: node.arguments[0]?.getText(source) ?? "",
          };
          const name = calleeName(node.expression);
          if (isBareFetch(node.expression)) result.bareFetch.push(site);
          else if (name === "localFetch") result.localFetch.push(site);
          else if (name === "cloudFetch") result.cloudFetch.push(site);
          else if (name === "fetchJson") {
            result.fetchJson.push({ ...site, local: hasLocalTrue(node.arguments[0]) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return result;
}

describe("AIを呼ぶ道は、手元なら localFetch、クラウドなら cloudFetch で投げる", () => {
  const sites = scan();

  test("網そのものが呼び出しを拾えている（空振りで満点にしない）", () => {
    // 拾えなくなったら、この網は何も見ていないことになる
    const files = (list: CallSite[]) => new Set(list.map((s) => s.file));
    expect(files(sites.localFetch)).toEqual(
      new Set(["src/ai/ollamaProvider.ts", "src/ai/ollamaEmbedding.ts", "src/mcp/tools/ollama.ts"])
    );
    // `fetchJson` は `local` の印で2つの口を振り分ける（呼び出しではなく値として選ぶ）
    const client = fs.readFileSync(path.join(ROOT, JSON_CLIENT_FILE), "utf8");
    expect(client).toMatch(/request\.local\s*\?\s*localFetch\s*:\s*cloudFetch/);
    expect(sites.fetchJson.some((s) => s.file === "src/ai/lmstudioProvider.ts")).toBe(true);
    expect(sites.fetchJson.some((s) => s.file === "src/ai/geminiProvider.ts")).toBe(true);
  });

  test("素の fetch は、口そのものと短い呼び出しだけ", () => {
    const offenders = sites.bareFetch
      .filter((s) => s.file !== GATE_FILE)
      .filter((s) => !SHORT_ENDPOINTS.some((re) => re.test(s.target)))
      .map((s) => `${s.where}  ${s.target}`);
    expect(offenders).toEqual([]);
  });

  test("口を使うファイルは、手元かクラウドかがどちらかに決まっている", () => {
    // 新しいAIを足したら、どちらの口で投げるかをここで決めさせる
    const users = new Set(
      [...sites.localFetch, ...sites.cloudFetch, ...sites.fetchJson]
        .map((s) => s.file)
        .filter((f) => f !== JSON_CLIENT_FILE)
    );
    const unclassified = [...users].filter((f) => !LOCAL_FILES.has(f) && !CLOUD_FILES.has(f));
    expect(unclassified).toEqual([]);
  });

  test("手元のAIは、VS Code の差し替えた fetch を通さない", () => {
    const offenders = [
      ...sites.cloudFetch.filter((s) => LOCAL_FILES.has(s.file)).map((s) => `${s.where} cloudFetch`),
      ...sites.fetchJson
        .filter((s) => LOCAL_FILES.has(s.file) && !s.local)
        .map((s) => `${s.where} fetchJson に local: true が無い`),
    ];
    expect(offenders).toEqual([]);
  });

  test("クラウドのAIは、手元の口を使わない（プロキシと社内証明書を失う）", () => {
    const offenders = [
      ...sites.localFetch.filter((s) => CLOUD_FILES.has(s.file)).map((s) => `${s.where} localFetch`),
      ...sites.fetchJson
        .filter((s) => CLOUD_FILES.has(s.file) && s.local)
        .map((s) => `${s.where} fetchJson に local: true`),
    ];
    expect(offenders).toEqual([]);
  });

  /**
   * **手元・クラウドの一覧は、ここの分けと `core/localProviders.ts` で一致する**
   * （作者の裁定、2026-09-23）。
   *
   * 待ち時間の上限（手元1800秒・クラウド600秒）は `core/localProviders.ts` の
   * 一覧で分ける。通信の口はこの網のファイル分けで決まる。**2つが食い違うと、
   * 手元の口で投げているのにクラウドの上限で切る（あるいはその逆）**ことになる。
   * プロバイダのファイル（`src/ai/<ID>Provider.ts`）で突き合わせる。
   */
  test("手元のプロバイダの一覧は、口の分けと一致する", () => {
    const providerIdOf = (file: string): string | undefined =>
      /^src\/ai\/(\w+)Provider\.ts$/.exec(file)?.[1];
    const localIds = [...LOCAL_FILES].map(providerIdOf).filter(
      (id): id is string => id !== undefined
    );
    const cloudIds = [...CLOUD_FILES].map(providerIdOf).filter(
      (id): id is string => id !== undefined
    );
    expect(new Set(localIds)).toEqual(new Set(LOCAL_PROVIDER_IDS));
    expect(cloudIds.filter((id) => isLocalProviderId(id))).toEqual([]);
    // 網のほうが空振りしていないこと（どちらも1つ以上ある）
    expect(localIds.length).toBeGreaterThan(0);
    expect(cloudIds.length).toBeGreaterThan(0);
  });

  test("口を使うファイルは、fetchTimeouts の部品から取っている", () => {
    // 自前で undici を静的 import すると、ブラウザ版が起動の瞬間に落ちる（規則7）
    const files = new Set([...sites.localFetch, ...sites.cloudFetch].map((s) => s.file));
    const missing = [...files].filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      return !/import\s*\{[^}]*\b(localFetch|cloudFetch)\b[^}]*\}\s*from\s*"[^"]*fetchTimeouts"/.test(
        text
      );
    });
    expect(missing).toEqual([]);
    // undici を静的に読み込んでいるファイルが src に無い
    const staticUndici = listTsFiles(path.join(ROOT, "src")).filter((f) =>
      /^\s*import\s[^;]*from\s*"undici"/m.test(fs.readFileSync(f, "utf8"))
    );
    expect(staticUndici).toEqual([]);
  });
});
