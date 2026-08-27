import { Bm25Index } from "./bm25";
import type { RetrievalItem, RetrievalSource } from "./retrievalCorpus";
import type { VectorIndex } from "./vectorIndex";

/**
 * 質問に近い材料を選び、AIへ渡せる形にまとめる。
 *
 * ## いまのやり方の何が問題だったか
 *
 * 設定資料パネルの相談は、名前が出てくる場面を集めて
 * **作品全体から均等に間引く**だけで、質問文を検索に使っていなかった。
 * 実データ（マイナ先生・978回登場）で測ると、名前を含む場面733件のうち
 * 渡していたのは30件（4.1%）で、しかも**どの質問でも中身が同じ**だった。
 *
 * 「答えの語が渡した12,000字に入っているか」で数えると：
 *   均等間引き 1/5 → 質問で並べ替え 3/5 → 検索語に直して半々 5/5
 *
 * ## なぜ2つの検索を混ぜるか
 *
 * 問題によって、どちらが当たるかが入れ替わる。
 *   「嫉妬」    → 語句一致が1位、意味検索は圏外
 *   「傷口を洗う薬」→ 意味検索が2位、語句一致は圏外
 *
 * **順位を足し込む（RRF）と両方薄まって悪くなる**（実測で5位以内が
 * 6/6→4/6へ低下）。交互に詰めるほうが、片方が強い問題を潰さない。
 *
 * ## 意味検索を使わない設定でも動く
 *
 * 非力な機械では埋め込みモデルを回せない。そのときは語句一致だけで動く。
 * **それでも今より良い。** 質問を検索に使うようになるからである。
 *
 * VS Code APIに依存しない。
 */

export interface RetrievalCandidate {
  item: RetrievalItem;
  /** どの検索で見つかったか。作者に説明するために持つ */
  foundBy: "意味検索" | "語句一致" | "両方";
}

export interface RetrievalOptions {
  /** 渡す文字数の上限 */
  maxChars: number;
  /** 各検索から取る件数 */
  perMethod?: number;
  /** この出どころだけに絞る。設定資料パネルなど、対象が決まっているとき */
  sources?: RetrievalSource[];
  /** この語を含む材料だけに絞る。人物の相談で、その人の場面に限るため */
  mustInclude?: string[];
}

const DEFAULT_PER_METHOD = 20;

export interface SearchInput {
  items: readonly RetrievalItem[];
  bm25: Bm25Index;
  /** 検索に使う文字列（質問そのもの、または検索語へ直したもの） */
  query: string;
  /** 意味検索の材料。無ければ語句一致だけで動く */
  semantic?: {
    index: VectorIndex;
    queryVector: Float32Array;
  };
}

/**
 * 質問に近い材料を並べる。
 *
 * 意味検索が使えないときは語句一致だけで返す。
 * **どちらも0件なら空を返す。** 苦し紛れに冒頭を返すと、
 * 「関係のある場面が見つかった」と誤解させる。
 */
export function retrieve(
  input: SearchInput,
  options: RetrievalOptions
): RetrievalCandidate[] {
  const perMethod = options.perMethod ?? DEFAULT_PER_METHOD;
  const pool = filterItems(input.items, options);
  if (pool.length === 0) return [];

  const byId = new Map(pool.map((item) => [item.id, item]));
  const allowed = new Set(byId.keys());

  // 母集団を索引へ渡してから引く。以前は索引全体から多め（perMethod*3）に
  // 引いてからふるいにかけており、mustInclude で数十件まで狭めた相談では
  // 全体の上位に母集団の文書が残らず、語句一致が丸ごと空になっていた
  // （設計書6.27.6）。意味検索側が pool を渡しているのと同じ形へ揃える
  const lexical = input.bm25
    .search(input.query, perMethod, allowed)
    .map((hit) => hit.id);

  const semantic = input.semantic
    ? input.semantic.index
        .search(
          input.semantic.queryVector,
          pool.map((item) => ({ id: item.id, hash: item.hash })),
          perMethod
        )
        .map((hit) => hit.id)
    : [];

  const semanticSet = new Set(semantic);
  const lexicalSet = new Set(lexical);

  const ordered: RetrievalCandidate[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    const item = byId.get(id);
    if (!item) return;
    seen.add(id);
    ordered.push({
      item,
      foundBy:
        semanticSet.has(id) && lexicalSet.has(id)
          ? "両方"
          : semanticSet.has(id)
            ? "意味検索"
            : "語句一致",
    });
  };

  // 交互に詰める。片方しか無ければそちらだけになる
  for (let i = 0; i < perMethod; i++) {
    if (semantic[i]) push(semantic[i]);
    if (lexical[i]) push(lexical[i]);
  }

  return trimToBudget(ordered, options.maxChars);
}

function filterItems(
  items: readonly RetrievalItem[],
  options: RetrievalOptions
): RetrievalItem[] {
  let pool = [...items];
  if (options.sources && options.sources.length > 0) {
    const wanted = new Set(options.sources);
    pool = pool.filter((item) => wanted.has(item.source));
  }
  if (options.mustInclude && options.mustInclude.length > 0) {
    const terms = options.mustInclude.filter((term) => term.trim());
    if (terms.length > 0) {
      pool = pool.filter((item) =>
        terms.some((term) => item.text.includes(term))
      );
    }
  }
  return pool;
}

function trimToBudget(
  candidates: RetrievalCandidate[],
  maxChars: number
): RetrievalCandidate[] {
  const out: RetrievalCandidate[] = [];
  let total = 0;
  for (const candidate of candidates) {
    const size = candidate.item.text.length;
    if (total + size > maxChars) {
      // 1件目から入らないときだけ、切り詰めてでも1件は渡す
      if (out.length === 0) out.push(candidate);
      break;
    }
    out.push(candidate);
    total += size;
  }
  return out;
}

/**
 * AIへ渡す文章に組み立てる。
 *
 * **出どころを必ず書く。** 設定資料とあらすじは本文からAIが作ったもので、
 * 本文と対等な証言ではない。実データで、設定資料が本文に無い血縁関係を
 * 書いており、それが混ざった索引を通してAIの答えへ入り込んだ例がある。
 * どこ由来かを見せておけば、AIにも作者にも区別がつく。
 */
export function formatForPrompt(candidates: readonly RetrievalCandidate[]): string {
  return candidates
    .map((candidate) => {
      const { item } = candidate;
      const note = item.authorWritten ? "・作者記述" : "";
      return `《${item.source}${note}／${item.label}》\n${item.text}`;
    })
    .join("\n\n");
}

/** 作者に見せる短い説明。どこから何件拾ったか */
export function describeRetrieval(
  candidates: readonly RetrievalCandidate[]
): string {
  if (candidates.length === 0) return "関係する場面は見つかりませんでした";
  const counts = new Map<RetrievalSource, number>();
  for (const candidate of candidates) {
    counts.set(
      candidate.item.source,
      (counts.get(candidate.item.source) ?? 0) + 1
    );
  }
  const parts = [...counts.entries()].map(([source, count]) => `${source}${count}件`);
  return `${parts.join("・")}を参照`;
}
