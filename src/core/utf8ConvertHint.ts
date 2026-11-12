/**
 * 「原稿を UTF-8 に変換する」へ案内する文とボタン（設計書5.4.2、0.149.0）。
 *
 * 作者の指示（2026-11-09）：「知らせる時は、原稿の文字コード変換を案内してください」。
 * Shift_JIS で書けない字を知らせる所（保存で〓にした窓・校正・メモパネルの〓の行・
 * 書き戻しを止めた知らせ）が、**同じ文と同じボタンの名前**を使うように、ここ1か所に置く。
 *
 * `iconv` も `vscode` も読まない——校正・メモパネルの行（`sjisMarkFinding.ts`）や
 * MCP の書き戻し（`mcp/tools/bodyWrite.ts`）からも読むため。
 */

/** 案内の文（作者の言葉の形で決めた文。知らせの文の後ろに添える） */
export const UTF8_CONVERT_HINT = "この原稿を UTF-8 に変換すれば、この字もそのまま書けます。";

/**
 * ボタンを置けない所（校正・メモパネルの行・パネルの状態欄・MCP の答え）に添える、命令の場所。
 * 作品一覧の話のメニューは、どの画面で開いていても同じ所にある。
 *
 * **OS で変わる言い方（右クリック）を入れない。** 校正・メモパネルの行の説明は同期される置き場
 * （`.aiwriter/findings.jsonl`）に残り、書いた OS の言い方がほかの OS の画面に出るため
 */
export const UTF8_CONVERT_WHERE = "（作品一覧のこの話のメニュー →「原稿 UTF-8 変換」）";

/** 失敗の詳しい文（`encoding_error` の `detail`。句点が無い）を、案内の前に置ける1文にする */
export function asSentence(detail: string | undefined): string {
  if (!detail) return "";
  return /[。．]$/.test(detail) ? detail : `${detail}。`;
}

/** 知らせに添えるボタン */
export const UTF8_CONVERT_BUTTON = "UTF-8 に変換する";

/** 変換の命令 */
export const CONVERT_TO_UTF8_COMMAND = "novelai.convertToUtf8";

/**
 * 知らせのボタンから命令へ渡す引数（「この原稿」を指す）。作品一覧の話の行
 * （`EpisodeNode`）は持てないので、ファイルの場所だけを渡す
 */
export interface Utf8ConvertFileArg {
  type: "utf8File";
  filePath: string;
}

export function utf8ConvertFileArg(filePath: string): Utf8ConvertFileArg {
  return { type: "utf8File", filePath };
}

export function isUtf8ConvertFileArg(value: unknown): value is Utf8ConvertFileArg {
  if (typeof value !== "object" || value === null) return false;
  const arg = value as { type?: unknown; filePath?: unknown };
  return arg.type === "utf8File" && typeof arg.filePath === "string";
}
