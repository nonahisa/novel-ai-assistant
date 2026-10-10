/**
 * 競合マーカーの解析（設計書5.5.4）。
 *
 * 同一人物が環境を渡り歩いて書くため、「どちらが正しいか」は
 * 本人が見れば分かる。機械的なマージを試みるより、
 * **両方を並べて選ばせる方が速く確実**である。
 *
 * ここは判定と組み立てだけを行い、ファイルへは書かない。
 * 原稿への書き込みはgit自身にやらせる（`checkout --ours` など）。
 * この拡張機能は既存の原稿ファイルを上書きしない、という
 * 不変条件を崩さないためである。
 */

/** 競合している1か所 */
export interface ConflictHunk {
  /** 本文（LF区切り）の何行目から始まるか（0始まり） */
  startLine: number;
  /** この環境の版のラベル（`<<<<<<< HEAD` の HEAD の部分） */
  oursLabel: string;
  /** 別環境の版のラベル（`>>>>>>> origin/main` の右側） */
  theirsLabel: string;
  /** この環境の版の行 */
  ours: string[];
  /** 別環境の版の行 */
  theirs: string[];
  /** 共通の祖先（diff3形式のときだけ入る） */
  base?: string[];
}

export interface ConflictParseResult {
  hunks: ConflictHunk[];
  /** 開始と終了が噛み合っていない箇所があったか */
  malformed: boolean;
}

const START = /^<{7}(?:\s(.*))?$/;
const BASE = /^\|{7}(?:\s(.*))?$/;
const SEPARATOR = /^={7}\s*$/;
const END = /^>{7}(?:\s(.*))?$/;

/**
 * 競合マーカーを読み取る。
 *
 * 入力は改行をLFへ揃えた本文（`decodeBytes` の `text`）を前提とする。
 * 元の改行コードは呼び出し側が保持しているので、ここでは扱わない。
 */
export function parseConflicts(text: string): ConflictParseResult {
  const lines = text.split("\n");
  const hunks: ConflictHunk[] = [];
  let malformed = false;

  let index = 0;
  while (index < lines.length) {
    const startMatch = START.exec(lines[index]);
    if (!startMatch) {
      index++;
      continue;
    }

    const startLine = index;
    const oursLabel = (startMatch[1] ?? "").trim();
    const ours: string[] = [];
    const theirs: string[] = [];
    let base: string[] | undefined;
    let section: "ours" | "base" | "theirs" = "ours";
    let theirsLabel = "";
    let closed = false;

    index++;
    while (index < lines.length) {
      const line = lines[index];

      // マーカーの入れ子は解釈しない。手で編集途中の可能性が高く、
      // 想像で読み解くと誤った版を採用させてしまう
      if (START.test(line)) break;

      if (BASE.test(line)) {
        section = "base";
        base = [];
        index++;
        continue;
      }
      if (SEPARATOR.test(line)) {
        section = "theirs";
        index++;
        continue;
      }
      const endMatch = END.exec(line);
      if (endMatch) {
        theirsLabel = (endMatch[1] ?? "").trim();
        closed = true;
        index++;
        break;
      }

      if (section === "ours") ours.push(line);
      else if (section === "base") base?.push(line);
      else theirs.push(line);

      index++;
    }

    if (!closed) {
      malformed = true;
      continue;
    }
    hunks.push({ startLine, oursLabel, theirsLabel, ours, theirs, base });
  }

  return { hunks, malformed };
}

export type ConflictChoice = "ours" | "theirs";

/**
 * 競合マーカーを取り除いて、選んだ側だけの本文を組み立てる。
 *
 * **すべての箇所に同じ選択を適用する。** 箇所ごとに選ばせる形は
 * 作らない。1ファイルの中で版が混ざると、前後のつながりが壊れた
 * 原稿ができあがり、しかもそれに気づきにくい。
 */
export function resolveConflicts(text: string, choice: ConflictChoice): string {
  const lines = text.split("\n");
  const parsed = parseConflicts(text);
  if (parsed.hunks.length === 0) return text;

  const result: string[] = [];
  let cursor = 0;

  for (const hunk of parsed.hunks) {
    // マーカーの手前まではそのまま
    for (let line = cursor; line < hunk.startLine; line++) {
      result.push(lines[line]);
    }
    result.push(...(choice === "ours" ? hunk.ours : hunk.theirs));
    cursor = endLineOf(lines, hunk.startLine) + 1;
  }
  for (let line = cursor; line < lines.length; line++) {
    result.push(lines[line]);
  }
  return result.join("\n");
}

/** そのhunkを閉じている `>>>>>>>` の行番号 */
function endLineOf(lines: string[], startLine: number): number {
  for (let line = startLine + 1; line < lines.length; line++) {
    if (END.test(lines[line])) return line;
  }
  return lines.length - 1;
}

/**
 * 退避ファイルの目印。原稿と見分けるために名前へ必ず入る。
 *
 * 判断に迷う場合、片方を消すより両方残す方が安全である。
 * 原稿は失われた時の損害が大きく、あとから統合する手間の方が
 * はるかに軽い（設計書5.5.4）。
 */
const SIDE_FILE_MARKER = ".conflict-";

/**
 * 「両方を残す」で作った退避ファイルか。
 *
 * **退避ファイルは別環境の版の写しであって、原稿ではない。**
 * 走査が原稿として拾うと、同じ話数の本文が2つある状態になり、
 * 文字数が二重に数えられ、AIにも同じ話を2回送ることになる
 * （クラウドAIならそのまま料金になる）。
 */
export function isConflictSideFile(fileName: string): boolean {
  return fileName.includes(SIDE_FILE_MARKER);
}

/**
 * 「両方とも残す」で作る別ファイルの名前（設計書5.5.4）。
 *
 * **形は「元の名前.conflict-年-月-日-時分.拡張子」**（作者の裁定、2026-10-11）。
 * それまでは git の印（`origin/main:本文/第9話.txt` のような長い文字列）を
 * 32字で切って使っていたため、名前が途中で切れ、何の写しか読めなかった。
 * 日時なら、いつそろえたときの写しかが名前だけで分かる。
 *
 * `.conflict-` の目印は必ず残す。`isConflictSideFile` が、原稿の走査から
 * 外すのに使っている（写しを話数として二重に数えないため）。
 *
 * 同じ名前が既にあれば、末尾に -2, -3 … を付ける（`existing` に今ある名前を渡す）。
 * **既にあるファイルは決して潰さない**——前回の写しにしか無い原稿が消える。
 */
export function sideFileName(
  fileName: string,
  when: Date,
  existing: ReadonlySet<string> = new Set()
): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  const base = `${stem}${SIDE_FILE_MARKER}${sideFileStamp(when)}`;
  let candidate = `${base}${extension}`;
  for (let attempt = 2; existing.has(candidate); attempt++) {
    candidate = `${base}-${attempt}${extension}`;
  }
  return candidate;
}

/** 別ファイルの名前に入れる日時（YYYY-MM-DD-HHmm。手元の時刻） */
export function sideFileStamp(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}`
  );
}

/** 競合の規模を1文で伝える */
export function describeConflict(parsed: ConflictParseResult): string {
  if (parsed.hunks.length === 0) {
    return parsed.malformed
      ? "競合マーカーが閉じていません。手で確認してください。"
      : "競合はありません。";
  }
  const lines = parsed.hunks.reduce(
    (total, hunk) => total + Math.max(hunk.ours.length, hunk.theirs.length),
    0
  );
  const note = parsed.malformed
    ? "（閉じていないマーカーもあります）"
    : "";
  return `${parsed.hunks.length}か所・最大${lines}行が食い違っています${note}`;
}

/**
 * どちらの文を残すかを選ぶ一覧の、入力欄の案内（作者の裁定、2026-10-11）。
 *
 * **左右がどちらの機械の文かを、ここで必ず言う。** 差分の見出しは小さく、
 * 作者は一覧の文だけを読んで選ぶことがある。違う箇所の数を添えるのは、
 * 1か所だけの違いか、話の大半が違うのかで、選び方の慎重さが変わるため。
 * 印を読めなかったとき（索引の版を並べたとき）は数を出さない。
 */
export function describeChoicePlaceholder(parsed: ConflictParseResult): string {
  const head = "左がこのパソコン、右がもう1台の文です";
  if (parsed.hunks.length === 0) return head;
  const lines = parsed.hunks.reduce(
    (total, hunk) => total + Math.max(hunk.ours.length, hunk.theirs.length),
    0
  );
  return `${head}（${parsed.hunks.length}か所・最大${lines}行が違います）`;
}
