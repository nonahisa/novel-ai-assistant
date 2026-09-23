/**
 * バックアップとの本文の違いを、1か所ずつの提案にする（作者の裁定、2026-09-23。
 * 設計書6.99.7 の続き）。
 *
 * 作者の裁定：「違い1か所ずつを提案パネルに並べ、採るかどうかを箇所ごとに
 * 選べるようにする。段落の増減も扱えるよう、提案の形を広げる」。
 *
 * ## 行の番号は「ファイルの何行目か」で持つ
 *
 * 違いの計算（`backupMerge.ts` の `diffBodies`）は**本文だけ**を比べるので、
 * 番号は「本文の何行目か」である。ところが書き換えるのはファイルで、
 * ファイルには本文の前に見出し（【エピソードタイトル】など）があり、合本なら
 * ほかの話も並んでいる。**本文がファイルの何行目から始まるか**を、本文の
 * 行の並びそのものをファイルの中で探して決める（`locateBodyInFile`）。
 * 1か所に決まらなければ提案にしない——当て推量の行へ書き込むより、
 * 記録（「違いを見る」）にだけ残すほうが原稿を壊さない。
 *
 * ## 書き換える前に、中身をもう一度確かめる
 *
 * 当てる直前に、ファイルのその行が**提案を作ったときの手元の行と同じか**を
 * 確かめる（`applyLineBlock`）。ハッシュの照合（呼ぶ側）と二重になるが、
 * こちらは「照合をすり抜けた取り違え」への最後の柵である。
 *
 * VS Code API には依存しない。
 */

/** 複数行の置き換え1か所（行はファイルの中の番号。1始まり） */
export interface LineBlock {
  /**
   * ファイルの何行目から置き換えるか（改行を LF にそろえて数える）。
   * `local` が空（行を足すだけ）なら、**この行の前へ**入れる
   */
  readonly startLine: number;
  /** いまファイルにある行（行末の空白を落としたもの）。空なら足すだけ */
  readonly local: readonly string[];
  /** 置き換えたあとの行。空なら消すだけ */
  readonly replacement: readonly string[];
}

/** 提案パネルへ渡す1か所ぶん（ファイルの場所は呼ぶ側が絶対パスにする） */
export interface BackupHunkProposal {
  /** 作品フォルダーからの相対パス（`/` 区切り） */
  readonly relPath: string;
  /** どの話か（「2話　検査」） */
  readonly episodeLabel: string;
  /** ファイルの何行目から（1始まり） */
  readonly startLine: number;
  /** 手元の行 */
  readonly local: readonly string[];
  /** バックアップの行 */
  readonly backup: readonly string[];
  /** 提案を作ったときのファイルのハッシュ。**これと違えば当てない** */
  readonly fileHash: string;
}

/** 行末の空白を落とす（`diffBodies` の比べ方と同じ。字下げの全角空白は残す） */
export function trimLineEnd(line: string): string {
  return line.replace(/[ \t　]+$/u, "");
}

/**
 * 本文の行がファイルの何行目から始まるか（0始まりの行の位置）。
 *
 * 比べ方は `diffBodies` と同じ——行末の空白を落とし、本文の前後の空行は
 * 除いてから、**本文の全部の行が続けて並んでいる場所**を探す。
 *
 * @returns 1か所に決まればその位置。見つからない・2か所以上なら null
 */
export function locateBodyInFile(fileText: string, body: string): number | null {
  const bodyLines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(trimLineEnd);
  while (bodyLines.length > 0 && bodyLines[0] === "") bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
    bodyLines.pop();
  }
  // 本文が空なら、どこから始まるとも言えない
  if (bodyLines.length === 0) return null;

  const fileLines = fileText.replace(/\r\n?/g, "\n").split("\n").map(trimLineEnd);
  let found: number | null = null;
  for (let start = 0; start + bodyLines.length <= fileLines.length; start++) {
    // 1行目で先に振るい落とす（合本の何万行でも、ほとんどここで済む）
    if (fileLines[start] !== bodyLines[0]) continue;
    let same = true;
    for (let i = 1; i < bodyLines.length; i++) {
      if (fileLines[start + i] !== bodyLines[i]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    // **2か所目が見つかったら決めない。** どちらを書き換えるべきか分からない
    if (found !== null) return null;
    found = start;
  }
  return found;
}

/**
 * 1話ぶんの違いを、1か所ずつの提案にする。
 *
 * @param diff `backupMerge.ts` の `EpisodeBodyDiff`（本文がファイルのどこから
 *   始まるかと、ファイルのハッシュを持つもの）
 * @returns 位置かハッシュが分からなければ空（記録にだけ残す）
 */
export function hunkProposalsOf(diff: {
  readonly label: string;
  readonly relPath: string;
  readonly hunks: readonly {
    readonly localLine: number;
    readonly local: readonly string[];
    readonly backup: readonly string[];
  }[];
  readonly bodyLineOffset: number | null;
  readonly fileHash: string | null;
}): BackupHunkProposal[] {
  if (diff.bodyLineOffset === null || diff.fileHash === null) return [];
  const offset = diff.bodyLineOffset;
  const hash = diff.fileHash;
  return diff.hunks.map((hunk) => ({
    relPath: diff.relPath,
    episodeLabel: diff.label,
    // 本文の1行目がファイルの (offset + 1) 行目
    startLine: offset + hunk.localLine,
    local: hunk.local,
    backup: hunk.backup,
    fileHash: hash,
  }));
}

/** 提案にできた違いの数（確認画面の「M か所」） */
export function countProposableHunks(
  diffs: readonly Parameters<typeof hunkProposalsOf>[0][]
): number {
  return diffs.reduce((total, diff) => total + hunkProposalsOf(diff).length, 0);
}

/**
 * ファイルの本文（LF）へ、1か所の置き換えを当てる。
 *
 * **置き換える行が `local` と1行でも違えば当てない**（null）。行末の空白は
 * 比べない（`diffBodies` と同じ）が、行頭の字下げは比べる。
 *
 * @returns 当てたあとの全文（LF）。当てられなければ null
 */
export function applyLineBlock(fileText: string, block: LineBlock): string | null {
  const lines = fileText.split("\n");
  const at = block.startLine - 1;
  if (at < 0 || at > lines.length) return null;
  if (at + block.local.length > lines.length) return null;
  for (let i = 0; i < block.local.length; i++) {
    if (trimLineEnd(lines[at + i]) !== block.local[i]) return null;
  }
  lines.splice(at, block.local.length, ...block.replacement);
  return lines.join("\n");
}

/** 当てた（戻した）1か所の逆向き。「戻す」に使う */
export function invertLineBlock(block: LineBlock): LineBlock {
  return {
    startLine: block.startLine,
    local: block.replacement,
    replacement: block.local,
  };
}

/**
 * 同じファイルの別の1か所が当たったあと、この1か所の始まりの行を直す。
 *
 * **後ろにある箇所だけが、増減した行の数だけずれる。** 違いは互いに
 * 重ならない（`diffBodies` は同じ行を挟んで区切る）ので、始まりが
 * 当てた箇所より後ろなら、そのまま足し引きすればよい。
 */
export function shiftedStartLine(startLine: number, applied: LineBlock): number {
  if (startLine <= applied.startLine) return startLine;
  return startLine + applied.replacement.length - applied.local.length;
}
