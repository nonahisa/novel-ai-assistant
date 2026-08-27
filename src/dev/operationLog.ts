import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import * as vscode from "vscode";
import * as paths from "../core/paths";

/**
 * F5の開発ホストで「どの操作を実際に押したか」を記録する（作者の依頼、2026-08-27）。
 *
 * **配布物には入らない。** `esbuild.js` が本番ビルドで `__DEV_HELPERS__` を
 * `false` に畳むので、これを読み込む枝ごと落ちる（`scripts/releaseSupport.mjs`
 * の禁止語が出口でも見張る）。
 *
 * ## 残すのは「実行した事実」だけ
 *
 * 実機確認リストの合否の印（`- [x]`）には**触らない**。押したことと
 * 通ったことは別で、ここが自動で進むと**確かめていないものが済んだことになる**
 * （`checkRunner.ts` の「判断は作者がする」と同じ理由）。
 * この記録が答えられるのは「いつ・何回実行したか」までである。
 *
 * ## なぜ JSON Lines なのか
 *
 * 1操作＝1行の追記で済むので、**途中でVS Codeが落ちても、それまでの行は残る。**
 * 代わりに**最後の行が欠けることがある**ので、読む側は壊れた行を飛ばす。
 *
 * ## なぜ Node の fs を直に使うのか
 *
 * F5の「拡張機能開発ホスト」は常にデスクトップで、ブラウザ版では動かない。
 * 記録は**コマンドを押すたびに同期で1行書く**ので、非同期の
 * `vscode.workspace.fs`（読んで足して書き戻す）だと、連打したときに
 * 取りこぼす。書き込みを直列にする仕組みを持つより、追記1回で済ませる。
 */

/** ログの置き場。`initOperationLog` を呼ぶまでは記録しない */
let logFile: string | undefined;

/** 失敗をもう知らせたか（`warnOnce` を参照） */
let warned = false;

/** 1回の操作の記録 */
interface OperationEntry {
  /** 実行した時刻（ISO8601） */
  ts: string;
  /** コマンドID（"novelai.checkTypos"） */
  command: string;
}

/** コマンドごとの集計 */
export interface OperationCount {
  /** 実行した回数 */
  count: number;
  /** 最後に実行した時刻（ISO8601） */
  lastTs: string;
}

/**
 * ログの置き場を決める。
 *
 * **拡張機能のフォルダーの下に置く**（開いている作品とは無関係）。
 * 作品の中へ書くと、作者の原稿と一緒にGitへ乗ってしまう。
 * `logs/` は `.gitignore` に入れてある（個人の作業記録なので同期しない）。
 */
export function initOperationLog(extensionPath: string): void {
  const folder = paths.join(extensionPath, "logs");
  try {
    mkdirSync(folder, { recursive: true });
    logFile = paths.join(folder, "operations.jsonl");
  } catch (error) {
    // 置き場が作れなければ、記録しないまま先へ進む（logFile は undefined のまま）
    warnOnce(error);
  }
}

/**
 * 1回の操作を記録する。
 *
 * **失敗してもコマンド本体を止めない。** これは操作の付随物であって、
 * 作者がやろうとしていることではない。記録できないことを理由に
 * 誤字脱字検知が動かなくなるのでは本末転倒である。
 */
export function logOperation(command: string): void {
  if (!logFile) return;
  const entry: OperationEntry = { ts: new Date().toISOString(), command };
  try {
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    warnOnce(error);
  }
}

/**
 * コマンドごとの実行回数と、最後に実行した時刻。
 *
 * **壊れた行は飛ばす。** 追記専用なので、書いている途中でVS Codeが落ちれば
 * 最後の行が欠ける。1行読めないだけで全部を捨てると、記録の意味が無くなる。
 */
export function readOperationSummary(): Map<string, OperationCount> {
  const summary = new Map<string, OperationCount>();
  if (!logFile) return summary;

  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    // まだ一度も操作していなければファイルが無い。**空で返すのが正しい答え**なので、
    // ここは警告を出さない（記録の失敗と、記録がまだ無いことは違う）
    return summary;
  }

  for (const line of text.split("\n")) {
    const entry = parseEntry(line);
    if (!entry) continue;
    const found = summary.get(entry.command);
    if (!found) {
      summary.set(entry.command, { count: 1, lastTs: entry.ts });
      continue;
    }
    found.count++;
    // 追記の順に並んでいるはずだが、**並びを当てにしない**。
    // 端末の時計が戻ることもあるので、いちばん新しいものを採る
    if (entry.ts > found.lastTs) found.lastTs = entry.ts;
  }

  return summary;
}

/** 1行を読む。読めないものは undefined（呼び出し側が飛ばす） */
function parseEntry(line: string): OperationEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const { ts, command } = parsed as Record<string, unknown>;
  if (typeof ts !== "string" || typeof command !== "string") return undefined;
  if (command === "") return undefined;
  return { ts, command };
}

/**
 * 記録の失敗は、**最初の1回だけ**知らせる。
 *
 * 書けない状態（権限が無い・ディスクが一杯）になると、コマンドを押すたびに
 * 同じ警告が出て**操作そのものができなくなる**。原因は1回伝われば足りる。
 */
function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  const reason = error instanceof Error ? error.message : String(error);
  void vscode.window.showWarningMessage(
    `操作ログを記録できませんでした（以後は黙ります）: ${reason}`
  );
}
