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
 * 「両方を残す」ときに使う、別環境の版のファイル名。
 *
 * 判断に迷う場合、片方を消すより両方残す方が安全である。
 * 原稿は失われた時の損害が大きく、あとから統合する手間の方が
 * はるかに軽い（設計書5.5.4）。
 */
export function sideFileName(fileName: string, label: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  return `${stem}.conflict-${sanitizeLabel(label)}${extension}`;
}

/**
 * ラベルをファイル名に使える形へ均す。
 *
 * `>>>>>>> origin/main` の「origin/main」はそのままでは
 * パス区切りを含む。何も残らなければ "other" とする。
 */
export function sanitizeLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/[/\\:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || "other";
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
