/**
 * MCP の返事の大きさの目安（設計書6.87.24。2026-10-16）。
 *
 * **呼び出し側には返事の大きさの上限がある。** Claude Code は既定で約25,000トークンを
 * 超えた道具の返事を会話へ入れず、ファイルへ逃がす（外部AIはそのまま読めない）。
 * 2026-10-16 に確認用の作品（24話）へ `novel.read` を撃った実測：
 * - 年表 72k字（うち和文26k字）→ **切られた**
 * - 相関図 45k字（うち和文1.7k字）→ 通った
 *
 * 字数で切ると、ASCII ばかりの相関図には厳しすぎ、和文の多い年表には緩すぎる。
 * そこで **和文（ASCII 以外）は1字≈1トークン、ASCII は3字≈1トークン** で見積もる。
 * この見積もりで年表は約41,000、相関図は約16,000になり、上の境目をちょうど説明する。
 *
 * 正確なトークン数は呼び出し側のトークナイザーにしか分からない（モデルで変わる）ので、
 * 数えずに見積もる。外れる向きに余裕を持たせるのは上限のほう（下の定数）で行う。
 */
export function estimateTokens(text: string): number {
  let nonAscii = 0;
  let ascii = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) nonAscii++;
    else ascii++;
  }
  return nonAscii + Math.ceil(ascii / 3);
}

/**
 * 読む口が1回で返す大きさの上限（見積もりトークン）。
 *
 * **12,000＝呼び出し側の上限（約25,000）の半分弱。** 半分まで下げるのは：
 * - 見積もりは粗い。漢字は1字で2トークン近くになることがあり、和文の多い返事ほど
 *   実際は見積もりより重い（年表がまさにそれ）
 * - 転送層が返事に断り書き（古い束・手元のAIの順番待ち・保管庫の場所）を足す
 * - Claude Code 以外の呼び出し側は、もっと小さな上限を持つことがある
 *
 * 大きくすると1回で読める話が増えるが、切られたときの害（何も読めない）のほうが
 * 大きいので、低めに置いて続きの印で読ませる。
 */
export const READ_RESULT_TOKEN_BUDGET = 12_000;

/** 実際に届く形（`server.ts` の `ok()` と同じ整形）で見積もる */
export function estimateResultTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value, null, 2));
}
