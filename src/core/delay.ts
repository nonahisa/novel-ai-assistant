/**
 * 指定のミリ秒だけ待つ（取り消しはできない単純な待ち）。
 *
 * ollamaLauncher と lmstudioLauncher が同じ3行を写して持っていた。
 * 取り消せる待ち（キャンセルトークンや AbortSignal つき）は別の部品なので、ここには含めない。
 * どこにも依存しない葉として置く。
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
