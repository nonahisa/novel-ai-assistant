// 引継ぎ書の目次を作り直す。
//
//   node scripts/handoverToc.mjs
//
// **目次だけを作り直す。文章には触らない。**
// 元はセッション用の使い捨てスクリプトで、冒頭の「いまの状態」の表ごと
// 組み立て直していた。表の中身（版・テスト数）が書き手の手元で固定されて
// いたため、**走らせるたびに版が 0.6.9 へ巻き戻っていた**。
// 5回分の修正のあいだ気づかれず、引継ぎ書だけが古いままだった。
//
// 文章を機械で組み立てると、直した内容が次の実行で消える。
// 機械が触ってよいのは、機械にしか作れないもの（見出しから作る目次）だけ。
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.join(root, "docs", "進捗と引継ぎ.md");

const raw = fs.readFileSync(DOC, "utf-8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

/**
 * VS Code のプレビューが見出しから作るリンク先と同じ規則。
 * ここがずれると目次のリンクが切れる（`designDocToc.test.ts` が止める）。
 */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(
      /[\]\[\!\/\'\"\#\$\%\&\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\_\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”～‖∶＂＇｀｜〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g,
      ""
    )
    .replace(/\s+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// 目次は章（##）と、8章より前の節（###）だけにする。
// 8章（作業の記録）は節が90以上あり、並べると目次が目次でなくなる
const journalAt = lines.findIndex((line) => /^## 8\. 作業の記録/.test(line));
const seen = new Map();
const toc = [];
let inFence = false;
lines.forEach((line, index) => {
  if (/^```/.test(line)) {
    inFence = !inFence;
    return;
  }
  if (inFence) return;
  const matched = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
  if (!matched) return;
  const level = matched[1].length;
  if (level === 3 && index > journalAt) return;
  // 目次そのものを目次へ入れない
  if (matched[2] === "目次") return;

  const base = slugify(matched[2]);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  const slug = count === 0 ? base : `${base}-${count}`;
  toc.push(`${level === 2 ? "" : "  "}- [${matched[2]}](#${slug})`);
});

const section = [
  "## 目次",
  "",
  "8章（作業の記録）の中の節は、数が多いため目次に載せていません。",
  "",
  ...toc,
  "",
  "---",
  "",
];

// 既にある目次だけを差し替える。前後の文章はそのまま
const at = lines.findIndex((line) => line === "## 目次");
if (at < 0) {
  throw new Error(
    "「## 目次」が見つかりません。置き場所は手で決めてください（このスクリプトは差し替えだけを行います）。"
  );
}
const end = lines.findIndex((line, index) => index > at && /^## /.test(line));
if (end < 0) throw new Error("目次の終わりが見つかりません。");

const out = [...lines.slice(0, at), ...section, ...lines.slice(end)];
fs.writeFileSync(DOC, out.join(eol), "utf-8");

console.log(`目次 ${toc.length}件を作り直しました（全体 ${out.length}行）`);
