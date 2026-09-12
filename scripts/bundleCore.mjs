// 外から呼ぶ束（MCP サーバー）を、実際に組めるか確かめる。
//
//   node scripts/bundleCore.mjs
//
// **出す層は `prompts`（プロンプトの組み立て）と `core`（材料の組み立て・検算）
// までで、`features`・`views` は出さない**（設計書6.87.3）。その束に `vscode`
// が混ざると、**Node 単体では読み込んだ瞬間に落ちる。**
//
// `test/unit/mcpReach.test.ts` は静的 import をソースからたどって同じことを
// 見るが、**たどり方の取りこぼしまでは自分で気づけない。** こちらは esbuild に
// 本当に組ませて、**メタファイルの inputs に `vscode` が無い**ことを見る。
// 二重にしているのは、「ビルドが通った」と「届いていない」が別のことだから
// である（CLAUDE.md の「繰り返し起きた失敗」6）。
//
// 出した `dist/core-bundle.mjs` は**確かめるための副産物**で、配布物には
// 入れない（`.vscodeignore`）。版が上がったら束ね直すこと（6.87.6）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModules } from "node:module";
import esbuild from "esbuild";
import { allEntryFiles } from "./coreEntries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const outfile = path.join(root, "dist", "core-bundle.mjs");

const entries = allEntryFiles(src);
const missing = entries.filter((file) => !fs.existsSync(file));
if (missing.length > 0) {
  console.error("起点が見つかりません:");
  for (const file of missing) console.error(`  ${path.relative(root, file)}`);
  process.exit(1);
}

/**
 * 入口を1つにまとめる。
 *
 * esbuild は**起点が複数あると出し先をフォルダにしろと言う**ので、
 * 全部を名前空間として取り込む小さな入口をその場で作り、1本にする。
 * `export *` を並べないのは、**同じ名前の輸出がぶつかると黙って
 * 落ちる**ため（どの部品が消えたか分からなくなる）。
 */
function identifierFor(file) {
  return path
    .relative(src, file)
    .replace(/\.ts$/, "")
    .replace(/[\\/]/g, "$")
    .replace(/[^A-Za-z0-9$_]/g, "_");
}

const stdinContents = entries
  .map(
    (file) =>
      `export * as ${identifierFor(file)} from ${JSON.stringify(
        file.replace(/\\/g, "/")
      )};`
  )
  .join("\n");

const result = await esbuild.build({
  stdin: {
    contents: stdinContents,
    resolveDir: root,
    sourcefile: "core-bundle-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  // **何も外に出さない。** `vscode` が混ざっていれば、ここで解決に失敗して
  // 落ちる（`external` に入れると「実行時まで待つ」に化けて気づけない）
  external: [],
  outfile,
  metafile: true,
  sourcemap: false,
  logLevel: "info",
});

const inputs = Object.keys(result.metafile.inputs);
const offenders = inputs.filter((name) => /(^|\/)vscode(\.ts|\.js)?$/.test(name));

/**
 * どの入力からでも `vscode` を import していないか（取りこぼし対策）。
 *
 * **Node 組み込み（`path` など）は外に出たままでよい。** `platform: "node"`
 * では esbuild が自動で外へ出し、Node で走らせる分には解決できる。
 * それ以外が外に出ていたら、束だけでは動かないということなので止める。
 */
const importedVscode = [];
for (const [name, info] of Object.entries(result.metafile.inputs)) {
  for (const imported of info.imports ?? []) {
    if (imported.path === "vscode") {
      importedVscode.push(`${name} -> vscode`);
      continue;
    }
    if (!imported.external) continue;
    const bare = imported.path.replace(/^node:/, "");
    if (!builtinModules.includes(bare)) {
      importedVscode.push(`${name} -> ${imported.path}`);
    }
  }
}

if (offenders.length > 0 || importedVscode.length > 0) {
  console.error("束に `vscode`（または外出しの相手）が混ざっています:");
  for (const name of [...offenders, ...importedVscode]) {
    console.error(`  ${name}`);
  }
  process.exit(1);
}

// **「組めた」は「動く」ではない。** 実際に Node から読み込んで、
// 入口がぜんぶ生えていることまで見る（CLAUDE.md の「繰り返し起きた失敗」6）
const loaded = await import(pathToFileURL(outfile).href);
const grown = entries.map(identifierFor).filter((name) => !loaded[name]);
if (grown.length > 0) {
  console.error("束から生えていない入口があります:");
  for (const name of grown) console.error(`  ${name}`);
  process.exit(1);
}

const bytes = fs.statSync(outfile).size;
console.log(
  `束ねました: ${path.relative(root, outfile)}  ` +
    `入口 ${entries.length} 本 / 取り込んだファイル ${inputs.length} 件 / ${bytes} バイト`
);
