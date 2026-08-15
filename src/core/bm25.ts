/**
 * 語句一致による検索（BM25）。
 *
 * **AIも埋め込みモデルも要らない。** ベクトルDBを使わない設定でも、
 * また非力な機械でも動く。ここが「不使用」側の土台になる。
 *
 * ## なぜ文字2つ組み（bigram）で数えるか
 *
 * 日本語は語の間に空白が無いので、英語のように空白で切れない。
 * 形態素解析器を入れれば正確に切れるが、辞書込みで数十MBの依存が増え、
 * 拡張機能の配布物が重くなる。文字2つ組みは辞書が要らず、
 * 「嫉妬」「柔道」のような固有の語をきちんと拾える。
 *
 * 実データ（78.5万字・219話）で測ったところ、質問を検索語に直してから
 * 引けば、意味検索が取りこぼす問いを語句一致が1位で拾うことがあった
 * （「嫉妬」がその例）。逆に語句一致が取りこぼす問いもある。
 * **どちらか一方では足りない**ので、両方を持って混ぜる。
 *
 * VS Code APIに依存しない。
 */

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

/** BM25の調整値。情報検索で広く使われている既定値をそのまま使う */
const K1 = 1.2;
const B = 0.75;

interface IndexedDocument {
  id: string;
  counts: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private readonly docs: IndexedDocument[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(documents: readonly Bm25Document[]) {
    for (const document of documents) {
      const grams = bigrams(document.text);
      const counts = new Map<string, number>();
      for (const gram of grams) {
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
      this.docs.push({ id: document.id, counts, length: grams.length });
      for (const gram of counts.keys()) {
        this.documentFrequency.set(
          gram,
          (this.documentFrequency.get(gram) ?? 0) + 1
        );
      }
    }
    const total = this.docs.reduce((sum, doc) => sum + doc.length, 0);
    this.averageLength = this.docs.length > 0 ? total / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * 質問に近い順に返す。
   *
   * 一致が1つも無い文書は返さない。0点のものを混ぜると、
   * 呼び出し側が「上位n件」を取ったときに無関係な場面が紛れ込む。
   */
  search(query: string, limit: number): Bm25Hit[] {
    if (this.docs.length === 0 || limit <= 0) return [];

    // 同じ2つ組みを何度も数えない。質問側の重複は重みにしない
    const queryGrams = [...new Set(bigrams(query))];
    if (queryGrams.length === 0) return [];

    const hits: Bm25Hit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const gram of queryGrams) {
        const termFrequency = doc.counts.get(gram);
        if (!termFrequency) continue;
        const df = this.documentFrequency.get(gram) ?? 0;
        const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
        const norm =
          this.averageLength > 0 ? doc.length / this.averageLength : 1;
        score +=
          idf *
          ((termFrequency * (K1 + 1)) /
            (termFrequency + K1 * (1 - B + B * norm)));
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

/**
 * 文字2つ組みに割る。
 *
 * 空白と改行は落とす。小説は1行が短く改行が多いので、
 * 残すと「。\n「」のような組みばかりが増えて判定が鈍る。
 */
export function bigrams(text: string): string[] {
  const cleaned = text.replace(/[\s　]/g, "");
  // 絵文字や異体字で崩れないよう、コードポイント単位で扱う
  const chars = [...cleaned];
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars[i] + chars[i + 1]);
  }
  return grams;
}
