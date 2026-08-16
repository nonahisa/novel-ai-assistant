// VS Code Marketplace へ出す。
//
//   npm run publish:marketplace
//
// **`npm run package:vsix`（GitHub Releases用）とは別に用意する。**
// あちらは publisher が仮のままでも動いてよい。ローカルへ配るVSIXは
// publisher を見ないためで、そこを縛ると今の配布が止まる。
//
// ここは**Marketplaceへ出すときだけ**通る道なので、店に並べるのに
// 足りないものを先に止める。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8")
);

const problems = [];

if (pkg.publisher === "local" || !pkg.publisher) {
  problems.push(
    "publisher が仮のままです。\n" +
      "  1. https://marketplace.visualstudio.com/manage で publisher を作る\n" +
      "  2. package.json の publisher をその名前にする\n" +
      "  （世界で1つしか取れない名前です。あとから変えるには出し直しが要ります）"
  );
}
if (pkg.private) {
  problems.push("package.json の private を消してください（publish を拒みます）。");
}
if (!pkg.icon) {
  problems.push(
    "icon がありません。`node scripts/buildIcon.mjs` でPNGを作ってください。"
  );
}
if (!pkg.repository?.url) {
  problems.push("repository.url がありません（READMEの相対リンクが壊れます）。");
}

// **非公開リポジトリのままだと、READMEのリンクが読者に404になる。**
// 止めはしない（非公開のまま出す判断もありうる）が、必ず知らせる
const warnings = [];
if (pkg.repository?.url?.includes("github.com")) {
  warnings.push(
    "READMEの相対リンク（LICENSE・THIRD-PARTY-NOTICES）は " +
      `${pkg.repository.url.replace(/\.git$/, "")} へ向きます。\n` +
      "  **リポジトリが非公開なら、読者には404になります。**\n" +
      "  公開するか、READMEからリンクを外すか、どちらかを決めてください。"
  );
}

if (problems.length > 0) {
  console.error("\nMarketplace へ出せません。\n");
  for (const problem of problems) console.error(`- ${problem}\n`);
  process.exit(1);
}

for (const warning of warnings) console.warn(`\n⚠ ${warning}\n`);

console.log(
  `${pkg.displayName} ${pkg.version} を ${pkg.publisher} として公開します。\n` +
    "初回は Personal Access Token を訊かれます" +
    "（https://dev.azure.com で作った、Marketplace の Manage 権限のもの）。\n"
);

execFileSync("npx", ["vsce", "publish", "--no-git-tag-version"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
