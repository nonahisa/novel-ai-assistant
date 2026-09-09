import * as vscode from "vscode";
import * as path from "./paths";
import { redactUrlCredentials } from "./redactUrl";

/**
 * 診断用のログ。
 *
 * AI呼び出しの失敗は、通知には「何が起きたか」と「次にどうするか」だけを出し、
 * プロバイダーが返した本文は載せていない。通知は目に入りやすく、
 * 応答本文に何が混ざるかを制御できないため。
 *
 * ただし本文が**どこにも残らない**と、作者が原因にたどり着けず、
 * こちらも直しようがない。そこで作者が自分で開くログにだけ残す。
 *
 * **出力パネルに加えてファイルにも書く。** パネルの内容はVS Codeを閉じると消え、
 * 作者が画面を写して伝えるしかなくなる。とくに「止まった」ときは
 * 失敗の記録が残らないため、どこまで進んだかを後から追えることが要る。
 * 置き場所は `.aiwriter/logs/`（Git同期の対象外）。
 */

let channel: vscode.OutputChannel | undefined;

/** ログを書き込む先。作品を開いたときに設定する */
let logFilePath: string | undefined;
/** 書き込みは順番に行う。並行して呼ばれると行が混ざる */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * ログファイルの置き場所を決める。
 * 作品ごとに分けず1つにするのは、作品をまたいだ操作の順序も追いたいため。
 */
export function useLogFile(workFolderPath: string): void {
  logFilePath = path.join(workFolderPath, ".aiwriter", "logs", "actions.log");
}

/**
 * 動作の記録（`.aiwriter/logs/actions.log`）1ファイルの上限。
 *
 * **ログのバイト上限は3つある。値も違う**（設計書6.77の第2段で名前だけ揃えた）。
 * `chatLog.ts` の `MAX_CHAT_LOG_BYTES`（相談の記録）と
 * `usageLog.ts` の `MAX_USAGE_LOG_BYTES`（呼び出し量の表）がそれで、
 * **用途が違うので値も違う**——寄せない。ここは1行が短い代わりに件数が多く、
 * 直近が読めればよいので、いちばん小さい。
 */
const MAX_ACTION_LOG_BYTES = 1_000_000;

function appendToFile(text: string): void {
  const target = logFilePath;
  if (!target) return;

  // 失敗しても本来の処理は止めない。ログが書けないことより、
  // 抽出が中断するほうが作者にとって困る
  writeQueue = writeQueue
    .then(async () => {
      const uri = path.toUri(target);
      await vscode.workspace.fs.createDirectory(
        path.toUri(path.dirname(target))
      );
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(uri);
      } catch {
        existing = new Uint8Array();
      }
      const addition = new TextEncoder().encode(`${text}\n`);
      // 上限を超えたら古いほうから捨てる。直近が読めることを優先する
      const merged =
        existing.byteLength + addition.byteLength > MAX_ACTION_LOG_BYTES
          ? addition
          : concat(existing, addition);
      await vscode.workspace.fs.writeFile(uri, merged);
    })
    .catch(() => undefined);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

export function outputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("小説AI執筆補助");
  }
  return channel;
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}

export function showLog(): void {
  outputChannel().show(true);
}

/**
 * ログの時刻。**作者の時計に合わせる（現地時刻）。**
 *
 * 以前は `toISOString()`（UTC）で書いていた。日本時間とは9時間ずれるため、
 * 実際には1分前に書かれた行が「9時間前」に見え、**動いているのに
 * 止まったように見える。** 実際に作者が「また止まってそう」と判断した
 * ときの抽出は、その1〜2分前まで正常に進んでいた。
 *
 * 日付も入れる。ファイルには複数日ぶんが残るので、
 * 時刻だけだと「今日のものか」が分からない。
 */
export function formatLogTime(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export function logLine(message: string): void {
  const line = `[${formatLogTime()}] ${redactSecrets(message)}`;
  outputChannel().appendLine(line);
  appendToFile(line);
}

/**
 * 処理の区切りを記録する。
 *
 * **止まったときは失敗が記録されない。** 何番目のチャンクまで進んで、
 * どこから応答が返らなくなったのかが、あとから追えるようにしておく。
 * 本文そのものは書かない（原稿がログへ漏れるのを避ける）。
 */
export function logStep(message: string): void {
  logLine(message);
}

/**
 * AIの応答をログに残すときの字数（設計書6.77の第2段）。
 *
 * **全文は残さない。** 読み取れなかった応答は数万字のこともあり、
 * そのまま書くとログが1件で埋まって、ほかの失敗が見えなくなる。
 * 原因の見当をつけるには先頭だけで足りる（形が違うのか、断り文句なのか、
 * 途中で切れたのかは冒頭に出る）。
 *
 * **14の機能が同じ切り詰めを自分で書いていた**うち、5つが300字、
 * 9つが400字と割れていた。少ないほうへ揃えると手がかりが減るので、
 * 多いほう（最頻値）に合わせた。
 */
export const MAX_LOGGED_RESPONSE_CHARS = 400;

/**
 * AIの応答を、ログへ載せられる長さに切り詰める。
 *
 * **切り詰めた印（「…」など）は足さない。** ログに残る文字列が
 * 「AIが返した本文そのもの」でなくなると、作者がそのまま検索したときに
 * 見つからない。
 */
export function responseExcerptForLog(text: string): string {
  return text.slice(0, MAX_LOGGED_RESPONSE_CHARS);
}

/** 失敗の詳細を、作者が読める形で残す */
export function logFailure(
  context: string,
  detail: Record<string, unknown>
): void {
  const lines = [`--- ${context} ---`];
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`  ${key}: ${String(value)}`);
  }
  logLine(lines.join("\n"));
}

/**
 * APIキーらしき文字列を伏せる。
 *
 * キー自体はヘッダーで送っており応答本文には現れないはずだが、
 * 作者がログを貼って助けを求めることを考えると、
 * 万一混ざったときの被害が大きい。念のため伏せる。
 */
export function redactSecrets(text: string): string {
  // 実際に使っているキーそのものを先に消す。
  // 接頭辞での判定より確実で、形式が変わっても効く
  let result = text;
  for (const secret of knownSecrets) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }

  // URLに埋め込まれた資格情報。GitHub同期の失敗はURLごとログに残るので、
  // 接頭辞の判定より先に、形そのものを落とす
  result = redactUrlCredentials(result);

  // 登録し損ねたキーへの保険。接頭辞は変わりうるので、これだけに頼らない
  for (const prefix of SECRET_PREFIXES) {
    result = result.replace(secretPattern(prefix), `${prefix}***`);
  }
  return result;
}

/**
 * 伏せ字にするキーの接頭辞。
 *
 * **`scripts/releaseSupport.mjs` の出口走査と揃える。** 片方だけに足すのが
 * 一番ありがちな壊れ方なので、`test/unit/secretScanParity.test.ts` が
 * 「同じ形の値を両方が知っているか」を見張っている。
 *
 * GitHubのトークン（`ghp_` など）は、`https://<トークン>@github.com/...` の
 * 形でURLに埋め込まれてログへ流れ込む。
 */
export const SECRET_PREFIXES = [
  "sk-",
  "AIza",
  "AQ.",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
] as const;

/**
 * 接頭辞から、伏せ字の判定に使う正規表現を作る。
 *
 * **語の途中は見ない**（`(?<![A-Za-z0-9])`）。`sk-` は `task-` `risk-` の
 * 中にも現れるので、そこまで潰すと「task-list-item-checkbox」が
 * 「task-***」になってログが読めなくなる。
 */
function secretPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}[A-Za-z0-9_-]{8,}`, "g");
}

/**
 * 伏せ字にすべきキーの実物。
 *
 * **接頭辞での判定に頼らない。** このプロジェクトは以前、
 * 接頭辞（`AIza`）でキーの形式を検証して、Googleが形式を変えた結果
 * 正しいキーを弾いた。同じ理屈で、接頭辞での伏せ字も将来外れる。
 *
 * 実際に使っている値そのものを控えておけば、形式が何であれ消せる。
 * ログはファイルにも残るようになったので、取りこぼしが残り続ける。
 */
const knownSecrets = new Set<string>();

/**
 * キーを伏せ字の対象に加える。読み込み・保存のたびに呼ぶ。
 *
 * 短い値は登録しない。ありふれた文字列を消すと、
 * ログが伏せ字だらけになって読めなくなる。
 */
export function registerSecret(value: string | undefined): void {
  const secret = value?.trim();
  if (!secret || secret.length < 8) return;
  knownSecrets.add(secret);
}

/** キーを消したときに呼ぶ。控えたままにしない */
export function forgetSecret(value: string | undefined): void {
  const secret = value?.trim();
  if (secret) knownSecrets.delete(secret);
}

/** テスト用。控えをすべて捨てる */
export function clearSecrets(): void {
  knownSecrets.clear();
}
