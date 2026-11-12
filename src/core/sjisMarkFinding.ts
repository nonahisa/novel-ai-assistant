/*
  **`paths` ではなく `pathText` を読む**（`findingSource.ts` と同じ理由）。`paths` は `vscode` を
  読み込むので、ここを `core` の純粋な側に保てなくなる
*/
import * as path from "./pathText";
import { buildFinding } from "./findingSource";
import type { Finding } from "../models/finding";
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
 * - **〓を直すと行が消える。** 原文（`original`）に〓を含む前後を持たせるので、作者が〓を
 *   別の字に直すと `locateFindings` が「消えた」として落とす
 * - **［本文へ］で〓の行へ飛べ、［見送る］で作者が自分で消せる。** 修正案を持たせず、
 *   提案パネルへ戻す表（`findingSource.ts` の `RECORDED`）にも入れないので、［直す］や
 *   提案パネルの［適用］の道には乗らない
 * - 同期される・追記だけ、という置き場の約束にそのまま乗る
 */

/** 校正・メモパネルの札と絞り込みに出る分類名 */
export const SJIS_MARK_FINDING_LABEL = "Shift_JIS に無い字";

/** 目印にした字（`core/sjisFallback.ts` の `SjisMark` と同じ形。`iconv` を読み込まないために写す型） */
export interface SjisMarkPlace {
  char: string;
  line: number;
  context: string;
}

/**
 * 目印にした字を、指摘の形へ組む。
 *
 * **同じ前後の目印は1行にまとめる**（「♡♡」は2つとも前後が「…〓〓…」になり、番号が同じになる。
 * 2行に分けても、片方を直せば両方の原文が本文から消える）。
 *
 * @param savedText 置き換えたあとの本文（保存されたもの）。原文の場所はここから決め直す
 * @param recoveryPath 元の字を含む控えの場所。残せなかったら undefined
 */
export function buildSjisMarkFindings(
  workFolder: string,
  filePath: string,
  savedText: string,
  marks: readonly SjisMarkPlace[],
  recoveryPath: string | undefined,
  time: string
): Finding[] {
  const groups = new Map<string, { line: number; context: string; chars: string[] }>();
  for (const mark of marks) {
    const key = `${mark.line}:${mark.context}`;
    const group = groups.get(key);
    if (group) {
      if (!group.chars.includes(mark.char)) group.chars.push(mark.char);
    } else {
      groups.set(key, { line: mark.line, context: mark.context, chars: [mark.char] });
    }
  }
  const where = recoveryPath
    ? `元の字は控え（${path.relative(workFolder, recoveryPath).split("\\").join("/")}）にあります。`
    : "元の字の控えは残せませんでした。";
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const group of groups.values()) {
    const chars = group.chars.map((char) => `「${char}」`).join("");
    const finding = buildFinding(
      workFolder,
      {
        filePath,
        line: group.line,
        original: group.context,
        target: "〓",
        suggestion: "",
        // 原稿の文字コード変換を案内する（作者の指示 2026-11-09）。パネルの行から命令は呼べないので、呼ぶ場所を書く
        message: `${chars}は Shift_JIS に無い字なので「〓」にしました。${where}${UTF8_CONVERT_HINT}${UTF8_CONVERT_WHERE}`,
        category: "other",
        label: SJIS_MARK_FINDING_LABEL,
      },
      savedText,
      time
    );
    // 前後が本文に見つからない（本文が空白だけの行など）ものは組まれない。同じ番号は1つに
    if (!finding || seen.has(finding.id)) continue;
    seen.add(finding.id);
    findings.push(finding);
  }
  return findings;
}
