// node_modules が package-lock.json と揃っているかを見る。
//
//   node scripts/checkDeps.mjs
//
// **2台で書いていると、片方だけ依存が入っていない状態になる。**
// 2026-09-11 に実際に起きた：`fflate` を一方の機械で足したあと、
// もう一方で `npm install` が走っていなかった。`build:dev` は
// 「Could not resolve "fflate"」で止まっていたが、F5 は
// `debug.onTaskErrors: debugAnyway` のせいで黙って起動し、
// **9日前のバンドルで動き続けた**（引継ぎ書の記録237）。
//
// **単体テストでは見つからない。** テストは `src/` を直接読むので、
// 依存が無くても緑になる。落ちるのはビルドだけで、
// そのビルドが黙って飛ばされていた。
//
// **ここでは「入っているか」と「版が lock と同じか」だけを見る。**
// 範囲（`^0.8.3`）の解釈はしない——`npm install` が決めた答えが
// `package-lock.json` に書いてあるので、それと突き合わせれば足りる。
// 範囲を自前で解釈すると、semver の実装を1つ増やすことになる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));

const pkg = read("package.json");
const modules = path.join(root, "node_modules");

if (!fs.existsSync(modules)) {
  console.error("node_modules がありません。`npm install` を実行してください。");
  process.exit(1);
}

let lock;
try {
  lock = read("package-lock.json");
} catch {
  // lock が無いリポジトリもありうる。そのときは「入っているか」だけ見る
  lock = { packages: {} };
}

/** lock が「この版を入れた」と言っている版。分からなければ undefined */
function lockedVersion(name) {
  return lock.packages?.[`node_modules/${name}`]?.version;
}

/** 実際に入っている版。入っていなければ undefined */
function installedVersion(name) {
  try {
    const manifest = path.join(modules, ...name.split("/"), "package.json");
    return JSON.parse(fs.readFileSync(manifest, "utf-8")).version;
  } catch {
    return undefined;
  }
}

const wanted = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};

const missing = [];
const mismatched = [];

for (const name of Object.keys(wanted).sort()) {
  const installed = installedVersion(name);
  if (installed === undefined) {
    missing.push(name);
    continue;
  }
  const locked = lockedVersion(name);
  // lock に無いものは突き合わせない（入っていることは確かめた）
  if (locked !== undefined && locked !== installed) {
    mismatched.push({ name, locked, installed });
  }
}

if (missing.length === 0 && mismatched.length === 0) {
  process.exit(0);
}

console.error("依存が package-lock.json と揃っていません。");
console.error("");
if (missing.length > 0) {
  console.error(`  入っていないもの（${missing.length}件）`);
  for (const name of missing) {
    console.error(`    ${name}  （欲しい版: ${wanted[name]}）`);
  }
}
if (mismatched.length > 0) {
  console.error(`  版が違うもの（${mismatched.length}件）`);
  for (const item of mismatched) {
    console.error(
      `    ${item.name}  lock: ${item.locked} / 入っている: ${item.installed}`
    );
  }
}
console.error("");
console.error("  **`npm install` を実行してください。**");
console.error(
  "  2台で書いていると、片方だけ依存が入っていない状態になります"
);
console.error("  （git pull のあと package-lock.json が変わっていたら、install が要ります）。");
process.exit(1);
