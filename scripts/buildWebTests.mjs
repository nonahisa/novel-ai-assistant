// ブラウザ版の実動テスト（`npm run test:web`）を、1本の束にする。
//
//   node scripts/buildWebTests.mjs
//
// **拡張機能の束と同じ条件で組む**（設計書5.8.13）。`platform: "browser"`・
// `path` の差し替え・Node組み込みの外出しを揃えないと、検査の側だけが
// Nodeの部品を掴んでしまい、**ブラウザでは動かないものが緑になる**。
// ここが `esbuild.js` のブラウザ向けの設定と食い違ったら、両方を直すこと。
//
// 出し先を `dist/` にしているのは、`@vscode/test-web` が
// `extensionDevelopmentPath`（リポジトリの根）の下にある道しか
// 配れないからである（`out/server/workbench.js` が相対パスを作る）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "test", "web", "index.ts");
const outfile = path.join(root, "dist", "web-tests.js");

// **束ねる前に型を見る。** `npm run typecheck` は `src/**` しか見ないので、
// ここで見ないと検査コードの型崩れに誰も気づかない（esbuild は型を見ない）
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    path.join(root, "test", "web", "tsconfig.json"),
  ],
  { cwd: root, stdio: "inherit" }
);

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8")
);

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  // ブラウザの拡張機能ホストは CommonJS の形で読み込む（`dist/browser-extension.js` と同じ）
  format: "cjs",
  platform: "browser",
  sourcemap: true,
  sourcesContent: false,
  outfile,
  external: [
    "vscode",
    // `esbuild.js` の BROWSER_EXTERNAL_BUILTINS と同じ顔ぶれ。
    // 検査が読み込む `src/` の部品が、動的importでこれらに触れることがある
    "os",
    "node:os",
    "node:fs/promises",
    "node:fs",
    "node:path",
    "node:child_process",
    "child_process",
    "undici",
  ],
  alias: { path: "path-browserify" },
  define: {
    // publisher を変えても付いてこられるように、ここで埋める
    __EXTENSION_ID__: JSON.stringify(`${pkg.publisher}.${pkg.name}`),
  },
  logLevel: "info",
});

console.log(`ブラウザ版の検査を束ねました: ${path.relative(root, outfile)}`);
