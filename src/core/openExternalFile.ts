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
 * `start`（Windows）／`open`（macOS）／`xdg-open`（Linux）に**生のパス**を
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
  const { childProcessEnv } = await import("../ai/childProcessEnv.js");

  const command = shellOpenCommand(filePath, process.platform);
  if (!command) return false;

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
        env: childProcessEnv(),
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      // VS Codeを閉じてもブラウザが道連れにならないようにする
      child.unref();
    } catch {
      finish(false);
    }
  });
}

/**
 * OSごとの「既定のアプリで開く」コマンド。
 *
 * **Windowsは `cmd /c start` を使う。** `start` は `cmd` の内蔵命令で、
 * 実行ファイルとしては存在しない。第1引数の `""` は**ウィンドウ題名**で、
 * これを省くとパスのほうが題名と解釈されて何も開かない。
 */
export function shellOpenCommand(
  filePath: string,
  platform: NodeJS.Platform
): { file: string; args: string[] } | undefined {
  if (platform === "win32") {
    return { file: "cmd", args: ["/c", "start", "", filePath] };
  }
  if (platform === "darwin") return { file: "open", args: [filePath] };
  if (platform === "linux") return { file: "xdg-open", args: [filePath] };
  return undefined;
}
