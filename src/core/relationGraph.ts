import type { Character } from "../models/character";
import { expandNameVariants } from "./termIndex";

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

/**
 * なぜ資料に結べなかったか。
 *
 * - `notFound`：その名前の人物が資料に居ない（抽出漏れか、脇役）
 * - `ambiguous`：同じ名前の人物が複数居て、どちらか決められない
 *
 * **2つを分ける。** 前者は抽出すれば消えるが、後者は別名の重複を
 * 直さないと消えない。同じ「資料に無い」で括ると、作者は抽出をやり直して
 * 何も変わらない、を繰り返すことになる。
 */
export type UnresolvedReason = "notFound" | "ambiguous";

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
      provisional: false,
    };
    byId.set(node.id, node);
    nodes.push(node);
  }

  const resolve = createNameResolver(characters);
  const edges = new Map<string, RelationEdge>();
  /** 辺の中の言葉の重複よけ。同じ言葉で太さを水増ししない */
  const seenLabels = new Set<string>();
  const unresolved: UnresolvedTarget[] = [];
  const seenUnresolved = new Set<string>();

  const addEdge = (
    fromId: string,
    toId: string,
    kind: RelationLabelKind,
    text: string
  ): void => {
    const [a, b] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const edgeKey = keyOf([a, b]);
    const labelKey = keyOf([a, b, kind, fromId, text]);
    if (seenLabels.has(labelKey)) return;
    seenLabels.add(labelKey);

    let edge = edges.get(edgeKey);
    if (!edge) {
      edge = { a, b, weight: 0, labels: [] };
      edges.set(edgeKey, edge);
    }
    edge.labels.push({ from: fromId, to: toId, kind, text });
    edge.weight = edge.labels.length;
  };

  const link = (
    from: Character,
    rawTargetName: string,
    targetId: string | null,
    kind: RelationLabelKind,
    rawText: string
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
      addEdge(from.id, resolved.id, kind, text);
      return;
    }

    const provisionalId = UNRESOLVED_ID_PREFIX + targetName;
    if (!byId.has(provisionalId)) {
      const node: RelationNode = {
        id: provisionalId,
        name: targetName,
        affiliation: null,
        chapterCount: 0,
        provisional: true,
      };
      byId.set(provisionalId, node);
      nodes.push(node);
    }
    addEdge(from.id, provisionalId, kind, text);

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
      link(character, relation.name, null, "relation", relation.relation);
    }
    for (const term of character.addressTerms ?? []) {
      for (const form of term.forms ?? []) {
        link(character, term.targetName, term.targetId, "address", form.term);
      }
    }
  }

  return { nodes, edges: sortEdges([...edges.values()]), unresolved };
}

/** 名前を引いた結果。結べなかったときは、その理由を添える */
interface NameResolution {
  id: string | null;
  reason: UnresolvedReason | null;
}

/**
 * 名前・別名から人物を引く（設計書6.38.1）。
 *
 * 名前の広げ方は `termIndex.ts` の `expandNameVariants` を借りる。姓だけ・
 * 名だけで呼ぶ小説の書き方に合わせた規則が既にそこにあり、ここへ写しを
 * 作ると片方だけ直る日が来る。
 *
 * **当てるのは全体が一致したときだけ。** `TermIndex.find` は本文の中から
 * 用語を探す道具なので、部分文字列にも当たる。相関図でそれを使うと、
 * 資料に無い「アリシア」が登録済みの「リシア」に化けて、**どこにも無い線**が
 * 図に引かれる（気づきようがない）。名前どうしを突き合わせるここでは、
 * 索引ではなく名前の対応表で引く。
 *
 * **同じ名前が複数の人物に当たるときは結ばない。** 先に見つかったほうへ
 * 線を引くと、別名が重なっているだけで別人が繋がる。図には点線の仮ノードを
 * 残し、`ambiguous` として件数に出す（黙って落とさない・黙って繋がない）。
 */
function createNameResolver(
  characters: Character[]
): (name: string) => NameResolution {
  const idsByName = new Map<string, Set<string>>();
  for (const character of characters) {
    const names = expandNameVariants([
      character.name,
      ...(character.aliases ?? []),
    ]);
    for (const text of names) {
      const key = text.trim();
      if (!key) continue;
      const ids = idsByName.get(key);
      if (ids) ids.add(character.id);
      else idsByName.set(key, new Set([character.id]));
    }
  }

  return (name: string): NameResolution => {
    const ids = idsByName.get(name.trim());
    if (!ids || ids.size === 0) return { id: null, reason: "notFound" };
    if (ids.size > 1) return { id: null, reason: "ambiguous" };
    return { id: [...ids][0], reason: null };
  };
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
  /** 登場話数の下限。仮ノードは登場話数を持たないので対象外 */
  minChapters?: number;
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
  const minChapters = filter.minChapters ?? 0;
  const affiliations = filter.affiliations
    ? new Set(filter.affiliations)
    : null;

  const keptReal = new Set<string>();
  for (const node of graph.nodes) {
    if (node.provisional) continue;
    if (node.chapterCount < minChapters) continue;
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
    const labels = kinds
      ? edge.labels.filter((label) => kinds.includes(label.kind))
      : edge.labels;
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
  for (const node of graph.nodes) {
    if (node.provisional) {
      // 相手ごと消えた仮ノードは、指す先が無いので出さない
      if (linked.has(node.id)) nodes.push(node);
      continue;
    }
    if (!keptReal.has(node.id)) continue;
    if (linked.has(node.id) || filter.showIsolated) {
      nodes.push(node);
      continue;
    }
    hiddenIsolated.push(node);
  }

  const remaining = new Set(nodes.map((node) => node.id));
  const unresolved = graph.unresolved.filter(
    (entry) =>
      remaining.has(entry.fromId) &&
      remaining.has(UNRESOLVED_ID_PREFIX + entry.targetName)
  );

  return { graph: { nodes, edges, unresolved }, hiddenIsolated };
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
