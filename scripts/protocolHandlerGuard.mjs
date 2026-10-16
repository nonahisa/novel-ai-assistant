/**
 * 試験用の VS Code が書き換えた `vscode://` の受け手を、試験のあとで元に戻す（2026-10-17）。
 *
 * ## なぜ要るか
 *
 * Windows の VS Code は、起動するたびに自分を `vscode://` の受け手として
 * `HKCU\Software\Classes\vscode\shell\open\command` へ書く。**試験用に取り寄せた
 * `.vscode-test` の VS Code も同じことをする。** 作者の機械で、配布前の検査
 * （`check:release` の `test:integration:patched`）が起こした 1.138.0 が受け手に
 * 居座り、入っている VS Code は起動しても取り返さなかった。そのため外部AIの
 * run.request（`vscode://nonahisa.novel-ai-assistant/run?...`）が作者の知らない
 * 試験版の窓を起こし、確認の窓が作者に見えなかった。
 *
 * ## 決まり
 *
 * - **Windows のときだけ。** ほかの OS は受け手の仕組みが違い、試験も書き換えない
 * - **触るのは `vscode` の受け手だけ。** `vscode-insiders` は試験が使わないので触らない
 * - **控えが取れなかったときは戻さない。** キーが無かった機械で、こちらが値を
 *   作ると、作者の知らない設定を足すことになる（機器全体に入れた VS Code の
 *   HKLM の登録を、HKCU の値が隠してしまう）
 * - 控えは `reg export` で一時ファイルへ書き、戻しは `reg import` で読み込み直す。
 *   値には引用符と `%1` が入り、`reg query` の出力は OEM の文字コードなので、
 *   文字列を読み取って `reg add` で書き戻すと化ける恐れがある。書き出したファイル
 *   （UTF-16）をそのまま戻せば、型（REG_SZ など）も含めて元の通りになる
 * - **戻すのに失敗しても試験の結果は変えない。** 記録に1行出して、作者が手で
 *   戻せるようにする（試験が通ったのに配布が止まるのは筋違い）
 * - レジストリの呼び出し（`run`）は差し替えられる。単体テスト
 *   （`test/unit/cross/protocolHandlerGuard.test.ts`）は本物のレジストリに触らない
 *
 * 使う所：`scripts/runIntegrationTests.mjs`・`scripts/verifyVsix.mjs`・
 * 画面の自動テストの `test/e2e/support/globalSetup.ts`。
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 見張る鍵（`vscode://` を開くときに Windows が使うコマンド） */
export const VSCODE_PROTOCOL_COMMAND_KEY =
  "HKCU\\Software\\Classes\\vscode\\shell\\open\\command";

/**
 * 子プロセスで `reg` を叩く。**shell は通さない**——値の `%1` と引用符を
 * cmd が解釈しないように。
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{ status: number | null; stdout: string; stderr: string }}
 */
export function defaultRegRunner(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

/**
 * 試験の前に受け手を控える。控えられなければ undefined（＝あとで戻さない）。
 *
 * @param {{ platform?: string; run?: typeof defaultRegRunner; log?: (line: string) => void; tempDir?: string }} [options]
 * @returns {{ file: string; before: string; done: boolean } | undefined}
 */
export function snapshotProtocolHandler(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const run = options.run ?? defaultRegRunner;
  const log = options.log ?? ((line) => console.log(line));

  const query = run("reg", ["query", VSCODE_PROTOCOL_COMMAND_KEY, "/ve"]);
  if (query.status !== 0) {
    log(
      "vscode:// の受け手が登録されていない（または読めない）ため、控えを取りません。" +
        "試験のあとも戻しません（値を勝手に作らないため）。"
    );
    return undefined;
  }
  const file = path.join(
    options.tempDir ?? tmpdir(),
    `novelai-vscode-protocol-${process.pid}-${Date.now()}.reg`
  );
  const exported = run("reg", ["export", VSCODE_PROTOCOL_COMMAND_KEY, file, "/y"]);
  if (exported.status !== 0) {
    log(
      `vscode:// の受け手の控えを書き出せなかったため、試験のあとも戻しません：${(exported.stderr || exported.stdout).trim()}`
    );
    return undefined;
  }
  return { file, before: query.stdout, done: false };
}

/**
 * 控えから受け手を戻す。**変わっていたときだけ**読み込み直す。2度呼ばれても
 * 戻すのは1回（Ctrl+C の後始末と finally が重なるため）。
 *
 * @param {{ file: string; before: string; done: boolean } | undefined} snapshot
 * @param {{ run?: typeof defaultRegRunner; log?: (line: string) => void }} [options]
 * @returns {{ changed: boolean; restored: boolean } | undefined}
 */
export function restoreProtocolHandler(snapshot, options = {}) {
  if (!snapshot || snapshot.done) return undefined;
  snapshot.done = true;
  const run = options.run ?? defaultRegRunner;
  const log = options.log ?? ((line) => console.log(line));
  try {
    const now = run("reg", ["query", VSCODE_PROTOCOL_COMMAND_KEY, "/ve"]);
    if (now.status === 0 && now.stdout === snapshot.before) {
      rmSync(snapshot.file, { force: true });
      return { changed: false, restored: false };
    }
    const imported = run("reg", ["import", snapshot.file]);
    const after = run("reg", ["query", VSCODE_PROTOCOL_COMMAND_KEY, "/ve"]);
    if (imported.status !== 0 || after.status !== 0 || after.stdout !== snapshot.before) {
      log(
        "試験用の VS Code が書き換えた vscode:// の受け手を、元に戻せませんでした。" +
          `控えは ${snapshot.file} にあります（ダブルクリックで読み込めます）：` +
          `${(imported.stderr || imported.stdout).trim()}`
      );
      // 控えのファイルは作者が手で戻すのに要るので残す
      return { changed: true, restored: false };
    }
    log("試験用の VS Code が書き換えた vscode:// の受け手を、試験の前の値に戻しました。");
    rmSync(snapshot.file, { force: true });
    return { changed: true, restored: true };
  } catch (error) {
    log(`vscode:// の受け手を戻す途中で失敗しました（控え：${snapshot.file}）：${String(error)}`);
    return { changed: true, restored: false };
  }
}

/**
 * 試験を包む。前に控え、終わったら（失敗しても）戻す。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {{ platform?: string; run?: typeof defaultRegRunner; log?: (line: string) => void; tempDir?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withProtocolHandlerGuard(task, options = {}) {
  const snapshot = snapshotProtocolHandler(options);
  try {
    return await task();
  } finally {
    restoreProtocolHandler(snapshot, options);
  }
}
