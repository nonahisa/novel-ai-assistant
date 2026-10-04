import { relationFirstChapter, type Character } from "../models/character";
import {
  createNameResolver,
  type UnresolvedReason,
} from "./characterNameResolve";
import { chaptersAsOf, hasAppearedBy } from "./settingsAsOf";

/**
 * 人物相関図の材料を組み立てる（設計書6.38.1）。
 *
 * AIを使わない。材料は人物レコードに既にある——関係（`relations`）、
 * 呼称（`addressTerms`）、所属（`affiliation`）、登場話数
 * （`appearedChapters`）。組み立ては安いので、キャッシュもしない。
 *
 * VS Code API に依存しない純粋関数だけを置く。画面（WebView）は描くだけで、
 * 計算はすべてここと `relationGraphLayout.ts` で行い、単体テストで守る。
 */

/** 辺に載る言葉の種類。関係（AがBを「師匠」と見る）と呼称（「先生」と呼ぶ） */
export type RelationLabelKind = "relation" | "address";

export interface RelationNode {
  /** 人物レコードのid。資料に無い相手は `unresolved:名前` になる */
  id: string;
  name: string;
  affiliation: string | null;
  /** 登場話数。ノードの大きさに使う */
  chapterCount: number;
  /**
   * 登場した話（昇順・重複なし）。「第N話まで」の絞り込みと最終話の割り出しに使う。
   * `chapterCount` は件数なので、「第N話までに出たか」も「最終話は何話か」も
   * そこからは分からない。仮ノードは空
   */
  appearedChapters: number[];
  /**
   * 資料に無い相手か（設計書6.38.5）。
   *
   * 名前でも別名でも人物レコードに当たらなかった相手は、黙って落とさず
   * 点線の仮ノードとして残す。落とすと、抽出漏れに気づく機会が消える。
   */
  provisional: boolean;
}

export interface RelationLabel {
  /** どちらから見た言葉か。ノードのid */
  from: string;
  to: string;
  kind: RelationLabelKind;
  /** 関係なら「師匠」、呼称なら「先生」 */
  text: string;
  /**
   * 何話から使われた言葉か。分からなければ null。
   *
   * 呼称は `AddressForm.firstChapter`、関係は `CharacterRelation.firstChapter`
   * （抽出が最初に拾った話。2026-10-02 から `characterMerge.ts` が記録する）。
   * 作者が書いた関係と、話数を記録する前の資料の関係は null
   */
  firstChapter: number | null;
}

/**
 * 2人を結ぶ辺。
 *
 * 向きの違う言葉を1本にまとめる（設計書6.38.1）。A→B「師匠」と
 * B→A「弟子」を別々の線にすると、同じ2人の間に線が何本も走って
 * 人数の割に読めない図になる。向きは `labels` が持つ。
 */
export interface RelationEdge {
  /** 常に a < b（同じ2人の辺が2つできないように正規化する） */
  a: string;
  b: string;
  /** 関係と呼称を合わせた本数。線の太さに使う */
  weight: number;
  labels: RelationLabel[];
}

/** 結べなかった理由。**呼び合い（`addressPairs.ts`）と分け合う** */
export type { UnresolvedReason };

/** 資料に当たらなかった相手（件数を画面の隅に出す） */
export interface UnresolvedTarget {
  fromId: string;
  targetName: string;
  kind: RelationLabelKind;
  reason: UnresolvedReason;
}

export interface RelationGraph {
  nodes: RelationNode[];
  edges: RelationEdge[];
  unresolved: UnresolvedTarget[];
}

/** 仮ノードのidの頭。人物レコードのidは `char_001` なのでぶつからない */
export const UNRESOLVED_ID_PREFIX = "unresolved:";

export function isUnresolvedId(id: string): boolean {
  return id.startsWith(UNRESOLVED_ID_PREFIX);
}

/**
 * 索引の鍵を作る。
 *
 * 区切り字をつないで鍵にすると、名前に同じ字が入っていたときに
 * 別の組が同じ鍵になる（人物名は作者が自由に付けられる）。JSONにすれば
 * 字の種類を選ばずに済むし、制御文字をソースへ書かなくてよい。
 */
function keyOf(parts: string[]): string {
  return JSON.stringify(parts);
}

export function buildRelationGraph(characters: Character[]): RelationGraph {
  const nodes: RelationNode[] = [];
  const byId = new Map<string, RelationNode>();
  for (const character of characters) {
    // 同じidが2つあるのは資料の壊れだが、ここで落とさず先勝ちにする
    if (byId.has(character.id)) continue;
    const node: RelationNode = {
      id: character.id,
      name: character.name,
      affiliation: trimmedOrNull(character.affiliation),
      chapterCount: (character.appearedChapters ?? []).length,
      appearedChapters: normalizeChapters(character.appearedChapters ?? []),
      provisional: false,
    };
    byId.set(node.id, node);
    nodes.push(node);
  }

  const resolve = createNameResolver(characters);
  const edges = new Map<string, RelationEdge>();
  /** 辺の中の言葉の重複よけ。同じ言葉で太さを水増ししない */
  const seenLabels = new Map<string, RelationLabel>();
  const unresolved: UnresolvedTarget[] = [];
  const seenUnresolved = new Set<string>();

  const addEdge = (
    fromId: string,
    toId: string,
    kind: RelationLabelKind,
    text: string,
    firstChapter: number | null
  ): void => {
    const [a, b] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const edgeKey = keyOf([a, b]);
    const labelKey = keyOf([a, b, kind, fromId, text]);
    const seen = seenLabels.get(labelKey);
    if (seen) {
      // 同じ言葉が別の話数で2度書かれていたら、早いほうを採る。
      // 話数の分からない側（null）は「それ以前」として勝つ——
      // `hasAppearedBy` と同じく、分からないものは隠さない側へ倒す
      if (
        seen.firstChapter !== null &&
        (firstChapter === null || firstChapter < seen.firstChapter)
      ) {
        seen.firstChapter = firstChapter;
      }
      return;
    }

    let edge = edges.get(edgeKey);
    if (!edge) {
      edge = { a, b, weight: 0, labels: [] };
      edges.set(edgeKey, edge);
    }
    const label: RelationLabel = {
      from: fromId,
      to: toId,
      kind,
      text,
      firstChapter,
    };
    seenLabels.set(labelKey, label);
    edge.labels.push(label);
    edge.weight = edge.labels.length;
  };

  const link = (
    from: Character,
    rawTargetName: string,
    targetId: string | null,
    kind: RelationLabelKind,
    rawText: string,
    firstChapter: number | null
  ): void => {
    const targetName = (rawTargetName ?? "").trim();
    const text = (rawText ?? "").trim();
    if (!targetName || !text) return;

    // idがあればそれを信じる（設計書6.38.1）。ただし指し先が消えている
    // ことがあるので、そのときは名前の照合へ落とす（辺ごと消さない）
    const resolved =
      targetId && byId.has(targetId)
        ? { id: targetId, reason: null }
        : resolve(targetName);

    if (resolved.id) {
      // 自分を呼ぶ言葉は輪にしない。図では点にしかならず、太さだけが増える
      if (resolved.id === from.id) return;
      addEdge(from.id, resolved.id, kind, text, firstChapter);
      return;
    }

    const provisionalId = UNRESOLVED_ID_PREFIX + targetName;
    if (!byId.has(provisionalId)) {
      const node: RelationNode = {
        id: provisionalId,
        name: targetName,
        affiliation: null,
        chapterCount: 0,
        appearedChapters: [],
        provisional: true,
      };
      byId.set(provisionalId, node);
      nodes.push(node);
    }
    addEdge(from.id, provisionalId, kind, text, firstChapter);

    // 件数として出すのは「誰が・誰を・どの種類で」の組。呼び方が3通り
    // あっても、資料に足りていない相手は1人である
    const reportKey = keyOf([from.id, targetName, kind]);
    if (!seenUnresolved.has(reportKey)) {
      seenUnresolved.add(reportKey);
      unresolved.push({
        fromId: from.id,
        targetName,
        kind,
        // idの指し先が消えていた場合も、名前で引き直して届かなければ
        // 「資料に居ない」である
        reason: resolved.reason ?? "notFound",
      });
    }
  };

  for (const character of characters) {
    for (const relation of character.relations ?? []) {
      // 話数の無い関係は null（「第N話まで」でも両端が出ていれば引く）
      link(
        character,
        relation.name,
        null,
        "relation",
        relation.relation,
        relationFirstChapter(relation)
      );
    }
    for (const term of character.addressTerms ?? []) {
      for (const form of term.forms ?? []) {
        link(
          character,
          term.targetName,
          term.targetId,
          "address",
          form.term,
          typeof form.firstChapter === "number" &&
            Number.isFinite(form.firstChapter)
            ? form.firstChapter
            : null
        );
      }
    }
  }

  return { nodes, edges: sortEdges([...edges.values()]), unresolved };
}

/**
 * ほかの人物のレコードに書かれた、この人物への関係（作者の依頼「B3」、2026-09-22 未明）。
 *
 * 設定資料パネルの関係欄の下に「相手側の記録」として見せる。関係は人物ごとの
 * レコードに片側ずつ書かれているので、片側だけ直すと向かい側の誤りが残る。
 *
 * **名前の引き当ては相関図と同じ `createNameResolver`**——パネルで「相手側」に
 * 出る関係と、相関図でこの人物へ引かれる線が食い違わないように。同じ名前の
 * 人物が複数居て決められないもの（`ambiguous`）は入れない（図にも線が無い）。
 */
export function incomingRelations(
  characters: readonly Character[],
  targetId: string
): Array<{ fromId: string; fromName: string; relation: string }> {
  const resolve = createNameResolver(characters);
  const result: Array<{ fromId: string; fromName: string; relation: string }> = [];
  for (const character of characters) {
    if (character.id === targetId) continue;
    for (const relation of character.relations ?? []) {
      const text = (relation.relation ?? "").trim();
      if (!text) continue;
      if (resolve(relation.name ?? "").id !== targetId) continue;
      result.push({ fromId: character.id, fromName: character.name, relation: text });
    }
  }
  return result;
}

/**
 * 名前の下の1語の長さの上限（字）。これを超えたら切って「…」を付ける。
 *
 * 関係の欄には「電気について教えを受けている相手」のような説明が入ることがある。
 * 名前の下は「どんな間柄か」の見当が付けば足りる——全文は右の欄で読める。
 */
export const CAPTION_WORD_MAX_CHARS = 8;

/**
 * 名前の下に並べる語の合計の字数の上限（区切りの「・」を含む。「ほかN」は含まない）。
 *
 * 相手30人の環では、隣の人との縦の間が40画素ほどしか無い。名前の下の1行は
 * 名前と同じくらいの幅に収めないと、横や上へずらす先も無くなる。
 * 1語目はこの上限を超えても置く（切った1語＋「ほかN」で、何も無いよりは読める）。
 */
export const CAPTION_MAX_CHARS = 10;

/**
 * 個人中心図で、周りの人の名前の下に書く言葉（作者の裁定、2026-10-04
 * 「関係は人の名前の下に書く」。設計書6.38.2）。
 *
 * **中心の人から見た関係を、矢印なしで書く**（「師匠・兄」）。名前の下に置いた
 * 時点で「この人は中心の人にとって何か」と読まれるので、矢印は要らない。
 * 両向きを並べると幅が倍になり、相手30人の環では置き場が無くなる——相手から
 * 見た関係は、右の「つながっている人」と線を押したときの詳細で読める。
 *
 * どの言葉を採るかは、関係を呼び方より先にする（量が多いときは関係を優先）：
 * 1. 中心→相手の関係（「師匠」） 2. 相手→中心の関係を「←」付きで（「←主人」）
 * 3. 中心→相手の呼び方（『リナ』） 4. 相手→中心の呼び方を「←」付きで（「←『イント様』」）。
 * 選んだ向きの中では、関係のあとに同じ向きの呼び方を『』で続ける（今までの線の
 * 文字と同じ並べ方）。「←」は右の一覧の約束（←は相手から中心へ）と同じ意味。
 *
 * 語は「・」でつなぎ、合計が `CAPTION_MAX_CHARS` を超える分は「ほかN」と数だけ出す。
 * 1語は `CAPTION_WORD_MAX_CHARS` で切る。中心との言葉が何も無ければ空文字。
 */
export function nodeCaption(edge: RelationEdge, centerId: string): string {
  const otherId = edge.a === centerId ? edge.b : edge.a;
  const relationsFrom = (id: string): string[] =>
    uniqueWords(edge, id, "relation");
  const addressesFrom = (id: string): string[] =>
    uniqueWords(edge, id, "address").map((text) => `『${text}』`);

  const forwardRelations = relationsFrom(centerId);
  const backwardRelations = relationsFrom(otherId);
  let prefix = "";
  let words: string[];
  if (forwardRelations.length > 0) {
    words = [...forwardRelations, ...addressesFrom(centerId)];
  } else if (backwardRelations.length > 0) {
    prefix = "←";
    words = [...backwardRelations, ...addressesFrom(otherId)];
  } else if (addressesFrom(centerId).length > 0) {
    words = addressesFrom(centerId);
  } else {
    prefix = "←";
    words = addressesFrom(otherId);
  }
  if (words.length === 0) return "";

  const shown: string[] = [];
  let used = 0;
  for (const word of words) {
    const clipped = clipWord(word);
    const cost = [...clipped].length + (shown.length > 0 ? 1 : 0);
    if (shown.length > 0 && used + cost > CAPTION_MAX_CHARS) break;
    shown.push(clipped);
    used += cost;
  }
  const rest = words.length - shown.length;
  return prefix + shown.join("・") + (rest > 0 ? ` ほか${rest}` : "");
}

/** 1つの向き・1つの種類の言葉。同じ言葉は1度だけ（「ほか1」が実は同じ語、にしない） */
function uniqueWords(
  edge: RelationEdge,
  speakerId: string,
  kind: RelationLabelKind
): string[] {
  const out: string[] = [];
  for (const label of edge.labels) {
    if (label.from !== speakerId || label.kind !== kind) continue;
    if (!out.includes(label.text)) out.push(label.text);
  }
  return out;
}

/** 長い1語を切る。サロゲートペアを割らないよう、字の配列で数える */
function clipWord(word: string): string {
  const chars = [...word];
  if (chars.length <= CAPTION_WORD_MAX_CHARS) return word;
  // 『』で囲んだ呼び方は、閉じ括弧を残す（切ると括弧が開いたままになる）
  if (word.startsWith("『") && word.endsWith("』")) {
    const inner = chars.slice(1, -1);
    return `『${inner.slice(0, CAPTION_WORD_MAX_CHARS - 2).join("")}…』`;
  }
  return `${chars.slice(0, CAPTION_WORD_MAX_CHARS).join("")}…`;
}

/** どの環に居るか。0が中心、1が1次、2が2次 */
export type EgoRing = 0 | 1 | 2;

export interface EgoNode extends RelationNode {
  ring: EgoRing;
}

export interface EgoGraph {
  centerId: string;
  nodes: EgoNode[];
  edges: RelationEdge[];
}

/**
 * 1人を中心にした部分図（設計書6.38.3）。
 *
 * 辺は、残ったノードどうしのものをすべて入れる。中心から出る線だけに
 * すると、1次の相手どうしが実は師弟だった、といった重なりが消える。
 *
 * 中心が図に居ないとき（絞り込みで落ちた・idが古い）は空の図を返す。
 * 呼び出し側が案内を出せるように、例外にはしない。
 */
export function egoGraph(
  graph: RelationGraph,
  centerId: string,
  depth: 1 | 2 = 1
): EgoGraph {
  const center = graph.nodes.find((node) => node.id === centerId);
  if (!center) return { centerId, nodes: [], edges: [] };

  const neighbours = new Map<string, Set<string>>();
  const connect = (from: string, to: string): void => {
    const known = neighbours.get(from);
    if (known) known.add(to);
    else neighbours.set(from, new Set([to]));
  };
  for (const edge of graph.edges) {
    connect(edge.a, edge.b);
    connect(edge.b, edge.a);
  }

  const ring = new Map<string, EgoRing>([[centerId, 0]]);
  for (const id of neighbours.get(centerId) ?? []) {
    if (!ring.has(id)) ring.set(id, 1);
  }
  if (depth >= 2) {
    for (const [id, level] of [...ring]) {
      if (level !== 1) continue;
      for (const far of neighbours.get(id) ?? []) {
        if (!ring.has(far)) ring.set(far, 2);
      }
    }
  }

  // 並びは元の図のまま。配置（`relationGraphLayout.ts`）が並べ替えるので、
  // ここで順序を決めると決め手が2か所に散る
  const nodes: EgoNode[] = [];
  for (const node of graph.nodes) {
    const level = ring.get(node.id);
    if (level === undefined) continue;
    nodes.push({ ...node, ring: level });
  }
  const edges = graph.edges.filter(
    (edge) => ring.has(edge.a) && ring.has(edge.b)
  );
  return { centerId, nodes, edges };
}

/** 関係も呼称も無い人物（既定では畳んで「ほか N人」と出す） */
export function isolatedNodes(graph: RelationGraph): RelationNode[] {
  const linked = new Set<string>();
  for (const edge of graph.edges) {
    linked.add(edge.a);
    linked.add(edge.b);
  }
  return graph.nodes.filter((node) => !linked.has(node.id));
}

/** 所属で絞り込むときの、所属なしを表す鍵（画面と拡張機能で共用する） */
export const NO_AFFILIATION_KEY = "";

export interface RelationGraphFilter {
  /**
   * 第N話までの図にする（作者の要望、2026-10-02「下限ではなく上限」）。
   * 未指定・null なら絞らない（＝最終話まで）。
   *
   * 人物は「第N話までに初登場したか」、呼称は「第N話までに使われ始めたか」で
   * 見る。話数の記録が無いもの（登場話数が空の人物・関係・初出の分からない
   * 呼称）は落とさない——分からないものを消すと、作者が手で書いたものが
   * 黙って図から消える（`settingsAsOf.ts` の `hasAppearedBy` と同じ倒し方）
   */
  upToChapter?: number | null;
  /** 出す辺の種類。空や未指定なら両方 */
  kinds?: RelationLabelKind[];
  /**
   * 選んだ所属（所属なしは `NO_AFFILIATION_KEY`）。
   *
   * 未指定なら全部。空の配列は「1つも選んでいない」であって全部ではない
   * ——チェックを全部外したのに全員出てくると、外した意味が分からない。
   */
  affiliations?: string[];
  /** 孤立ノードも出すか。既定は畳む（設計書6.38.2） */
  showIsolated?: boolean;
}

export interface FilteredRelationGraph {
  graph: RelationGraph;
  /** 畳んだ孤立ノード。「ほか N人」として名前を出す */
  hiddenIsolated: RelationNode[];
}

/**
 * 図を絞り込む（設計書6.38.2）。
 *
 * 仮ノードは、登場話数と所属では落とさない。どちらも資料が無いから
 * 空なのであって、条件に合わなかったわけではない。相手が残っている限り
 * 点線のまま残す（6.38.5「黙って落とさない」）。
 */
export function filterRelationGraph(
  graph: RelationGraph,
  filter: RelationGraphFilter = {}
): FilteredRelationGraph {
  const kinds = filter.kinds && filter.kinds.length > 0 ? filter.kinds : null;
  const upTo = filter.upToChapter ?? null;
  const affiliations = filter.affiliations
    ? new Set(filter.affiliations)
    : null;

  const keptReal = new Set<string>();
  for (const node of graph.nodes) {
    if (node.provisional) continue;
    if (!hasAppearedBy(node.appearedChapters, upTo)) continue;
    if (
      affiliations &&
      !affiliations.has(node.affiliation ?? NO_AFFILIATION_KEY)
    ) {
      continue;
    }
    keptReal.add(node.id);
  }

  const edges: RelationEdge[] = [];
  for (const edge of graph.edges) {
    const labels = edge.labels.filter(
      (label) =>
        (!kinds || kinds.includes(label.kind)) && labelStartedBy(label, upTo)
    );
    if (labels.length === 0) continue;
    // 仮ノードは相手が残っていれば残す
    const aOk = isUnresolvedId(edge.a)
      ? keptReal.has(edge.b)
      : keptReal.has(edge.a);
    const bOk = isUnresolvedId(edge.b)
      ? keptReal.has(edge.a)
      : keptReal.has(edge.b);
    if (!aOk || !bOk) continue;
    edges.push({ a: edge.a, b: edge.b, weight: labels.length, labels });
  }

  const linked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.a);
    linked.add(edge.b);
  }

  const nodes: RelationNode[] = [];
  const hiddenIsolated: RelationNode[] = [];
  for (const original of graph.nodes) {
    if (original.provisional) {
      // 相手ごと消えた仮ノードは、指す先が無いので出さない
      if (linked.has(original.id)) nodes.push(original);
      continue;
    }
    if (!keptReal.has(original.id)) continue;
    const node = nodeAsOf(original, upTo);
    if (linked.has(node.id) || filter.showIsolated) {
      nodes.push(node);
      continue;
    }
    hiddenIsolated.push(node);
  }

  const remaining = new Set(nodes.map((node) => node.id));

  return {
    graph: { nodes, edges, unresolved: restrictUnresolved(graph, remaining) },
    hiddenIsolated,
  };
}

/**
 * 「結べなかった一覧」を、いま図に残っている相手だけに絞る。
 *
 * **呼ぶ側（絞り込みと個人中心図）が、それぞれ違う絞り方をしないための
 * 唯一の入口である。** 個人中心図は以前ここを写さずに「呼んだ側
 * （`fromId`）が図に居るか」だけで絞っており、点線を出していない相手まで
 * 一覧に残っていた。その一覧から内訳（同名で決められなかった数）を数えて
 * いたため、注記が「6人のうち8人」と、内訳が全体を超えた。
 *
 * 両端——呼んだ側と、点線で出している相手そのもの——を見る。
 */
export function restrictUnresolved(
  graph: RelationGraph,
  visibleIds: ReadonlySet<string>
): UnresolvedTarget[] {
  return graph.unresolved.filter(
    (entry) =>
      visibleIds.has(entry.fromId) &&
      visibleIds.has(UNRESOLVED_ID_PREFIX + entry.targetName)
  );
}

/** 画面の下に出す注記の件数（全体と、その内訳） */
export interface UnresolvedCounts {
  /** 資料に結べず、点線で出している相手の人数 */
  unresolvedCount: number;
  /** そのうち、同じ名前の人物が資料に複数いて決められなかった人数 */
  ambiguousCount: number;
}

/**
 * 注記の件数を数える（設計書6.38.5）。
 *
 * **2つの件数を必ず同じ集合——画面に点線で出している仮ノードそのもの——
 * から数える。** 片方をノード、片方を一覧から別々に数えると、絞り込みの
 * 効き方の違いがそのまま「内訳が全体を超える」形で注記に出る（実際に
 * 個人中心図で起きた）。ここを通す限り `ambiguousCount <= unresolvedCount`
 * が成り立つ。
 *
 * 「資料に無い」と「どの人か決められない」は直し方が違うので分けて出す。
 * 前者は抽出し直せば減るが、後者は別名の重なりを直さないと減らない。
 * 同じ名前で何人から呼ばれていても、困っている相手は1人である。
 */
export function countUnresolved(graph: RelationGraph): UnresolvedCounts {
  const shown = new Set(
    graph.nodes.filter((node) => node.provisional).map((node) => node.id)
  );
  const ambiguous = new Set(
    graph.unresolved
      .filter(
        (entry) =>
          entry.reason === "ambiguous" &&
          shown.has(UNRESOLVED_ID_PREFIX + entry.targetName)
      )
      .map((entry) => entry.targetName)
  );
  return { unresolvedCount: shown.size, ambiguousCount: ambiguous.size };
}

/**
 * その言葉は、第N話までに使われ始めていたか。
 *
 * **「第N話の時点で使われているか」ではない。** 図は「第N話までに起きた
 * こと」を見るので、第3話で使われなくなった呼び方も第5話までの図に残す
 * （`addressPairs.ts` の時点の判定とは向きが違うので流用しない）
 */
function labelStartedBy(label: RelationLabel, upTo: number | null): boolean {
  return hasAppearedBy(
    label.firstChapter === null ? [] : [label.firstChapter],
    upTo
  );
}

/**
 * ノードを第N話の時点の形にする。大きさ（登場話数）も第N話までで数え直す
 * ——第2話までの図で、第9話までの登場回数の大きさを見せない
 */
function nodeAsOf(node: RelationNode, upTo: number | null): RelationNode {
  if (upTo === null) return node;
  const appearedChapters = chaptersAsOf(node.appearedChapters, upTo);
  if (appearedChapters.length === node.appearedChapters.length) return node;
  return {
    ...node,
    appearedChapters,
    chapterCount: appearedChapters.length,
  };
}

/**
 * 図の最終話（「第N話まで」のつまみの上限）。
 *
 * 登場した話と、呼称が使われ始めた話のいちばん後ろ。**登場話数の件数の
 * 最大ではない**——飛び飛びに出る人物しか居ない作品では、件数では最終話に
 * 届かない。話数の記録が1つも無ければ0
 */
export function lastChapterOf(graph: RelationGraph): number {
  let last = 0;
  for (const node of graph.nodes) {
    for (const at of node.appearedChapters) last = Math.max(last, at);
  }
  for (const edge of graph.edges) {
    for (const label of edge.labels) {
      if (label.firstChapter !== null) last = Math.max(last, label.firstChapter);
    }
  }
  return last;
}

/**
 * つまみの値を「第N話まで」の絞り込みへ直す。`null` は「最終話まで」。
 *
 * **最終話（以上）を選んだら `null` にする。** 数字のまま持つと、抽出で
 * 新しい話の人物が増えたとき、作者が触っていないのに図が古い最終話で
 * 止まり、増えた人物が黙って隠れる（所属の絞り込みで、あとから増えた
 * 所属を選んだことにして出すのと同じ考え方）。資料が減って最終話を
 * 超えた値も、同じく最終話へ寄せる。
 */
export function normalizeUpToChapter(
  value: number | null | undefined,
  last: number
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (last <= 0) return null;
  const rounded = Math.round(value);
  if (rounded >= last) return null;
  return Math.max(1, rounded);
}

/** 登場話数を昇順・重複なし・数値だけにそろえる */
function normalizeChapters(chapters: readonly number[]): number[] {
  return [...new Set(chapters.filter((at) => Number.isFinite(at)))].sort(
    (left, right) => left - right
  );
}

function sortEdges(edges: RelationEdge[]): RelationEdge[] {
  // 同じ材料からいつも同じ図が出るように、並びまで決めておく。
  // 画面は受け取った順に描く
  return edges.sort((left, right) => {
    if (left.a !== right.a) return left.a < right.a ? -1 : 1;
    if (left.b !== right.b) return left.b < right.b ? -1 : 1;
    return 0;
  });
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}
