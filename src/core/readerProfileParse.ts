import {
  READER_PROFILE_SCHEMA_VERSION,
  type ReaderAxis,
  type ReaderEvidence,
  type ReaderProfile,
  type ReaderScores,
} from "../models/readerProfile";
import { READER_AXIS_ORDER, READER_QUESTIONS } from "./readerTarget";

/**
 * ターゲット読者の台帳（`設定/読者像.json`）を**読み解く**部分だけ
 * （設計書6.91）。
 *
 * **`vscode` が要らない部分を切り出してある**（0.64.2）。元の
 * `readerTargetStore.ts` は `vscode.workspace.fs` でファイルを読み書き
 * するので、MCP の束（設計書6.87.8）からは届かない。外から相談の
 * プロンプトを組むとき、**読者診断は作品フォルダーの中にある**ので
 * 読めるべきである。
 *
 * **やり方は `textDecode`・`workStyleFacts` と同じ。** 元のファイルが
 * ここを再輸出するので、**使う側の既定は今までどおり**である。
 *
 * VS Code APIに依存しない。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 点数を読み解く。
 *
 * **0〜6の外は受け取らない。** 作者が手で直すファイルであり、AIが書いた
 * 値も通る。範囲の外が入ると段階の判定が壊れ、どのタイプにも当てはまらない
 * 結果が出る（CLAUDE.mdの実装ルール3「AIの出力を信用しない」）。
 */
export function parseReaderScores(raw: unknown): ReaderScores {
  if (!isRecord(raw)) throw new Error("点数の形が違います。");
  const scores = {} as ReaderScores;
  for (const axis of READER_AXIS_ORDER) {
    const value = raw[axis];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`点数「${axis}」が数ではありません。`);
    }
    if (value < 0 || value > 6) {
      throw new Error(`点数「${axis}」が0〜6の外です（${value}）。`);
    }
    scores[axis] = value;
  }
  return scores;
}

function parseAnswers(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new Error("答えの形が違います。");
  return raw.map((value, index) => {
    const question = READER_QUESTIONS[index];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      !question ||
      value < 0 ||
      value >= question.choices.length
    ) {
      throw new Error(`${index + 1}問目の答えが選択肢の外です。`);
    }
    return value;
  });
}

/**
 * 根拠を読み解く。
 *
 * **読めない1件で全体を落とさない。** 根拠は説明のための添え物であって、
 * 判定は点数のほうで決まっている。1件が壊れていることを理由に
 * 台帳ごと読めなくすると、作者は診断そのものを失う。
 */
function parseEvidence(raw: unknown): ReaderEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("根拠の形が違います。");
  const axes = new Set<string>(READER_AXIS_ORDER);
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { axis, quote, from } = entry;
    if (typeof axis !== "string" || !axes.has(axis)) return [];
    if (typeof quote !== "string" || !quote.trim()) return [];
    return [
      {
        axis: axis as ReaderAxis,
        quote,
        from: typeof from === "string" ? from : "",
      },
    ];
  });
}

function parseTime(raw: unknown, what: string): string {
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new Error(`${what}の日時が読めません。`);
  }
  return raw;
}

/**
 * 台帳を読み解く。
 *
 * **壊れていたら直さずに投げる**（CLAUDE.mdの実装ルール2）。
 * 作者が手で書き換えるファイルなので、こちらの解釈で上書きしない。
 */
export function parseReaderProfile(raw: unknown): ReaderProfile {
  if (!isRecord(raw)) throw new Error("読者像の記録の形が違います。");

  const profile: ReaderProfile = {
    schemaVersion:
      typeof raw.schemaVersion === "string" && raw.schemaVersion
        ? raw.schemaVersion
        : READER_PROFILE_SCHEMA_VERSION,
  };

  if (raw.declared !== undefined && raw.declared !== null) {
    if (!isRecord(raw.declared)) throw new Error("宣言の形が違います。");
    profile.declared = {
      scores: parseReaderScores(raw.declared.scores),
      answers: parseAnswers(raw.declared.answers),
      updatedAt: parseTime(raw.declared.updatedAt, "宣言"),
    };
  }

  if (raw.actual !== undefined && raw.actual !== null) {
    if (!isRecord(raw.actual)) throw new Error("実像の形が違います。");
    profile.actual = {
      scores: parseReaderScores(raw.actual.scores),
      evidence: parseEvidence(raw.actual.evidence),
      basis: typeof raw.actual.basis === "string" ? raw.actual.basis : "",
      model: typeof raw.actual.model === "string" ? raw.actual.model : "",
      updatedAt: parseTime(raw.actual.updatedAt, "実像"),
    };
  }

  return profile;
}
