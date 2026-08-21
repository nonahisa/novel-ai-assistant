/**
 * 2つの文字列の「違うところだけ」を取り出す（設計書6.11.2）。
 *
 * **提案パネルは、行まるごとに取り消し線と色を付けていた。** 誤字脱字は
 * 直す語が短いので気にならなかったが、推敲の指摘は文まるごとが対象になる。
 * 全部が赤で消され全部が緑で出るので、**どこが変わるのか目で追えない**
 * （作者の指摘、2026-08-21）。
 *
 *   呪詛だらけの学校は視界が悪いので、引き寄せて視界を確保する。
 *   → 呪詛だらけの学校は視界が悪いので、引き寄せて確保する。
 *
 * 消えるのは「視界を」の3文字だけである。そこだけを塗る。
 */

export type DiffKind = "equal" | "removed" | "added";

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

/**
 * 差分を細かく求めるのをやめる大きさ。
 *
 * 総当たりの表を作るので、長さの積が増えると重くなる。**パネルは
 * 本文を書きながら開きっぱなしにする場所**なので、ここで止める。
 * 超えたときは「まるごと消して、まるごと足す」という粗い形に落とす。
 */
const MAX_TABLE_CELLS = 200_000;

/**
 * 違いの塊がこれより多くなったら、細かく出すのをやめる。
 *
 * **文の書き換えを1文字ずつ照らし合わせると、たまたま同じ文字
 * （「の」「、」など）が拾われて虫食いになる。** そうなるくらいなら、
 * まるごと消してまるごと足すほうが読める。
 */
const MAX_MIDDLE_SEGMENTS = 6;

/**
 * 共通部分がこれだけ無ければ、細かく出すのをやめる。
 *
 * **塊の数を見るだけでは足りなかった。** 「まったく別の文です」と
 * 「共通するところが何も無い」を比べると、たまたま「す」が一致して
 * 4つの塊に割れる。**まるごと書き換わっているのに、真ん中の1文字だけが
 * 「変わっていません」と出る。** 塊が少なくても嘘になる。
 *
 * 短いほうの何割が共通なら、それを「同じところ」と呼んでよいか。
 */
const MIN_COMMON_SHARE = 0.3;

/**
 * `before` を `after` にするための、区間の並びを返す。
 *
 * 並べ直せば元に戻る（`equal` と `removed` を繋ぐと `before`、
 * `equal` と `added` を繋ぐと `after` になる）。
 */
export function diffChars(before: string, after: string): DiffSegment[] {
  if (before === after) {
    return before ? [{ kind: "equal", text: before }] : [];
  }

  // **符号位置で切る。** 文字単位で切ると、サロゲートペア（一部の漢字や
  // 絵文字）が2つに割れて、画面に壊れた文字が出る
  const a = Array.from(before);
  const b = Array.from(after);

  // 前と後ろの同じところを先に落とす。**直しはたいてい真ん中の
  // ひと塊なので、これだけで済むことが多い**（表を作らずに終わる）
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const segments: DiffSegment[] = [];
  if (head > 0) {
    segments.push({ kind: "equal", text: a.slice(0, head).join("") });
  }
  segments.push(
    ...diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail))
  );
  if (tail > 0) {
    segments.push({ kind: "equal", text: a.slice(a.length - tail).join("") });
  }

  return segments;
}

/** 前後の共通部分を落とした、残りの部分を比べる */
function diffMiddle(a: string[], b: string[]): DiffSegment[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ kind: "added", text: b.join("") }];
  if (b.length === 0) return [{ kind: "removed", text: a.join("") }];

  if (a.length * b.length > MAX_TABLE_CELLS) return wholesale(a, b);

  const detailed = longestCommonDiff(a, b);

  // 虫食いになるくらいなら、粗いほうが読める
  if (detailed.length > MAX_MIDDLE_SEGMENTS) return wholesale(a, b);

  const common = detailed
    .filter((segment) => segment.kind === "equal")
    .reduce((total, segment) => total + Array.from(segment.text).length, 0);
  if (common < Math.min(a.length, b.length) * MIN_COMMON_SHARE) {
    return wholesale(a, b);
  }

  return detailed;
}

/** まるごと消して、まるごと足す */
function wholesale(a: string[], b: string[]): DiffSegment[] {
  return [
    { kind: "removed", text: a.join("") },
    { kind: "added", text: b.join("") },
  ];
}

/**
 * 最長共通部分列をたどって、区間に分ける。
 *
 * `table[i][j]` は「`a` の i 文字目以降と `b` の j 文字目以降で、
 * 共通して残せる文字数」。後ろから埋めて、前からたどる。
 */
function longestCommonDiff(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      append(segments, "equal", a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      // **迷ったら「消す」を先に出す。** 同じ場所での入れ替えは
      // 「消してから足す」の順に並ぶほうが読みやすい
      append(segments, "removed", a[i]);
      i++;
    } else {
      append(segments, "added", b[j]);
      j++;
    }
  }
  while (i < n) append(segments, "removed", a[i++]);
  while (j < m) append(segments, "added", b[j++]);

  return segments;
}

/** 同じ種類が続くなら、区間を分けずに繋ぐ */
function append(segments: DiffSegment[], kind: DiffKind, text: string): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  segments.push({ kind, text });
}
