import * as vscode from "vscode";
import * as path from "./paths";
import { canRunProcesses } from "./runtime";

/**
 * 作った書き出しファイルを、OSの既定のアプリで開く（設計書6.43）。
 *
 * ## なぜ `vscode.env.openExternal` だけでは足りないのか
 *
 * 作者の報告（2026-08-30）：PDF出力でVS Codeが
 * 「外部プログラムを開く際にエラーが発生しました。
 * Failed to open: 指定されたファイルが見つかりません。(0x2)」を出した。
 * それでも拡張機能は「ブラウザで開きました」と告げていた——**戻り値を
 * 見ていなかった**ためである。
 *
 * `openExternal` は `Uri` を**パーセント符号化した文字列**にしてOSへ渡す。
 * 作品フォルダ名に日本語が入っていると（この作品は「ハイエルフ未亡人の…」）、
 * Windowsのシェルはその符号化された名前のファイルを探しに行き、
 * `0x2`（ファイルが見つかりません）で失敗する。
 *
 * ## だから、手元では OS のコマンドを先に使う
 *
 * `explorer.exe`（Windows）／`open`（macOS）／`xdg-open`（Linux）に**生のパス**を
 * 渡せば符号化を経ないので、日本語のパスでも開く。使えないとき
 * （ブラウザ版）は `openExternal` へ落とす。**どちらも失敗したら、
 * 成功したふりをしない。**
 *
 * 子へ渡す環境から `ELECTRON_RUN_AS_NODE` を外す理由は
 * `ai/childProcessEnv.ts` にある（既定のブラウザがElectron製だと即終了する）。
 */
export async function openInDefaultApp(filePath: string): Promise<boolean> {
  if (canRunProcesses()) {
    if (await openWithShell(filePath)) return true;
  }
  try {
    return await vscode.env.openExternal(path.toUri(filePath));
  } catch {
    // VS Code 側が自前のエラーダイアログを出したうえで投げてくることがある。
    // 呼び出し側が「開けなかった」道を用意しているので、ここでは握って戻す
    return false;
  }
}

/** OSのコマンドで開く。開けたと確認できたときだけ true */
async function openWithShell(filePath: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const { stat } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { childProcessEnv } = await import("../ai/childProcessEnv.js");

  const command = shellOpenCommand(filePath, process.platform, homedir());
  if (!command) return false;

  // **在ることを先に確かめる。** explorer.exe は無いパスを渡されても、別のフォルダーを
  // 開いて同じ終わり方をする（終了コードで見分けられない）。無いなら開けていない
  try {
    if (!(await stat(filePath)).isFile()) return false;
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // 既定のアプリが立ち上がるまで待たない。**起動を指示できたら成功**と
    // みなす（ブラウザの起動は数十秒かかることがあり、待つと画面が止まる）
    const timer = setTimeout(() => finish(true), 3000);

    try {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        env: childProcessEnv(),
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(shellOpenSucceeded(code, process.platform)));
      // VS Codeを閉じてもブラウザが道連れにならないようにする
      child.unref();
    } catch {
      finish(false);
    }
  });
}

/** 既定のアプリで開くために起こすもの */
export interface ShellOpenCommand {
  file: string;
  args: string[];
  /** Windows で、引数をこちらで囲んだまま渡させる（Node に囲み直させない） */
  windowsVerbatimArguments?: boolean;
  /** 起こすときの作業フォルダー（Windows で、名前で探す最初の場所になる） */
  cwd?: string;
}

/**
 * OSごとの「既定のアプリで開く」コマンド。
 *
 * **Windowsは `cmd` を通さず、`explorer.exe` にパスを渡す**（セキュリティ点検 2026-11-21）。
 * 1.0.34 までは `cmd /c start "" <パス>` だった。ファイル名は書き出しの題から来て、
 * `sanitizeFileName` は `&` `%` `^` を落とさない。cmd はそれを命令の区切り・変数として読みうる。
 * Node が引数を引用符で囲めば `&` は区切りにならないが（手元の Node 24 で確かめた）、
 * `%…%` は囲んでも展開され、囲み方を Node に頼ることになる。explorer.exe は引数を命令として読まない。
 *
 * - **作業フォルダーを `safeCwd`（ホーム）にして、名前で起こす。** Windows は名前で起こすとき、
 *   まず作業フォルダーを探し、次に PATH を探す。作業フォルダーが作品フォルダー（同期され、
 *   編集部とも共有する）だと、そこに置かれた同じ名前のものが起きうる。絶対パス
 *   （`C:\Windows\explorer.exe`）にしないのは、画面の自動テストが「PATH を空にすると
 *   起こせない」ことで本物のブラウザを開かせずにいるため（`test/e2e/exportEpisodePdf.test.ts`）
 * - **パスは必ず引用符で囲み、そのまま渡させる**（`windowsVerbatimArguments`）。
 *   Node は空白の無い引数を囲まないが、explorer.exe はカンマを区切りとして読む。
 *   Windows のファイル名に `"` は入らないので、囲んでも中身は変わらない。入っていれば
 *   作り物なので開かない
 */
export function shellOpenCommand(
  filePath: string,
  platform: NodeJS.Platform,
  safeCwd?: string
): ShellOpenCommand | undefined {
  if (platform === "win32") {
    if (filePath.includes('"')) return undefined;
    return {
      file: "explorer.exe",
      args: [`"${filePath}"`],
      windowsVerbatimArguments: true,
      ...(safeCwd ? { cwd: safeCwd } : {}),
    };
  }
  if (platform === "darwin") return { file: "open", args: [filePath] };
  if (platform === "linux") return { file: "xdg-open", args: [filePath] };
  return undefined;
}

/**
 * 起こしたコマンドの終わり方から、開けたかを決める。
 *
 * **explorer.exe は開けても 1 を返す**ので、Windows では終わり方で決めない
 * （普通に終われば開けた。無いパスは起こす前に確かめてある）。`open`・`xdg-open` は 0 のときだけ。
 * 止められた（`null`）なら開けていない
 */
export function shellOpenSucceeded(code: number | null, platform: NodeJS.Platform): boolean {
  if (code === null) return false;
  if (platform === "win32") return true;
  return code === 0;
}
