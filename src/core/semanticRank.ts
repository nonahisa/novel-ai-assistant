/**
 * ベクトル検索の索引を「相談以外」で使うための計算（設計書6.19.10）。
 *
 * 相談（`retrieval.ts`）は質問1つに近いものを引くだけだったが、
 * 場面検索・矛盾検知・伏線の回収・執筆再開・似た場面の検出では、
 * **複数の問いのうちどれかに近いもの**や、**場面どうしの近さ**が要る。
 * その計算をここに1つだけ置く（機能ごとに近さの式を写さない）。
 *
 * **VS Code API にも索引の置き場にも依らない。** ベクトルは
 * `VectorLookup`（ハッシュ → ベクトル）で受け取る。索引の読み書きは
 * `vectorIndex.ts`、どの作品で使えるかの判断は `features/vectorSearch.ts`。
 */

/** 内容ハッシュからベクトルを引く口。索引に無ければ undefined */
export type VectorLookup = (hash: string) => Float32Array | undefined;

/** 長さを1に揃えたベクトルを作る。長さ0なら undefined（向きが無い） */
function unit(vector: Float32Array): Float32Array | undefined {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum);
  if (length === 0) return undefined;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / length;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

export interface RankOptions {
  limit: number;
  /**
   * これより遠いもの（コサイン類似度が下）は並べない。
   *
   * **意味検索は、関係が無くても「いちばん近いもの」を必ず返す。**
   * 材料へ足す使い方（矛盾検知の過去の場面）では、下限が無いと
   * 無関係な場面が毎回入る。
   */
  minScore?: number;
}

/**
 * 候補を、問いのうち**いちばん近いもの**との近さで並べる。
 *
 * 問いが複数あるのは、チャンク（数千字）を1本のベクトルにすると
 * 中身が平均されてぼやけるからである。場面（400字）ごとのベクトルを
 * 問いにし、どれか1つに近ければ関係があると読む。
 *
 * 索引に無い候補は並べない。近さが同じなら渡した順を保つ（並びを揺らさない）。
 */
export function rankByNearest(
  queries: readonly Float32Array[],
  candidates: readonly { id: string; hash: string }[],
  lookup: VectorLookup,
  options: RankOptions
): Array<{ id: string; score: number }> {
  if (options.limit <= 0) return [];
  const units = queries
    .map((query) => unit(query))
    .filter((query): query is Float32Array => query !== undefined);
  if (units.length === 0) return [];

  const scored: Array<{ id: string; score: number; order: number }> = [];
  candidates.forEach((candidate, order) => {
    const stored = lookup(candidate.hash);
    if (!stored) return;
    const vector = unit(stored);
    if (!vector) return;
    let best = -Infinity;
    for (const query of units) {
      const score = dot(query, vector);
      if (score > best) best = score;
    }
    if (options.minScore !== undefined && best < options.minScore) return;
    scored.push({ id: candidate.id, score: best, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored
    .slice(0, options.limit)
    .map(({ id, score }) => ({ id, score }));
}

/**
 * 1本のベクトルと、いくつかのベクトルのうち最も近いものとの近さ。
 * 測れない（どちらも長さ0・空）なら undefined。
 */
export function bestSimilarity(
  vectors: readonly Float32Array[],
  target: Float32Array
): number | undefined {
  const goal = unit(target);
  if (!goal) return undefined;
  let best: number | undefined;
  for (const vector of vectors) {
    const other = unit(vector);
    if (!other) continue;
    const score = dot(goal, other);
    if (best === undefined || score > best) best = score;
  }
  return best;
}

/** 似た場面の組を探す相手1件 */
export interface PairItem {
  id: string;
  hash: string;
  /** どの話か。**同じ話の中の組は出さない** */
  group: string;
  /** 話の中の何番目の場面か。隣どうしを1組へまとめるのに使う */
  position: number;
}

export interface SimilarPair {
  a: string;
  b: string;
  score: number;
  /**
   * この組の片側（`near`。`a` か `b`）と同じ場面・隣の場面が、ほかにも近い
   * 相手（`id`）を持っていた分（残課題 R8、2026-09-26）。**近い順。**
   *
   * 同じ場面を何組も並べず1組へまとめるが、相手は捨てずにここへ残す。
   * 無ければ省く。
   */
  others?: Array<{ near: string; id: string; score: number }>;
}

export interface PairOptions {
  minScore: number;
  limit: number;
  /** 何行ぶん計算するごとに手を離すか（画面を固めない） */
  yieldEvery?: number;
  /** true を返したら、そこまでの組を返して止める */
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 別の話どうしで、近い場面の組を探す（似た場面の重なりの検出）。
 *
 * **良し悪しは言わない。** 並べるのは「近い」という事実だけで、繰り返しが
 * 意図した呼応なのか、うっかりの重複なのかは作者が決める。
 *
 * ## 隣どうしを1組にまとめる
 *
 * 場面は100字ずつ重ねて切ってある（`passages.ts`）。そのため1か所の
 * 似た記述が、隣り合う2〜3個の場面の組として何度も並ぶ。**どちらの側も
 * 既に採った組の隣なら、同じ重なりとして捨てる。**
 *
 * ## 同じ場面が片側に出る組も1組にまとめる（残課題 R8）
 *
 * **片側だけ**が既に採った組の場面（か隣）なら、相手だけ替えた同じ話である。
 * 並べると、ありふれた場面1つが一覧の上を埋める。組は増やさず、相手を
 * 先に採った組の `others` へ残す（黙って捨てない）。上限（`limit`）は
 * 本物の組で数える。
 *
 * ## 総当たり
 *
 * 2,541件（78.5万字）で約320万組。長さ1に揃えてから内積を取れば、
 * 手元で数秒に収まる（近似検索の仕組みは入れない——`vectorIndex.ts` と同じ判断）。
 */
export async function findSimilarPairs(
  items: readonly PairItem[],
  lookup: VectorLookup,
  options: PairOptions
): Promise<SimilarPair[]> {
  const usable: Array<{ item: PairItem; vector: Float32Array; order: number }> = [];
  items.forEach((item, order) => {
    const stored = lookup(item.hash);
    const vector = stored ? unit(stored) : undefined;
    if (vector) usable.push({ item, vector, order });
  });

  const yieldEvery = Math.max(1, options.yieldEvery ?? 64);
  const keep = Math.max(options.limit * 20, 200);
  let pool: Array<{ i: number; j: number; score: number }> = [];
  const trim = (): void => {
    pool.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
    pool = pool.slice(0, keep);
  };

  for (let i = 0; i < usable.length; i++) {
    if (options.isCancelled?.()) break;
    const left = usable[i];
    for (let j = i + 1; j < usable.length; j++) {
      const right = usable[j];
      if (left.item.group === right.item.group) continue;
      const score = dot(left.vector, right.vector);
      if (score < options.minScore) continue;
      pool.push({ i, j, score });
    }
    if (pool.length > keep * 4) trim();
    if ((i + 1) % yieldEvery === 0) {
      options.onProgress?.(i + 1, usable.length);
      // 画面と中止の合図に番を回す（ブラウザ版でも使える形で）
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  trim();

  const chosen: ChosenPair[] = [];
  for (const entry of pool) {
    const left = usable[entry.i].item;
    const right = usable[entry.j].item;
    const duplicate = chosen.some(
      (other) =>
        (isNeighbor(other.left, left) && isNeighbor(other.right, right)) ||
        (isNeighbor(other.left, right) && isNeighbor(other.right, left))
    );
    if (duplicate) continue;
    /*
      **片側だけが既に採った組の場面（か、その隣）でも、1組へまとめる**
      （残課題 R8）。隣どうしの畳みは両側が隣のときしか効かないので、
      ありふれた場面が1つあると、相手だけ替えて何組でも上位を埋める
      （ギルド第1話の同じ場面が上位12組の5組）。相手は捨てず、先に採った
      組の `others` に残す。先に採った組のほうが近い（`pool` は近い順）
    */
    if (foldIntoChosen(chosen, left, right, entry.score)) continue;
    // 上限は**本物の組**で数える。まとめた相手で枠を使い切らない
    if (chosen.length >= options.limit) continue;
    chosen.push({ left, right, score: entry.score, others: [] });
  }
  return chosen.map(({ left, right, score, others }) => ({
    a: left.id,
    b: right.id,
    score,
    ...(others.length > 0
      ? {
          others: others.map((other) => ({
            near: other.near.id,
            id: other.partner.id,
            score: other.score,
          })),
        }
      : {}),
  }));
}

/** 採った組。まとめた相手は、隣の判定に使えるよう場面ごと持つ */
interface ChosenPair {
  left: PairItem;
  right: PairItem;
  score: number;
  others: Array<{ near: PairItem; partner: PairItem; score: number }>;
}

/**
 * 片側が既に採った組の場面（か、その隣）なら、もう片側をその組の `others` へ
 * 足して true を返す。どちらの側でも当たるときは、先に採った組の左を優先する
 * （並びを揺らさない）。
 */
function foldIntoChosen(
  chosen: ChosenPair[],
  left: PairItem,
  right: PairItem,
  score: number
): boolean {
  for (const pair of chosen) {
    for (const side of [pair.left, pair.right]) {
      const partner = isNeighbor(side, left)
        ? right
        : isNeighbor(side, right)
          ? left
          : undefined;
      if (!partner) continue;
      // 同じ相手（と重なった隣）を二度数えない
      const known =
        isNeighbor(pair.left, partner) ||
        isNeighbor(pair.right, partner) ||
        pair.others.some((other) => isNeighbor(other.partner, partner));
      if (!known) pair.others.push({ near: side, partner, score });
      return true;
    }
  }
  return false;
}

function isNeighbor(a: PairItem, b: PairItem): boolean {
  return a.group === b.group && Math.abs(a.position - b.position) <= 1;
}

/**
 * チャンクの中に丸ごと入っている場面を返す。
 *
 * 検知のチャンクと検索の場面は、切り方が違う（チャンクは数千字、場面は
 * 400字）。**埋め込みを取り直さずに、索引に既にある場面のベクトルを
 * チャンクの問いとして使う**ために、どの場面がそのチャンクに入っているかを
 * 見る。改行の違い（CRLF）と前後の空白は揃えてから比べる。
 */
export function passagesWithin(
  chunkText: string,
  passages: readonly { id: string; text: string }[]
): string[] {
  const haystack = normalize(chunkText);
  const found: string[] = [];
  for (const passage of passages) {
    const needle = normalize(passage.text).trim();
    if (!needle) continue;
    if (haystack.includes(needle)) found.push(passage.id);
  }
  return found;
}

/**
 * 場面が、ファイルの何行目から始まるか（1始まり）。
 *
 * 場面は頭書きやシーンメモを抜いた本文から切っているので、位置を
 * そのまま行へ直せない。**場面の最初の中身のある行を、ファイルの中で探す。**
 * 同じ行（「はい」など）が何度も出るときは、続く行まで合うところを採る。
 * 見つからなければ undefined——でたらめな行へ飛ばすより、話の頭を開くほうがよい。
 */
export function lineOfPassage(fileText: string, passage: string): number | undefined {
  const fileLines = normalize(fileText).split("\n");
  const wanted = normalize(passage)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (wanted.length === 0) return undefined;

  let fallback: number | undefined;
  for (let at = 0; at < fileLines.length; at++) {
    if (fileLines[at].trim() !== wanted[0]) continue;
    if (fallback === undefined) fallback = at + 1;
    if (restMatches(fileLines, at + 1, wanted.slice(1, 3))) return at + 1;
  }
  return fallback;
}

/** 続く中身のある行が、望む並びと合うか（空行は飛ばす） */
function restMatches(lines: readonly string[], from: number, wanted: readonly string[]): boolean {
  let cursor = from;
  for (const line of wanted) {
    while (cursor < lines.length && lines[cursor].trim() === "") cursor++;
    if (cursor >= lines.length || lines[cursor].trim() !== line) return false;
    cursor++;
  }
  return true;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
