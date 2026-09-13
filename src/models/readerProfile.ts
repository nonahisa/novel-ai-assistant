/**
 * ターゲット読者の台帳（`設定/読者像.json`）の形（設計書6.91）。
 *
 * **作品ごとに1つ。** 同じ作者が異世界転生と純文学を書いていれば、
 * ターゲット読者は別物である（作者の裁定、2026-09-13）。
 *
 * **宣言と実像を、別々の欄に持つ。** 片方だけでも成り立つし、
 * 上書きし合わない——実像を読み直しても、作者が答えた宣言は消えない。
 * ズレを出すのがこの機能の値打ちなので、混ぜたら意味が無くなる。
 *
 * **ここには型と定数だけを置く。** 軸の呼び名・質問・タイプの一覧と
 * 判定は `core/readerTarget.ts` にある。`models` は `core` を
 * 取り込まない（依存の向きは views/features → core → models）。
 *
 * VS Code APIに依存しない。
 */

export const READER_PROFILE_FILE = "読者像.json";
export const READER_PROFILE_SCHEMA_VERSION = "1";

export type ReaderAxis = "familiarity" | "posture" | "craving";

export interface ReaderScores {
  /** A 読み慣れ（0〜6）。低＝その題材が初めて／高＝読み尽くしている */
  familiarity: number;
  /** B 読む姿勢（0〜6）。低＝隙間に読む／高＝腰を据えて読む */
  posture: number;
  /** C 求めるもの（0〜6）。低＝気持ちよさ／高＝揺さぶり */
  craving: number;
}

/** 実像の根拠1件。**本文に実在する文言だけを入れる** */
export interface ReaderEvidence {
  axis: ReaderAxis;
  /** 本文・プロット・紹介文からの引用（そのまま） */
  quote: string;
  /** どこから取ったか（「第3話」「プロット」） */
  from: string;
}

/** 作者が答えた宛先 */
export interface ReaderDeclaration {
  scores: ReaderScores;
  /** 9問の答え（選んだ番号）。答え直すときに印を戻すのに使う */
  answers: number[];
  updatedAt: string;
}

/** 本文から読んだ実像 */
export interface ReaderActual {
  scores: ReaderScores;
  evidence: ReaderEvidence[];
  /** 何を材料にしたか（「第1〜3話・プロット」）。古さの判断に要る */
  basis: string;
  /** どのモデルが読んだか。モデルを変えたら結果が変わる */
  model: string;
  updatedAt: string;
}

export interface ReaderProfile {
  schemaVersion: string;
  declared?: ReaderDeclaration;
  actual?: ReaderActual;
}

export function emptyReaderProfile(): ReaderProfile {
  return { schemaVersion: READER_PROFILE_SCHEMA_VERSION };
}

/** 台帳に中身があるか（片方でも入っていれば「ある」） */
export function hasReaderProfile(profile: ReaderProfile): boolean {
  return Boolean(profile.declared || profile.actual);
}
