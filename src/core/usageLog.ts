import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR } from "../models/types";
import { formatLogTime, redactSecrets } from "./logger";

/**
 * AIへ1回送るごとに、送った量を1行だけ残す。
 *
 * ## なぜ要るか
 *
 * 0.22.5 で、相談パネルが**機能の一覧8,111字を毎回送っていた**ことが
 * 分かった。1回で送る量の半分を占め、肝心の本文は19%しかなかった。
 * 直せたのは、**先に測ったから**である。
 *
 * ほかの機能については、まだ誰も測っていない。ソースの文字数から
 * 見積もることはできるが（矛盾検知の世界観は2,000〜20,000字と幅がある）、
 * **作者の作品で実際に何字送っているかは、動かさないと分からない。**
 *
 * ## actions.log とも chat.md とも分ける
 *
 * `logger.ts`（actions.log）は**失敗の記録**で、本文を書かない方針。
 * `chatLog.ts`（chat.md）は**相談のやり取り**で、本文を含む。
 * ここは**数字だけ**で、成功した回も全部残す。方針が違うものを
 * 同じファイルへ混ぜると、どちらの規則で書けばよいのか分からなくなる
 * （設計書6.20.1と同じ理由）。
 *
 * **本文そのものは1文字も書かない。** 字数と機能名だけである。
 *
 * ## なぜ表で書くか
 *
 * 相談ログは1回が長いので見出しと引用で書いたが、こちらは1回1行の
 * 数字で、**並べて比べることに意味がある**（抽出なら39行が一度に並ぶ）。
 * 表なら「どの機能が重いか」「本文の割合が小さいのはどれか」を
 * 目で追える。
 *
 * 置き場所は `.aiwriter/logs/usage.md`。**Git除外済み**（5.5節）。
 */

/**
 * 呼び出し量の表1ファイルの上限。超えたら古いほうから捨て、直近が読めることを優先する。
 *
 * **ログのバイト上限は3つある。値も違う**（設計書6.77の第2段で名前だけ揃えた）。
 * `logger.ts` の `MAX_ACTION_LOG_BYTES`（動作の記録）と
 * `chatLog.ts` の `MAX_CHAT_LOG_BYTES`（相談の記録）がそれで、
 * **用途が違うので値も違う**——寄せない。ここは1行が短い代わりに、
 * 抽出1回で39行が一度に並ぶ。比べるには過去のぶんが要るので広く取る。
 */
const MAX_USAGE_LOG_BYTES = 2_000_000;

export interface UsageLogEntry {
  /** どの機能の呼び出しか。`chunkCache` の feature 名と揃える */
  feature: string;
  provider: string;
  model: string;
  paid: boolean;
  /** systemPrompt の字数 */
  systemChars: number;
  /** userPrompt の字数 */
  userChars: number;
  /**
   * スキーマをJSONにしたときの字数。
   *
   * **プロンプトとは別枠で送られる**（Ollamaなら `format`、
   * OpenAI互換なら `response_format`）。これが入力トークンに
   * 乗るかどうかはプロバイダによって違うので、**足さずに分けて出す**。
   * `inputTokens` と並べて見れば、乗っているかどうかが分かる。
   */
  schemaChars?: number;
  /** 送ったものの内訳（字数）。「本文」「世界観」など */
  parts?: Record<string, number>;
  /** 実際に確保したコンテキスト長。`inputTokens` と並べると過不足が見える */
  numCtx?: number;
  /**
   * 応答が返した消費量。
   *
   * `cachedInputTokens` は**入力のうちキャッシュから読めた分**で、
   * **数えられないAI（Ollama等）では undefined になる。** 0と分けて
   * 扱う（0は「数えたうえで効かなかった」）。
   * 型は `ai/types.ts` の `GenerateResult["usage"]` と揃えているが、
   * **こちらから ai/ をimportしない**（core → ai の逆流を作らないため）。
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  elapsedMs?: number;
  /** 応答が長さ上限で打ち切られたか */
  truncated?: boolean;
  /** 失敗したとき。成功した回だけ残すと、遅い・届かない理由を追えない */
  error?: string;
}

/**
 * 内訳を組み立てる。
 *
 * **「指示」は引き算で出す。** 部品の字数を1つずつ足す形にすると、
 * プロンプトの組み立て方を変えたときに合計が合わなくなり、しかも
 * 合わないことに気づけない。渡した全体から分かっている部品を引けば、
 * 残りは必ず指示文である。
 *
 * 0を渡された項目は落とす（その回に無かったものを「0字」と並べても読みにくい）。
 */
export function measureParts(
  userPrompt: string,
  parts: Record<string, number>
): Record<string, number> {
  const known = Object.values(parts).reduce((sum, chars) => sum + chars, 0);
  const kept = Object.fromEntries(
    Object.entries(parts).filter(([, chars]) => chars > 0)
  );
  return { ...kept, 指示: Math.max(0, userPrompt.length - known) };
}

export function isUsageLogEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("usageLog.enabled", true);
}

export function usageLogPath(workFolder: string): string {
  return path.join(workFolder, AIWRITER_DIR, "logs", "usage.md");
}

/** 書き込みは順番に行う。並行して呼ばれると行が混ざる */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * 1回ぶんを書き足す。
 *
 * **失敗しても処理は止めない。** 記録が書けないことより、
 * 抽出や検知が中断するほうが作者にとって困る。
 */
export function appendUsageLog(workFolder: string, entry: UsageLogEntry): void {
  if (!isUsageLogEnabled()) return;

  const target = usageLogPath(workFolder);
  const row = renderUsageRow(entry);

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
        existing = new TextEncoder().encode(usageLogHeader(workFolder));
      }
      const addition = new TextEncoder().encode(row);
      // 上限を超えたら、見出しを作り直して直近のぶんだけ残す。
      // 途中で切ると表の途中から始まって読めなくなる
      const merged =
        existing.byteLength + addition.byteLength > MAX_USAGE_LOG_BYTES
          ? new Uint8Array([
              ...new TextEncoder().encode(usageLogHeader(workFolder)),
              ...addition,
            ])
          : concat(existing, addition);
      await vscode.workspace.fs.writeFile(uri, merged);
    })
    .catch(() => undefined);
}

/**
 * ファイルの先頭。表の見出しもここで作る。
 *
 * VS Code APIに触れないので単体テストできる。
 */
export function usageLogHeader(workFolder: string): string {
  return [
    `# ${path.basename(workFolder)} の送信量`,
    "",
    "AIへ1回送るごとに1行ずつ増えます。**本文そのものは記録しません**（字数だけです）。",
    "このファイルは `.aiwriter/logs/` にあり、GitHubへは送られません。",
    "残したくない場合は設定 `novelai.usageLog.enabled` を切ってください。",
    "",
    "- **指示＋本文** … プロンプトとして送った字数の合計",
    "- **スキーマ** … 出力の形の指定。プロンプトとは別枠で送るため、足さずに分けています",
    "- **本文%** … 指示＋本文のうち、原稿そのものが占める割合。小さいほど見落としが増えます",
    "- **確保** … `num_ctx`（確保したコンテキスト長）。**入力トークンがこれに近いと、入力が切り捨てられます**",
    "- **キャッシュ** … 入力トークンのうち、プロンプトキャッシュから読めた分。空欄は、数を返さないAI（Ollamaなど）です",
    "",
    // **キャッシュは末尾に足す。** 途中へ入れると、すでに書かれた行が
    // 1つずつずれて、備考が「秒」の欄に出るようになる（過去の記録が読めなくなる）
    "| 時刻 | 機能 | モデル | 指示＋本文 | スキーマ | 本文% | 内訳 | 確保 | 入力tok | 出力tok | 秒 | 備考 | キャッシュ |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ].join("\n");
}

/**
 * 1回ぶんを表の1行にする。
 *
 * VS Code APIに触れないので、ここだけ単体テストできる。
 */
export function renderUsageRow(
  entry: UsageLogEntry,
  now: Date = new Date()
): string {
  const promptChars = entry.systemChars + entry.userChars;
  const cells = [
    formatLogTime(now),
    clean(entry.feature),
    `${clean(entry.model)}${entry.paid ? "・有料" : ""}`,
    num(promptChars),
    entry.schemaChars ? num(entry.schemaChars) : "",
    bodyShare(entry.parts, promptChars),
    formatParts(entry.parts),
    entry.numCtx ? num(entry.numCtx) : "",
    entry.usage ? num(entry.usage.inputTokens) : "",
    entry.usage ? num(entry.usage.outputTokens) : "",
    entry.elapsedMs === undefined ? "" : (entry.elapsedMs / 1000).toFixed(1),
    note(entry),
    cachedTokens(entry),
  ];
  return `\n| ${cells.join(" | ")} |`;
}

/**
 * 原稿そのものが占める割合。
 *
 * **内訳に「本文」が無ければ空にする。** 0%と書くと「本文を
 * 送っていない」ように読めるが、実際は「内訳を渡していない」だけである。
 */
function bodyShare(
  parts: Record<string, number> | undefined,
  promptChars: number
): string {
  const body = parts?.["本文"];
  if (body === undefined || promptChars <= 0) return "";
  return `${Math.round((body / promptChars) * 100)}%`;
}

/** 内訳を1つのセルに詰める。多い順に並べる（重いものから目に入る） */
function formatParts(parts: Record<string, number> | undefined): string {
  if (!parts) return "";
  const entries = Object.entries(parts).filter(([, chars]) => chars > 0);
  if (entries.length === 0) return "";
  return entries
    .sort((left, right) => right[1] - left[1])
    .map(([label, chars]) => `${clean(label)} ${num(chars)}`)
    .join("・");
}

/**
 * 備考。**失敗と切り詰めを見落とさないための欄**なので、
 * どちらも起きていなければ空にする（毎行に何か書くと目が滑る）。
 */
function note(entry: UsageLogEntry): string {
  const notes: string[] = [];
  if (entry.truncated) notes.push("**切り詰め**");
  if (entry.error) notes.push(`**失敗**: ${clean(entry.error)}`);
  return notes.join("／");
}

/**
 * 入力のうち、プロンプトキャッシュから読めた分。
 *
 * **0も書く。** 「対応しているのに効いていない」は、効かせる工夫をする
 * ときにいちばん知りたい数字で、空欄にすると気づけない。
 * 数を返さないAI（Ollamaなど）だけを空欄にする。
 */
function cachedTokens(entry: UsageLogEntry): string {
  const cached = entry.usage?.cachedInputTokens;
  return typeof cached === "number" ? num(cached) : "";
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * 表のセルに入れる。
 *
 * **縦棒を伏せる。** モデル名やエラー文に `|` が入ると表が崩れて、
 * その行から先が読めなくなる。改行も同じ理由でつぶす。
 */
function clean(text: string): string {
  return redactSecrets(text).replace(/\r?\n/g, " ").replace(/\|/g, "／").trim();
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}
