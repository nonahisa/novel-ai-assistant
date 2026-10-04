import {
  shortPairLabel,
  type EgoGraph,
  type RelationGraph,
  type RelationNode,
} from "./relationGraph";

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

/**
 * 辺のラベルの置き場。全体図は弦の中点。個人中心図は相手の側へ寄せ、
 * 重なるときは線に沿ってずらした位置（`layoutEgo`）
 */
export interface LayoutEdgeLabel {
  a: string;
  b: string;
  x: number;
  y: number;
  /**
   * 線の上に書く短い言葉（`shortPairLabel`）。個人中心図だけが持つ。
   *
   * **全体図には置かない**——線が混むので、全体図は元から線に文字を書かない
   * （設計書6.38.2）。重なりよけに文字の幅が要るので、配置と一緒にここで決める
   */
  text?: string;
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
  /**
   * 置き場が無くて線の上の文字を省いた線の数（個人中心図。全体図は元から
   * 文字を置かないので0）。画面はこの数を右の一覧の説明に添える——黙って
   * 消したことにしないため（全部は右の「つながっている人」で読める）
   */
  omittedEdgeLabels: number;
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
    // 隙間の合計が円を超えて重なり出す。
    //
    // **隙間そのものにも上限が要る。** 固定（0.08）のままだと、所属が
    // 79に達したところで隙間の合計が円周を追い越し、使える角度が負になる
    // （弧が逆さまになり、人物が1点に重なって押し分けられなくなる）。
    // 隙間に半周までしか使わないよう `π/集団数` で頭を押さえる
    const gap =
      groups.length > 1 ? Math.min(GROUP_GAP, Math.PI / groups.length) : 0;
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
    omittedEdgeLabels: 0,
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

  const labels = egoEdgeLabels(ego, positions);
  return {
    width,
    height,
    center,
    radius: second.length > 0 ? outer : inner,
    nodes: ego.nodes
      .map((node) => positions.get(node.id))
      .filter((node): node is LayoutNode => node !== undefined),
    arcs: [],
    edges: labels.placed,
    rings: second.length > 0 ? [inner, outer] : [inner],
    omittedEdgeLabels: labels.omitted,
  };
}

/** 線の文字の大きさ（画面の `.g-edge-label` と同じ値にしておく） */
export const EDGE_LABEL_FONT_SIZE = 11;
/** 人物の名前の文字の大きさ（画面の `.g-node-label`） */
const NODE_LABEL_FONT_SIZE = 12;

/**
 * 文字の幅の見積もり（画素）。
 *
 * 配置は拡張機能の側で決めるので、画面で実際の幅を測れない。和文は1字が
 * ほぼ文字の大きさの正方形、半角の英数字はその6割として数える。少し広めに
 * 見積もっておけば、実際の幅で重なることはない。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const half = code < 0x80 || (code >= 0xff61 && code <= 0xff9f);
    width += half ? fontSize * 0.6 : fontSize;
  }
  return width;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxAt(x: number, y: number, width: number, height: number): Box {
  return {
    left: x - width / 2,
    right: x + width / 2,
    top: y - height / 2,
    bottom: y + height / 2,
  };
}

/** 2つの箱が重なる面積。重ならなければ0 */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 中心から出る線の上で、文字を置いてみる位置（中心からの割合）。
 *
 * **中点（0.5）より中心の側は試さない。** 中心から出る線は中心へ向かって
 * 寄り集まるので、中心に近いほど置き場が無い（実機、教科書チートの「アブス」
 * 〔0.96.4〕と「イント」〔2026-10-04、相手30人前後〕）。相手の側へ寄せた位置から
 * 試し、重なれば相手の側の範囲で前後へずらす。
 */
const CENTER_EDGE_STEPS = [0.64, 0.74, 0.56, 0.84];
/** 中心に触れない線（2次の環との線）。こちらは中点から試す */
const OTHER_EDGE_STEPS = [0.5, 0.38, 0.62, 0.28, 0.72];

/**
 * 線の文字の箱の高さ（画素）。
 *
 * 文字の大きさちょうど（11）では足りない。画面の字の矩形は書体の上下の
 * 余白を含み、和文の書体では文字の大きさの1.4〜1.5倍になる。見積もりが
 * 低いと、縦に並べた2つの文字が画面では重なる（相手30人の画面の自動テストで
 * 実際の矩形を測って決めた。設計書6.38.2）
 */
const EDGE_LABEL_BOX_HEIGHT = Math.ceil(EDGE_LABEL_FONT_SIZE * 1.5);

/**
 * 個人中心図の線の文字の置き場と中身（作者の裁定、2026-10-03「線の文字を絞る」。
 * 2026-10-04 に「置き場が無ければ省く」へ改めた）。
 *
 * 文字は `shortPairLabel` の短い形。向きは画面の約束どおり、中心に触れる線は
 * 中心から、触れない線は辺の a から見る。中身の無い線（両向きとも何も無い）
 * には何も置かない。
 *
 * 置き方：文字が線の見えている長さ（両端の円の間）より長ければ置かない。
 * そうでなければ候補の位置を順に試し、**先に置いた文字・人物の円・人物の名前**の
 * どれとも重ならない最初の位置に置く。
 * 線に沿った候補で足りなければ、線と直角の向きへ1行ぶんずらした位置も試す。
 *
 * **どこでも重なるときは、その線には文字を置かない**（省いた数は `omitted`）。
 * 以前は重なりのいちばん小さい位置に無理に置いていたが、相手が30人前後になると
 * それが何十回も起き、中心のまわりで文字が積み重なって1つも読めなかった
 * （作者の実機確認、2026-10-04）。省いた線の言葉は、右の「つながっている人」で
 * 全部読める。置く順は中心から出る線が先なので、後から置く線（2次の環との線）
 * ほど省かれやすい。試す順は決めてあるので、同じ材料からはいつも同じ図が出る。
 */
function egoEdgeLabels(
  ego: EgoGraph,
  positions: Map<string, LayoutNode>
): { placed: LayoutEdgeLabel[]; omitted: number } {
  const obstacles: Box[] = [];
  const centerPos = positions.get(ego.centerId);
  for (const node of ego.nodes) {
    const at = positions.get(node.id);
    if (!at) continue;
    const pad = 3;
    obstacles.push(boxAt(at.x, at.y, (at.r + pad) * 2, (at.r + pad) * 2));
    const nameWidth = estimateTextWidth(node.name, NODE_LABEL_FONT_SIZE);
    const nameHeight = NODE_LABEL_FONT_SIZE + 2;
    if (node.id === ego.centerId) {
      // 中心の名前は円の下（画面の描き方と同じ）
      obstacles.push(boxAt(at.x, at.y + at.r + 16, nameWidth, nameHeight));
    } else if (centerPos && at.x >= centerPos.x) {
      obstacles.push(
        boxAt(at.x + at.r + 6 + nameWidth / 2, at.y, nameWidth, nameHeight)
      );
    } else {
      obstacles.push(
        boxAt(at.x - at.r - 6 - nameWidth / 2, at.y, nameWidth, nameHeight)
      );
    }
  }

  // 中心から出る線を先に置く。いちばん混むのがそこで、2次の線は空いた所へ回す
  const ordered = [
    ...ego.edges.filter((edge) => touches(edge, ego.centerId)),
    ...ego.edges.filter((edge) => !touches(edge, ego.centerId)),
  ];
  const placed = new Map<string, LayoutEdgeLabel>();
  const height = EDGE_LABEL_BOX_HEIGHT;
  let omitted = 0;

  for (const edge of ordered) {
    const fromId = touches(edge, ego.centerId) ? ego.centerId : edge.a;
    const toId = edge.a === fromId ? edge.b : edge.a;
    const from = positions.get(fromId);
    const to = positions.get(toId);
    if (!from || !to) continue;
    const text = shortPairLabel(edge, fromId);
    // 中身の無い線は、省いたのではなく書くことが無い（数に入れない）
    if (!text) continue;
    const width = estimateTextWidth(text, EDGE_LABEL_FONT_SIZE) + 4;
    const steps = fromId === ego.centerId ? CENTER_EDGE_STEPS : OTHER_EDGE_STEPS;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    // 線と直角の向き（1行ぶんずらすときに使う）
    const nx = -uy;
    const ny = ux;
    const shifts = [0, height, -height];
    // 文字の箱を線の向きへ映した長さ。両端の円の間（線の見えている長さ）より
    // 長い文字は、どこに置いても線からはみ出して誰の線か読めないので置かない。
    // 置く位置そのものは、下の重なりの検査（円・名前・先に置いた文字）に任せる
    // ——位置まで線の内側に縛ると、斜めの線で横長の文字の置き場が中点の
    // まわりにしか残らず、相手6人の図でも省くことになった
    const along = Math.abs(ux) * width + Math.abs(uy) * height;
    const visible = length - from.r - to.r - 4;
    if (along > visible) {
      omitted++;
      continue;
    }

    let spot: { x: number; y: number } | null = null;
    search: for (const shift of shifts) {
      for (const t of steps) {
        const x = from.x + dx * t + nx * shift;
        const y = from.y + dy * t + ny * shift;
        const box = boxAt(x, y, width, height);
        if (obstacles.every((other) => overlapArea(box, other) === 0)) {
          spot = { x, y };
          break search;
        }
      }
    }
    if (!spot) {
      omitted++;
      continue;
    }
    obstacles.push(boxAt(spot.x, spot.y, width, height));
    placed.set(edgeKeyOf(edge.a, edge.b), {
      a: edge.a,
      b: edge.b,
      x: spot.x,
      y: spot.y,
      text,
    });
  }

  // 並びは辺の順に戻す（画面は受け取った順に描く。決定的にしておく）
  return {
    placed: ego.edges
      .map((edge) => placed.get(edgeKeyOf(edge.a, edge.b)))
      .filter((label): label is LayoutEdgeLabel => label !== undefined),
    omitted,
  };
}

function touches(edge: { a: string; b: string }, id: string): boolean {
  return edge.a === id || edge.b === id;
}

/** 辺の鍵。idに何の字が入っていても衝突しないよう JSON にする */
function edgeKeyOf(a: string, b: string): string {
  return JSON.stringify([a, b]);
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
