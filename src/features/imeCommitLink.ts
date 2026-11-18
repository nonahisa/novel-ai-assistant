// ログの書き先：作品が定まらない——つながりの状態は窓ごとの話で、どの作品のログでもないので
// 保管庫のログへ倒す（窓の札・いまの作品の知らせと同じ扱い）
import * as vscode from "vscode";
import { logLine } from "../core/logger";
import { canRunProcesses, environmentVariable, hostPlatform } from "../core/runtime";
import {
  IME_LINK_PIPE_ENV,
  imeLinkPipeName,
  pipePreviousCommit,
  routeImePipeCommit,
  type ImePipeLastCommit,
} from "../core/imeAppLink";
import type { CompositionPair } from "../core/imeReading";
import { IME_NOTIFY_SETTING } from "./imeCurrentWork";

/**
 * 六徳 IME の確定の知らせ（パイプ）を受ける（設計書6.13.8・6.42.2）。
 *
 * **動くのは Windows の手元の VS Code だけ**（ブラウザ版・リモートではつながない。
 * リモートでは拡張機能が別の機械で動いていて、作者が打っている機械のパイプへ届かない）。
 * 設定 `novelai.ime.notifyCurrentWork` を「IME との連動」の入り切りとして共に使う
 * （オフならつながない。新しい設定は足さない）。
 *
 * 受けた確定は、焦点のある原稿エディターがあるときだけ `onCommit` へ渡す。それ以外
 * （ほかのエディター・入力欄で打った字）は捨て、控えにも記録にも字を残さない。
 */

export interface ImeCommitLinkOptions {
  /** 前に出ている原稿エディター（`features/manuscriptEditor.ts` の `frontManuscript`） */
  frontManuscript: () => { filePath: string; active: boolean } | undefined;
  /**
   * 焦点のある原稿エディターで確定した。`reading` は IME が打った読み、`text` は確定した字。
   * `previous` は同じ話で間を置かずに続いた前の確定（姓と名を分けて確定する打ち方）
   */
  onCommit(filePath: string, reading: string, text: string, previous?: CompositionPair): void;
}

export interface ImeCommitLinkHandle extends vscode.Disposable {
  /** いま確定の知らせを許されてつながっているか（composition の道を控えるかの判定に使う） */
  granted(): boolean;
}

/** 状態の言い方（ログの1行。字の中身は書かない） */
const STATE_TEXT: Record<string, string> = {
  absent: "六徳 IME の確定の知らせ：つながりません（IME が動いていないか、まだ新しい版でない）。間をおいて試します",
  denied: "六徳 IME の確定の知らせ：つながりましたが、送ることを許されていません（IME の設定のアプリで許せます）",
  granted: "六徳 IME の確定の知らせ：つながりました。IMEで打った名前の読みは、この知らせから拾います",
  lost: "六徳 IME の確定の知らせ：つながりが切れました。間をおいてつなぎ直します",
  stopped: "六徳 IME の確定の知らせ：切りました",
};

/**
 * 確定の知らせを受け始める。手元の Windows の VS Code でなければ undefined（何もしない）。
 * 設定はあとから切り替えても効く（切ったら切る、入れたらつなぐ）。
 */
export function startImeCommitLink(
  context: vscode.ExtensionContext,
  options: ImeCommitLinkOptions
): ImeCommitLinkHandle | undefined {
  if (!canRunProcesses()) return undefined;
  if (vscode.env.remoteName) return undefined;
  if (hostPlatform() !== "win32") return undefined;

  type Client = { granted(): boolean; stop(): void };
  let client: Client | undefined;
  let starting = false;
  let disposed = false;
  let last: ImePipeLastCommit | undefined;

  const enabled = (): boolean =>
    vscode.workspace.getConfiguration("novelai").get<boolean>(IME_NOTIFY_SETTING, true);

  const receive = (commit: { text: string; reading: string }): void => {
    const filePath = routeImePipeCommit({
      windowFocused: vscode.window.state.focused,
      front: options.frontManuscript(),
    });
    // 焦点のある原稿エディターが無い確定は、字を覚えもせずに捨てる
    if (!filePath) return;
    const now = Date.now();
    const previous = pipePreviousCommit(last, filePath, now);
    last = { filePath, kana: commit.reading, committed: commit.text, at: now };
    options.onCommit(filePath, commit.reading, commit.text, previous);
  };

  const connect = async (): Promise<void> => {
    if (client || starting || disposed || !enabled()) return;
    starting = true;
    try {
      // Node の部品（net・child_process）は動的に読む（実装ルール7）
      const node = await import("../core/imeLinkPipeNode.js");
      const override = environmentVariable(IME_LINK_PIPE_ENV);
      const pipeName = imeLinkPipeName({
        override,
        sid: override ? undefined : await node.readWindowsUserSid(),
      });
      if (!pipeName) {
        logLine("六徳 IME の確定の知らせ：ユーザーの印（SID）を読めないので、つなぎません");
        return;
      }
      // 読んでいる間に設定を切った・拡張機能を止めた
      if (disposed || !enabled()) return;
      client = node.startImeLinkClient({
        pipeName,
        onCommit: receive,
        onState: (state) => {
          if (state === "lost") last = undefined;
          logLine(STATE_TEXT[state] ?? `六徳 IME の確定の知らせ：${state}`);
        },
      });
    } catch (error) {
      logLine(
        `六徳 IME の確定の知らせを受け始められませんでした：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      starting = false;
    }
  };

  const disconnect = (): void => {
    client?.stop();
    client = undefined;
    last = undefined;
  };

  void connect();

  const configWatch = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(`novelai.${IME_NOTIFY_SETTING}`)) return;
    if (enabled()) void connect();
    else disconnect();
  });

  const handle: ImeCommitLinkHandle = {
    granted: () => client?.granted() ?? false,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      configWatch.dispose();
      disconnect();
    },
  };
  context.subscriptions.push(handle);
  return handle;
}
