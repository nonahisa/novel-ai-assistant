import type { Eol } from "../models/types";

/**
 * 改行コードの食い違いを見つけて、揃える計画を立てる（設計書5.4.2）。
 *
 * 作者の依頼（2026-09-12）：「改行コードが違う場合、他のツールで不具合が
 * 起こる可能性を指摘しつつ、変換を促したほうが良いのではないでしょうか」。
 *
 * **保持が原則なのは変わらない。** 読んだままの改行で書き戻すという決まり
 * （5.4.2）はそのままで、ここがするのは**知らせること**と、
 * **作者が押したときに揃える計画を作ること**だけである。自動では変えない。
 *
 * VS Code APIに依存しない。走査の結果（`EpisodeFile`）から組み立てられる
 * 材料だけを受け取り、数と一覧を返す。
 */

/** 監査に渡す1件ぶん。走査で読んだ結果をそのまま渡せる形にしてある */
export interface EolAuditEntry {
  filePath: string;
  /** 読めなかったファイルは null */
  eol: Eol | null;
  /** 1つのファイルの中で CRLF と LF（か CR）が混ざっているか */
  hasMixedEol: boolean;
}

export interface EolCounts {
  lf: number;
  crlf: number;
  cr: number;
  /** 1ファイルの中で混ざっているもの。**lf/crlf には数えない** */
  mixed: number;
  /** 読めなかったもの */
  unreadable: number;
}

export interface EolAudit {
  /**
   * この作品の多数派。**同数なら LF。**
   *
   * GitHub も、投稿サイトへ貼るときの経路も、LF のほうが波風が立たない
   * （`core.autocrlf` の下では CRLF へ展開されるので、リポジトリ側が LF で
   * あるほうが差分が出ない）。**全部読めなければ null**——1件も材料が
   * 無いのに「LF が多数派」と言い切ると、次の判断が全部そこに乗ってしまう。
   */
  majority: "\n" | "\r\n" | null;
  counts: EolCounts;
  /**
   * 多数派と違うファイル。**混在しているものも、CR だけのものも入れる。**
   * 混在は「どちらでもない」ので、多数派と一致することがない。
   */
  differing: string[];
}

/** 改行コードの散らばりを数える */
export function auditEol(files: readonly EolAuditEntry[]): EolAudit {
  const counts: EolCounts = { lf: 0, crlf: 0, cr: 0, mixed: 0, unreadable: 0 };

  for (const file of files) {
    if (file.eol === null) {
      counts.unreadable += 1;
      continue;
    }
    // **混在は lf/crlf のどちらにも数えない。** 数えてしまうと、
    // 「混ざったファイルばかりの作品」が多数派を決めてしまう
    if (file.hasMixedEol) {
      counts.mixed += 1;
      continue;
    }
    if (file.eol === "\r\n") counts.crlf += 1;
    else if (file.eol === "\r") counts.cr += 1;
    else counts.lf += 1;
  }

  const readable = files.length - counts.unreadable;
  const majority: EolAudit["majority"] =
    readable === 0
      ? null
      : counts.crlf > counts.lf
        ? "\r\n"
        : // 同数（0件どうしを含む）は LF
          "\n";

  const differing =
    majority === null ? [] : files.filter(differsFrom(majority)).map((f) => f.filePath);

  return { majority, counts, differing };
}

/** その目標に対して、書き換えが要るか */
function differsFrom(target: "\n" | "\r\n") {
  return (file: EolAuditEntry): boolean =>
    file.eol !== null && (file.hasMixedEol || file.eol !== target);
}

/**
 * 目標の改行コードへ揃えるとき、書き換えるファイル。
 *
 * **監査ではなく、走査の結果そのものを受け取る。** `EolAudit.differing` は
 * 多数派に対する一覧なので、作者が少数派の側（例：多数派が LF の作品で
 * CRLF）を選んだときには使えない。
 */
export function planEolUnify(
  files: readonly EolAuditEntry[],
  target: "\n" | "\r\n"
): string[] {
  return files.filter(differsFrom(target)).map((file) => file.filePath);
}

/** 作者へ伝える、いまの散らばり */
export function describeEolAudit(audit: EolAudit): string {
  const parts: string[] = [];
  if (audit.counts.lf > 0) parts.push(`LF が${audit.counts.lf}件`);
  if (audit.counts.crlf > 0) parts.push(`CRLF が${audit.counts.crlf}件`);
  if (audit.counts.cr > 0) parts.push(`CR が${audit.counts.cr}件`);
  if (audit.counts.mixed > 0) parts.push(`混在が${audit.counts.mixed}件`);
  if (parts.length === 0) return "改行コードを数えられる本文がありませんでした。";

  const head = `${parts.join("、")}。`;
  // **読めなかったぶんを黙らせない。** 「LF が18件」だけを見せると、
  // 読めなかった1件が揃っていることになってしまう
  return audit.counts.unreadable > 0
    ? `${head}（ほかに読めなかったファイルが${audit.counts.unreadable}件）`
    : head;
}

/**
 * 改行コードの呼び名。画面と報告で同じ言葉を使う。
 *
 * **`CR` も言える**（0.50.6）。揃え**先**は LF と CRLF の2つだけだが、
 * 揃え**元**には古い Mac の CR が来ることがあり、編集履歴の
 * 「◯◯ → LF」に出すのに要る。
 */
export function eolLabel(eol: Eol): string {
  if (eol === "\r\n") return "CRLF";
  if (eol === "\r") return "CR";
  return "LF";
}

/**
 * なぜ揃えるのか。**QuickPickの説明と、原稿エディタの案内で同じ文を使う。**
 * 場所ごとに言い方が違うと、同じ話をされていると分からない。
 */
export const EOL_MISMATCH_REASON =
  "改行が違うファイルは、他のツールで開いたときに全行が変更扱いになったり、" +
  "行の位置がずれたりします。";

/**
 * 原稿エディタで開いたときの案内文（設計書5.4.2）。
 *
 * **何と違うのかを数で言う。** 「改行コードが違います」だけでは、
 * 作者はどちらを直せばよいのか決められない。
 */
export function describeEolMismatch(file: {
  eol: Eol;
  hasMixedEol: boolean;
  majority: "\n" | "\r\n";
  /** 多数派の改行で書かれている、ほかのファイルの数 */
  majorityCount: number;
}): string {
  const others =
    file.majorityCount > 0
      ? `作品の他の${file.majorityCount}件（${eolLabel(file.majority)}）と違います。`
      : `この作品の多数派（${eolLabel(file.majority)}）と違います。`;

  const head = file.hasMixedEol
    ? "この原稿は、1つのファイルの中で改行コードが混ざっています。"
    : `この原稿の改行コードは ${describeSingleEol(file.eol)} で、`;

  return `${head}${file.hasMixedEol ? `作品の他は ${eolLabel(file.majority)} です。` : others}${EOL_MISMATCH_REASON}`;
}

/** CR だけの古い形も、そのまま名前で呼ぶ */
function describeSingleEol(eol: Eol): string {
  return eol === "\r" ? "CR" : eolLabel(eol);
}

/**
 * 1ファイルを書き換える計画。
 *
 * **本文は1文字も変えない。** 書き戻しに渡すのは読んだままの `text` で、
 * 変えるのは書き出すときの改行コードだけである。文字コード・末尾改行は
 * 読んだ値をそのまま引き継ぐ（設計書5.4.2）。
 */
/**
 * 文字コードは**型を素通しする**（`E`）。ここで `Encoding` を輸入すると
 * `core/textFile.ts` 経由で vscode が付いてきて、この純粋な部品が
 * VS Code 無しでは試せなくなる。
 */
export type EolWritePlan<E extends string = string> =
  | { kind: "skip"; reason: EolSkipReason }
  | {
      kind: "write";
      text: string;
      format: { encoding: E; eol: "\n" | "\r\n"; hasTrailingNewline: boolean };
      expectedHash: string;
    };

export type EolSkipReason =
  /** もう目標の改行コードで揃っている */
  | "already"
  /** 競合の印が残っている。AI処理と同じく触らない */
  | "conflict_markers";

/** 読み込んだ本文1件を、書き戻しの引数へ組み立てる */
export function planFileEolWrite<E extends string>(
  content: {
    text: string;
    encoding: E;
    eol: Eol;
    hasTrailingNewline: boolean;
    hash: string;
    hasConflictMarkers: boolean;
    hasMixedEol: boolean;
  },
  target: "\n" | "\r\n"
): EolWritePlan<E> {
  // **競合の印が残っているファイルは触らない**（CLAUDE.md 規則1）。
  // 両方の版が混ざったまま書き直すと、どちらが本物か分からなくなる
  if (content.hasConflictMarkers) {
    return { kind: "skip", reason: "conflict_markers" };
  }
  if (!content.hasMixedEol && content.eol === target) {
    return { kind: "skip", reason: "already" };
  }
  return {
    kind: "write",
    text: content.text,
    format: {
      encoding: content.encoding,
      eol: target,
      hasTrailingNewline: content.hasTrailingNewline,
    },
    expectedHash: content.hash,
  };
}

/**
 * 1つのファイルの中の改行コードを見分ける。
 *
 * `eol` は**最初に見つかったもの**を返す（`decodeBytes` が昔からこう決めて
 * いる）。多数派で決め直すと、これまで書き戻してきた形が変わってしまう。
 *
 * `hasMixedEol` は「CRLF と、CRLF の一部でない裸の LF か CR が両方ある」。
 * 混ざったファイルは、どのツールで開いても行の数え方が揺れる。
 */
export function detectEol(raw: string): { eol: Eol; hasMixedEol: boolean } {
  const hasCrlf = raw.includes("\r\n");
  const eol: Eol = hasCrlf ? "\r\n" : raw.includes("\r") ? "\r" : "\n";
  // 直前が CR でない LF＝CRLF の一部ではない裸の LF
  const hasBareLf = /(?:^|[^\r])\n/.test(raw);
  // 直後が LF でない CR＝CRLF の一部ではない裸の CR
  const hasBareCr = /\r(?!\n)/.test(raw);

  return { eol, hasMixedEol: hasCrlf && (hasBareLf || hasBareCr) };
}
