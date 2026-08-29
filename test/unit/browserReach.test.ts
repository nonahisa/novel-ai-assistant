import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * ブラウザ版で起動した瞬間に落ちる形になっていないか（設計書5.8、CLAUDE.md 規則7）。
 *
 * **「ビルドが通った」は「動く」ではない。** `esbuild.js` はブラウザ束で
 * `node:child_process` などを `external` に指定しているので、**静的 import が
 * 残っていてもビルドは通る**。`external` は「実行時まで解決を遅らせる」
 * 指定であって、import を消すものではない。
 *
 * 実際に一度これで済ませかけた（引継ぎ書の「繰り返し起きた失敗」6）。
 * **静的 import は呼ばれなくても実行される**ので、Node専用のファイルへ
 * 静的に届いていると、ブラウザでは拡張機能が読み込まれた瞬間に落ちる。
 *
 * そこで CLAUDE.md が「確かめ方」として書いている手順——`extension.ts` から
 * **静的 import だけを**たどって Node専用へ届かないこと——をここで自動化する。
 * 動的 import（`await import("./x.js")`）は `canRunProcesses()` で守られた
 * 正しい道なので、たどらない。
 */

const SRC = path.join(__dirname, "..", "..", "src");
const ENTRY = path.join(SRC, "extension.ts");

/**
 * 静的な `import` 文だけを拾う。
 *
 * - 行頭の `import` に限る（`await import(...)` は行の途中なので当たらない）
 * - `import type` は実行時に消えるので除く
 */
const STATIC_IMPORT =
  /^import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm;

/** ブラウザに無いもの。`paths.ts` の `path` だけは差し替えられる（`esbuild.js`） */
const NODE_ONLY = /^node:|^(child_process|fs|os|crypto|worker_threads)$/;

interface Reached {
  files: Set<string>;
  nodeImports: string[];
}

function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  // 動的 import は `.js` を付ける決まりなので、落としてから探す
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** `extension.ts` から静的 import だけをたどる */
function walkStaticImports(): Reached {
  const files = new Set<string>();
  const nodeImports: string[] = [];
  const queue = [ENTRY];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);

    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const spec = match[2] ?? match[3];
      if (!spec) continue;
      if (NODE_ONLY.test(spec)) {
        nodeImports.push(`${path.relative(SRC, file)} -> ${spec}`);
        continue;
      }
      const next = resolveImport(file, spec);
      if (next) queue.push(next);
    }
  }
  return { files, nodeImports };
}

function relativeNames(files: Set<string>): string[] {
  return [...files].map((file) => path.relative(SRC, file).replace(/\\/g, "/"));
}

describe("ブラウザ版で起動した瞬間に落ちないか", () => {
  const reached = walkStaticImports();

  test("Node専用のものへ、静的 import で届いていない", () => {
    // 落ちたら：そのファイルの import を、`canRunProcesses()` で守った
    // 動的 import（`await import("./x.js")`。**`.js` が要る**）へ変える
    expect(reached.nodeImports).toEqual([]);
  });

  test("`path` を直接使っていない（`core/paths` を通す）", () => {
    // ブラウザ上の作品は `vscode-vfs://github/...` にあり、
    // `path.join()` は `//` を潰して別の場所を指す
    const offenders = relativeNames(reached.files).filter((name) => {
      if (name === "core/paths.ts") return false; // ここだけが差し替え先を知る
      const source = fs.readFileSync(path.join(SRC, name), "utf8");
      return /^import\s+[\s\S]*?\s+from\s+["']path["']/m.test(source);
    });
    expect(offenders).toEqual([]);
  });

  test("`vscode.Uri.file()` を直接呼んでいない（`paths.toUri` を通す）", () => {
    const offenders = relativeNames(reached.files).filter((name) => {
      if (name === "core/paths.ts") return false;
      return /vscode\.Uri\.file\(/.test(fs.readFileSync(path.join(SRC, name), "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  test("検査が空振りしていない（実際に多数たどれている）", () => {
    // たどり方が壊れて0件になっても、上の3つは通ってしまう
    expect(reached.files.size).toBeGreaterThan(200);
  });

  test("Node専用のファイルは、静的には到達しない側に居る", () => {
    // 動的 import でしか読まれないことの裏取り。ここに挙げたものが
    // 静的到達に入ってきたら、上の検査より先にこちらで気づける
    const nodeOnlyFiles = [
      "ai/lmstudioLauncher.ts",
      "ai/ollamaLauncher.ts",
      "core/git.ts",
      "core/gitSetup.ts",
      "core/packageInstall.ts",
      "features/selectOllamaExecutable.ts",
    ];
    const names = new Set(relativeNames(reached.files));
    for (const file of nodeOnlyFiles) {
      expect(names.has(file), `${file} が静的に到達している`).toBe(false);
    }
  });
});
