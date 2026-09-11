/**
 * 同一性——肉体・人格・身分（設計書6.88.5）。
 *
 * **憑依・多重人格・転生・入れ替わりを矛盾にしない**ために、1人の登場人物を
 * 3つの id に分ける。「文佳の体で太志の口調で喋っている」は、体と人格を
 * 1つの id で持っているかぎり必ず矛盾に見える——**モデルの賢さで解かず、
 * スキーマで解く。**
 *
 * そのうえで、**遷移の記録が無いのに組が変わっていれば、それこそを矛盾として
 * 出す**（照合は `core/contradictionMatch.ts` の `findIdentityDrift`）。
 *
 * VS Code APIにも `core/` にも依存しない（`models` → `core` は依存の逆流）。
 */

import {
  invalid,
  objectValue,
  optionalEnum,
  optionalNullableString,
  requireNonEmptyString,
} from "./jsonValidation";
import {
  IDENTITY_TRANSITION_KINDS,
  parseFactPosition,
  parseRelativeTimeValue,
  type IdentityTransition,
  type IdentityTransitionKind,
  type RelativeTime,
  type StoryFactError,
} from "./storyFact";

/**
 * 誰の体で、どの人格が前に出ていて、周りは誰だと思っているか。
 *
 * - `bodyId`     肉体
 * - `personaId`  魂・人格（**体を共有していても人格が別なら別人**。P-04a 5.2 の裁定）
 * - `identityId` 社会的な名前・身分（偽名・変装はここだけが変わる）
 */
export interface IdentityTriple {
  bodyId: string;
  personaId: string;
  identityId: string;
}

/** 場面ごとの組（6.88.5） */
export interface SceneIdentity {
  chapter: number | null;
  lineRange: [number, number];
  /** 相対時期。読めなければ `null`（推測で埋めない。6.88.4） */
  storyTime: RelativeTime | null;
  triple: IdentityTriple;
  /** どこから読んだか。事実の id か本文の位置。候補の左右にそのまま入る */
  source: string;
}

/**
 * 遷移のあとに前へ出る人格。
 *
 * `toPersona` を書かない抽出（第1段の形のまま）でも照合が効くよう、
 * 省略時は `subject`（誰の遷移か）で代用する。**2か所で別々に代用すると
 * 片方だけ直したときに食い違う**ので、読み方はここ1か所に置く。
 */
export function transitionToPersona(transition: IdentityTransition): string {
  return transition.toPersona ?? transition.subject;
}

/**
 * AIや作者が書いた遷移1件を検証する。
 *
 * `parseStoryFact` と同じ流儀で、**弾いた1件で抽出全体を止めない**ため
 * 例外ではなく `{ error }` を返す（呼ぶ側が「何件落とした」を報告できる）。
 */
export function parseIdentityTransition(
  raw: unknown
): IdentityTransition | StoryFactError {
  try {
    const entry = objectValue(raw, "transition");
    requireNonEmptyString(entry.subject, "transition.subject");
    if (entry.kind === undefined) invalid("transition.kind");
    optionalEnum(entry.kind, "transition.kind", IDENTITY_TRANSITION_KINDS);
    if (entry.at === undefined || entry.at === null) invalid("transition.at");
    optionalNullableString(entry.fromPersona, "transition.fromPersona");
    optionalNullableString(entry.identity, "transition.identity");
    if (entry.body !== undefined) {
      requireNonEmptyString(entry.body, "transition.body");
    }
    if (entry.toPersona !== undefined) {
      requireNonEmptyString(entry.toPersona, "transition.toPersona");
    }

    return {
      subject: entry.subject as string,
      kind: entry.kind as IdentityTransitionKind,
      at: parseFactPosition(entry.at, "transition.at"),
      // **省略は「分からない」であって「無い」ではない。** 空文字やnullで
      // 埋めると、照合側が「体が違う」と読んで正当な遷移を取り落とす
      ...(entry.body !== undefined ? { body: entry.body as string } : {}),
      ...(entry.fromPersona !== undefined
        ? { fromPersona: (entry.fromPersona as string | null) ?? null }
        : {}),
      ...(entry.toPersona !== undefined
        ? { toPersona: entry.toPersona as string }
        : {}),
      ...(entry.identity !== undefined
        ? { identity: (entry.identity as string | null) ?? null }
        : {}),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 場面の組1件を検証する。遷移と同じく、1件の不良で全体を止めない */
export function parseSceneIdentity(
  raw: unknown
): SceneIdentity | StoryFactError {
  try {
    const entry = objectValue(raw, "scene");
    const triple = objectValue(entry.triple, "scene.triple");
    requireNonEmptyString(triple.bodyId, "scene.triple.bodyId");
    requireNonEmptyString(triple.personaId, "scene.triple.personaId");
    requireNonEmptyString(triple.identityId, "scene.triple.identityId");
    requireNonEmptyString(entry.source, "scene.source");
    if (entry.chapter !== undefined && entry.chapter !== null) {
      if (!Number.isSafeInteger(entry.chapter) || (entry.chapter as number) < 0) {
        invalid("scene.chapter");
      }
    }

    return {
      chapter: (entry.chapter as number | null | undefined) ?? null,
      lineRange: parseLineRange(entry.lineRange),
      storyTime: parseRelativeTimeValue(entry.storyTime, "scene.storyTime"),
      triple: {
        bodyId: triple.bodyId as string,
        personaId: triple.personaId as string,
        identityId: triple.identityId as string,
      },
      source: entry.source as string,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 検証に落ちたか。`isStoryFactError` と同じ見分け方 */
export function isIdentityError(
  value: IdentityTransition | SceneIdentity | StoryFactError
): value is StoryFactError {
  return (value as StoryFactError).error !== undefined;
}

/** 行の範囲。書かれていなければ先頭（0行目）に置く */
function parseLineRange(value: unknown): [number, number] {
  if (value === undefined || value === null) return [0, 0];
  if (!Array.isArray(value) || value.length !== 2) invalid("scene.lineRange");
  const range = value as unknown[];
  for (const line of range) {
    if (!Number.isSafeInteger(line) || (line as number) < 0) {
      invalid("scene.lineRange");
    }
  }
  return [range[0] as number, range[1] as number];
}
