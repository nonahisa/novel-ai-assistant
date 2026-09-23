/**
 * 「打鍵が止まってから」1回だけ走らせる仕掛け。
 *
 * **VS Code の標準エディターでは、日本語の変換中の文字も打鍵のたびに本文へ
 * 入り、そのたびに `onDidChangeTextDocument` が届く**（作者の報告、
 * 2026-09-23：「変換時に入力が飛ぶ」）。その知らせで本文全体の装飾を
 * 付け直したり、本文全体の字数を数えたりすると、変換の途中に割り込んで
 * 文字が飛ぶ・変換が途切れることがある。
 *
 * そこで、打鍵で動く処理は**知らせが途切れてから**まとめて1回だけ走らせる。
 * 途切れる前に次の知らせが来たら、待ち直す（前の予約は捨てる）。
 *
 * vscode に依存させない（core に置き、テストで時計を進めて確かめるため）。
 */
export class TypingPause {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** この時刻までは、打鍵中とみなす（`holdUntilPause` が延ばす） */
  private quietAt = 0;

  constructor(
    private readonly run: () => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * 打鍵の知らせ。`delayMs` だけ静かになってから走らせる。
   * 打鍵中である印も残すので、あとから来た `schedule` はそれより早く走らない。
   */
  typed(delayMs: number): void {
    this.quietAt = Math.max(this.quietAt, this.now() + delayMs);
    this.arm(delayMs);
  }

  /**
   * 打鍵以外の知らせ（画面の切り替え・スクロールなど）。`delayMs` 後に走らせる。
   *
   * **ただし打鍵中なら、打鍵が止まるまで待つ。** 標準エディターでは、
   * 最後の行で打つと画面が送られて「見えている範囲が変わった」知らせも
   * 一緒に届く——それを短い待ち時間で走らせると、遅らせた意味が無くなる。
   */
  schedule(delayMs: number): void {
    const remaining = this.quietAt - this.now();
    this.arm(Math.max(delayMs, remaining));
  }

  /** 予約を捨てて、いま走らせる（保存・設定の変更など、打鍵でない知らせ用） */
  runNow(): void {
    this.cancel();
    this.run();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancel();
  }

  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, delayMs);
  }
}
