/**
 * 有料のAIを使う前に見せる断りの行（設計書7.1.1）。
 *
 * **中身の決め方はここ1か所。** 画面の確認（`features/aiConnectivity.ts` の
 * `confirmPaidUsage`）と、外から頼まれた実行の確認（設計書6.87.22）が
 * 同じ行を出す。写しを2つ持つと、片方だけ言い回しが変わった日に
 * 「同じAIなのに、頼まれ方で料金の断りが違う」ことになる。
 *
 * **サービス名は決め打ちしない**（CLAUDE.md 実装ルール5）。呼び出し側が
 * 渡した表示名（プロバイダの `displayName`）をそのまま使う。
 *
 * VS Code API にも Node にも依存しない（MCP の束からも読めるように）。
 */
export function paidUsageLines(
  providerName: string,
  model: string,
  options: {
    /** AIを何回呼ぶか。分かるときだけ */
    calls?: number;
    /** 追加の説明。処理の大きさが分かるもの */
    detail?: string;
  } = {}
): string[] {
  const lines = [
    `${providerName}（${model}）を使います。`,
    "実行するとトークンを消費し、利用量が加算されます。",
  ];
  if (options.calls !== undefined) {
    lines.push(
      options.calls === 1
        ? "AIの呼び出しは1回です。"
        : `AIの呼び出しは ${options.calls} 回です。`
    );
  }
  if (options.detail) lines.push(options.detail);
  lines.push("実際の金額はモデル・実使用量・各社の現行料金によって変わります。");
  return lines;
}
