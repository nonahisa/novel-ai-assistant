// 型紙.html の {{IMG:名前}} を img/名前.png の埋め込み（base64）に置き換えて、
// 編集者の校閲手順書.html を作る。幅と高さは PNG の頭（IHDR）から読んで入れ直す。
// 使い方：node build.mjs（このフォルダーで。PDF は pdf.mjs が HTML から作る）
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, "..");
const template = readFileSync(path.join(here, "型紙.html"), "utf8");

let count = 0;
const html = template.replace(/<img src="\{\{IMG:([^}]+)\}\}"([^>]*?) width="\d+" height="\d+"/g, (_all, name, rest) => {
  const bytes = readFileSync(path.join(base, "img", `${name}.png`));
  // PNG の IHDR：幅は 16〜19 バイト目、高さは 20〜23 バイト目（どちらも大きい順の4バイト）
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  count++;
  return `<img src="data:image/png;base64,${bytes.toString("base64")}"${rest} width="${width}" height="${height}"`;
});
if (html.includes("{{IMG:")) throw new Error("置き換わらなかった画像があります");
writeFileSync(path.join(base, "編集者の校閲手順書.html"), html, "utf8");
console.log(`画像 ${count} 枚を埋め込みました`);
