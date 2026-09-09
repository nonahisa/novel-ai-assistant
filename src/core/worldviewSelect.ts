import type { WorldItem } from "../models/world";
import { Bm25Index } from "./bm25";
import { describeWorldItem } from "./settingsSummary";
import { referenceBudgetChars } from "./sizeBudget";

/**
 * 矛盾検知へ渡す世界観を、上限の範囲で選ぶ（設計書6.27.6の「穴2」）。
 *
 * 世界観だけ上限が無かった。人物・場所は本文に名前が出たものへ絞り
 * （`checkContradictions.ts` の `relevantFor`）、あらすじは直近12話、
 * 未来の事実は20行で切っているのに、**世界観は全項目が毎チャンクに乗っていた**。
 * 2,000〜20,000字超が毎回の入力に積まれる、いちばん大きな無駄である。
 *
 * VS Code APIに依存しない純粋関数。同じ入力からは必ず同じ文字列を返す
 * （キャッシュの鍵は「設定の指紋＋チャンクのハッシュ」なので、
 * 選抜が揺れると同じ鍵に違う材料の答えが入る）。
 */

/**
 * 1チャンクへ載せる世界観の上限（字数の頭打ち）。
 *
 * **実測はまだ無い**（`usage.md` を回してから決める）。推定の最大
 * 20,000字超より上に置いてあるので、**いまの作品では1バイトも挙動が変わらない**。
 * 数字を見てから下げるのが本命で、これは「増える一方」を止める安全弁である。
 *
 * **実際に効く上限はこれではなく `worldviewMaxChars`** である（設計書6.27.10）。
 * 固定字数だけだと、モデルを小さいものに替えたときにそのまま溢れる。
 */
export const WORLDVIEW_MAX_CHARS = 30000;

/**
 * 世界観にまわしてよい、モデルの上限に対する割合。
 *
 * 参照資料の上限が固定字数だと、**モデルを小さいものに替えたときに
 * そのまま溢れる**（設計書6.27.10の穴2）。32kのモデルでは30,000字＝
 * 約43,000トークンで、本文を1文字も足さないうちに上限を超えている。
 */
const WORLDVIEW_CONTEXT_RATIO = 0.25;

/**
 * そのモデルで世界観に使ってよい字数を決める。
 *
 * 上限の25%をトークンから字数へ直し（0.7字/トークン）、固定の頭打ちと
 * 小さいほうを取る。131,072のモデルなら22,937字、32,768なら5,734字。
 *
 * **いまの作品では、まだ一度もこの上限に当たっていない**（世界観の推定
 * 最大が20,000字超）。当たるのは項目が増えてからで、そのときに減るのは
 * **本文と関係の薄い項目から**である（`selectWorldview` の並べ方）。
 */
export function worldviewMaxChars(contextWindow: number | undefined): number {
  // 式は `sizeBudget` に寄せ、**比率と頭打ちはここに残す**（設計書6.77）
  // ——どれだけまわしてよいかは、この用途の判断だから
  return referenceBudgetChars(
    contextWindow,
    WORLDVIEW_CONTEXT_RATIO,
    WORLDVIEW_MAX_CHARS
  );
}

/** 項目と項目の区切り。従来の組み立て（`join("\n\n")`）と同じにする */
const SEPARATOR = "\n\n";

export function selectWorldview(options: {
  items: readonly WorldItem[];
  /** チャンクの本文。名前一致と語句の近さの判定に使う */
  chunkText: string;
  /** relevantFor に渡ってくる話数（まとめチャンクでは代表の1話） */
  chapter: number | null;
  maxChars?: number;
}): string {
  const { items, chunkText, chapter } = options;
  const maxChars = options.maxChars ?? WORLDVIEW_MAX_CHARS;

  const described = items.map((item) => describeWorldItem(item));

  // **上限内なら、従来と完全に同じ文字列を返す。** 並び替えも間引きもしない。
  // ここが1文字でも変わると、いまの作品でも送る内容が変わってしまい、
  // 「大きな作品だけで絞りが効く」という約束が崩れる
  const whole = described.join(SEPARATOR);
  if (whole.length <= maxChars) return whole;

  // ── ここから先は、上限を超える作品だけが通る ──────────────

  // (a) 名前一致：見出しか別の言い方が、そのまま本文に出てくるもの
  const byName: number[] = [];
  // (b) 話数の保険：名前は出ていないが、その話に登場した記録があるもの
  const byChapter: number[] = [];
  // (c) 残り：語句の近さで順位を付ける
  const rest: number[] = [];

  items.forEach((item, index) => {
    // **`TermIndex` は使わない。** あちらの `TermKind` は用語ハイライトの
    // 色分けに使う閉じた合併型で、世界観のために広げると画面側へ漏れる。
    // 世界観の項目は多くて数十件なので、素朴な `includes` で足りる
    const terms = [item.name, ...item.aliases]
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    if (terms.some((term) => chunkText.includes(term))) {
      byName.push(index);
      return;
    }
    // 本文が言い換えている（「詠唱の制約」を「唱えきるまで動けない」と書く）と
    // (a) を外す。登場話の記録が、その取りこぼしを拾う
    if (chapter !== null && item.appearedChapters.includes(chapter)) {
      byChapter.push(index);
      return;
    }
    rest.push(index);
  });

  const ranked = rankByRelevance(items, described, rest, chunkText);

  // 詰める順は (a)→(b)→(c)。(a)(b) は元の並び順のまま、(c) は点の高い順。
  // `Array.sort` は安定なので、点が同じ項目は元の並び順で残る＝選抜は決定的
  const order = [...byName, ...byChapter, ...ranked];

  const chosen: string[] = [];
  let total = 0;
  for (const index of order) {
    const text = described[index];
    // 2件目からは区切りのぶんも数える。数えないと出力が上限を超える
    const size =
      chosen.length === 0 ? text.length : SEPARATOR.length + text.length;
    if (total + size > maxChars) {
      // 1件目から入らないときだけ、はみ出してでも1件は渡す
      // （`retrieval.ts` の `trimToBudget` と同じ考え方。材料が空になると
      // 矛盾検知は「照らし合わせる相手が無い」と見なして本文を飛ばす）
      if (chosen.length === 0) chosen.push(text);
      break;
    }
    chosen.push(text);
    total += size;
  }

  return chosen.join(SEPARATOR);
}

/**
 * 残った項目を、本文との語句の近さで並べる。
 *
 * 索引は**世界観の項目だけ**で作る。本文まるごとの索引（意味検索）は
 * 持ち込まない（設計書6.27.4）。
 *
 * **一致が1つも無かった項目も、うしろへ残す。** `Bm25Index.search` は
 * 0点の文書を返さないので、落とすと**世界観が丸ごと空になることがある**
 * （本文が短く、共通する2文字組みが1つも無い場合）。材料が空のまま問うと、
 * AIは本文だけを見て「矛盾していそうなこと」を作り出す。
 * ここは足切りではなく順番付けであり、切るのは字数の上限の役目である。
 */
function rankByRelevance(
  items: readonly WorldItem[],
  described: readonly string[],
  rest: readonly number[],
  chunkText: string
): number[] {
  if (rest.length === 0) return [];

  const index = new Bm25Index(
    rest.map((at) => ({ id: items[at].id, text: described[at] }))
  );
  const indexById = new Map(rest.map((at) => [items[at].id, at]));

  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const hit of index.search(chunkText, rest.length)) {
    const at = indexById.get(hit.id);
    if (at === undefined || seen.has(at)) continue;
    seen.add(at);
    ordered.push(at);
  }
  // 点の付かなかったものは、元の並び順で末尾に付ける
  for (const at of rest) {
    if (!seen.has(at)) ordered.push(at);
  }
  return ordered;
}
