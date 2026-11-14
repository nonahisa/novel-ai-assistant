// Marketplace 用のアイコン（PNG）と、アクティビティバーのアイコン（SVG）を置く。
//
//   node scripts/buildIcon.mjs
//
// **1.0.0 から、絵の元は `docs/assets/icon-1.0.0/`**（共通アイコン。作者の依頼 2026-10-18、
// 切り替えは 1.0.0 を出すとき）。統合小説執筆環境・ヘルパー・Discord で同じ絵を使う。
//
// - `media/icon.png` ← `icon-256.png`（色つき。Marketplace の下限は128px）
// - `media/icon.svg` ← `icon-mono.svg`（1色・塗りだけ。VS Code がテーマの色で塗り直す。
//   決まりは test/unit/cross/icon.test.ts）
//
// 0.x までは `media/icon.svg` から PNG を自前で塗っていたが、色つきの絵は1色の SVG から
// 起こせないので、作り直さずに写す。**絵を直すときは `docs/assets/icon-1.0.0/` の元を直してから
// これを走らせる**（2つの置き場の絵がずれないように）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "docs", "assets", "icon-1.0.0");

const copies = [
  ["icon-256.png", path.join("media", "icon.png")],
  ["icon-mono.svg", path.join("media", "icon.svg")],
];

for (const [from, to] of copies) {
  fs.copyFileSync(path.join(source, from), path.join(root, to));
  console.log(`${to} ← docs/assets/icon-1.0.0/${from}`);
}
