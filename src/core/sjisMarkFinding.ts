/*
  **`paths` ではなく `pathText` を読む**（`findingSource.ts` と同じ理由）。`paths` は `vscode` を
  読み込むので、ここを `core` の純粋な側に保てなくなる
*/
import * as path from "./pathText";
import { buildFinding } from "./findingSource";
import type { FindingLocationStatus } from "./findingLocation";
import { findingId, type Finding, type FindingView } from "../models/finding";
import { UTF8_CONVERT_HINT, UTF8_CONVERT_WHERE } from "./utf8ConvertHint";

/**
 * 保存の直前に「〓」にした字の説明を、校正・メモパネルの行にする（設計書5.4.2、0.148.3。
 * 作者の答え 2026-11-09「目印に置き換えた上で、メモ校正パネルに説明を残して、ポップアップもあげてください」）。
 *
 * ## 置き場は指摘（`.aiwriter/findings.jsonl`）
 *
 * 付箋は**本文の中**の行なので使えない（本文には書かない。実装ルール1）。編集者の提案は
 * 編集者との台帳で、こちらが書く場所ではない。指摘の置き場なら：
 *
 * - **［本文へ］で〓の行へ飛べ、［見送る］で作者が自分で消せる。** 修正案を持たせず、
 *   提案パネルへ戻す表（`findingSource.ts` の `RECORDED`）にも入れないので、［直す］や
 *   提案パネルの［適用］の道には乗らない
 * - 同期される・追記だけ、という置き場の約束にそのまま乗る
 *
 * ## ほかの指摘と違う扱い（0.148.3 の担当の気づき。〓1つに行1つ、〓が残る限り出す）
 *
 * ほかの指摘は「原文（前後の本文）が本文に残っているか」で生き死にが決まり、3日で隠れる。
 * 〓の行は**〓そのものが本文に残っているか**で決める——作者が直すべきなのは〓で、その隣の字ではない。
 *
 * - **番号は〓ごとに別にする**（保存の時刻とその保存の中での順から作る）。前後の字から作ると、
 *   前後4字が同じ別の〓（「♡♡」、同じ文が2か所）が同じ番号になり、置き場で1件に畳まれる
 * - **場所は本文の〓と1対1で突き合わせる**（`placeSjisMarkFindings`）。前後の字は「どの〓か」の
 *   手がかりにだけ使い、合わなくても〓が残っていれば行は消さない。〓が本文から無くなったら、
 *   割り当てる〓が足りなくなった行が出なくなる（解決）
 * - **日付では隠さない・消さない**（校正・メモパネルと「期限切れ指摘消去」。`isSjisMarkFinding`）
 */

/** 校正・メモパネルの札と絞り込みに出る分類名 */
export const SJIS_MARK_FINDING_LABEL = "Shift_JIS に無い字";

/**
 * 目印の字（`core/sjisFallback.ts` の `SJIS_UNENCODABLE_MARK` と同じ字）。あちらは `iconv` を
 * 読み込むので、ここでは写す（あちらがこのファイルの `sjisMarkPlaces` を使う向きにしてある）
 */
const MARK = "〓";

/** 前後に添える字数（字＝コードポイント） */
export const SJIS_MARK_CONTEXT_CHARS = 4;

/** 目印にした字（`core/sjisFallback.ts` の `SjisMark` と同じ形。`iconv` を読み込まないために写す型） */
export interface SjisMarkPlace {
  char: string;
  line: number;
  context: string;
}

/** 本文の中の〓が1つ、どこにあるか */
export interface SjisMarkOccurrence {
  /** 本文の位置（JavaScript の文字列の単位） */
  index: number;
  /** 1から数える行（改行は CRLF・CR・LF のどれでも1つに数える） */
  line: number;
  /** 同じ行の、〓の直前の字（最大4字） */
  before: string;
  /** 同じ行の、〓の直後の字（最大4字） */
  after: string;
  /** `before` + 〓 + `after`。記録した行の原文（`original`）と同じ形 */
  context: string;
}

/**
 * 本文の〓を全部、行と前後の字つきで拾う。
 *
 * **全文を1回だけ前から読む**（〓ごとに頭から数え直さない）。保存の直前の受け口
 * （持ち時間1.5秒）でも呼ぶ。300万字の合本に〓が200あると、〓ごとに頭から改行を数える形では
 * それだけで約100ミリ秒かかった（2026-11-14 の測定）
 */
export function sjisMarkPlaces(text: string): SjisMarkOccurrence[] {
  const found: SjisMarkOccurrence[] = [];
  let line = 1;
  let counted = 0;
  for (let at = text.indexOf(MARK); at >= 0; at = text.indexOf(MARK, at + MARK.length)) {
    // 前の〓からここまでの改行を数える。区切りは〓の位置なので、CRLF の途中で切れることはない
    line += countBreaks(text.slice(counted, at));
    counted = at;
    const lineStart = Math.max(text.lastIndexOf("\n", at - 1), text.lastIndexOf("\r", at - 1)) + 1;
    const rest = text.slice(at + MARK.length, at + MARK.length + SJIS_MARK_CONTEXT_CHARS * 2 + 2);
    const lineEnd = rest.search(/\r|\n/);
    const head = text.slice(Math.max(lineStart, at - SJIS_MARK_CONTEXT_CHARS * 2), at);
    const before = Array.from(head).slice(-SJIS_MARK_CONTEXT_CHARS).join("");
    const after = Array.from(lineEnd < 0 ? rest : rest.slice(0, lineEnd)).slice(0, SJIS_MARK_CONTEXT_CHARS).join("");
    found.push({ index: at, line, before, after, context: `${before}${MARK}${after}` });
  }
  return found;
}

function countBreaks(segment: string): number {
  return (segment.match(/\r\n|\r|\n/g) ?? []).length;
}

/** 「Shift_JIS に無い字」の行か（日付で隠さない・消さない行） */
export function isSjisMarkFinding(finding: { label: string }): boolean {
  return finding.label === SJIS_MARK_FINDING_LABEL;
}

/**
 * 目印にした字を、指摘の形へ組む。**〓1つにつき1行**（番号も〓ごとに別）。
 *
 * @param savedText 置き換えたあとの本文（保存されたもの）。原文の場所はここから決め直す
 * @param recoveryPath 元の字を含む控えの場所。残せなかったら undefined
 * @param time 保存した時刻。番号の素にもする（同じ場所にあとでまた〓を置いても、別の〓として別の行になる。
 *   前に見送った行を勝手に未決へ戻さずに済む）
 */
export function buildSjisMarkFindings(
  workFolder: string,
  filePath: string,
  savedText: string,
  marks: readonly SjisMarkPlace[],
  recoveryPath: string | undefined,
  time: string
): Finding[] {
  const where = recoveryPath
    ? `元の字は控え（${path.relative(workFolder, recoveryPath).split("\\").join("/")}）にあります。`
    : "元の字の控えは残せませんでした。";
  const findings: Finding[] = [];
  marks.forEach((mark, ordinal) => {
    const finding = buildFinding(
      workFolder,
      {
        filePath,
        line: mark.line,
        original: mark.context,
        target: MARK,
        suggestion: "",
        // 原稿の文字コード変換を案内する（作者の指示 2026-11-09）。パネルの行から命令は呼べないので、呼ぶ場所を書く
        message: `「${mark.char}」は Shift_JIS に無い字なので「〓」にしました。${where}${UTF8_CONVERT_HINT}${UTF8_CONVERT_WHERE}`,
        category: "other",
        label: SJIS_MARK_FINDING_LABEL,
      },
      savedText,
      time
    );
    // 前後が本文に見つからない（本文が空白だけの行など）ものは組まれない
    if (!finding) return;
    /*
      番号を〓ごとに別にする。中身から作る番号（`findingIdOf`）は前後の字で決まり、同じ前後の〓が
      同じ番号になる。〓の行は修正案を持たず、中身から番号を作り直す道（提案パネルへ戻す・［適用］）
      に乗らないので、ここで決めた番号を置き場の番号として使い続けてよい
    */
    findings.push({
      ...finding,
      id: findingId(finding.file, `${time}#${ordinal}`, MARK, "", finding.category, finding.label),
    });
  });
  return findings;
}

/**
 * 〓の行を、いまの本文の〓と1対1で突き合わせ、並べる行（未決のもの）を位置つきで返す。
 *
 * **見送った行も渡すこと**（日付も見ない）。見送った行も自分の〓を取っておく——外すと、見送った〓を
 * 別の行（その〓が直されて余った行）が拾い、作者が見送った〓の行がまた出てくる。
 *
 * 割り当ての順（新しい行から。同じ場所に、見送った古い行と新しい行があれば、新しい行が〓を取る）：
 * 1. 前後の字がそのまま合う〓（行の近いほう）
 * 2. 前か後ろの片方が合う〓（〓の隣の字を直した。空の側は手がかりにしない）
 * 3. 残った〓のうち行の近いもの（前後を両方書き直した）
 *
 * 割り当てる〓が無かった行は出さない（〓が本文から無くなった＝解決）。行の無い〓（作者が自分で
 * 打った〓など）に行は作らない。
 *
 * @param texts ファイル（`Finding.file` と同じ表記）→ その全文。無いファイルの行は返さない（まだ見ていない）
 */
export function placeSjisMarkFindings<T extends FindingView>(
  rows: readonly T[],
  texts: ReadonlyMap<string, string>
): Array<T & { line: number; located: FindingLocationStatus }> {
  const byFile = new Map<string, Array<{ row: T; order: number }>>();
  rows.forEach((row, order) => {
    if (!isSjisMarkFinding(row) || !texts.has(row.file)) return;
    const list = byFile.get(row.file) ?? [];
    list.push({ row, order });
    byFile.set(row.file, list);
  });

  const placed: Array<T & { line: number; located: FindingLocationStatus }> = [];
  for (const [file, list] of byFile) {
    const occurrences = sjisMarkPlaces(texts.get(file) ?? "");
    const taken = new Set<number>();
    const assigned = new Map<number, SjisMarkOccurrence>();
    // 新しい行から（同じ時刻なら行の順、それも同じなら置き場の順）。並べ方を固定しないと、開くたびに割り当てが変わる
    const ordered = [...list].sort(
      (a, b) => compareTimeDesc(a.row.time, b.row.time) || a.row.hintLine - b.row.hintLine || a.order - b.order
    );
    const passes: Array<(row: T, occurrence: SjisMarkOccurrence) => boolean> = [
      (row, occurrence) => row.original === occurrence.context,
      (row, occurrence) => sharesOneSide(row.original, occurrence),
      () => true,
    ];
    for (const matches of passes) {
      for (const { row, order } of ordered) {
        if (assigned.has(order)) continue;
        const occurrence = nearestFree(occurrences, taken, row.hintLine, (candidate) => matches(row, candidate));
        if (!occurrence) continue;
        taken.add(occurrence.index);
        assigned.set(order, occurrence);
      }
    }
    for (const { row, order } of list) {
      const occurrence = assigned.get(order);
      // 見送った行は〓を取っておくだけで、並べない
      if (!occurrence || row.status !== "pending") continue;
      placed.push({ ...row, line: occurrence.line, located: occurrence.line === row.hintLine ? "found" : "moved" });
    }
  }
  return placed;
}

/** 新しいほうが前。読めない日時は後ろへ */
function compareTimeDesc(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
  return b - a;
}

/**
 * 記録した前後（`original`）と、いまの〓の前後の、片方だけでも合うか。
 * 記録した前後に〓が2つ以上あるとき（「あい〓〓うえ」）は、どの〓が目印だったか分からないので、
 * どの区切り方で合ってもよい。空の側（行の頭・終わりの〓）は、どの行の頭とも合ってしまうので見ない
 */
function sharesOneSide(original: string, occurrence: SjisMarkOccurrence): boolean {
  for (let at = original.indexOf(MARK); at >= 0; at = original.indexOf(MARK, at + MARK.length)) {
    const before = original.slice(0, at);
    const after = original.slice(at + MARK.length);
    if (before.length > 0 && before === occurrence.before) return true;
    if (after.length > 0 && after === occurrence.after) return true;
  }
  return false;
}

/** まだ取られていない〓のうち、条件に合い、行がいちばん近いもの（同じ距離なら前） */
function nearestFree(
  occurrences: readonly SjisMarkOccurrence[],
  taken: ReadonlySet<number>,
  hintLine: number,
  matches: (occurrence: SjisMarkOccurrence) => boolean
): SjisMarkOccurrence | undefined {
  let best: SjisMarkOccurrence | undefined;
  for (const occurrence of occurrences) {
    if (taken.has(occurrence.index) || !matches(occurrence)) continue;
    if (!best || Math.abs(occurrence.line - hintLine) < Math.abs(best.line - hintLine)) best = occurrence;
  }
  return best;
}
