/**
 * git の失敗の文から、**画面に出す理由の行**を選ぶ（設計書5.5.21。2026-11-14 の作者の実機）。
 *
 * 書庫に 722MB の zip が入った回、「確認用コピー：記録できませんでした」の下に
 * `warning: in the working copy of '…', LF will be replaced by CRLF …` が並んだ。
 * git は改行の変換の warning を標準エラーの先頭へ出すので、最初の行を理由として
 * 見せると、本当の失敗（`error:`・`fatal:`・GitHub の断り）が埋もれる。
 *
 * **原因は当てない**（実装ルール5）。ここでするのは、warning と hint を外して
 * エラーの行を前に出すことだけで、文の言い換えはしない。全文はログへ残す
 * （呼び出し側。`describeFailure` などの戻り値は変えない）。
 */

/** 理由として見せる行の上限。長い断りの文で知らせが読めなくならないように */
const REASON_MAX_LINES = 6;

/** 理由から外す行（改行の変換の warning・git の助言） */
function isNoise(line: string): boolean {
  return /^(?:remote:\s*)?(?:warning|hint):/i.test(line);
}

/** 失敗そのものを言う行 */
function isErrorLine(line: string): boolean {
  return (
    /^(?:error|fatal):/i.test(line) ||
    /^remote:\s*(?:error|fatal)\b/i.test(line) ||
    /\[(?:remote )?rejected\]/.test(line) ||
    /\bGH\d{3}\b/.test(line)
  );
}

/**
 * 画面に出す理由の行。warning と hint だけで理由の行が無ければ undefined
 * （呼び出し側が終了コードと「ログにあります」を出す。空の理由は出さない）。
 */
export function pickGitFailureReason(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !isNoise(line));
  const errors = lines.filter(isErrorLine);
  const picked = [...new Set(errors.length > 0 ? errors : lines)].slice(0, REASON_MAX_LINES);
  return picked.length > 0 ? picked.join("\n") : undefined;
}

/**
 * 送り先が送信を**断った**か（受け取ったうえで、送り先の決まりで拒んだ）。
 *
 * git が送信の結果として出す参照ごとの行 `! [remote rejected]` で見る。git は言語を
 * 固定して起こしている（`core/git.ts` の `LC_ALL: "C"`）ので、この形は変わらない。
 *
 * - **回線が無いときはこの行が出ない**——届かなかっただけの失敗を「断られた」と言わない
 * - **`! [rejected]`（別の機械が先に送っていた・fetch first）は含めない。** 2台で書く
 *   作者には普通に起きることで、取り込めば通る。今までの案内（先に取り込む）のままにする
 *
 * ほかの文からは推し量らない（実装ルール5）。
 */
export function isPushRejected(text: string | undefined): boolean {
  if (!text) return false;
  return /\[remote rejected\]/.test(text);
}

/** 理由の行が無かったときの一文（終了コードは事実なので添える） */
export function noReasonText(code: number | undefined): string {
  return code === undefined
    ? "git が理由を出さずに止まりました（詳しくはログにあります）"
    : `git が理由を出さずに止まりました（終了コード ${code}。詳しくはログにあります）`;
}
