import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/**
 * 本物の git の倉庫を、**テストのファイルごとに1回だけ作って、テストごとに写す**
 * （2026-10-17。単体テストの重さの見直し）。
 *
 * ## なぜ写すのか
 *
 * 分岐を合わせる試験（`resolveDivergence.test.ts` など）は、テスト1件ごとに
 * 「種の倉庫 → GitHub役の倉庫 → この端末の写し」を git の子プロセスで
 * 10回あまり起こして作り直していた。Windows では1回の起動が重く、並列で
 * 走ると1件の前準備だけで数百ミリ秒かかり、全体の実行時間をこのファイル
 * 1本が決めていた（全体75秒のうち73秒）。
 *
 * **作られる倉庫の中身は毎回同じ**なので、1回作ったものをフォルダーごと
 * 写しても、テストが受け取る状態は変わらない（測ると 290ms → 26ms）。
 * 試験が確かめたい「git の実際の振る舞い」は、写したあとに本物の git を
 * 動かして確かめるので、そこは何も省いていない。
 *
 * ## 写すときに直すもの
 *
 * git は手元の道から複製した倉庫の `origin` を**絶対の道で**覚える。写した
 * だけだと、写しの `origin` は雛形の GitHub役を指したままになり、送った記録が
 * 雛形へ流れ込んで次のテストを汚す。写したら `pointOrigin` で写し先へ向け直す。
 */

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export interface GitTemplate {
  /** 雛形を新しい一時フォルダーへ写し、その場所を返す */
  copy(): string;
}

/**
 * `build` で雛形を1回だけ作る（最初に `copy()` されたときに作る）。
 *
 * **作るのを最初の `copy()` まで遅らせる**のは、純粋な文面だけを見るテストしか
 * 走らせないとき（`-t` で絞ったときなど）に、git を1回も起こさずに済ませるため。
 */
export function gitTemplate(
  prefix: string,
  build: (dir: string) => void
): GitTemplate {
  let template: string | undefined;
  return {
    copy() {
      if (!template) {
        const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), `${prefix}tpl-`));
        build(dir);
        template = dir;
      }
      const dest = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
      // 時刻も写す。索引（.git/index）が覚えている更新時刻とずれると、
      // git は中身を読み直して確かめる——結果は同じだが、そのぶん遅くなる
      fs.cpSync(template, dest, { recursive: true, preserveTimestamps: true });
      return dest;
    },
  };
}

/**
 * 試験用の倉庫の設定を揃える。
 *
 * - **端末のgitの設定で結果が変わらないようにする**：改行の自動変換を切り、
 *   記録の名前を決める。取り出したあとに切ると、取り出し済みのファイルだけ
 *   改行が違う形で残り、「両方の環境が同じ行を書き換えた」ことになってしまう
 *   （雛形の種・この端末・別のPCのすべてに、取り出す前から入れておく）
 * - **後片づけの自動起動を止める**（`maintenance.auto`）。git は記録・取り込み・
 *   送信のたびに後片づけ（`git maintenance run --auto`）を別の子プロセスで起こす。
 *   1件の試験で8回ほど起き、どれも何もせずに終わる（倉庫が小さいので片づける
 *   ものが無い）。合流や衝突の振る舞いには関わらないので、試験の倉庫では止める
 */
export function configureTestRepo(dir: string): void {
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "user.name", "作者");
  git(dir, "config", "user.email", "author@example.com");
  git(dir, "config", "maintenance.auto", "false");
}

/** 写した倉庫の `origin` を、写し先の GitHub役へ向け直す（上の「写すときに直すもの」） */
export function pointOrigin(repo: string, remote: string): void {
  git(repo, "remote", "set-url", "origin", remote);
}
