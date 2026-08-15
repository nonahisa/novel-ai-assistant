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
 * ## なぜ「転置」した形で持つか
 *
 * 最初は**チャンクごとに「2つ組み→回数」のMap**を持っていた。素直だが、
 * 同じ2つ組みが何百のチャンクに現れるため、**同じ文字列を何度も抱える**。
 * 実データで測ると 78.5万字の作品で **54.5MB**（本文の25倍）になっていた。
 * 内訳は 81.7万件の項目に対し、2つ組みの種類はわずか 5.8万件。
 * **平均14.1回ずつ重複して持っていた。**
 *
 * そこで「2つ組み→それが出てくるチャンクの並び」へ裏返し、
 * チャンク側の情報は数値の並び（TypedArray）で持つ。
 * 文字列は種類のぶんだけになり、数値は1件8バイトで済む。
 *
 * 検索も速くなる。以前は全チャンクを走査していたが、
 * いまは**その語を含むチャンクだけ**を見る。
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

export class Bm25Index {
  private readonly ids: string[] = [];
  private readonly lengths: Int32Array;
  private readonly averageLength: number;

  /** 2つ組み → 通し番号。**文字列はここにしか持たない** */
  private readonly termIds = new Map<string, number>();
  /** 通し番号ごとの、postings の開始位置（末尾に番兵を1つ置く） */
  private readonly termStart: Int32Array;
  /** postings：その語が出てくるチャンクの番号 */
  private readonly postingDocs: Int32Array;
  /** postings：そのチャンクでの出現回数 */
  private readonly postingCounts: Int32Array;

  constructor(documents: readonly Bm25Document[]) {
    const grams: Array<Map<number, number>> = [];
    const lengths: number[] = [];

    // 1周目：語に通し番号を振り、チャンクごとの回数を数える
    for (const document of documents) {
      this.ids.push(document.id);
      const list = bigrams(document.text);
      lengths.push(list.length);

      const counts = new Map<number, number>();
      for (const gram of list) {
        let id = this.termIds.get(gram);
        if (id === undefined) {
          id = this.termIds.size;
          this.termIds.set(gram, id);
        }
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      grams.push(counts);
    }

    this.lengths = Int32Array.from(lengths);
    const total = lengths.reduce((sum, n) => sum + n, 0);
    this.averageLength = lengths.length > 0 ? total / lengths.length : 0;

    // 2周目：語ごとの件数を数えて、並びの置き場所を決める
    const termCount = this.termIds.size;
    const perTerm = new Int32Array(termCount);
    let entries = 0;
    for (const counts of grams) {
      for (const id of counts.keys()) {
        perTerm[id]++;
        entries++;
      }
    }

    this.termStart = new Int32Array(termCount + 1);
    for (let i = 0; i < termCount; i++) {
      this.termStart[i + 1] = this.termStart[i] + perTerm[i];
    }

    // 3周目：実際に詰める
    this.postingDocs = new Int32Array(entries);
    this.postingCounts = new Int32Array(entries);
    const cursor = Int32Array.from(this.termStart.subarray(0, termCount));
    grams.forEach((counts, docIndex) => {
      for (const [id, count] of counts) {
        const at = cursor[id]++;
        this.postingDocs[at] = docIndex;
        this.postingCounts[at] = count;
      }
    });
  }

  get size(): number {
    return this.ids.length;
  }

  /**
   * 質問に近い順に返す。
   *
   * 一致が1つも無い文書は返さない。0点のものを混ぜると、
   * 呼び出し側が「上位n件」を取ったときに無関係な場面が紛れ込む。
   */
  search(query: string, limit: number): Bm25Hit[] {
    if (this.ids.length === 0 || limit <= 0) return [];

    // 同じ2つ組みを何度も数えない。質問側の重複は重みにしない
    const queryGrams = [...new Set(bigrams(query))];
    if (queryGrams.length === 0) return [];

    const scores = new Float64Array(this.ids.length);
    const touched = new Set<number>();

    for (const gram of queryGrams) {
      const id = this.termIds.get(gram);
      if (id === undefined) continue;

      const from = this.termStart[id];
      const to = this.termStart[id + 1];
      const df = to - from;
      if (df === 0) continue;

      const idf = Math.log(1 + (this.ids.length - df + 0.5) / (df + 0.5));

      for (let i = from; i < to; i++) {
        const doc = this.postingDocs[i];
        const termFrequency = this.postingCounts[i];
        const norm =
          this.averageLength > 0 ? this.lengths[doc] / this.averageLength : 1;
        scores[doc] +=
          idf *
          ((termFrequency * (K1 + 1)) /
            (termFrequency + K1 * (1 - B + B * norm)));
        touched.add(doc);
      }
    }

    // 文書の並び順で集める。点が同じときの前後関係を、
    // 以前の作り（全件を順に見る形）と揃えるため
    const hits: Bm25Hit[] = [];
    for (let doc = 0; doc < this.ids.length; doc++) {
      if (!touched.has(doc)) continue;
      if (scores[doc] <= 0) continue;
      hits.push({ id: this.ids[doc], score: scores[doc] });
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
