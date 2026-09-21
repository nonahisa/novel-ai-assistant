/**
 * セッションの始めに、リポジトリの取りこぼしを片付ける（作者の指示、2026-09-21）。
 *
 * **ノートPCとデスクトップを行き来する**ようになったので、`git pull` の忘れを
 * 機械に見張らせる。運用の規則としては CLAUDE.md と記憶にあるが、
 * **規則は忘れられる。** 機械なら忘れない。
 *
 * ## なぜ「終わるとき」ではなく「始めるとき」なのか
 *
 * `SessionEnd` のフックは**出力が表示されない**（セッションが終わりつつあるため）。
 * 知らせたいのに知らせられないので、**未 push の知らせも開始時に出す**。
 * 実効は同じ——次に作業を始める人（たいてい自分）が、必ず目にする。
 *
 * ## 何があっても終了コードは 0
 *
 * ここで止めてよいことは1つも無い。取れなくても、押し戻されても、
 * **作業そのものは始められる**べきである。起きたことを書いて、黙って 0 で終わる。
 *
 * ## シェルに頼らない
 *
 * Windows では Git Bash と PowerShell が混ざる。`||` や `$(...)` の意味が
 * 変わるので、**フックからは node を1本呼ぶだけ**にして、中身をここへ書く。
 */

import { execFileSync } from "node:child_process";

/** git を叩く。失敗しても投げず、空文字を返す */
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

const lines = [];

// ── 取る ──────────────────────────────────────────────
// **`--ff-only`。** 勝手に merge させない——別の機械の作業と混ざった結果を
// 黙って作ると、どちらの文章が消えたか分からなくなる（設計書6.15 と同じ考え方）
const before = git("rev-parse", "HEAD");
const pulled = git("pull", "--ff-only");
const after = git("rev-parse", "HEAD");

if (before && after && before !== after) {
  const count = git("rev-list", "--count", `${before}..${after}`);
  lines.push(`git pull：${count || "?"} 件のコミットを取り込みました。`);
} else if (pulled.includes("Already up to date") || pulled.includes("最新")) {
  // 何も起きていないときは黙る。毎回出ると読まれなくなる
} else if (!pulled) {
  lines.push(
    "git pull が通りませんでした（早送りできない・通信が無い・衝突など）。" +
      "**作業を始める前に `git status` を見てください。**"
  );
}

// ── 送り忘れを知らせる ────────────────────────────────
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
if (upstream) {
  const unpushed = git("log", "--oneline", `${upstream}..HEAD`);
  if (unpushed) {
    const n = unpushed.split("\n").length;
    lines.push(
      `**送っていないコミットが ${n} 件あります**（${branch}）。` +
        "別の機械で続きをやる前に push してください。"
    );
    for (const line of unpushed.split("\n").slice(0, 5)) {
      lines.push(`  ${line}`);
    }
  }
}

// ── 手つかずの変更 ────────────────────────────────────
const dirty = git("status", "--porcelain");
if (dirty) {
  const n = dirty.split("\n").length;
  lines.push(`手元に未コミットの変更が ${n} 件あります。`);
}

if (lines.length > 0) {
  console.log("【リポジトリの状態】\n" + lines.join("\n"));
}

// **必ず 0。** ここで作業を止めない
process.exitCode = 0;
