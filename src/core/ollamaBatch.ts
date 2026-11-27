/**
 * Ollama へ送る `num_batch`（本文を一度にまとめて読む量）を決める（設計書6.53.4）。
 *
 * ## なぜ送るか
 *
 * Ollama の既定は 512。**部品を分けたモデル（MoE）が GPU に入りきらず、一部を
 * CPU に置いているとき**は、まとめて読む量を増やすと読みが速くなる長さがある
 * （2026-11-28 実測。RTX 4060 Ti 8GB・gemma4:26b・誤字脱字の8,000字＝約5,500トークン、
 * 答えの形の指定 `format` あり＝製品のチェックと同じ送り方、3回の中央値）。
 *
 * | num_ctx | 512（既定） | 2048 |
 * |---|---|---|
 * | 8k・12k | 14.0〜15.9秒 | **変わらない**（読み 620〜630 tok/s。3回測って同じ） |
 * | 16k | 15.1秒 | **10.4秒**（読み 675 → 1,470 tok/s） |
 * | 20k | 14.9秒 | **11.0秒** |
 * | 24k | 16.8秒 | **10.9秒** |
 * | 32k | 17.4秒 | **13.2秒** |
 * | 64k | 13.1秒 | 15.4秒（遅くなる。format なしで測った） |
 *
 * 製品の道（`OllamaProvider`・流し受信・format あり・num_ctx 16k）でも、読みが
 * 8.2〜8.5秒 → 3.8秒、1回が 12〜13秒 → 8〜10秒になった。e4b（全部 GPU）は
 * 変わらない。4096 は 2048 より遅かった。
 *
 * **12k 以下で効かない理由は分かっていない**（format なしでは 12k でも効いた）。
 * 測った結果に合わせて、効いた長さの内側だけで送る。
 *
 * ## 送る条件（3つともそろったときだけ）
 *
 * 1. **部品を分けたモデル**（`/api/show` で部品の数が読めた）。部品を分けない
 *    モデルでは測っていない
 * 2. **GPU と CPU に分けて載っている**（`/api/ps` の `size` が `size_vram` より
 *    大きい。`core/gpuLoad.ts` の `isSplitAcrossCpu`）。全部 GPU に載るモデルは
 *    速くならない
 * 3. **`num_ctx` が下限以上・上限以下**（`NUM_BATCH_MIN_CONTEXT`〜`NUM_BATCH_MAX_CONTEXT`）
 *
 * どれか1つでも分からなければ送らない（今までの動きのまま）。
 *
 * ## 読み込み直し
 *
 * Ollama は `num_batch` が変わるとモデルを読み込み直す（26b で約15秒）。
 * `num_ctx` も長さの段（4096 ごと）が変わるたびに読み込み直しになっている
 * （設計書6.53）ので、範囲の出入りはもともと読み込み直しの回に重なる。
 * **増えるのは「分けて載っている」と初めて分かった直後の1回だけ**で、
 * 1回あたり約4秒縮むので、4回目あたりから取り返す。
 *
 * VS Code には触らない（`core` の純粋な部品）。
 */

/** 送る量。測った中でいちばん速かった値 */
export const MOE_NUM_BATCH = 2048;

/** 送る `num_ctx` の下限。format ありの 8k・12k では速くならなかった */
export const NUM_BATCH_MIN_CONTEXT = 16_384;

/**
 * 送る `num_ctx` の上限（これより長い回では送らない）。
 *
 * 32k まで速くなり、64k で遅くなった。そのあいだは測っていないので、
 * 速くなると確かめた 32k までにする。
 */
export const NUM_BATCH_MAX_CONTEXT = 32_768;

export interface NumBatchInput {
  /** 今回送る `num_ctx` */
  readonly numCtx: number;
  /** 部品を分けたモデルか（`/api/show` で部品の数が読めたか） */
  readonly mixtureOfExperts: boolean;
  /**
   * そのモデルが GPU と CPU に分けて載っているか。`/api/ps` で見えなければ
   * undefined（分からない）
   */
  readonly splitAcrossCpu: boolean | undefined;
}

/** 送る `num_batch`。送らないときは undefined */
export function decideOllamaNumBatch(input: NumBatchInput): number | undefined {
  if (!needsResidencyCheck(input)) return undefined;
  return input.splitAcrossCpu === true ? MOE_NUM_BATCH : undefined;
}

/**
 * `/api/ps` を読む値打ちがあるか（部品を分けたモデルで、効く長さの回か）。
 *
 * **ほかの回では読まない**——全部 GPU に載るモデルや範囲の外の回で、1回ぶんの
 * 往復を増やさないため。
 */
export function needsResidencyCheck(
  input: Pick<NumBatchInput, "numCtx" | "mixtureOfExperts">
): boolean {
  return (
    input.mixtureOfExperts &&
    input.numCtx >= NUM_BATCH_MIN_CONTEXT &&
    input.numCtx <= NUM_BATCH_MAX_CONTEXT
  );
}
