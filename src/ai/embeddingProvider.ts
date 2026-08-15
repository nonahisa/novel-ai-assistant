/**
 * 埋め込み（文章をベクトルに変える）の窓口。
 *
 * ## なぜOllama（手元・無料）だけにするか
 *
 * 3つ理由がある。
 *
 * 1. **Claudeには埋め込みのAPIが無い。** Anthropicは自前で持たず、
 *    Voyage AIという別サービスを勧めている。つまりClaudeを選んでいる
 *    作者には、そもそもクラウドでの手段が無い。
 *
 * 2. **量が多く、料金が読みにくい。** 78.5万字の作品で2,541件を
 *    埋め込む。本文を直したびに作り直しも要る。有料APIだと
 *    「相談しただけなのに課金された」という驚きになりやすい。
 *    この拡張機能は、有料AIを使う前に必ず知らせる約束をしている。
 *
 * 3. **手元なら無料で、実測39秒だった。** 待てる速さである。
 *
 * したがって、埋め込みが使えるのはOllamaがある環境だけ。
 * 無ければ意味検索を切り、**語句一致だけで動かす**。
 * 語句一致でも、質問を検索に使うぶん今より良くなる。
 */

export type EmbeddingErrorKind =
  | "not_running"
  | "model_missing"
  | "timeout"
  | "unknown";

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly kind: EmbeddingErrorKind,
    /** 作者が次に取れる操作を1つだけ示す */
    readonly nextStep: string
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export interface EmbeddingProvider {
  /** 画面に出す名前 */
  readonly label: string;
  /** 索引の鍵に入れる。変わったら索引を作り直す */
  readonly model: string;
  /**
   * 文章をベクトルにする。
   *
   * まとめて渡せるようにしてある。1件ずつ呼ぶと通信の往復で遅くなる。
   */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** すぐ使える状態か。使えないなら理由を返す */
  check(): Promise<{ ok: true } | { ok: false; error: EmbeddingError }>;
}
