// 手元で試すための VSIX を、リリース検査を通さずに作る。
//
//   build-vsix.bat をダブルクリック（または npm run vsix:local）
//
// **配布用ではない。** `npm run package:vsix` は全リリースゲート
// （型検査・単体・結合テスト2版・ブラウザ版テスト・audit）を通すので重い。
// 「ちょっと直したのを入れて試す」にはそこまで要らないため、
// 依存の確認とビルド・梱包だけを行う。
//
// **出力は release/local/ に、名前に -local を付けて置く。**
// 配布用（release/novel-ai-assistant-<版>.vsix）と同じ名前にすると、
// 検査を通していない VSIX を Release へ取り違えて上げかねないため。
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { deriveReleaseMetadata } from "./releaseSupport.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const startedAt = Date.now();

function fail(stage, detail) {
  console.error("");
  console.error(`【止まりました】${stage}`);
  if (detail) console.error(detail);
  process.exit(1);
}

// --- 1. 依存の確認 ---------------------------------------------------------
// 2台の機械で書いていると、片方だけ依存が古いことがある（checkDeps.mjs の冒頭）。
// 揃っていなければ `npm ci` で lock どおりに入れ直す。`npm install` にしないのは、
// package-lock.json を書き換えて作業ツリーを汚さないため。
function dependenciesReady() {
  if (!existsSync(path.join(repositoryRoot, "node_modules"))) return false;
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "checkDeps.mjs")],
    { cwd: repositoryRoot, stdio: "ignore" }
  );
  return result.status === 0;
}

console.log("[1/2] 依存を確かめています…");
if (dependenciesReady()) {
  console.log("      揃っています。");
} else {
  console.log("      揃っていないので npm ci で入れ直します（初回は数分かかります）。");
  // Windows の npm は npm.cmd なので shell を通す。引数は固定の文字列だけ。
  const install = spawnSync("npm ci", {
    cwd: repositoryRoot,
    shell: true,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    fail(
      "依存の入れ直し（npm ci）に失敗しました。",
      "ネットにつながっているか、VS Code や別の端末が node_modules の中のファイルを掴んでいないかを確かめてください。"
    );
  }
}

// --- 2. ビルドと梱包 -------------------------------------------------------
// vsce が vscode:prepublish（= npm run build、本番ビルド）を自分で走らせるので、
// ここでビルドを別に呼ばない（呼ぶと2回ビルドすることになる）。
const { rootManifest } = await deriveReleaseMetadata(repositoryRoot);
const outputDirectory = path.join(repositoryRoot, "release", "local");
const outputPath = path.join(
  outputDirectory,
  `${rootManifest.name}-${rootManifest.version}-local.vsix`
);

console.log("[2/2] ビルドして VSIX にまとめています…");
await mkdir(outputDirectory, { recursive: true });
try {
  const require = createRequire(import.meta.url);
  const { createVSIX } = require("@vscode/vsce/out/api");
  await createVSIX({
    cwd: repositoryRoot,
    packagePath: outputPath,
    allowMissingRepository: true,
  });
} catch (error) {
  fail(
    "ビルドまたは VSIX へのまとめに失敗しました。",
    error instanceof Error ? error.message : String(error)
  );
}

// --- 終わりの案内 ----------------------------------------------------------
const sizeMb = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
const seconds = Math.round((Date.now() - startedAt) / 1000);
console.log("");
console.log(`できました（${seconds}秒）：版 ${rootManifest.version}、${sizeMb} MB`);
console.log(`  ${outputPath}`);
console.log("");
console.log("VS Code へ入れるには、次のどちらかで：");
console.log(`  code --install-extension "${outputPath}" --force`);
console.log("  拡張機能ビュー右上の「…」→「VSIXからのインストール」でこのファイルを選ぶ");
console.log("入れたあと、VS Code のウィンドウを再読み込みすると新しい版で動きます。");
console.log("");
console.log("※ これは手元で試すための VSIX です。リリース検査は通していません。");
console.log("   配布するときは npm run package:vsix を使ってください。");
