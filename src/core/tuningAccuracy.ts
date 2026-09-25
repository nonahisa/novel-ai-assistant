/**
 * AIチューニングの「誤字脱字の精度」の段——**置いた誤りの答え合わせ**
 * （設計書6.49.9。作者の承認、2026-09-25「チューニング 1/2/3-4-5/6：すべて」）。
 *
 * ## 何を数えるか
 *
 * 同梱の短い文（`core/tuningWorkSample.ts`）には誤りが7つ置いてある。
 * 製品の誤字脱字と同じ道（プロンプトの選び分け・形式の強制・検算
 * `core/typoCheckValidation.ts`）を通った指摘を、**当たりと誤検出の両方**で
 * 数える（CLAUDE.md の失敗2「見逃しと誤検出の両方を測ること。片方だけでは、
 * 何も指摘しない実装が満点になる」）。
 *
 * - **当たり**：置いた誤りと**位置が重なり**、当てると**正しい形になる**指摘。
 *   「当てた結果」で比べる——「しっかりりと」→「しっかりと」でも「りり」→「り」
 *   でも本文は同じに直るので、切り方の好みで点を動かさない
 *   （`scripts/measureScoring.mjs` の `applyTypoFix` と同じ考え方）
 * - **直し方が違う**：位置は当てたが、当てても正しい形にならない指摘。
 *   **当たりには数えない**（押しても本文が直らない）。誤検出にも数えない
 * - **誤検出**：置いた誤りのどれとも重ならない指摘。この文には置いた誤り
 *   のほかに直すところは無いので、作者が消して回る指摘の数になる
 *
 * ## 目安でしかない
 *
 * 文は4段落しかなく、誤りは7つしかない。1件の差で率が大きく動く。
 * **作者の作品で採った・退けた率（`core/verdictTally.ts`）があれば、そちらが
 * 主である。** ここの数字は「目安」と名乗り、モデルの良し悪しを断定しない。
 *
 * VS Code API に依存しない。
 */

import type { AcceptedTypoIssue } from "./typoCheckValidation";
import { typoPromptVersion } from "../prompts/typoCheck";
import {
  TUNING_WORK_PARAGRAPHS,
  TUNING_WORK_PLANTED_TYPOS,
  TUNING_WORK_SAMPLE_VERSION,
} from "./tuningWorkSample";

/**
 * 精度の段で送る本文。**4段落すべてを1回で送る**（1段落が1行になる）。
 *
 * 段落を分けて送ると回数が増える（有料AIでは料金）。製品の誤字脱字も
 * チャンクごとに1回なので、1回にまとめるほうが実際に近い。
 */
export const TUNING_ACCURACY_BODY: string = TUNING_WORK_PARAGRAPHS.join("\n");

/** 置いた誤り1つ（`TUNING_WORK_PLANTED_TYPOS` の形） */
export interface PlantedTypo {
  readonly paragraph: number;
  readonly target: string;
  readonly suggestion: string;
}

/** 答え合わせの結果 */
export interface TypoAccuracyScore {
  /** 当たり（位置が合い、当てると正しい形になる） */
  readonly hits: number;
  /** 置いた誤りの数 */
  readonly total: number;
  /** 位置は合ったが、当てても正しい形にならなかった数 */
  readonly wrongFixes: number;
  /** 置いた誤りのどれとも重ならない指摘の数 */
  readonly falsePositives: number;
  /** 拾えなかった誤り（直し方が違ったものも含む）。ログに残す */
  readonly missed: readonly PlantedTypo[];
  /** 誤検出の中身。ログに残す（作者が見る画面には出さない） */
  readonly falsePositiveItems: readonly { readonly target: string; readonly suggestion: string }[];
}

/** 指摘が本文のどこを直すか（本文の通しの字の位置） */
interface LocatedFix {
  readonly start: number;
  readonly end: number;
  /** 当てたあとの本文 */
  readonly applied: string;
}

/** 段落ごとの、本文の通しの頭の位置（改行1字ぶんずつずれる） */
function paragraphOffsets(paragraphs: readonly string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const paragraph of paragraphs) {
    offsets.push(at);
    at += paragraph.length + 1;
  }
  return offsets;
}

/**
 * 指摘を本文の位置へ戻す。戻せなければ undefined。
 *
 * **適用処理と同じ手順で当てる**（AI指摘パネルは、その行の中で抜粋
 * `original` を探し、その中の `target` を `suggestion` に置き換える）。
 * 検算は抜粋を正規化して照らすので、字どおりに見つからないことがある。
 * そのときは、その行で `target` が1回だけ出てくるならそこを使う。
 */
function locate(
  issue: Pick<AcceptedTypoIssue, "line" | "original" | "target" | "suggestion">,
  text: string,
  paragraphs: readonly string[],
  offsets: readonly number[]
): LocatedFix | undefined {
  if (issue.target.length === 0) return undefined;
  const index = issue.line - 1;
  const lineText = paragraphs[index];
  const lineStart = offsets[index];
  let start: number | undefined;
  if (lineText !== undefined && lineStart !== undefined) {
    const inOriginal = issue.original.indexOf(issue.target);
    const originalAt = lineText.indexOf(issue.original);
    if (originalAt !== -1 && inOriginal !== -1) {
      start = lineStart + originalAt + inOriginal;
    } else {
      const first = lineText.indexOf(issue.target);
      if (first !== -1 && lineText.indexOf(issue.target, first + 1) === -1) {
        start = lineStart + first;
      }
    }
  }
  if (start === undefined) return undefined;
  const end = start + issue.target.length;
  return {
    start,
    end,
    applied: text.slice(0, start) + issue.suggestion + text.slice(end),
  };
}

/**
 * 検算を通った指摘を、置いた誤りと突き合わせる。
 *
 * **1つの指摘は1つの誤りにしか当てない**（測定台の数え方と同じ）。
 * 同じ誤りへの2件目の指摘は、当たりにも誤検出にも数えない——作者の画面では
 * 同じ場所に2件並ぶだけで、別の場所を誤りと言ったわけではない。
 */
export function scoreTypoAccuracy(
  accepted: readonly Pick<AcceptedTypoIssue, "line" | "original" | "target" | "suggestion">[],
  paragraphs: readonly string[] = TUNING_WORK_PARAGRAPHS,
  planted: readonly PlantedTypo[] = TUNING_WORK_PLANTED_TYPOS
): TypoAccuracyScore {
  const text = paragraphs.join("\n");
  const offsets = paragraphOffsets(paragraphs);
  const fixes = accepted.map((issue) => locate(issue, text, paragraphs, offsets));

  const used = new Set<number>();
  const missed: PlantedTypo[] = [];
  let hits = 0;
  let wrongFixes = 0;

  const plantedRanges = planted.map((typo) => {
    const start = offsets[typo.paragraph] + paragraphs[typo.paragraph].indexOf(typo.target);
    const end = start + typo.target.length;
    return {
      typo,
      start,
      end,
      expected: text.slice(0, start) + typo.suggestion + text.slice(end),
    };
  });
  const overlaps = (fix: LocatedFix, range: { start: number; end: number }): boolean =>
    fix.start < range.end && range.start < fix.end;

  for (const range of plantedRanges) {
    const near = fixes
      .map((fix, at) => ({ fix, at }))
      .filter(
        (entry): entry is { fix: LocatedFix; at: number } =>
          entry.fix !== undefined && !used.has(entry.at) && overlaps(entry.fix, range)
      );
    const hit = near.find((entry) => entry.fix.applied === range.expected);
    if (hit !== undefined) {
      used.add(hit.at);
      hits += 1;
      continue;
    }
    missed.push(range.typo);
    if (near.length > 0) {
      used.add(near[0].at);
      wrongFixes += 1;
    }
  }

  const falsePositiveItems: { target: string; suggestion: string }[] = [];
  fixes.forEach((fix, at) => {
    if (used.has(at)) return;
    // 同じ誤りへの2件目（上の断り書き）
    if (fix !== undefined && plantedRanges.some((range) => overlaps(fix, range))) return;
    falsePositiveItems.push({
      target: accepted[at].target,
      suggestion: accepted[at].suggestion,
    });
  });

  return {
    hits,
    total: planted.length,
    wrongFixes,
    falsePositives: falsePositiveItems.length,
    missed,
    falsePositiveItems,
  };
}

/* ── 台帳に残す形 ─────────────────────────────────── */

/**
 * 台帳（`core/modelTuning.ts` の `ModelTuning`）に残す欄。
 *
 * **頼み方の版と文の版を一緒に持つ。** どちらかが変わった結果は、
 * 別の測りものの結果である（古い結果として扱う）。
 */
export interface TypoAccuracyRecord {
  readonly typoAccuracyHits?: number;
  readonly typoAccuracyTotal?: number;
  readonly typoAccuracyFalsePositives?: number;
  readonly typoAccuracyWrongFixes?: number;
  /** 送った頼み方の版（P-09 の `typoPromptVersion`） */
  readonly typoAccuracyPromptVersion?: string;
  /** 小さいモデル向けの頼み方を送ったか（版の比べ先を決める） */
  readonly typoAccuracySmallPrompt?: boolean;
  /** 同梱の文の版（`TUNING_WORK_SAMPLE_VERSION`） */
  readonly typoAccuracySampleVersion?: string;
  /** 測った時刻（ISO 8601） */
  readonly typoAccuracyMeasuredAt?: string;
}

/** 測った結果を、台帳へ書く形にする */
export function typoAccuracyRecord(
  score: TypoAccuracyScore,
  forSmallModel: boolean,
  measuredAt: string
): Required<TypoAccuracyRecord> {
  return {
    typoAccuracyHits: score.hits,
    typoAccuracyTotal: score.total,
    typoAccuracyFalsePositives: score.falsePositives,
    typoAccuracyWrongFixes: score.wrongFixes,
    typoAccuracyPromptVersion: typoPromptVersion(forSmallModel),
    typoAccuracySmallPrompt: forSmallModel,
    typoAccuracySampleVersion: TUNING_WORK_SAMPLE_VERSION,
    typoAccuracyMeasuredAt: measuredAt,
  };
}

/** 台帳に精度の結果があるか（数の欄がそろっているか） */
export function hasTypoAccuracy(
  record: TypoAccuracyRecord | undefined
): record is TypoAccuracyRecord & {
  typoAccuracyHits: number;
  typoAccuracyTotal: number;
  typoAccuracyFalsePositives: number;
} {
  return (
    record?.typoAccuracyHits !== undefined &&
    record.typoAccuracyTotal !== undefined &&
    record.typoAccuracyFalsePositives !== undefined
  );
}

/**
 * その結果が、**いまの頼み方と文で測ったもの**か。
 *
 * 頼み方の版は、そのとき送った側（小さいモデル向けか）のいまの版と比べる。
 * 版が変わったら、同じモデルでも別の測りものなので古い結果として扱う。
 */
export function isTypoAccuracyCurrent(record: TypoAccuracyRecord | undefined): boolean {
  if (!hasTypoAccuracy(record)) return false;
  if (record.typoAccuracySampleVersion !== TUNING_WORK_SAMPLE_VERSION) return false;
  const small = record.typoAccuracySmallPrompt === true;
  return record.typoAccuracyPromptVersion === typoPromptVersion(small);
}

/**
 * 台帳に書いた時刻から、**作者の機械の暦の**日付だけを取る（読めなければ空）。
 *
 * 台帳の時刻は世界時（末尾 Z）なので、頭の10字をそのまま取ると、日本の
 * 朝9時より前に測った結果が前の日の日付になる（実機 2026-09-26 朝6時の
 * 測定で「2026-09-25」と出た）。
 */
function dateOf(iso: string | undefined): string {
  if (iso === undefined) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * 台帳に残した形の一文（記録の一覧・ログ向け）。
 *
 * 例：「誤字脱字：7件中5件・誤検出1件（2026-09-26・P-09 1.2）」
 */
export function describeTypoAccuracyRecord(record: TypoAccuracyRecord | undefined): string | undefined {
  if (!hasTypoAccuracy(record)) return undefined;
  const notes = [
    dateOf(record.typoAccuracyMeasuredAt),
    record.typoAccuracyPromptVersion !== undefined
      ? `P-09 ${record.typoAccuracyPromptVersion}`
      : "",
  ].filter((note) => note.length > 0);
  return (
    `誤字脱字：${record.typoAccuracyTotal}件中${record.typoAccuracyHits}件・` +
    `誤検出${record.typoAccuracyFalsePositives}件` +
    (notes.length > 0 ? `（${notes.join("・")}）` : "") +
    (isTypoAccuracyCurrent(record) ? "" : "（頼み方か文が変わる前の、古い結果）")
  );
}

/**
 * 機能別のAIの割り当て（設計書6.28.9）の誤字脱字の行に添える一文。
 *
 * **「目安」と名乗る。** 作者が採った率（`core/verdictTally.ts`）が並ぶ
 * ときは、そちらが主で、これは添え物である（並べ方は呼び出し側）。
 * 古い結果は、古いと言って出す（黙って出すと、いまの頼み方の結果に見える）。
 */
export function describeTypoAccuracyHint(record: TypoAccuracyRecord | undefined): string | undefined {
  if (!hasTypoAccuracy(record)) return undefined;
  const numbers =
    `${record.typoAccuracyTotal}件中${record.typoAccuracyHits}件・` +
    `誤検出${record.typoAccuracyFalsePositives}`;
  return isTypoAccuracyCurrent(record)
    ? `目安（同梱の短い文で測定）：${numbers}`
    : `目安（同梱の短い文で測定）：${numbers}（頼み方が変わる前の古い結果。測り直せます）`;
}

/**
 * 段の結果として作者へ見せる一文。
 *
 * **良し悪しを言い切らない。** 文が短く、1件で大きく動くことを必ず添える。
 */
export function describeTypoAccuracyScore(score: TypoAccuracyScore): string {
  const missed = score.total - score.hits;
  return (
    `誤字脱字の精度の目安：同梱の短い文に置いた誤り${score.total}件のうち` +
    `${score.hits}件を正しく直し（見逃し${missed}件` +
    (score.wrongFixes > 0 ? `。うち${score.wrongFixes}件は場所は合っていたが直し方が違った` : "") +
    `）、誤りでない所への指摘は${score.falsePositives}件でした。` +
    "文は4段落しかないので1件で大きく動きます。モデルの良し悪しは、作品で" +
    "指摘を採った・退けた率のほうが確かです（機能別のAIの割り当てに並べて出します）。"
  );
}
