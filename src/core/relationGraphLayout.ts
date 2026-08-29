import type { EgoGraph, RelationGraph, RelationNode } from "./relationGraph";

/**
 * 人物相関図の配置（設計書6.38.2）。
 *
 * 力学配置（force-directed）は作らない。実装が重いうえ、開くたびに形が
 * 変わって「前に見た場所」が無くなる。円周は決定的で、所属で弧を分ければ
 * 集団が見える——同じ材料からは、いつも同じ図が出る。
 *
 * 画面（WebView）は受け取った座標を描くだけにする。ここを純粋関数にして
 * おけば、配置の崩れは単体テストで捕まえられる。
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  /** 円の半径。登場話数で3段階 */
  r: number;
}

/** 所属ごとの弧。組織の色の帯と名前を、この範囲に描く */
export interface LayoutArc {
  affiliation: string | null;
  /** ラジアン。真上（-π/2）から時計回り */
  start: number;
  end: number;
}

/** 辺のラベルの置き場（弦の中点） */
export interface LayoutEdgeLabel {
  a: string;
  b: string;
  x: number;
  y: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  center: { x: number; y: number };
  /** いちばん外側の環の半径。弧の帯はこの少し外に描く */
  radius: number;
  nodes: LayoutNode[];
  /** 所属の弧。個人中心図では空 */
  arcs: LayoutArc[];
  edges: LayoutEdgeLabel[];
  /** 薄く引く環の半径。個人中心図で1次・2次の環を示すために使う */
  rings: number[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** 円の外に名前を書くための余白 */
  padding?: number;
}

export interface CircleLayoutOptions extends LayoutOptions {
  /** まとめ方。いまは所属だけ（設計書6.38.2） */
  groupBy?: "affiliation";
}

/**
 * ノードの半径。登場話数の多い人ほど大きい。
 *
 * 段は3つで足りる。話数をそのまま面積にすると、19話の作品では
 * 1話しか出ない人が点になって押せなくなる。
 */
export const NODE_RADII = { small: 5, medium: 8, large: 12 } as const;

/** 名前を置くぶんの既定の余白 */
const DEFAULT_PADDING = 84;

/** 所属の弧のあいだに空ける角度。集団の切れ目を目で追えるようにする */
const GROUP_GAP = 0.08;

/** 真上から始める。時計回りに並べる（SVGはyが下向き） */
const START_ANGLE = -Math.PI / 2;

/**
 * 全体図の配置（設計書6.38.2）。
 *
 * 所属ごとに弧を分け、所属なしは最後の弧へまとめる。並びは所属名→名前の
 * 順に固定してあるので、人物が増えても既にある人の場所は大きく動かない。
 */
export function layoutCircle(
  graph: RelationGraph,
  options: CircleLayoutOptions
): GraphLayout {
  const { width, height } = options;
  const center = { x: width / 2, y: height / 2 };
  const radius = radiusOf(options);
  const maxChapters = graph.nodes.reduce(
    (max, node) => Math.max(max, node.chapterCount),
    0
  );

  const groups = groupByAffiliation(graph.nodes);
  const total = graph.nodes.length;
  const positions = new Map<string, LayoutNode>();
  const arcs: LayoutArc[] = [];

  if (total > 0) {
    // 弧の間の隙間を先に取り分ける。取り分けないと、集団が多いときに
    // 隙間の合計が円を超えて重なり出す
    const gap = groups.length > 1 ? GROUP_GAP : 0;
    const usable = Math.PI * 2 - gap * groups.length;
    let cursor = START_ANGLE;

    for (const group of groups) {
      const span = usable * (group.nodes.length / total);
      arcs.push({
        affiliation: group.affiliation,
        start: cursor,
        end: cursor + span,
      });
      group.nodes.forEach((node, index) => {
        // 端に寄せず、区間の真ん中へ等間隔に置く。寄せると隣の集団の
        // 人と見分けがつかなくなる
        const angle = cursor + (span * (index + 0.5)) / group.nodes.length;
        positions.set(node.id, {
          id: node.id,
          x: center.x + radius * Math.cos(angle),
          y: center.y + radius * Math.sin(angle),
          r: nodeRadius(node.chapterCount, maxChapters),
        });
      });
      cursor += span + gap;
    }
  }

  return {
    width,
    height,
    center,
    radius,
    nodes: graph.nodes
      .map((node) => positions.get(node.id))
      .filter((node): node is LayoutNode => node !== undefined),
    arcs,
    edges: edgeLabels(graph.edges, positions),
    rings: [radius],
  };
}

/**
 * 個人中心図の配置（設計書6.38.3）。
 *
 * 中心に1人、1次を内側の環に等間隔、2次を外側の環に置く。並びは名前順で
 * 固定する——中心を切り替えて戻ってきたときに、同じ場所に同じ人が居る。
 */
export function layoutEgo(ego: EgoGraph, options: LayoutOptions): GraphLayout {
  const { width, height } = options;
  const center = { x: width / 2, y: height / 2 };
  const outer = radiusOf(options);
  // 内側の環は外の6割弱。近すぎると1次のラベルが中心の名前と重なる
  const inner = outer * 0.58;

  const maxChapters = ego.nodes.reduce(
    (max, node) => Math.max(max, node.chapterCount),
    0
  );
  const first = sortByName(ego.nodes.filter((node) => node.ring === 1));
  const second = sortByName(ego.nodes.filter((node) => node.ring === 2));

  const positions = new Map<string, LayoutNode>();
  const centerNode = ego.nodes.find((node) => node.ring === 0);
  if (centerNode) {
    positions.set(centerNode.id, {
      id: centerNode.id,
      x: center.x,
      y: center.y,
      // 中心はいちばん大きく描く。どれが中心かを大きさでも分かるようにする
      r: NODE_RADII.large,
    });
  }

  const place = (nodes: RelationNode[], ringRadius: number): void => {
    nodes.forEach((node, index) => {
      const angle = START_ANGLE + (Math.PI * 2 * index) / nodes.length;
      positions.set(node.id, {
        id: node.id,
        x: center.x + ringRadius * Math.cos(angle),
        y: center.y + ringRadius * Math.sin(angle),
        r: nodeRadius(node.chapterCount, maxChapters),
      });
    });
  };
  place(first, inner);
  place(second, outer);

  return {
    width,
    height,
    center,
    radius: second.length > 0 ? outer : inner,
    nodes: ego.nodes
      .map((node) => positions.get(node.id))
      .filter((node): node is LayoutNode => node !== undefined),
    arcs: [],
    edges: edgeLabels(ego.edges, positions),
    rings: second.length > 0 ? [inner, outer] : [inner],
  };
}

/** 登場話数を3段階の大きさへ。話数の上限は作品ごとに違うので割合で見る */
export function nodeRadius(chapterCount: number, maxChapters: number): number {
  if (maxChapters <= 0) return NODE_RADII.small;
  const ratio = chapterCount / maxChapters;
  if (ratio >= 2 / 3) return NODE_RADII.large;
  if (ratio >= 1 / 3) return NODE_RADII.medium;
  return NODE_RADII.small;
}

function radiusOf(options: LayoutOptions): number {
  const padding = options.padding ?? DEFAULT_PADDING;
  return Math.max(20, Math.min(options.width, options.height) / 2 - padding);
}

interface AffiliationGroup {
  affiliation: string | null;
  nodes: RelationNode[];
}

/**
 * 所属でまとめる。
 *
 * 所属なしは最後の弧へまとめる（設計書6.38.2）。組織のあいだに挟むと、
 * 集団の切れ目が読めなくなる。
 */
function groupByAffiliation(nodes: RelationNode[]): AffiliationGroup[] {
  const groups = new Map<string, RelationNode[]>();
  const none: RelationNode[] = [];
  for (const node of nodes) {
    if (node.affiliation === null) {
      none.push(node);
      continue;
    }
    const known = groups.get(node.affiliation);
    if (known) known.push(node);
    else groups.set(node.affiliation, [node]);
  }

  const sorted: AffiliationGroup[] = [...groups.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([affiliation, members]) => ({
      affiliation,
      nodes: sortByName(members),
    }));
  if (none.length > 0) {
    sorted.push({ affiliation: null, nodes: sortByName(none) });
  }
  return sorted;
}

/**
 * 名前の順に並べる。
 *
 * `localeCompare` を使わない。並びが環境の言語設定で変わると、同じ材料から
 * 違う図が出る（配置を決定的にする意味が無くなる）。同名のときはidで決める。
 */
function sortByName<T extends RelationNode>(nodes: T[]): T[] {
  return [...nodes].sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return 0;
  });
}

/**
 * 辺のラベルの置き場。弦の中点に置く。
 *
 * 弦そのものは画面側が引くが、置き場をここで返すのは、
 * 座標の決め方を1か所にまとめておくためである。
 */
function edgeLabels(
  edges: Array<{ a: string; b: string }>,
  positions: Map<string, LayoutNode>
): LayoutEdgeLabel[] {
  const out: LayoutEdgeLabel[] = [];
  for (const edge of edges) {
    const from = positions.get(edge.a);
    const to = positions.get(edge.b);
    if (!from || !to) continue;
    out.push({
      a: edge.a,
      b: edge.b,
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
    });
  }
  return out;
}
