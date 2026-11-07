import { hasConflictMarkers } from "./textDecode";

/**
 * 直した場所が違えば合わせ、同じ場所だけ選ばせる（設計書5.10.7。0.134.0）。
 *
 * Google ドライブでそろえるときの食い違いを、**行（段落）を単位に**合わせる。
 * 元の文（共通の祖先の中身）と N 個の候補を比べ、
 *
 * - 変わった範囲がほかの候補の変わった範囲と**重なる・接する**（間に変わって
 *   いない行が1行も無い。同じ所への挿入も含む）なら「同じ場所」。git の diff3 が
 *   食い違いにする範囲と同じにした——作者が GitHub の同期で慣れた手間にそろえるため
 * - 同じ場所でも、変えた結果の文がどの候補も同じなら1つとして当てる
 * - 重ならない範囲はそのまま当てる
 *
 * **機械は新しい文を作らない。** 当てるのは、どれかの候補の行をそのまま写したものだけ。
 * 書く前に `verifyDriveMerge` でそれをコードで確かめる（実装ルール3「AIの出力を信用
 * しない」と同じ考えを、機械の合わせにも当てる）。
 *
 * **どの台が合わせても同じ結果になる**ように、候補は呼び手が渡した順ではなく
 * `id`（中身のハッシュ）の順に並べ直してから合わせる。2台が別々に同じ食い違いを
 * 合わせても同じ中身になり、往復しない（設計書5.10.7 の5）。
 *
 * ここは文字列だけを扱う純粋な関数で、何も読まず何も書かない。改行の形は
 * 比べる前に `\n` へそろえ、返す文も `\n` で返す（書くときの改行は呼び手が決める）。
 * `vscode`・`node:`・`./paths` を読まない（モバイル版へ持っていくため。
 * `test/unit/core/driveTextMerge.test.ts` の最後のテストが見張る）。
 */

/** 合わせてよい本文か（`.txt`・`.md`）。設定資料は `decideSettingsConflict` のまま */
export function isDriveMergeTextPath(syncPath: string): boolean {
  return /\.(txt|md)$/i.test(syncPath);
}

/** 改行の形（`mixed` は1つのファイルの中で CRLF と LF が混ざっている） */
export type DriveTextEol = "\n" | "\r\n" | "none" | "mixed";

/** 文の改行の形を見る。CR だけの改行は行の中身として扱う（Windows でも Mac でも今は使わない） */
export function driveTextEol(text: string): DriveTextEol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (lf === 0) return "none";
  if (crlf === lf) return "\r\n";
  if (crlf === 0) return "\n";
  return "mixed";
}

/** `\n` へそろえて行に割る。末尾の改行は最後の空の行として残る（組み直すと元に戻る） */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export interface DriveMergeCandidate {
  /** 候補の印。**中身のハッシュを渡す**（この順に並べて合わせる） */
  id: string;
  text: string;
}

/** 同じ場所で選べる文の1つ（同じ文を持つ候補はまとめる） */
export interface DriveMergeOption {
  /** その場所の文（行の並び。空なら「消す」） */
  lines: string[];
  /** この文を持つ候補の `id`（`id` の順） */
  candidates: string[];
  /** 確かめ用：候補ごとの、その文がある行の範囲（候補の行の番号。終わりは含まない） */
  sources: { candidate: string; start: number; end: number }[];
}

/** 同じ場所1つ */
export interface DriveMergeRegion {
  /** 元の文の行の範囲（終わりは含まない。挿入なら start === end） */
  baseStart: number;
  baseEnd: number;
  /** 元の文のその範囲（**選ぶ行ではなく、見比べのために添える**） */
  baseLines: string[];
  /** 選べる文。並びは、その文を持つ候補の `id` のいちばん小さいものの順 */
  options: DriveMergeOption[];
}

/**
 * 合わせた結果を組む部品。元の文の順に並び、元の文の行の範囲を隙間なく覆う。
 *
 * - `base`：どの候補も変えていない元の文の行
 * - `take`：合わせられた所（1つの候補だけが変えた・変えた候補がみな同じ文）。
 *   `lines` は候補 `candidate` の行 `candStart`〜`candEnd` をそのまま写したもの
 * - `region`：同じ場所（`regions[region]`。作者が選ぶ）
 */
export type DriveMergePiece =
  | { kind: "base"; baseStart: number; baseEnd: number }
  | {
      kind: "take";
      baseStart: number;
      baseEnd: number;
      lines: string[];
      candidate: string;
      candStart: number;
      candEnd: number;
    }
  | { kind: "region"; baseStart: number; baseEnd: number; region: number };

/** 合わせた結果。`regions` が空なら、黙って合わせてよい */
export interface DriveTextMerge {
  kind: "merge";
  /** 元の文の行（`\n` へそろえたもの） */
  baseLines: string[];
  /** 候補（`id` の順）と、その行 */
  candidates: { id: string; lines: string[] }[];
  pieces: DriveMergePiece[];
  regions: DriveMergeRegion[];
}

export type DriveTextMergeResult = DriveTextMerge | { kind: "unmergeable"; reason: string };

/**
 * 差分の上限（行の違いの数）。これを越える書き換えは、行で合わせるより
 * ファイルごとに見比べたほうが早い。長い原稿でも、直した所が少なければ速い
 * （比べる手間は「行の数 × 違いの数」で増える）
 */
const MAX_DIFF = 2000;

/** 候補1つが元の文から変えた所（元の文の範囲を、候補の範囲で置き換えた） */
interface Change {
  candidate: number;
  baseStart: number;
  baseEnd: number;
  candStart: number;
  candEnd: number;
}

/**
 * 元の文と候補を合わせる（設計書5.10.7 の2〜5）。
 *
 * 合わせられないとき（候補が2つ未満・競合マーカー・改行の形が混ざっている・
 * 違いが多すぎる）は `unmergeable` を返す。呼び手はファイルごとの扱いへ回す。
 */
export function mergeDriveTexts(input: {
  base: string;
  candidates: readonly DriveMergeCandidate[];
}): DriveTextMergeResult {
  if (input.candidates.length < 2) return { kind: "unmergeable", reason: "候補が2つ以上ありません" };
  for (const text of [input.base, ...input.candidates.map((c) => c.text)]) {
    // 競合マーカーのある文を行で合わせると、印の行が本文に混ざる（実装ルール1）
    if (hasConflictMarkers(text)) return { kind: "unmergeable", reason: "競合マーカーがあります" };
    // 混ざった改行は、そろえると元の形に戻せない（設計書5.4.2）
    if (driveTextEol(text) === "mixed") return { kind: "unmergeable", reason: "改行の形が混ざっています" };
  }

  // 中身のハッシュの順に並べる。同じ中身（同じ id）は1つにする
  const sorted = [...input.candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 同じ中身の候補は1つにする（同じ直しを2台がした。結果は1つとして当たる）
  const unique = sorted.filter((c, i) => i === 0 || c.id !== sorted[i - 1].id);

  const baseLines = splitLines(input.base);
  const candidates = unique.map((c) => ({ id: c.id, lines: splitLines(c.text) }));

  const changes: Change[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const diff = diffLines(baseLines, candidates[i].lines);
    if (diff === undefined) return { kind: "unmergeable", reason: "違いが多すぎます" };
    for (const change of diff) changes.push({ candidate: i, ...change });
  }

  // 変わった範囲を、重なる・接するものどうしでまとめる（[s1,e1) と [s2,e2) は
  // s2 <= e1 なら接する。長さ0の挿入どうしが同じ位置なら当たる）
  changes.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd || a.candidate - b.candidate);
  const clusters: Change[][] = [];
  let clusterEnd = -1;
  for (const change of changes) {
    const last = clusters[clusters.length - 1];
    if (last && change.baseStart <= clusterEnd) {
      last.push(change);
      clusterEnd = Math.max(clusterEnd, change.baseEnd);
    } else {
      clusters.push([change]);
      clusterEnd = change.baseEnd;
    }
  }

  const pieces: DriveMergePiece[] = [];
  const regions: DriveMergeRegion[] = [];
  let cursor = 0;
  for (const cluster of clusters) {
    const start = cluster[0].baseStart;
    const end = Math.max(...cluster.map((c) => c.baseEnd));
    if (start > cursor) pieces.push({ kind: "base", baseStart: cursor, baseEnd: start });

    // この場所で変えた候補ごとの、その場所の文（候補の行の範囲として）
    const changedBy = [...new Set(cluster.map((c) => c.candidate))].sort((a, b) => a - b);
    const options: DriveMergeOption[] = [];
    for (const index of changedBy) {
      const own = cluster.filter((c) => c.candidate === index);
      // 元の文の start は、この候補ではどの行か（start より前の変更でずれた分を足す）
      const before = changes.filter((c) => c.candidate === index && c.baseEnd <= start && !own.includes(c));
      const shift = before.reduce((sum, c) => sum + (c.candEnd - c.candStart) - (c.baseEnd - c.baseStart), 0);
      const candStart = start + shift;
      const grown = own.reduce((sum, c) => sum + (c.candEnd - c.candStart) - (c.baseEnd - c.baseStart), 0);
      const candEnd = candStart + (end - start) + grown;
      const lines = candidates[index].lines.slice(candStart, candEnd);
      const key = lines.join("\n");
      const source = { candidate: candidates[index].id, start: candStart, end: candEnd };
      const found = options.find((option) => option.lines.length === lines.length && option.lines.join("\n") === key);
      if (found) {
        found.candidates.push(candidates[index].id);
        found.sources.push(source);
      } else {
        options.push({ lines, candidates: [candidates[index].id], sources: [source] });
      }
    }

    if (options.length === 1) {
      const [option] = options;
      const [source] = option.sources;
      pieces.push({
        kind: "take",
        baseStart: start,
        baseEnd: end,
        lines: option.lines,
        candidate: source.candidate,
        candStart: source.start,
        candEnd: source.end,
      });
    } else {
      pieces.push({ kind: "region", baseStart: start, baseEnd: end, region: regions.length });
      regions.push({ baseStart: start, baseEnd: end, baseLines: baseLines.slice(start, end), options });
    }
    cursor = end;
  }
  if (cursor < baseLines.length) pieces.push({ kind: "base", baseStart: cursor, baseEnd: baseLines.length });

  return { kind: "merge", baseLines, candidates, pieces, regions };
}

/**
 * 選んだ答え（場所ごとに `options` の番号）から最後の文を組む。改行は `\n`。
 * 選びの数が場所の数と違う・番号が範囲の外なら undefined（組まない）。
 */
export function assembleDriveMerge(merge: DriveTextMerge, picks: readonly number[]): string | undefined {
  if (picks.length !== merge.regions.length) return undefined;
  const out: string[] = [];
  for (const piece of merge.pieces) {
    if (piece.kind === "base") out.push(...merge.baseLines.slice(piece.baseStart, piece.baseEnd));
    else if (piece.kind === "take") out.push(...piece.lines);
    else {
      const option = merge.regions[piece.region]?.options[picks[piece.region]];
      if (!option) return undefined;
      out.push(...option.lines);
    }
  }
  return out.join("\n");
}

/**
 * 合わせた結果を**書く前に**確かめる（設計書5.10.7 の守り）。通れば true、外れれば理由。
 *
 * 部品を組んだ側（`mergeDriveTexts`）を信じずに、元の文と候補から確かめ直す：
 *
 * 1. 部品が元の文の行の範囲を、順に隙間なく覆っている
 * 2. どの候補でも変わっていない元の文の行は、全部 `base` の部品に入っている
 *    （候補ごとに差分を取り直して数える）
 * 3. 当てた文（`take` と、選んだ文）が、どれかの候補の行をそのまま写したもの
 *    （機械が新しい文を作っていない）
 */
export function verifyDriveMerge(
  merge: DriveTextMerge,
  picks: readonly number[],
  original: { base: string; candidates: readonly DriveMergeCandidate[] }
): true | string {
  if (picks.length !== merge.regions.length) return "選びの数が場所の数と違います";
  // 0：結果が持つ元の文と候補の写しが、呼び手の持つ元の文・候補そのものか
  // （写しが書き換わっていれば、それと照らしても確かめたことにならない）
  const base = splitLines(original.base);
  if (base.length !== merge.baseLines.length || base.some((line, i) => line !== merge.baseLines[i])) {
    return "元の文が合わせたときの元の文と違います";
  }
  for (const candidate of merge.candidates) {
    const source = original.candidates.find((c) => c.id === candidate.id);
    const lines = source ? splitLines(source.text) : undefined;
    if (!lines || lines.length !== candidate.lines.length || lines.some((line, i) => line !== candidate.lines[i])) {
      return "候補の文が合わせたときの候補と違います";
    }
  }
  if (original.candidates.some((c) => !merge.candidates.some((own) => own.id === c.id))) {
    return "合わせていない候補があります";
  }
  const n = merge.baseLines.length;

  // 2 の準備：どの候補も変えていない元の文の行
  const untouched = new Array<boolean>(n).fill(true);
  for (const candidate of merge.candidates) {
    const diff = diffLines(merge.baseLines, candidate.lines);
    if (diff === undefined) return "違いが多すぎます";
    for (const change of diff) {
      for (let i = change.baseStart; i < change.baseEnd; i++) untouched[i] = false;
    }
  }
  const byId = new Map(merge.candidates.map((c) => [c.id, c.lines]));
  const sameSlice = (candidate: string, start: number, end: number, lines: readonly string[]) => {
    const source = byId.get(candidate);
    if (!source || start < 0 || end > source.length || end - start !== lines.length) return false;
    return lines.every((line, i) => line === source[start + i]);
  };

  let cursor = 0;
  const inBase = new Array<boolean>(n).fill(false);
  for (const piece of merge.pieces) {
    if (piece.baseStart !== cursor || piece.baseEnd < piece.baseStart) return "部品が元の文を順に覆っていません";
    cursor = piece.baseEnd;
    if (piece.kind === "base") {
      for (let i = piece.baseStart; i < piece.baseEnd; i++) inBase[i] = true;
    } else if (piece.kind === "take") {
      if (!sameSlice(piece.candidate, piece.candStart, piece.candEnd, piece.lines)) {
        return "当てた文が候補の文と違います";
      }
    } else {
      const region = merge.regions[piece.region];
      if (!region || region.baseStart !== piece.baseStart || region.baseEnd !== piece.baseEnd) {
        return "同じ場所の範囲が合いません";
      }
      const option = region.options[picks[piece.region]];
      if (!option) return "選んだ番号が範囲の外です";
      if (!option.sources.some((s) => sameSlice(s.candidate, s.start, s.end, option.lines))) {
        return "選んだ文が候補の文と違います";
      }
    }
  }
  if (cursor !== n) return "部品が元の文の終わりまで覆っていません";
  for (let i = 0; i < n; i++) {
    if (untouched[i] && !inBase[i]) return `どの候補でも変わっていない元の文の行（${i + 1}行目）が残っていません`;
  }
  return true;
}

/**
 * 行の差分（Myers の方法）。変わった所を、元の文の範囲と候補の範囲の組で返す。
 * 続いた変更（消す・足す）は1つにまとめるので、同じ候補の変更どうしの間には
 * 必ず変わっていない行が1行以上ある。違いが `MAX_DIFF` を越えれば undefined。
 */
function diffLines(
  a: readonly string[],
  b: readonly string[]
): { baseStart: number; baseEnd: number; candStart: number; candEnd: number }[] | undefined {
  // 頭と尻の同じ行を先に除く（直した所が少ない原稿では、ここでほとんど片づく）
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x0 = a.slice(head, a.length - tail);
  const y0 = b.slice(head, b.length - tail);
  const n = x0.length;
  const m = y0.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    return [{ baseStart: head, baseEnd: head + n, candStart: head, candEnd: head + m }];
  }

  const max = n + m;
  const limit = Math.min(max, MAX_DIFF);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // d 回目を終えたときの v の k = -d〜d の写し（戻りに使う）
  const snaps: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x0[x] === y0[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
    snaps.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return undefined;

  // 戻りながら、1手ずつ「同じ」「消す」「足す」を集める（後ろから）
  const ops: ("eq" | "del" | "ins")[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = snaps[d - 1];
    const get = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("eq");
      x--;
      y--;
    }
    if (down) {
      ops.push("ins");
      y--;
    } else {
      ops.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("eq");
    x--;
    y--;
  }
  ops.reverse();

  const out: { baseStart: number; baseEnd: number; candStart: number; candEnd: number }[] = [];
  let ai = 0;
  let bi = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === "eq") {
      ai++;
      bi++;
      i++;
      continue;
    }
    const start = { a: ai, b: bi };
    while (i < ops.length && ops[i] !== "eq") {
      if (ops[i] === "del") ai++;
      else bi++;
      i++;
    }
    out.push({ baseStart: head + start.a, baseEnd: head + ai, candStart: head + start.b, candEnd: head + bi });
  }
  return out;
}
