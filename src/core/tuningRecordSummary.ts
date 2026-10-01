import { FEATURE_OUTPUT_KEY_PREFIX } from "./tuningStoreNames";
import { isTypoAccuracyCurrent, type TypoAccuracyRecord } from "./tuningAccuracy";

/**
 * AIチューニングの記録（保管庫の `model-tuning.json`）を、MCP の `ai.settings`
 * で返す形に要約する（作者の裁定、2026-10-01）。
 *
 * **なぜ `parseModelTuning` を使わないか。** あちらは `core/modelTuning.ts`
 * にあり、`vscode` を import している（MCP の束から借りると、束が読み込んだ
 * 瞬間に落ちる）。それに、あちらは同梱の初期値を混ぜたり待ち時間を丸めたり
 * する「使う側」の解釈である。ここで返したいのは**作者の機械で測った値
 * そのもの**なので、生の台帳から欄を拾う。
 *
 * **返す欄は名指しで決める**（`TUNED_FIELDS` 以下）。台帳は作者が手で開いて
 * 直せる場所で、覚え書きの欄を足すこともある（引っ越しも「生のまま」写した）。
 * 中身を丸ごと返すと、そこに何が書かれていても外へ出る。鍵は台帳には
 * 入らない作りだが、**伏せるのではなく、そもそも拾わない**ことで守る。
 * サーバーが述べた文の写し（`contextDeclared`）も、断られたときの本文で
 * 何が入っているか分からないので返さない（受け取った時刻だけ返す）。
 *
 * **同梱の初期値は返さない**（`core/bundledTuning.ts`）。ここが返すのは
 * 作者自身の実測だけで、同梱の値はコードを読めば分かる。
 *
 * VS Code API に依存しない（`mcpReach.test.ts` が見張る）。
 */

/** 誤字脱字の精度の目安（同梱の短い文で測った結果） */
export interface TypoAccuracySummary {
  hits?: number;
  total?: number;
  falsePositives?: number;
  wrongFixes?: number;
  trapHits?: number;
  trapTotal?: number;
  promptVersion?: string;
  sampleVersion?: string;
  smallPrompt?: boolean;
  measuredAt?: string;
  /**
   * **いまの頼み方と文の版で測った結果か。** `false` は古い結果——頼み方か
   * 文が変われば、同じ「7件中N件」でも別の測りものである
   * （`isTypoAccuracyCurrent`。製品の割り当て画面と同じ判定）。
   */
  current: boolean;
}

export interface TuningRecordSummary {
  /** 台帳の鍵（`プロバイダID/モデル名`） */
  key: string;
  provider: string;
  model: string;
  /** 読める長さ・待ち時間を測った時刻 */
  measuredAt?: string;
  /** 実効のコンテキスト長（トークン） */
  contextWindow?: number;
  /** 先頭と末尾の合言葉が両方返った最大の字数（読める長さ） */
  measuredChars?: number;
  contextHitCeiling?: boolean;
  contextLimitedByRate?: boolean;
  contextMeasuredBy?: string;
  /** サーバーが述べた長さを受け取った時刻（文そのものは返さない） */
  contextDeclaredAt?: string;
  /** 1回の呼び出しで待つ秒数 */
  timeoutSeconds?: number;
  /** 本文1000字あたりの秒数 */
  secondsPer1000Chars?: number;
  /** 1回ごとに決まってかかる秒数 */
  fixedSeconds?: number;
  workMeasuredAt?: string;
  workOtherModelsLoaded?: boolean;
  workSplitAcrossCpu?: boolean;
  /** 書き出しの速さ（トークン/秒） */
  outputTokensPerSecond?: number;
  speedSource?: string;
  speedMeasuredAt?: string;
  /** 読み込みの速さ（トークン/秒） */
  inputTokensPerSecond?: number;
  inputSpeedMeasuredAt?: string;
  measuredOutputTokens?: number;
  outputMeasureTimedOut?: boolean;
  charsPerToken?: number;
  charsPerTokenSamples?: number;
  thinkingSeen?: boolean;
  thinkingOffWorks?: boolean;
  thinkingOverheadTokens?: number;
  thinkingMeasuredAt?: string;
  /** 誤字脱字の精度の目安。測っていなければ無い */
  typoAccuracy?: TypoAccuracySummary;
  /**
   * 数字を読むときの断り（**古い結果・弱い数字の印**）。無ければ空。
   * 製品の一覧が付けている断りと同じ意味のものだけを並べる。
   */
  cautions: string[];
}

export interface TuningTableSummary {
  records: TuningRecordSummary[];
  /** 機能ごとの出力見込みの行（`出力見込み/…`）の数。モデルの記録ではないので混ぜない */
  featureOutputRows: number;
  /** 鍵か中身の形が崩れていて読めなかった行の鍵（作者が手で触った跡など） */
  unreadableKeys: string[];
}

/** 数の欄（台帳の名前 → 返す名前） */
const NUMBER_FIELDS: readonly (readonly [string, keyof TuningRecordSummary])[] = [
  ["contextWindow", "contextWindow"],
  ["measuredChars", "measuredChars"],
  ["timeoutSeconds", "timeoutSeconds"],
  ["workSecondsPer1000Chars", "secondsPer1000Chars"],
  ["workFixedSeconds", "fixedSeconds"],
  ["outputTokensPerSecond", "outputTokensPerSecond"],
  ["inputTokensPerSecond", "inputTokensPerSecond"],
  ["measuredOutputTokens", "measuredOutputTokens"],
  ["charsPerToken", "charsPerToken"],
  ["charsPerTokenSamples", "charsPerTokenSamples"],
  ["thinkingOverheadTokens", "thinkingOverheadTokens"],
];

/** 文字の欄（時刻と、決まった語だけを持つ札） */
const STRING_FIELDS: readonly (readonly [string, keyof TuningRecordSummary])[] = [
  ["measuredAt", "measuredAt"],
  ["contextMeasuredBy", "contextMeasuredBy"],
  ["contextDeclaredAt", "contextDeclaredAt"],
  ["workMeasuredAt", "workMeasuredAt"],
  ["speedSource", "speedSource"],
  ["speedMeasuredAt", "speedMeasuredAt"],
  ["inputSpeedMeasuredAt", "inputSpeedMeasuredAt"],
  ["thinkingMeasuredAt", "thinkingMeasuredAt"],
];

const BOOLEAN_FIELDS: readonly (readonly [string, keyof TuningRecordSummary])[] = [
  ["contextHitCeiling", "contextHitCeiling"],
  ["contextLimitedByRate", "contextLimitedByRate"],
  ["workOtherModelsLoaded", "workOtherModelsLoaded"],
  ["workSplitAcrossCpu", "workSplitAcrossCpu"],
  ["outputMeasureTimedOut", "outputMeasureTimedOut"],
  ["thinkingSeen", "thinkingSeen"],
  ["thinkingOffWorks", "thinkingOffWorks"],
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 精度の目安を拾う。**欄が1つも無ければ測っていない**として `undefined`。
 *
 * 版の判定は製品の `isTypoAccuracyCurrent` をそのまま通す（写しを作ると、
 * 片方だけ直したときに古い結果が「いまの結果」の顔で並ぶ）。
 */
function typoAccuracyOf(entry: Record<string, unknown>): TypoAccuracySummary | undefined {
  const record: TypoAccuracyRecord = {
    typoAccuracyHits: numberOf(entry.typoAccuracyHits),
    typoAccuracyTotal: numberOf(entry.typoAccuracyTotal),
    typoAccuracyFalsePositives: numberOf(entry.typoAccuracyFalsePositives),
    typoAccuracyWrongFixes: numberOf(entry.typoAccuracyWrongFixes),
    typoAccuracyTrapHits: numberOf(entry.typoAccuracyTrapHits),
    typoAccuracyTrapTotal: numberOf(entry.typoAccuracyTrapTotal),
    typoAccuracyPromptVersion: stringOf(entry.typoAccuracyPromptVersion),
    typoAccuracySmallPrompt: booleanOf(entry.typoAccuracySmallPrompt),
    typoAccuracySampleVersion: stringOf(entry.typoAccuracySampleVersion),
    typoAccuracyMeasuredAt: stringOf(entry.typoAccuracyMeasuredAt),
  };
  if (Object.values(record).every((value) => value === undefined)) return undefined;
  const summary: TypoAccuracySummary = {
    hits: record.typoAccuracyHits,
    total: record.typoAccuracyTotal,
    falsePositives: record.typoAccuracyFalsePositives,
    wrongFixes: record.typoAccuracyWrongFixes,
    trapHits: record.typoAccuracyTrapHits,
    trapTotal: record.typoAccuracyTrapTotal,
    smallPrompt: record.typoAccuracySmallPrompt,
    measuredAt: record.typoAccuracyMeasuredAt,
    current: isTypoAccuracyCurrent(record),
  };
  // 版の文字は「古いか」の判定にだけ使えば足りるが、古いと言われたときに
  // どの版で測ったのかを辿れるよう、古いときだけ添える
  if (!summary.current) {
    summary.promptVersion = record.typoAccuracyPromptVersion;
    summary.sampleVersion = record.typoAccuracySampleVersion;
  }
  return dropUndefined(summary);
}

function dropUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    if (field !== undefined) out[name] = field;
  }
  return out as T;
}

/** 製品の一覧が付けている断りのうち、数字の読み方が変わるものだけ */
function cautionsOf(row: TuningRecordSummary): string[] {
  const out: string[] = [];
  if (row.contextHitCeiling === true) {
    out.push("読める長さは、測れる上限まで全部通った値（モデルの限界ではなく下限値）");
  }
  if (row.contextLimitedByRate === true) {
    out.push("読める長さは、分あたりの送信の上限で止まった値（待てばもっと長いかもしれない）");
  }
  if (row.contextMeasuredBy === "words") {
    out.push("読める長さは合言葉で測った値（長さと関係なく落ちることがあり、弱い）");
  }
  if (row.outputMeasureTimedOut === true) {
    out.push("書ける量の測定に時間切れの回が混じっていた（少なめに出ているかもしれない）");
  }
  if (row.workOtherModelsLoaded === true) {
    out.push("1000字あたりの秒数は、ほかのモデルも載っていたときの値（長めに出ているかもしれない）");
  }
  if (row.workSplitAcrossCpu === true) {
    out.push("1000字あたりの秒数は、GPU と CPU に分けて載っていたときの値");
  }
  if (row.typoAccuracy && !row.typoAccuracy.current) {
    out.push("誤字脱字の精度の目安は、頼み方か文の版が変わる前の古い結果（測り直せます）");
  }
  return out;
}

/**
 * 台帳の生の表を要約する。**表でなければ呼ばない**（壊れた台帳の断りは
 * 呼び出し側が出す。ここでは直しも推し量りもしない）。
 *
 * 並びは鍵の順（台帳のファイルの並びは書き込みの順で、読む人には意味が無い）。
 */
export function summarizeTuningTable(table: Record<string, unknown>): TuningTableSummary {
  const records: TuningRecordSummary[] = [];
  const unreadableKeys: string[] = [];
  let featureOutputRows = 0;

  for (const key of Object.keys(table).sort()) {
    if (key.startsWith(FEATURE_OUTPUT_KEY_PREFIX)) {
      featureOutputRows += 1;
      continue;
    }
    const entry = table[key];
    // 鍵は `プロバイダID/モデル名`。モデル名に `/` が入ることがある
    // （`hf.co/作者/モデル:q4`）ので、**最初の `/` だけ**で分ける
    const slash = key.indexOf("/");
    if (!isObject(entry) || slash <= 0 || slash === key.length - 1) {
      unreadableKeys.push(key);
      continue;
    }
    const row: Record<string, unknown> = {
      key,
      provider: key.slice(0, slash),
      model: key.slice(slash + 1),
    };
    for (const [from, to] of NUMBER_FIELDS) row[to] = numberOf(entry[from]);
    for (const [from, to] of STRING_FIELDS) row[to] = stringOf(entry[from]);
    for (const [from, to] of BOOLEAN_FIELDS) row[to] = booleanOf(entry[from]);
    row.typoAccuracy = typoAccuracyOf(entry);
    const summary = dropUndefined(row) as unknown as TuningRecordSummary;
    summary.cautions = cautionsOf(summary);
    records.push(summary);
  }
  return { records, featureOutputRows, unreadableKeys };
}
