/**
 * 矛盾検知の機械照合層が扱う「事実」の形（設計書6.88.3）。
 *
 * **LLM には「矛盾」ではなく「事実」を抜かせ、矛盾は機械が決める。**
 * ここはその受け皿であり、VS Code APIにも `core/` にも依存しない
 * （`models` → `core` は依存の逆流になるため、相対時期の**型**だけを
 * ここに置き、**読み取り**は `core/relativeTime.ts` が持つ）。
 */

import {
  invalid,
  objectValue,
  optionalEnum,
  optionalNullableNumber,
  optionalNullableString,
  requireNonEmptyString,
} from "./jsonValidation";

/**
 * 事実の種類。
 *
 * - `static`    変わらない属性（髪の色・生まれ）
 * - `state`     状態。変化イベントで区間が切れる（所在・怪我・所持品）
 * - `knowledge` 誰が何を知ったか（`subject` ＝ 知った人、`topic` ＝ 何を）
 * - `event`     出来事（死亡・移動・変化）
 */
export const FACT_KINDS = ["static", "state", "knowledge", "event"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/**
 * その事実がどういう強さで書かれているか。
 *
 * **これが肝である。** 地の文の断定と、人物が喋った内容を同じ強さで
 * 扱うと誤検出だらけになる。人物は嘘をつくし、勘違いもする。
 * 照合は modality を確信度に写す（narration＝高、dialogue・thought＝中、
 * rumor・lie_suspect＝低）。
 */
export const FACT_MODALITIES = [
  "narration",
  "dialogue",
  "thought",
  "rumor",
  "lie_suspect",
] as const;
export type FactModality = (typeof FACT_MODALITIES)[number];

/** 一日の区分。これより細かい目盛りは本文から安定して読めない */
export const TIME_PARTS = ["朝", "昼", "夕", "夜"] as const;
export type TimePart = (typeof TIME_PARTS)[number];

/**
 * 作中の時刻。暦ではなく**物語の起点からの相対**で持つ（作者の裁定、6.88.4）。
 *
 * `day` は起点より前なら負。`part` が `null` なら「その日のいつか」で、
 * **同じ日の中では前後が読めない**（`compareRelativeTime` は 0 を返す）。
 */
export interface RelativeTime {
  day: number;
  part: TimePart | null;
}

/**
 * 事実・遷移が置かれている場所。
 *
 * 時期が読めない事実もあるので、**本文の位置（話数と行）を必ず持つ**。
 * 時期が `null` のものは、この位置で挟み込んで並べる（6.88.4）。
 */
export interface FactPosition {
  storyTime: RelativeTime | null;
  chapter: number | null;
  line: number;
}

/** 場面から抜き出した1つの事実（6.88.3） */
export interface StoryFact {
  id: string;
  chapter: number | null;
  lineRange: [number, number];
  /** 人物の id（`char_006`）。解決できなければ本文の表記そのまま */
  subject: string;
  predicate: string;
  value: string;
  kind: FactKind;
  /** 相対時期。読めなければ `null`（推測で埋めない） */
  storyTime: RelativeTime | null;
  modality: FactModality;
  pov: string | null;
  /** dialogue のとき誰の発言か。知識矛盾の照合鍵 */
  speaker: string | null;
  /** 知識の照合鍵。同じ事柄には同じ語を付ける */
  topic: string | null;
}

/** 組が変わる出来事の種類（6.88.5） */
export const IDENTITY_TRANSITION_KINDS = [
  "possession",
  "switch",
  "reincarnation",
  "ghost",
  "swap",
] as const;
export type IdentityTransitionKind = (typeof IDENTITY_TRANSITION_KINDS)[number];

/**
 * 肉体・人格・身分の組が変わる出来事（6.88.5）。
 *
 * 第1段では「死亡後の登場」を候補から外すためだけに使っていた（`subject` と
 * `kind` と `at` だけで足りた）。第2段では**組の変化が正当かどうか**を
 * これで決めるので、遷移の中身——どの体で、どの人格からどの人格へ移ったか——
 * を持てるようにした。
 *
 * **`subject` は残す。** 第1段の「死亡後の登場」はこれを鍵に照合しており、
 * 遷移の中身を足したついでに鍵を変えると、幽霊・転生の除外が黙って効かなく
 * なる。`subject` は「誰の遷移か」＝前に出てくる側の人格である。
 *
 * `body`・`toPersona` は**分かる範囲で書く**。書かれていない項目で照合を
 * 厳しくすると、抽出が項目を落とした作品で遷移が効かなくなり、
 * 正当な憑依が矛盾として出る（`core/contradictionMatch.ts` の
 * `findIdentityDrift` は、記録の無い項目を「問わない」側に倒している）。
 */
export interface IdentityTransition {
  /** 誰の遷移か。前に出てくる側の人格の id。**第1段からの照合鍵** */
  subject: string;
  kind: IdentityTransitionKind;
  at: FactPosition;
  /** どの肉体で起きたか。読めなければ省略（推測で埋めない） */
  body?: string;
  /** それまで前に出ていた人格。いなければ（転生・幽霊など）null */
  fromPersona?: string | null;
  /** 遷移のあとに前へ出る人格。省略時は `subject` と同じとみなす */
  toPersona?: string;
  /** 遷移のあとの社会的な身分。変わらない／読めなければ null */
  identity?: string | null;
}

/** `parseStoryFact` が返す失敗。例外にしないのは、1件の不良で抽出全体を捨てないため */
export interface StoryFactError {
  error: string;
}

export function isStoryFactError(
  value: StoryFact | StoryFactError
): value is StoryFactError {
  return (value as StoryFactError).error !== undefined;
}

/**
 * AIが返した1件を検証して `StoryFact` にする。
 *
 * **AIの出力を信用しない。** 知らない `kind`／`modality` は弾く。
 * 弾いた1件で抽出全体を止めないため、例外ではなく `{ error }` を返す
 * （呼ぶ側が「何件落とした」を報告できるようにする）。
 */
export function parseStoryFact(raw: unknown): StoryFact | StoryFactError {
  try {
    const entry = objectValue(raw, "fact");
    requireNonEmptyString(entry.id, "fact.id");
    requireNonEmptyString(entry.subject, "fact.subject");
    requireNonEmptyString(entry.predicate, "fact.predicate");
    // 値は空でもよい（死亡イベントのように「起きたこと」だけの事実がある）
    if (typeof entry.value !== "string") invalid("fact.value");
    requireEnum(entry.kind, "fact.kind", FACT_KINDS);
    requireEnum(entry.modality, "fact.modality", FACT_MODALITIES);
    optionalNullableNumber(entry.chapter, "fact.chapter");
    optionalNullableString(entry.pov, "fact.pov");
    optionalNullableString(entry.speaker, "fact.speaker");
    optionalNullableString(entry.topic, "fact.topic");

    return {
      id: entry.id as string,
      chapter: (entry.chapter as number | null | undefined) ?? null,
      lineRange: parseLineRange(entry.lineRange),
      subject: entry.subject as string,
      predicate: entry.predicate as string,
      value: entry.value as string,
      kind: entry.kind as FactKind,
      storyTime: parseRelativeTimeValue(entry.storyTime, "fact.storyTime"),
      modality: entry.modality as FactModality,
      pov: (entry.pov as string | null | undefined) ?? null,
      speaker: (entry.speaker as string | null | undefined) ?? null,
      topic: (entry.topic as string | null | undefined) ?? null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** `optionalEnum` は未指定を通すので、必須の項目にはこちらを使う */
function requireEnum(
  value: unknown,
  path: string,
  allowed: readonly string[]
): void {
  if (value === undefined) invalid(path);
  optionalEnum(value, path, allowed);
}

/** 行の範囲。負の行や小数が入ると、本文の照合も並べ替えも静かに崩れる */
function parseLineRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) invalid("fact.lineRange");
  const range = value as unknown[];
  for (const line of range) {
    if (!Number.isSafeInteger(line) || (line as number) < 0) {
      invalid("fact.lineRange");
    }
  }
  return [range[0] as number, range[1] as number];
}

/**
 * 相対時期の検証。**事実からも遷移からも同じものを読む**ので、
 * 置き場所の名前（`path`）だけを差し替えられるようにしてある。
 */
export function parseRelativeTimeValue(
  value: unknown,
  path: string
): RelativeTime | null {
  if (value === undefined || value === null) return null;
  const time = objectValue(value, path);
  // 起点より前は負になるので、`optionalNullableNumber` は使えない（負を弾く）
  if (!Number.isSafeInteger(time.day)) invalid(`${path}.day`);
  if (time.part !== undefined && time.part !== null) {
    optionalEnum(time.part, `${path}.part`, TIME_PARTS);
  }
  return {
    day: time.day as number,
    part: (time.part as TimePart | null | undefined) ?? null,
  };
}

/**
 * 事実・遷移の置き場所の検証。
 *
 * 行が書かれていなければ 0 とする。**話の先頭に寄せるだけで、
 * 並びも照合も崩さない**（時期と話数で先に比べるため）。
 */
export function parseFactPosition(value: unknown, path: string): FactPosition {
  const position = objectValue(value, path);
  optionalNullableNumber(position.chapter, `${path}.chapter`);
  optionalNullableNumber(position.line, `${path}.line`);
  return {
    storyTime: parseRelativeTimeValue(position.storyTime, `${path}.storyTime`),
    chapter: (position.chapter as number | null | undefined) ?? null,
    line: (position.line as number | null | undefined) ?? 0,
  };
}
