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
  "この拡張機能（`dist/extension.js`・`dist/browser-extension.js`・`dist/mcp-server.mjs`・`dist/lame.js`）には、次のライブラリが組み込まれています。",
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
  const lgpl = /^LGPL-/i.test(entry.license ?? "");
  parts.push(
    `## ${entry.name} ${entry.version}`,
    "",
    `- ライセンス: ${entry.license ?? "（package.json に記載なし）"}`,
    ...(entry.homepage ? [`- 配布元: ${entry.homepage}`] : []),
    ...(lgpl ? [`- 入っている束: ${entry.bundles.join("・")}（拡張機能の束とは別のファイル）`] : []),
    "",
    "```",
    body,
    "```",
    "",
    ...(lgpl ? lgplNote(entry) : []),
    "---",
    ""
  );
}

/*
  **LGPL の部品は、条件の全文が LICENSE ファイルに無い**ことがある（`@breezystack/lamejs` の
  LICENSE は LAME の「商用で使えますか」の問答だけ）。LGPL-3.0 は GPL-3.0 を下敷きにして
  条件を足す形なので、**両方の全文**を添える（GNU の公式の文。`scripts/licenses/`）。
  あわせて、別のファイルとして配っていること・ソースの在り処・差し替え方を書く
  （LGPL-3.0 第4条。LAME も「別のファイルとして結んで使う」形を勧めている）。
*/
const LGPL_TEXTS = [
  ["GNU LESSER GENERAL PUBLIC LICENSE Version 3", "LGPL-3.0.txt"],
  ["GNU GENERAL PUBLIC LICENSE Version 3", "GPL-3.0.txt"],
];

function lgplNote(entry) {
  return [
    "この部品について：",
    "",
    `- 拡張機能の束（\`dist/extension.js\`）には混ぜず、別のファイル（${entry.bundles.map((b) => `\`${b}\``).join("・")}）のまま、改変せずに束ねて配っています。音声に書き出すときだけ読み込みます。`,
    "- 部品だけを差し替えたいときは、同じ口（`Mp3Encoder`）を持つ版で、このファイルを置き換えてください。",
    `- 部品のソースは npm の \`${entry.name}@${entry.version}\`${entry.homepage ? `（${entry.homepage}）` : ""}、LAME 本体は https://lame.sourceforge.io/ にあります。`,
    "- この拡張機能そのもののソースは公開しています（MIT）。リポジトリを取り、`npm install` と `npm run build` で束を作り直せます。",
    "",
    "LGPL-3.0 と、その下敷きの GPL-3.0 の全文は、この節の末尾にあります。",
    "",
  ];
}

const lgplPackages = packages.filter((entry) => /^LGPL-/i.test(entry.license ?? ""));
if (lgplPackages.length > 0) {
  parts.push(
    "## LGPL-3.0 と GPL-3.0 の全文",
    "",
    `対象：${lgplPackages.map((entry) => `${entry.name} ${entry.version}`).join("、")}`,
    ""
  );
  for (const [title, file] of LGPL_TEXTS) {
    const text = fs.readFileSync(path.join(root, "scripts", "licenses", file), "utf-8").trim();
    parts.push(`### ${title}`, "", "```", text, "```", "");
  }
  parts.push("---", "");
}

const out = parts.join("\n");
fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), out, "utf-8");
console.log(`${packages.length}件のライセンスを書き出しました（${out.length}文字）`);
for (const entry of packages) {
  console.log(
    `  ${entry.name} ${entry.version}  ${entry.license ?? "?"}  ${entry.bundles.join("・")}`
  );
}
