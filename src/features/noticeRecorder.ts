// ログの書き先：作品が定まらない——知らせの記録は窓ごとで、どの作品の話でもないので
// 保管庫のログへ倒す（窓の札と同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import {
  NOTICE_LOG_DIRECTORY,
  NOTICE_LOG_SCHEMA,
  answerChoice,
  describeNoticeCall,
  isNoticeLogExpired,
  noticeLogFileName,
  parseNoticeLog,
  pruneNotices,
  serializeNoticeLog,
  type NoticeEntry,
  type NoticeSeverity,
  type RedactFunction,
} from "../core/noticeLog";
import { atomicWriteFile } from "../core/atomicWrite";
import { canRunProcesses } from "../core/runtime";
import { logLine, redactSecrets } from "../core/logger";
import { globalStorageRoot } from "./globalStoragePath";
import { readMachineName } from "./windowCard";

/**
 * 拡張機能が出した知らせを保管庫へ書き留める（MCP の `notices.recent` が読む。
 * 作者の承認、2026-09-24）。
 *
 * ## 1か所で受ける
 *
 * 知らせを出している箇所は `src` 全体で700以上ある。**1か所ずつ書き換えない**
 * ——書き換え漏れがそのまま「記録に無い知らせ」になり、しかも漏れは
 * 誰にも見えない。代わりに、起動したときに `vscode.window` の3つ
 * （`showInformationMessage`・`showWarningMessage`・`showErrorMessage`）を
 * 包む。
 *
 * **包めるのはこの拡張機能の中だけ。** `vscode` の名前空間は拡張機能ごとに
 * 作られる別の物なので、ほかの拡張機能の知らせには触れない。
 * VS Code 1.138 の拡張機能ホストで、`window` が凍結されていない普通の
 * 物であることを確かめた（`extensionHostProcess.js`）。**それでも包めるとは
 * 決めつけない**——書き換えたあとで本当に差し替わったかを確かめ、
 * だめなら元へ戻して記録しない（知らせそのものは止めない）。
 *
 * ## 包んでも、知らせの振る舞いは変えない
 *
 * 元の関数をそのまま呼び、**返ってきた約束をそのまま返す**。記録は横で
 * 取るだけで、記録が失敗しても知らせは出る。押されたボタンは、同じ約束に
 * 別の受け手を付けて拾う（呼び手が受け取る約束は1つも変わらない）。
 *
 * ## 書き方
 *
 * - **窓ごとに1ファイル**（`core/noticeLog.ts` の断り書き）。1秒まとめて書く
 *   ——続けざまに出る知らせのたびにファイルを書き直さない
 * - 作者のデータではないので、上書きの経路（`atomicWriteFile` の指定なし）で
 *   書き、退避は取らない（実装ルール2の3経路のうち①。窓の札と同じ）
 * - **先に伏せてから切る**：APIキーらしき文字列は `logger.ts` と同じ伏せ方、
 *   文は先頭200字まで
 * - 起動したときに、保管期間（7日）を過ぎた閉じた窓の記録を片づける
 *
 * ## ブラウザ版では記録しない
 *
 * 読む相手（MCP サーバー）はブラウザでは走らない（外部プロセスを起動
 * できない）ので、書いても誰も読まない。プロセス番号も無い。
 * 窓の札（`features/windowCard.ts`）と同じ線引き。
 *
 * **失敗しても画面には出さない**（知らせの記録の失敗を知らせにすると、
 * それがまた記録へ回る）。理由はログへ1度だけ残す。
 */

export const NOTICE_FUNCTION_NAMES = [
  "showInformationMessage",
  "showWarningMessage",
  "showErrorMessage",
] as const;

export type NoticeFunctionName = (typeof NOTICE_FUNCTION_NAMES)[number];

const SEVERITY_OF: Record<NoticeFunctionName, NoticeSeverity> = {
  showInformationMessage: "info",
  showWarningMessage: "warning",
  showErrorMessage: "error",
};

/** 包む相手。本物は `vscode.window`、試験では作り物 */
export type NoticeTarget = Record<NoticeFunctionName, (...args: unknown[]) => unknown>;

export interface NoticeCall {
  severity: NoticeSeverity;
  args: readonly unknown[];
  /** 元の関数が返したもの（ふつうは押されたボタンで解決する約束） */
  result: unknown;
}

export type WrapResult =
  | { installed: true; restore: () => void }
  | { installed: false; reason: string };

/**
 * 3つの関数を包む。**1つでも包めなければ、全部を元に戻して諦める**
 * （種類によって記録が有ったり無かったりすると、無い知らせが
 * 「出なかった」のか「記録されなかった」のか区別できない）。
 */
export function wrapNoticeFunctions(
  target: NoticeTarget,
  onCall: (call: NoticeCall) => void
): WrapResult {
  const originals = new Map<NoticeFunctionName, (...args: unknown[]) => unknown>();

  const restore = (): void => {
    for (const [name, original] of originals) {
      try {
        target[name] = original;
      } catch {
        // 戻せないなら、包んだ関数が素通しで呼び続けるだけ（害は無い）
      }
    }
  };

  for (const name of NOTICE_FUNCTION_NAMES) {
    const original = target[name];
    if (typeof original !== "function") {
      restore();
      return { installed: false, reason: `${name} が関数ではありません` };
    }
    const severity = SEVERITY_OF[name];
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const result: unknown = original.apply(this, args);
      try {
        onCall({ severity, args, result });
      } catch {
        // 記録の失敗で知らせを止めない
      }
      return result;
    };
    try {
      target[name] = wrapped;
    } catch (error) {
      restore();
      return {
        installed: false,
        reason: `${name} を差し替えられません（${error instanceof Error ? error.message : String(error)}）`,
      };
    }
    // 凍結された物への代入は、厳格でない書き方だと黙って無視される。
    // **代入が通ったことではなく、差し替わったことを確かめる**
    if (target[name] !== wrapped) {
      restore();
      return { installed: false, reason: `${name} を差し替えても元のままでした` };
    }
    originals.set(name, original);
  }
  return { installed: true, restore };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * 1つの窓の知らせを溜めておく箱。**書き出しは知らない**（試験で中身を見るため）。
 */
export class NoticeBuffer {
  private entries: NoticeEntry[] = [];
  private nextSeq = 1;

  constructor(
    private readonly redact: RedactFunction,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** 知らせを1件加え、その通し番号を返す */
  add(call: Omit<NoticeCall, "result">): number {
    const now = this.clock();
    const seq = this.nextSeq++;
    this.entries.push({
      seq,
      at: now.toISOString(),
      ...describeNoticeCall(call.severity, call.args, this.redact),
      answer: null,
    });
    this.entries = pruneNotices(this.entries, now);
    return seq;
  }

  /** 閉じられた（押された）ことを書き足す。上限で既に落ちていれば何もしない */
  answer(seq: number, value: unknown): void {
    const entry = this.entries.find((item) => item.seq === seq);
    if (!entry) return;
    entry.answer = {
      at: this.clock().toISOString(),
      choice: answerChoice(value, this.redact),
    };
  }

  snapshot(): NoticeEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      items: [...entry.items],
      answer: entry.answer ? { ...entry.answer } : null,
    }));
  }
}

/** 続けざまの知らせを1回の書き出しにまとめる間 */
const WRITE_DELAY_MS = 1_000;

export interface NoticeRecorderHandle extends vscode.Disposable {
  /** 溜まっている分を書き出す（`deactivate` から。待たれないことがある） */
  flush(): Promise<void>;
}

export function startNoticeRecorder(
  context: vscode.ExtensionContext
): NoticeRecorderHandle | undefined {
  if (!canRunProcesses()) return undefined;

  const pid = process.pid;
  const startedAt = new Date();
  const directory = path.join(globalStorageRoot(context), ...NOTICE_LOG_DIRECTORY);
  const target = path.join(directory, noticeLogFileName(pid, startedAt));
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? "";
  const buffer = new NoticeBuffer(redactSecrets);
  let machineName: string | null = null;
  void readMachineName().then((name) => {
    machineName = name;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let failureLogged = false;
  let queue: Promise<void> = Promise.resolve();

  const writeNow = (): Promise<void> => {
    queue = queue.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        const now = new Date();
        await vscode.workspace.fs.createDirectory(path.toUri(directory));
        await atomicWriteFile(
          target,
          new TextEncoder().encode(
            serializeNoticeLog({
              schema: NOTICE_LOG_SCHEMA,
              pid,
              machineName,
              extensionVersion,
              startedAt: startedAt.toISOString(),
              updatedAt: now.toISOString(),
              notices: buffer.snapshot(),
            })
          )
        );
      } catch (error) {
        // **1度だけ残す。** 書けない状態が続くと、知らせのたびにログが埋まる
        if (!failureLogged) {
          failureLogged = true;
          logLine(
            "知らせの記録を保管庫へ書けませんでした（MCP の notices.recent にこの窓の知らせが出ません）：" +
              (error instanceof Error ? error.message : String(error))
          );
        }
      }
    });
    return queue;
  };

  const scheduleWrite = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void writeNow();
    }, WRITE_DELAY_MS);
  };

  const wrap = wrapNoticeFunctions(
    vscode.window as unknown as NoticeTarget,
    (call) => {
      const seq = buffer.add(call);
      scheduleWrite();
      if (isThenable(call.result)) {
        // 呼び手の約束は変えない。**同じ約束に別の受け手を付ける**だけ
        call.result.then(
          (value) => {
            buffer.answer(seq, value);
            scheduleWrite();
          },
          () => {
            buffer.answer(seq, undefined);
            scheduleWrite();
          }
        );
      }
    }
  );
  if (!wrap.installed) {
    logLine(`知らせの記録を始められませんでした（MCP の notices.recent は空のままです）：${wrap.reason}`);
    return undefined;
  }

  // 閉じた窓の古い記録を片づける。**失敗しても何も言わない**（次の起動でまた試す）
  void cleanUpExpiredNoticeLogs(directory, target).catch(() => undefined);

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await writeNow();
  };

  return {
    flush,
    dispose: () => {
      wrap.restore();
      void flush();
    },
  };
}

/**
 * 保管期間を過ぎた記録（閉じた窓のもの）を消す。**自分の窓の記録と、
 * 読めない記録には触らない**——読めないものは、それが何かを判断できない。
 */
async function cleanUpExpiredNoticeLogs(directory: string, own: string): Promise<void> {
  let names: [string, vscode.FileType][];
  try {
    // 先に作っておく。無いフォルダーを読むと、VS Code が失敗を開発者ツールへ
    // 毎回書き出してうるさい（どのみち最初の知らせで作るフォルダーである）
    await vscode.workspace.fs.createDirectory(path.toUri(directory));
    names = await vscode.workspace.fs.readDirectory(path.toUri(directory));
  } catch {
    return; // まだ1つも記録が無い
  }
  const now = new Date();
  for (const [name, type] of names) {
    if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    if (path.normalizeForComparison(file) === path.normalizeForComparison(own)) continue;
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(file));
      const log = parseNoticeLog(new TextDecoder().decode(bytes));
      if (!log || !isNoticeLogExpired(log, now)) continue;
      await vscode.workspace.fs.delete(path.toUri(file), { useTrash: false });
    } catch {
      // 1つ消せなくても、ほかは続ける
    }
  }
}
