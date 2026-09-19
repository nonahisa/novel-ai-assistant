import {
  READER_AXIS_ORDER,
  READER_TYPE_TABLE,
  type ReaderAxis,
  type ReaderTypeId,
} from "./readerTarget";

/**
 * 読者タイプの隣り合い（設計書6.101、実装の順「4」）。
 *
 * ## 何のためにあるか
 *
 * 3つの輪が1つも重ならないとき、「重なっていません」と告げても作者には
 * 何もできない。**渡すのは判定ではなく手段**で、そのうちの2つ
 * （ターゲットを寄せる・書ける範囲を広げる）は「**いきなり遠くへ
 * 飛ばさず、隣へ一歩**」という形でしか渡せない。その一歩を決めるのが
 * ここである。
 *
 * ## 表を2つ持たない
 *
 * 隣り合いは `READER_TYPE_TABLE`（主軸と副軸の組み合わせ）から**導く**。
 * 手書きの一覧をもう1つ置くと、軸の組み合わせを変えたときに片方だけ
 * 直る日が来る。
 *
 * ## 隣の決め方
 *
 * | 層 | 隣 |
 * |---|---|
 * | 角の9タイプ | ①主軸が同じで副軸が違うもの ②主軸と副軸を入れ替えたもの |
 * | すきま層（全低） | 副軸の無い3つ（軸を1つ上げた先だから） |
 * | 雑食層（全中） | 角の9タイプすべて（どこへでも寄せられる位置にいる） |
 *
 * ## 対称にする
 *
 * 上の規則は、すきま層と雑食層の側からしか書かれていない。そのままだと
 * 「すきま層から見れば回遊層は隣、回遊層から見ればすきま層は隣ではない」
 * という、**向きによって食い違う関係**になる。片側から足した隣は、
 * 反対側にも足す（対称閉包）。
 *
 * **上下は作らない。** 「隣」は距離であって順位ではない。どの層にも
 * その層なりの読み方があり、隣であることは優劣を意味しない。
 *
 * VS Code APIにも AI にも依存しない。
 */

/** 主軸と副軸（副軸が無ければ null）。表の鍵をほどいたもの */
interface ReaderTypeAxes {
  main: ReaderAxis;
  /** 副軸。角の9タイプのうち3つは持たない */
  sub: ReaderAxis | null;
}

/** 副軸が無いことを表す鍵の後半（`READER_TYPE_TABLE` と同じ言葉） */
const NO_SUB = "none";

/** 全低の層（軸が1つも立っていない）。表には載らない */
const LIGHT: ReaderTypeId = "light";
/** 全中の層（どの軸も中ほど）。こちらも表には載らない */
const OMNIVORE: ReaderTypeId = "omnivore";

/**
 * 並べる順。**角の9タイプは表の並びをそのまま使う。**
 *
 * 隣を返す順が実行のたびに変わると、「いちばん近い隣」の決まらない
 * ときの答え（先頭）まで変わってしまう。
 */
export const READER_TYPE_IDS: readonly ReaderTypeId[] = [
  ...Object.values(READER_TYPE_TABLE),
  OMNIVORE,
  LIGHT,
];

/** 鍵の文字列を軸に戻す。知らない言葉は null（**推測で埋めない**） */
function toAxis(value: string | undefined): ReaderAxis | null {
  return READER_AXIS_ORDER.find((axis) => axis === value) ?? null;
}

/** 角の9タイプの軸。`READER_TYPE_TABLE` の鍵をほどいて作る */
const CORNER_AXES: ReadonlyMap<ReaderTypeId, ReaderTypeAxes> = (() => {
  const axes = new Map<ReaderTypeId, ReaderTypeAxes>();
  for (const [key, typeId] of Object.entries(READER_TYPE_TABLE)) {
    const [mainKey, subKey] = key.split(":");
    const main = toAxis(mainKey);
    // 主軸を読めない鍵は、この表の形をしていない。黙って別の軸へ寄せない
    if (!main) continue;
    axes.set(typeId, { main, sub: toAxis(subKey) });
  }
  return axes;
})();

/** 主軸と副軸から角のタイプを引く。組み合わせが表に無ければ undefined */
function cornerAt(
  main: ReaderAxis,
  sub: ReaderAxis | null
): ReaderTypeId | undefined {
  return READER_TYPE_TABLE[`${main}:${sub ?? NO_SUB}`];
}

/** 隣り合い。両向きに足してから、並びを揃える */
const NEIGHBORS: ReadonlyMap<ReaderTypeId, readonly ReaderTypeId[]> = (() => {
  const edges = new Map<ReaderTypeId, Set<ReaderTypeId>>();
  const link = (left: ReaderTypeId, right: ReaderTypeId): void => {
    // 自分自身は隣ではない（「隣へ一歩」の行き先にならない）
    if (left === right) return;
    for (const [from, to] of [
      [left, right],
      [right, left],
    ] as const) {
      const found = edges.get(from) ?? new Set<ReaderTypeId>();
      found.add(to);
      edges.set(from, found);
    }
  };

  for (const [typeId, { main, sub }] of CORNER_AXES) {
    // ① 主軸が同じで、副軸が違うもの
    for (const other of [null, ...READER_AXIS_ORDER]) {
      if (other === sub) continue;
      const found = cornerAt(main, other);
      if (found) link(typeId, found);
    }
    // ② 主軸と副軸を入れ替えたもの（副軸があるときだけ）
    const swapped = sub === null ? undefined : cornerAt(sub, main);
    if (swapped) link(typeId, swapped);
    // 雑食層は、どの角へも寄せられる位置にいる
    link(typeId, OMNIVORE);
  }

  // すきま層の隣は、副軸の無い3つ。**軸を1つ上げた先**だからである
  for (const axis of READER_AXIS_ORDER) {
    const found = cornerAt(axis, null);
    if (found) link(LIGHT, found);
  }

  const sorted = new Map<ReaderTypeId, readonly ReaderTypeId[]>();
  for (const [typeId, found] of edges) {
    sorted.set(
      typeId,
      [...found].sort(
        (left, right) =>
          READER_TYPE_IDS.indexOf(left) - READER_TYPE_IDS.indexOf(right)
      )
    );
  }
  return sorted;
})();

/**
 * その層の隣（決まった順で返す）。
 *
 * 隣を持たない層は無いが、**無ければ空配列**を返す——呼ぶ側が
 * 「隣が1つある」ことを前提に書かずに済むようにしておく。
 */
export function readerTypeNeighbors(type: ReaderTypeId): ReaderTypeId[] {
  return [...(NEIGHBORS.get(type) ?? [])];
}

/**
 * `from` の隣のうち、`toward` へいちばん近いものを1つ。
 *
 * 近さは次の順で決める。
 *
 * 1. **`toward` 自身が隣にあるなら、それ**（一歩で着く）
 * 2. `toward` の主軸を主軸に持つ隣
 * 3. `toward` の副軸を主軸に持つ隣
 * 4. 先頭（`READER_TYPE_IDS` の並び）
 *
 * `from === toward` なら `undefined`——**もう動く必要が無い。**
 * 「同じところへ一歩寄りましょう」は助言として成り立たない。
 */
export function neighborToward(
  from: ReaderTypeId,
  toward: ReaderTypeId
): ReaderTypeId | undefined {
  if (from === toward) return undefined;

  const neighbors = readerTypeNeighbors(from);
  if (neighbors.includes(toward)) return toward;

  const axes = CORNER_AXES.get(toward);
  if (axes) {
    const byMain = neighbors.find(
      (id) => CORNER_AXES.get(id)?.main === axes.main
    );
    if (byMain) return byMain;

    const bySub =
      axes.sub === null
        ? undefined
        : neighbors.find((id) => CORNER_AXES.get(id)?.main === axes.sub);
    if (bySub) return bySub;
  }

  return neighbors[0];
}
