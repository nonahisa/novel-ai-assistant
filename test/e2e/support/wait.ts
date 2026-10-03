/**
 * 条件が満たされるまで待つ（画面の自動テスト、設計書6.113）。
 *
 * **固定の sleep を使わない。** 機械の速さで待ち時間が足りたり足りなかったりして、
 * 通ったり落ちたりする検査になる。
 */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) {
      throw new Error(`${label}を${timeoutMs}ミリ秒待ちましたが、そうなりません`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 条件が `holdMs` のあいだ**ずっと**満たされていることを確かめる。
 *
 * 「2枚目が開かない」のように**起きないこと**を見るときに使う。
 * 一度見ただけでは、少し遅れて開く2枚目を見逃す。崩れたらその場で落とす。
 */
export async function holdsFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  holdMs = 3_000
): Promise<void> {
  const until = Date.now() + holdMs;
  while (Date.now() < until) {
    if (!(await check())) throw new Error(`${label}が崩れました`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
