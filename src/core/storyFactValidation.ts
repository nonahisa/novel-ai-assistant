import { isMeaningfulValue } from "./characterExtractionValidation";
import { parseRelativeTime } from "./relativeTime";
import {
  FACT_KINDS,
  FACT_MODALITIES,
  type FactKind,
  type FactModality,
  type StoryFact,
} from "../models/storyFact";

/**
 * P-37（場面の事実の抽出）の応答の検算（設計書6.88）。
 *
 * **指示語がそのまま返ってくる前提で書く。** この作品では
 * `"category": "人物|状態|時系列"` のように、プロンプトに書いた選択肢の並びを
 * そのまま値として返す事故が繰り返し起きている（6.10.1）。構造化出力に
 * 対応したプロバイダなら enum で止まるが、対応していないプロバイダでは
 * 何でも返ってくる。**両方で受ける。**
 *
 * 弾いたものは捨てずに理由つきで返す。**理由ごとの件数を完了報告に出す**ため
 * （`describeStoryFactRejections`）——「N件落としました」だけでは、
 * プロンプトの問題なのか検算が厳しすぎるのかを切り分けられない（6.35.7 と同じ）。
 *
 * VS Code APIに依存しない。
 */

/** 弾いた理由。次に何をすればよいかが理由ごとに違うので、まとめない */
export type StoryFactRejection =
  /** 項目が足りない・型が違う */
  | "invalid_shape"
  /** 知らない `kind`。選択肢の写し（`"static|state"`）もここ */
  | "unknown_kind"
  /** 知らない `modality`。選択肢の写しもここ */
  | "unknown_modality"
  /** 行がチャンクの外を指している（本文に無い行を作った） */
  | "line_out_of_range"
  /** 主語が `char_999` のような**作られた id**（対応表に無い id の形） */
  | "unknown_subject"
  /** 「不明」「記述なし」のような、中身の無い値 */
  | "empty_value"
  /** 台詞なのに発言者が無い */
  | "dialogue_without_speaker";

export interface RejectedStoryFact {
  reason: StoryFactRejection;
  raw: unknown;
}

export interface StoryFactValidationInput {
  /** チャンクの先頭の行番号（1始まり。`withLineNumbers` が振ったものと同じ） */
  chunkLineStart: number;
  /** チャンクの末尾の行番号（1始まり） */
  chunkLineEnd: number;
  /** その話の話数。読めなければ null */
  chapter: number | null;
  /** 既知の人物の id */
  knownCharacterIds: Set<string>;
  /** 既知の表記から id を引く表（「文佳ちゃん」→ `char_006`） */
  knownNames: Map<string, string>;
}

export interface StoryFactValidationResult {
  accepted: StoryFact[];
  rejected: RejectedStoryFact[];
}

const KIND_SET = new Set<string>(FACT_KINDS);
const MODALITY_SET = new Set<string>(FACT_MODALITIES);

/**
 * AIが返した事実の一覧を検算する。
 *
 * **1件の不良で全部を捨てない。** 1チャンクから数十件返るので、
 * 1件でも例外を投げると、そのチャンクの正しい事実まで消える。
 */
export function validateStoryFactResult(
  result: unknown,
  input: StoryFactValidationInput
): StoryFactValidationResult {
  const accepted: StoryFact[] = [];
  const rejected: RejectedStoryFact[] = [];

  const facts = factsOf(result);
  if (facts === undefined) {
    return { accepted, rejected: [{ reason: "invalid_shape", raw: result }] };
  }

  // 同じ行に複数の事実が乗ることがあるので、行ごとに連番を振って id を分ける
  const perLine = new Map<number, number>();

  for (const raw of facts) {
    const checked = checkOne(raw, input);
    if (typeof checked === "string") {
      rejected.push({ reason: checked, raw });
      continue;
    }

    const seen = (perLine.get(checked.lineRange[0]) ?? 0) + 1;
    perLine.set(checked.lineRange[0], seen);
    accepted.push({
      ...checked,
      id: `fact:${input.chapter ?? "?"}:${checked.lineRange[0]}:${seen}`,
    });
  }

  return { accepted, rejected };
}

/** 1件を検算する。通れば id 以外が埋まった事実、通らなければ理由を返す */
function checkOne(
  raw: unknown,
  input: StoryFactValidationInput
): Omit<StoryFact, "id"> | StoryFactRejection {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "invalid_shape";
  }
  const entry = raw as Record<string, unknown>;

  const lineStart = entry.line_start;
  const lineEnd = entry.line_end;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) {
    return "invalid_shape";
  }
  const start = lineStart as number;
  const end = lineEnd as number;
  // 端も含めて、チャンクの中を指しているか。逆順（終わりが先）も本文に無い形
  if (
    start > end ||
    start < input.chunkLineStart ||
    end > input.chunkLineEnd
  ) {
    return "line_out_of_range";
  }

  const subject = trimmedString(entry.subject);
  const predicate = trimmedString(entry.predicate);
  if (subject === undefined || predicate === undefined) return "invalid_shape";
  if (typeof entry.value !== "string") return "invalid_shape";

  const resolvedSubject = resolveActor(subject, input);
  if (resolvedSubject === undefined) return "unknown_subject";

  // 「不明」「記述なし」を値にするのはプロンプトで禁じているが、指示だけでは守られない
  if (!isMeaningfulValue(entry.value)) return "empty_value";

  if (typeof entry.kind !== "string" || !KIND_SET.has(entry.kind.trim())) {
    return "unknown_kind";
  }
  if (
    typeof entry.modality !== "string" ||
    !MODALITY_SET.has(entry.modality.trim())
  ) {
    return "unknown_modality";
  }
  const modality = entry.modality.trim() as FactModality;

  const speaker = optionalActor(entry.speaker, input);
  // **黙って narration へ落とさない。** 発言者の分からない台詞を地の文に
  // すると、機械照合がいちばん強い証拠として扱う。弾いて件数に出す
  if (modality === "dialogue" && speaker === null) {
    return "dialogue_without_speaker";
  }

  return {
    chapter: input.chapter,
    lineRange: [start, end],
    subject: resolvedSubject,
    predicate,
    value: entry.value.trim(),
    kind: entry.kind.trim() as FactKind,
    // 読めなければ null に落とす（弾かない）。時期が無くても、本文の順で並べられる
    storyTime:
      typeof entry.story_time === "string"
        ? parseRelativeTime(entry.story_time)
        : null,
    modality,
    pov: optionalActor(entry.pov, input),
    speaker,
    topic: trimmedString(entry.topic) ?? null,
  };
}

/** `{ facts: [...] }` を取り出す。形が違えば undefined */
function factsOf(result: unknown): unknown[] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const facts = (result as Record<string, unknown>).facts;
  return Array.isArray(facts) ? facts : undefined;
}

/**
 * 人物の指定を id へ寄せる。
 *
 * **表記のまま返ってきたものを id に直す**のがここの仕事である。
 * 直さないと、同じ人物が場面ごとに別の主語になって照合が当たらない。
 * id でも既知の表記でもなければ undefined（呼ぶ側が弾く）。
 */
function resolveActor(
  value: string,
  input: StoryFactValidationInput
): string | undefined {
  if (input.knownCharacterIds.has(value)) return value;
  const resolved = input.knownNames.get(value);
  if (resolved !== undefined) return resolved;
  // **対応表に無い人物は、本文の表記そのまま通す**（P-37「表に無い人物は本文の表記そのまま」。
  // 本体の判断、0.46.2）。弾くと、対応表に無い新顔の事実が必ず落ちる。
  // 弾くのは、id の形をしているのに対応表に無いもの——モデルが作った id だけ
  if (/^char_\d+$/u.test(value)) return undefined;
  return value;
}

/**
 * `speaker`・`pov` の寄せ。
 *
 * **こちらは弾かない。** 名前のない語り手や、対応表に無い通行人が
 * 発言することはある。寄せられたら id、寄せられなければ書かれたまま残す。
 */
function optionalActor(
  value: unknown,
  input: StoryFactValidationInput
): string | null {
  const text = trimmedString(value);
  if (text === undefined) return null;
  return resolveActor(text, input) ?? text;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

/** 作者とログに見せる理由の名前 */
const REJECTION_LABELS: Record<StoryFactRejection, string> = {
  invalid_shape: "形が違う",
  unknown_kind: "知らない種類",
  unknown_modality: "知らない書かれ方",
  line_out_of_range: "行が範囲外",
  unknown_subject: "作られた人物id",
  empty_value: "中身の無い値",
  dialogue_without_speaker: "発言者の無い台詞",
};

/**
 * 弾いた内訳を1行にする。
 *
 * **「N件落としました」だけでは次の手が決まらない。** 理由ごとに直す場所が違う——
 * `unknown_kind`／`unknown_modality` が多ければプロンプトの選択肢の見せ方、
 * `line_out_of_range` が多ければ行番号の渡し方、`unknown_subject` が多ければ
 * 人物の対応表の作り方である。
 *
 * 件数が0なら空文字を返す（うまくいった回のログを汚さない）。
 */
export function describeStoryFactRejections(
  rejected: ReadonlyArray<{ reason: StoryFactRejection }>
): string {
  if (rejected.length === 0) return "";
  const counts = new Map<StoryFactRejection, number>();
  for (const entry of rejected) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  // 多い順。同数なら理由の名前で並べて、実行ごとに順が揺れないようにする
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${REJECTION_LABELS[reason]} ${count}件`)
    .join("、");
}
