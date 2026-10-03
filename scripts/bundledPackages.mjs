// 配布する3つの束（dist/extension.js・dist/browser-extension.js・
// dist/mcp-server.mjs）に、実際に組み込まれる部品を集める。
//
// **`package.json` の `dependencies` だけを見てはいけない。** 直接の依存が
// さらに使う部品（`buffer` の `base64-js`・`ieee754`、`iconv-lite` の
// `safer-buffer` など）も束に入り、同じく著作権表示が要る。0.96.14 まで
// それが載っていなかった。MCP サーバーの束は SDK（devDependencies）ごと
// 束ねて配布するので、そちらの部品も入る。
//
// 束に何が入るかは esbuild の metafile が知っている。設定は `esbuild.js` の
// `bundleOptions()` をそのまま使い、写しを作らない。
//
// 使う側：`scripts/buildThirdPartyNotices.mjs`（表示を作る）と
// `test/unit/cross/thirdPartyNotices.test.ts`（抜けを止める）。
import fs from "node:fs";
import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * metafile の入力パスから、部品の置き場（`node_modules/<名前>`）を取り出す。
 *
 * **最後の `node_modules/` を見る。** `node_modules/a/node_modules/b/x.js` は
 * `a` の中に入れ子で置かれた別の版の `b` であり、根の `node_modules/b` とは
 * 版も LICENSE も違いうる。
 */
export function packageDirOf(input) {
  const normalized = input.replace(/\\/g, "/");
  const match = normalized.match(/^(.*node_modules\/)((?:@[^/]+\/)?[^/]+)\//);
  if (!match) return undefined;
  return match[1] + match[2];
}

/**
 * 3つの束に入る部品を、名前と版の順で返す。
 *
 * @returns `{ name, version, license, homepage, dir, bundles }` の配列。
 *   `dir` はリポジトリの根からの相対パス、`bundles` は入っている束の出力先
 */
export async function collectBundledPackages() {
  const esbuild = require(path.join(root, "node_modules", "esbuild"));
  const { bundleOptions } = require(path.join(root, "esbuild.js"));
  const options = bundleOptions();

  /** @type {Map<string, Set<string>>} 部品の置き場 → 入っている束 */
  const found = new Map();
  for (const config of Object.values(options)) {
    const result = await esbuild.build({
      ...config,
      absWorkingDir: root,
      // 書き出さない。入るものを知りたいだけ
      write: false,
      metafile: true,
      logLevel: "silent",
      // 縮めても入る部品は同じなので、速いほうで組む
      minify: false,
      sourcemap: false,
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      const dir = packageDirOf(input);
      if (!dir) continue;
      if (!found.has(dir)) found.set(dir, new Set());
      found.get(dir).add(config.outfile);
    }
  }

  const packages = [...found.entries()].map(([dir, bundles]) => {
    const meta = JSON.parse(
      fs.readFileSync(path.join(root, dir, "package.json"), "utf-8")
    );
    return {
      name: meta.name,
      version: meta.version,
      license: meta.license,
      homepage: meta.homepage,
      dir,
      bundles: [...bundles].sort(),
    };
  });

  // 同じ名前・同じ版が別の置き場にあっても、表示は1つでよい
  const unique = new Map();
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    const existing = unique.get(key);
    if (existing) {
      existing.bundles = [...new Set([...existing.bundles, ...entry.bundles])].sort();
    } else {
      unique.set(key, entry);
    }
  }
  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  );
}
