// 同梱しているライブラリのライセンス表示を作る。
//
//   node scripts/buildThirdPartyNotices.mjs
//
// **要約を書いてはいけない。** MITもBSD-3-Clauseも「著作権表示とライセンス
// 本文をそのまま添えること」を配布の条件にしている。各パッケージの LICENSE を
// そのまま貼る。手で書き写すと、版が上がったときに古い表示が残る。
//
// 対象は、配布する3つの束（dist/extension.js・dist/browser-extension.js・
// dist/mcp-server.mjs）に**実際に組み込まれる部品**（`scripts/bundledPackages.mjs`）。
// 0.96.14 までは `dependencies` だけを見ていて、直接の依存の連れ
// （`base64-js`・`ieee754`・`safer-buffer` など）と、MCP サーバーの束に入る
// SDK の部品が抜けていた。束に入らない開発の道具（TypeScript・vitest・vsce）は
// 配布物に入らないので載せない。
//
// **依存を足したら、これを走らせ直すこと。**
// `test/unit/cross/thirdPartyNotices.test.ts` がずれを止める。
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { collectBundledPackages } from "./bundledPackages.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = await collectBundledPackages();

const parts = [
  "# 同梱しているソフトウェアについて",
  "",
  "この拡張機能（`dist/extension.js`・`dist/browser-extension.js`・`dist/mcp-server.mjs`）には、次のライブラリが組み込まれています。",
  "著作権はそれぞれの権利者に属し、以下のライセンスの条件で配布しています。",
  "",
  "拡張機能そのもののライセンスは [LICENSE](LICENSE)（MIT）です。",
  "**作者が書いた小説・プロット・設定資料には、これらは一切関係しません。**",
  "",
  "> このファイルは `node scripts/buildThirdPartyNotices.mjs` が作ります。",
  "> 手で書き換えず、依存を足したら走らせ直してください。",
  "",
  "---",
  "",
];

for (const entry of packages) {
  const dir = path.join(root, entry.dir);
  const licenseFile = fs
    .readdirSync(dir)
    .find((name) => /^licen[cs]e/i.test(name));
  if (!licenseFile) {
    throw new Error(
      `${entry.name} ${entry.version}（${entry.dir}）に LICENSE ファイルがありません。` +
        "手で確かめて追記してください。"
    );
  }

  const body = fs.readFileSync(path.join(dir, licenseFile), "utf-8").trim();
  parts.push(
    `## ${entry.name} ${entry.version}`,
    "",
    `- ライセンス: ${entry.license ?? "（package.json に記載なし）"}`,
    ...(entry.homepage ? [`- 配布元: ${entry.homepage}`] : []),
    "",
    "```",
    body,
    "```",
    "",
    "---",
    ""
  );
}

const out = parts.join("\n");
fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), out, "utf-8");
console.log(`${packages.length}件のライセンスを書き出しました（${out.length}文字）`);
for (const entry of packages) {
  console.log(
    `  ${entry.name} ${entry.version}  ${entry.license ?? "?"}  ${entry.bundles.join("・")}`
  );
}
