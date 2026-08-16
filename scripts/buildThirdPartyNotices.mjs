// 同梱しているライブラリのライセンス表示を作る。
//
//   node scripts/buildThirdPartyNotices.mjs
//
// **要約を書いてはいけない。** MITもBSD-3-Clauseも「著作権表示とライセンス
// 本文をそのまま添えること」を配布の条件にしている。各パッケージの LICENSE を
// そのまま貼る。手で書き写すと、版が上がったときに古い表示が残る。
//
// 対象は `dependencies` だけ。これらは esbuild が `dist/extension.js` へ
// **束ねて**配布する。devDependencies（TypeScript・vitest など）は
// 配布物に入らないので要らない。
//
// **依存を足したら、これを走らせ直すこと。**
// `test/unit/thirdPartyNotices.test.ts` がずれを止める。
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8")
);
const names = Object.keys(pkg.dependencies ?? {}).sort();

const parts = [
  "# 同梱しているソフトウェアについて",
  "",
  "この拡張機能（`dist/extension.js`）には、次のライブラリが組み込まれています。",
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

for (const name of names) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf-8")
  );
  const licenseFile = fs
    .readdirSync(dir)
    .find((entry) => /^licen[cs]e/i.test(entry));
  if (!licenseFile) {
    throw new Error(
      `${name} に LICENSE ファイルがありません。手で確かめて追記してください。`
    );
  }

  const body = fs.readFileSync(path.join(dir, licenseFile), "utf-8").trim();
  parts.push(
    `## ${meta.name} ${meta.version}`,
    "",
    `- ライセンス: ${meta.license ?? "（package.json に記載なし）"}`,
    ...(meta.homepage ? [`- 配布元: ${meta.homepage}`] : []),
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
console.log(`${names.length}件のライセンスを書き出しました（${out.length}文字）`);
