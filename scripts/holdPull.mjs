/**
 * 長いテスト・配布の検査を流している間、会話のフック（.claude/hooks/beforeWork.mjs）の
 * 自動の `git pull` を止める印（2026-11-13 ノートPCの気づき）。
 *
 * フックは前の pull から30分あくと、ツールを使う前に `git pull --ff-only` を走らせる。
 * 裏で画面テストを流している間にそれが走ると、ビルドした dist より新しいテストが入り、
 * 版のずれた組み合わせで流して「落ちた」と取り違えた。
 *
 * 印は `.git/novelai-hold-pull`（作業場では作業場の git の置き場）。中身は置いた時刻。
 * 止められて消えなかった印で pull がずっと止まらないよう、**6時間より古い印は無視する**。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HOLD_PULL_FILE = "novelai-hold-pull";
export const HOLD_PULL_MAX_MS = 6 * 60 * 60 * 1000;

/** いまの作業場の git の置き場（無ければ undefined） */
function gitDir(cwd = process.cwd()) {
  try {
    const dir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dir ? path.resolve(cwd, dir) : undefined;
  } catch {
    return undefined;
  }
}

/** 印を置く。返す関数で消す（置けなかったときは何もしない関数） */
export function holdPull(cwd = process.cwd()) {
  const dir = gitDir(cwd);
  if (!dir) return () => {};
  const file = path.join(dir, HOLD_PULL_FILE);
  try {
    fs.writeFileSync(file, String(Date.now()));
  } catch {
    return () => {};
  }
  return () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 消せなくても、6時間で無視される
    }
  };
}

/** 新しい印があるか（フックが見る） */
export function pullHeld(dir, now = Date.now()) {
  try {
    const at = Number(fs.readFileSync(path.join(dir, HOLD_PULL_FILE), "utf8")) || 0;
    return now - at < HOLD_PULL_MAX_MS;
  } catch {
    return false;
  }
}
