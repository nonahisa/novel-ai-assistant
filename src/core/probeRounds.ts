/**
 * AIチューニングの探索が、あと最大何回送るか（作者の裁定、2026-10-03
 * 「あと何回の見込みを出す」。設計書6.49.3）。
 *
 * 読める長さ（`contextProbe.ts`）も書ける量（`outputProbe.ts`）も、
 * 「状態と、直前の回が通ったか」から次を決める二分探索である。
 * **次の決め方そのものを使って、通った・通らなかったの両方へ枝を伸ばし、
 * 長いほうの枝の回数を数える。** 決め方を写して式で見積もると、探索の
 * 決まり（跳び方・打ち切りの幅・下限）を直したときに黙ってずれる。
 *
 * 数えるのは**長さを変えて送る回**だけ。時間切れで待ち時間を延ばして
 * 同じ長さを送り直す回・分あたりの上限で待って送り直す回は入らない
 * （画面では「測り直しを除く」と添える）。
 *
 * VS Code に依存しない。
 */

/** 枝を伸ばす深さの上限。二分探索なので実際は20にも届かない（念のための歯止め） */
const MAX_DEPTH = 40;

/**
 * いまの状態から、この回を含めてあと最大何回送るか。終わっていれば 0。
 */
export function maxProbeRounds<S>(
  state: S | undefined,
  next: (state: S, passed: boolean) => S | undefined
): number {
  const walk = (current: S | undefined, depth: number): number => {
    if (current === undefined || depth >= MAX_DEPTH) return 0;
    return (
      1 +
      Math.max(
        walk(next(current, true), depth + 1),
        walk(next(current, false), depth + 1)
      )
    );
  };
  return walk(state, 0);
}

/** 進み具合の一文に添える「（N回目・あと最大M回）」 */
export function describeProbeProgress(round: number, remaining: number): string {
  // この回を含めた残りから、この回を引いたものが「このあと」の回数
  const after = Math.max(0, remaining - 1);
  return after > 0
    ? `（${round}回目・このあと最大${after}回。測り直しを除く）`
    : `（${round}回目・これが最後の見込み）`;
}
