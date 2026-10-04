import {
  nodeCaption,
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
  /**
   * 名前の下に書く、中心の人から見た関係（個人中心図の1次の相手だけ。
   * `layoutEgo` が言葉と置き場を決める。置き場が無ければ付けない）
   */
  caption?: LayoutCaption;
}

/**
 * 名前の下の文字（設計書6.38.2、作者の裁定 2026-10-04「関係は人の名前の下に書く」）。
 *
 * 揃え（`anchor`）も配置が決めて渡す。下に置けないときは上・横・円の上下・
 * 円の内側へずらすので、揃えは名前と同じとは限らない
 */
export interface LayoutCaption {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

/** 所属ごとの弧。組織の色の帯と名前を、この範囲に描く */
export interface LayoutArc {
  affiliation: string | null;
  /** ラジアン。真上（-π/2）から時計回り */
  start: number;
  end: number;
}

/**
 * 線の中点。**線の上には文字を書かない**（全体図は線が混むため元から、
 * 個人中心図は 2026-10-04 の作者の裁定で、関係を名前の下へ移した。設計書6.38.2）。
 * 線を押すと関係が出る口は画面が線そのものに付ける
 */
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
  /**
   * 置き場が無くて名前の下の文字を省いた人の数（個人中心図。全体図は元から
   * 書かないので0）。画面はこの数を右の一覧の説明に添える——黙って
   * 消したことにしないため（全部は右の「つながっている人」で読める）
   */
  omittedCaptions: number;
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
    // 全体図は名前の下に書かない。中心が無いので「誰から見た関係か」が決まらず、
    // 相手の多い人の名前の下に1つの関係は書けない（設計書6.38.2）
    omittedCaptions: 0,
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

  const omittedCaptions = placeCaptions(ego, first, positions);
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
    omittedCaptions,
  };
}

/** 人物の名前の文字の大きさ（画面の `.g-node-label` と同じ値にしておく） */
export const NODE_LABEL_FONT_SIZE = 12;
/** 名前の下の文字の大きさ（画面の `.g-node-caption` と同じ値にしておく） */
export const CAPTION_FONT_SIZE = 10;

/**
 * 重なりを見るときの字の箱の高さ（画素）は、文字の大きさの1.5倍に見積もる。
 *
 * 画面に描かれた字の矩形は書体の上下の余白を含み、文字の大きさより高い。
 * 文字の大きさちょうどで見積もると、縦に並べた2つの文字が画面では重なる。
 * 描かれた字の高さ（SVG の座標で）がこの値に収まることは、画面の自動テスト
 * `e2e/relationGraph.test.ts` が見張る（設計書6.38.2）
 */
export const NODE_LABEL_BOX_HEIGHT = Math.ceil(NODE_LABEL_FONT_SIZE * 1.5);
export const CAPTION_BOX_HEIGHT = Math.ceil(CAPTION_FONT_SIZE * 1.5);

/** 名前の下の文字を置くとき、左右に空ける余白（画素） */
export const CAPTION_MARGIN = 2;

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

/** 箱を揃え（start は左端、end は右端、middle は真ん中）から作る */
function anchoredBox(
  anchor: LayoutCaption["anchor"],
  x: number,
  y: number,
  width: number,
  height: number
): Box {
  const left =
    anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
  return { left, right: left + width, top: y - height / 2, bottom: y + height / 2 };
}

/**
 * 名前の下の文字の言葉と置き場を決める（作者の裁定、2026-10-04「関係は人の名前の下に書く」。
 * 設計書6.38.2）。戻り値は、置き場が無くて省いた人の数。
 *
 * 相手が30人前後になると、線の上の文字は中心の近くへ寄り集まって読めなかった
 * （教科書チート_確認用の「イント」）。名前は環に沿って散らばっているので、
 * その下なら置き場が広い。
 *
 * 書くのは中心と線で結ばれた1次の相手だけ（2次の環の人は中心との関係が無い）。
 * 置く順は環の並び（名前順）で決めてあるので、同じ材料からはいつも同じ図が出る。
 * 候補は「名前の下 → 名前の上 → 名前の続き（外側の横）→ 円の下 → 円の上 →
 * 円の内側」の順に試し、**人物の円・人物の名前・先に置いた名前の下の文字**の
 * どれとも重ならない最初の位置に置く。どこでも重なるときは書かない（重ねて
 * 置くと、0.98.6 までの線の文字と同じく1つも読めなくなる）。
 */
function placeCaptions(
  ego: EgoGraph,
  firstRing: RelationNode[],
  positions: Map<string, LayoutNode>
): number {
  const centerPos = positions.get(ego.centerId);
  if (!centerPos) return 0;

  // 名前の置き場は画面（relationGraphPanelHtml.ts の renderGraph）と同じ決め方：
  // 中心は円の下の真ん中、ほかは円の右（中心より右の人）か左
  const obstacles: Box[] = [];
  for (const node of ego.nodes) {
    const at = positions.get(node.id);
    if (!at) continue;
    const pad = 3;
    obstacles.push(boxAt(at.x, at.y, (at.r + pad) * 2, (at.r + pad) * 2));
    const nameWidth = estimateTextWidth(node.name, NODE_LABEL_FONT_SIZE);
    if (node.id === ego.centerId) {
      obstacles.push(
        anchoredBox("middle", at.x, at.y + at.r + 16, nameWidth, NODE_LABEL_BOX_HEIGHT)
      );
    } else {
      const right = at.x >= centerPos.x;
      obstacles.push(
        anchoredBox(
          right ? "start" : "end",
          at.x + (right ? at.r + 6 : -at.r - 6),
          at.y,
          nameWidth,
          NODE_LABEL_BOX_HEIGHT
        )
      );
    }
  }

  const edgeTo = new Map<string, EgoGraph["edges"][number]>();
  for (const edge of ego.edges) {
    if (edge.a === ego.centerId) edgeTo.set(edge.b, edge);
    else if (edge.b === ego.centerId) edgeTo.set(edge.a, edge);
  }

  // 名前の下と名前の行の、縦の中心どうしの間。2つの箱がちょうど接する
  const rowGap = (NODE_LABEL_BOX_HEIGHT + CAPTION_BOX_HEIGHT) / 2;
  let omitted = 0;
  for (const node of firstRing) {
    const at = positions.get(node.id);
    const edge = edgeTo.get(node.id);
    if (!at || !edge) continue;
    const text = nodeCaption(edge, ego.centerId);
    // 中身の無い人は、省いたのではなく書くことが無い（数に入れない）
    if (!text) continue;

    const width = estimateTextWidth(text, CAPTION_FONT_SIZE);
    const nameWidth = estimateTextWidth(node.name, NODE_LABEL_FONT_SIZE);
    const right = at.x >= centerPos.x;
    const outward: LayoutCaption["anchor"] = right ? "start" : "end";
    const inward: LayoutCaption["anchor"] = right ? "end" : "start";
    const side = right ? 1 : -1;
    const nameX = at.x + side * (at.r + 6);
    const candidates: LayoutCaption[] = [
      { text, anchor: outward, x: nameX, y: at.y + rowGap },
      { text, anchor: outward, x: nameX, y: at.y - rowGap },
      { text, anchor: outward, x: nameX + side * (nameWidth + 6), y: at.y },
      { text, anchor: "middle", x: at.x, y: at.y + at.r + 3 + CAPTION_BOX_HEIGHT / 2 },
      { text, anchor: "middle", x: at.x, y: at.y - at.r - 3 - CAPTION_BOX_HEIGHT / 2 },
      { text, anchor: inward, x: at.x - side * (at.r + 6), y: at.y },
    ];

    let chosen: LayoutCaption | null = null;
    let chosenBox: Box | null = null;
    for (const candidate of candidates) {
      const box = anchoredBox(
        candidate.anchor,
        candidate.x,
        candidate.y,
        width,
        CAPTION_BOX_HEIGHT
      );
      // 周りに少し余白を取って調べる。ちょうど接する置き方を許すと、描いた字が
      // 見積もりよりわずかに広いときに隣の文字と重なる（2026-10-05 の画面の
      // 自動テストで、相手30人の図に 0.35 画素の重なりが出た）
      const padded: Box = {
        left: box.left - CAPTION_MARGIN,
        right: box.right + CAPTION_MARGIN,
        top: box.top,
        bottom: box.bottom,
      };
      if (obstacles.every((other) => overlapArea(padded, other) === 0)) {
        chosen = candidate;
        chosenBox = box;
        break;
      }
    }
    if (!chosen || !chosenBox) {
      omitted++;
      continue;
    }
    obstacles.push(chosenBox);
    at.caption = chosen;
  }
  return omitted;
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
