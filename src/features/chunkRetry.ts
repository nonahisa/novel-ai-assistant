import {
  MIN_CHUNK_CHARS,
  splitChunkInHalf,
  splitMergedChunk,
  type Chunk,
} from "../core/chunker";
import { AIError, recoveryForAIError } from "../ai/types";

/**
 * 「入らなかった」ときの逃げ道（設計書6.27.10）。
 *
 * 上限の関所（`ai/contextGuard.ts`）は、入らないものを送らずに止める。
 * **止めただけでは、そのチャンクは検査されないまま終わる**ので、
 * 小さくして試し直す道をここに1つだけ置く。
 *
 * **黙って切り捨てる経路を残さないのが目的である。** 小さくしても
 * 入らないなら、そのチャンクは「失敗」として数え、理由を作者へ見せる。
 * 何も言わずに飛ばすと、作者には「その話には何も無かった」と見える。
 */

/**
 * 分け直せるチャンクを作る。
 *
 * **まとめたものは必ず話ごとに戻す。半分に割ってはいけない。**
 * 半分に割ると内訳（どこからどこまでが何話か）が消え、登場話数が
 * まとめた範囲ぜんぶになる（第4話にしか出ない人物が「第4〜6話に登場」に
 * なる）。話ごとに戻せないもの（1話が大きすぎる場合）だけ半分に割る。
 *
 * @param minChars これ以上小さくは割らない字数
 */
export function splitForRetry(
  chunk: Chunk,
  minChars?: number
): Chunk[] | undefined {
  const byEpisode = splitMergedChunk(chunk);
  if (byEpisode.length > 1) return byEpisode;
  return splitChunkInHalf(chunk, minChars);
}

/** 上限に入らなかったチャンクを、どう扱うか */
export type OverflowRetry =
  /** 小さくして試し直す */
  | { kind: "split"; parts: Chunk[]; note: string }
  /** 小さくしても入らない。失敗として数え、次のチャンクへ進む */
  | { kind: "give_up"; note: string };

/**
 * 上限に入らなかったチャンクの扱いを決める。**判断だけで、副作用は持たない。**
 *
 * 順は「まとめたぶんを戻す → 半分に割る → 諦める」。まとめたものを
 * 先に戻すのは、そのほうが内訳を保てるからである（`splitForRetry`）。
 *
 * 割るのをやめる底は `MIN_CHUNK_CHARS`（1,500字）。これより小さくすると
 * 文の途中で切れて、誤検出のもとになる。**底でも入らないなら、それは
 * このモデルでは扱えないということ**であり、作者に伝えるのが正しい。
 */
export function retryOnOverflow(chunk: Chunk, error: AIError): OverflowRetry {
  const parts = splitForRetry(chunk, MIN_CHUNK_CHARS);
  if (parts && parts.length > 1) {
    return {
      kind: "split",
      parts,
      note: `モデルの上限に入らないため、${parts.length}件に分けて試し直します`,
    };
  }
  return {
    kind: "give_up",
    // **必要量と上限の数字を落とさない。** それが作者の唯一の手がかりで、
    // 「大きいモデルにすれば足りるのか」を判断できる材料である
    note: `このモデルには入りません。${error.message}${recoveryForAIError(error)}`,
  };
}

/** その失敗が「入らなかった」ものか */
export function isContextOverflow(error: unknown): error is AIError {
  return error instanceof AIError && error.kind === "context_overflow";
}
