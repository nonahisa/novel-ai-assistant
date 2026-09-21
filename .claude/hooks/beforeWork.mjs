/**
 * 長く離れたあと、作業を再開する前に取りこぼしを拾う（作者の指示、2026-09-21）。
 *
 * ## なぜ `SessionStart` だけでは足りないのか
 *
 * `SessionStart` は Claude Code のセッションが始まるときにしか走らない。
 * **PC をスリープから起こしても走らない。** セッションは続いているからである。
 *
 * > 前日のセッションを開いたまま PC をスリープ → その間にノートで作業して push
 * > → 翌朝スリープから起こして続きを始める → **取りこぼしたまま書き始める**
 *
 * **ノート側の記録ほど、取りに行かないと意味がないものは無い。**
 * 実機確認の結果を取りこぼすと、こちらは「まだ未確認」と思って
 * **同じ項目をもう一度作者へ頼む**ことになる。
 *
 * ## 毎回は走らせない
 *
 * ツールを使うたびに `git pull` を掛けたら、作業が目に見えて遅くなる。
 * **前回から30分空いたときだけ**取りに行く。それ未満なら、時計を1つ読んで即座に戻る。
 *
 * 時計の置き場は `.git/` の中。**追跡されない場所**なので、
 * `.gitignore` を足す必要も、作者の差分に出ることもない。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** これだけ空いたら取りに行く */
const QUIET_MS = 30 * 60 * 1000;

function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    }).trim();
  } catch {
    return "";
  }
}

const gitDir = git("rev-parse", "--git-dir");
if (!gitDir) process.exit(0);

const stamp = path.join(gitDir, "novelai-last-pull");

let last = 0;
try {
  last = Number(fs.readFileSync(stamp, "utf8")) || 0;
} catch {
  // まだ無い＝初回。取りに行く
}

const now = Date.now();
if (now - last < QUIET_MS) process.exit(0);

// **先に時刻を書く。** pull が長引いても、その間に何度も走らせない
try {
  fs.writeFileSync(stamp, String(now));
} catch {
  // 書けなくても取りに行く。次も取りに行くだけで、害は無い
}

const before = git("rev-parse", "HEAD");
git("pull", "--ff-only");
const after = git("rev-parse", "HEAD");

if (before && after && before !== after) {
  const count = git("rev-list", "--count", `${before}..${after}`);
  const files = git("diff", "--name-only", before, after);
  console.log(
    `【${Math.round((now - last) / 60000)}分ぶり】git pull で ${count || "?"} 件を取り込みました。\n` +
      (files ? `変わったファイル：\n${files}` : "")
  );
}

// **必ず 0。** 取れなくても作業は続けられる
process.exitCode = 0;
