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
 * 数字の裏付けがあっても、これより小さい本文には割らない（字）。
 *
 * **際限なく刻まないための底である。** 数百字まで刻めば入るとしても、
 * その大きさで送った結果は使いものにならない（前後の文脈が切れる）うえ、
 * 指示は1回ぶんまるごと付いて回るので、送信量ばかりが増える。
 * ここまで来たら「このモデルでは無理」と作者へ言うほうが正しい。
 */
export const OVERFLOW_MIN_BODY_CHARS = 500;

/**
 * あと何字なら本文を送れるのかを、失敗が持つ数字から割り出す。
 *
 * 超えたトークン数を、**関所が判断に使ったのと同じ換算**で字数へ戻し、
 * いまの本文から引く。返るのは「このチャンクの本文を何字まで減らせば
 * 入るか」で、資料や指示の量が変わらない前提での値である。
 *
 * 数字が付いていない失敗（サーバーが返した400など）では `undefined`。
 * **分からないときは、これまでどおりの底で扱う**——入るかどうか
 * 分からないまま刻む道を作らない。
 */
function bodyCharsThatFit(chunk: Chunk, error: AIError): number | undefined {
  const facts = error.overflow;
  if (!facts) return undefined;
  const excessTokens = facts.needTokens - facts.limitTokens;
  if (!Number.isFinite(excessTokens) || excessTokens <= 0) return undefined;
  if (!Number.isFinite(facts.tokensPerChar) || facts.tokensPerChar <= 0) {
    return undefined;
  }
  return chunk.text.length - Math.ceil(excessTokens / facts.tokensPerChar);
}

/**
 * 上限に入らなかったチャンクの扱いを決める。**判断だけで、副作用は持たない。**
 *
 * 順は「まとめたぶんを戻す → 半分に割る → 諦める」。まとめたものを
 * 先に戻すのは、そのほうが内訳を保てるからである（`splitForRetry`）。
 *
 * ## 割るのをやめる底
 *
 * ふだんの底は `MIN_CHUNK_CHARS`（1,500字）である。これより小さくすると
 * 文の途中で切れて、誤検出のもとになる。
 *
 * **ただし、入ると計算できたときだけは、この底より下へ降りる。**
 * 設定資料の抽出は、進むほど【既知の登場人物】などが肥えるので、
 * 本文が小さいチャンクでも入らなくなる。2026-09-19の実機では、
 * 最後に1話だけ残った2,343字のチャンクが1%（342トークン）超え、
 * 半分にすれば通ったのに「1,500字を割る」という理由で捨てられた。
 * **本文が小さいのに入らないのは本文のせいではない**ので、
 * 「このモデルでは扱えない」と言うのは嘘になる。
 *
 * 降りるのは、失敗が数字の内訳（`AIError.overflow`）を持っているときだけ
 * ——**入ると計算できていないのに刻むのは、ただの当てずっぽう**である。
 *
 * ## 本文を削っても入らないとき
 *
 * 指示と資料だけで上限に届いていることがある。そこで刻み続けても、
 * 入らない呼び出しが増えるだけなので、**割らずに諦めて理由を言う。**
 * このとき「本文を小さく分けてください」と案内してはいけない——
 * 作者は何度分けても直らない操作を繰り返すことになる。
 */
export function retryOnOverflow(chunk: Chunk, error: AIError): OverflowRetry {
  const room = bodyCharsThatFit(chunk, error);
  if (room !== undefined && room < OVERFLOW_MIN_BODY_CHARS) {
    return {
      kind: "give_up",
      // **数字は落とさない**（下の give_up と同じ理由）。ただし直し方は
      // 本文ではなく、資料とモデルのほうを指す
      note:
        `指示と資料だけでモデルの上限に届いています。${error.message}` +
        "本文を分けても直らないので、参照する資料を減らすか、" +
        "コンテキスト長の大きいモデルを選んでください。",
    };
  }

  const parts = splitForRetry(chunk, floorFor(chunk, room));
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

/**
 * このチャンクを割るときの底。
 *
 * **裏付けが無ければ、これまでどおり1,500字。** 裏付けがあるときだけ、
 * 半分に割れるところまで降りる——`splitChunkInHalf` は「底の2倍の長さが
 * 無ければ割らない」ので、いまの長さの半分を底にすれば必ず1回は割れる。
 *
 * **一度に必要なだけ刻まないのは、刻みすぎないためである。** 割った先は
 * もう一度関所が測るので、まだ入らなければそのときまた半分になる。
 * 1回ごとに確かめながら降りるほうが、余計に細かくならない。
 */
function floorFor(chunk: Chunk, room: number | undefined): number {
  if (room === undefined) return MIN_CHUNK_CHARS;
  return Math.max(
    OVERFLOW_MIN_BODY_CHARS,
    Math.min(MIN_CHUNK_CHARS, Math.floor(chunk.text.length / 2))
  );
}

/** その失敗が「入らなかった」ものか */
export function isContextOverflow(error: unknown): error is AIError {
  return error instanceof AIError && error.kind === "context_overflow";
}
