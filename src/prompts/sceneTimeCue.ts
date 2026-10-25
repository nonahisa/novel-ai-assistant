/**
 * P-52 場面の頭の時の経過（設計書6.88.13）。
 *
 * ## 何をさせるか
 *
 * 移動の照合の時計（`core/sceneClock.ts`）は、段落の頭の決まった語（「翌朝」
 * 「その頃」「三日後」）と日付しか読まない。「王都を出て二日目の夕方だった」
 * 「リナが城門に帰り着いたのは、翌朝のことだった」のように**文の途中に書かれた
 * 手がかり**は読めず、そこで時の鎖が切れる。切れた所では、同じ人物が離れた
 * 場所へ移っていても比べられない。
 *
 * そこで、**鎖が切れた場面の頭だけ**を AI に読ませ、前の場面からどれだけ経ったかを
 * 5つの答えのどれかで返させる。送るのは前の場面の終わり3段落と、この場面の頭
 * 5段落だけ（作品全体は送らない）。
 *
 * ## AIの読みを信用しない
 *
 * 引用がこの場面の最初の段落の地の文（「」の外）にあるか、経過が進んだと
 * 答えたなら引用に書かれた日数と同じか、をコードで確かめる
 * （`core/travelCues.ts` の `validateSceneTimeCue`）。合わなければ「分からない」
 * （cut）として扱う——時計は鎖を切ったまま、比べない側へ倒れる。
 *
 * 見本の引用は本文に出ない語にしてある。見本と同じ答えは検算で捨てる。
 *
 * プロンプトを変更したら version を上げること。
 */
export const SCENE_TIME_CUE_VERSION = "1.0";

export const SCENE_TIME_CUE_TEMPERATURE = 0.0;

/** 前の場面から何段落を見せるか */
export const SCENE_TIME_CUE_PREVIOUS_PARAGRAPHS = 3;
/** この場面の頭から何段落を見せるか */
export const SCENE_TIME_CUE_HEAD_PARAGRAPHS = 5;
/** 引用の上限（字） */
export const SCENE_TIME_CUE_EVIDENCE_MAX_CHARS = 40;

/** 答えの種類。`null` は「手がかりが無い」 */
export const SCENE_TIME_CUE_KINDS = [
  "simultaneous",
  "sameDay",
  "advance",
  "cut",
] as const;
export type SceneTimeCueKind = (typeof SCENE_TIME_CUE_KINDS)[number];

/** 見本（本文に出ない語）。**検算はこれと同じ引用を捨てる**（ここだけが持つ） */
export const SCENE_TIME_CUE_EXAMPLE = {
  kind: "advance",
  days: 4,
  evidence: "霧見ヶ原を発って四日目",
} as const;

export const SCENE_TIME_CUE_SYSTEM_PROMPT = `あなたは日本語の小説の場面の切り替わりで、前の場面からどれだけ時間が経ったかを、本文に書かれた言葉だけから読む装置です。
推測はしません。書かれていなければ「分からない」と答えます。`;

export interface SceneTimeCueInput {
  /** 前の場面の終わりの段落（古い順） */
  previousParagraphs: readonly string[];
  /** この場面の頭の段落（最初がこの場面の1段落目） */
  headParagraphs: readonly string[];
}

export function buildSceneTimeCuePrompt(input: SceneTimeCueInput): string {
  const example = SCENE_TIME_CUE_EXAMPLE;
  const previous =
    input.previousParagraphs.length > 0
      ? input.previousParagraphs.join("\n")
      : "（前の場面はありません）";
  return `## 前の場面の終わり
${previous}

## この場面の頭
${input.headParagraphs.join("\n")}

## してほしいこと
「この場面の頭」の**最初の段落**が、前の場面からどれだけ後のことかを、本文の言葉だけから答えてください。

- kind は次のどれか1つ
  - "simultaneous"：前の場面と同じ時（「その頃」「同じ時刻」など）
  - "sameDay"：前の場面と同じ日のうち（「その日の夕方」「その夜」など）
  - "advance"：前の場面から決まった日数が経った（「翌朝」「三日後」「出て二日目」など）
  - "cut"：時間が経ったが、何日か書かれていない（「数日後」「しばらくして」「三年前」の回想など）
  - null：時間の手がかりが書かれていない
- days は、advance のときだけ経った日数（整数）。ほかは 0
- evidence は、手がかりの言葉を最初の段落から1字も変えずに書き写す（40字まで）。台詞（「」の中）からは取らない。手がかりが無ければ空文字
- 何日かかったかの言い方（「三日三晩語り合った」「馬で三日の道のり」）は、前の場面からの経過ではない

## 答えの形（見本。見本の言葉は本文に無いので、そのまま写さない）
{ "kind": "${example.kind}", "days": ${example.days}, "evidence": "${example.evidence}" }`;
}

/** Ollama の `format` へ渡すスキーマ（実装ルール6） */
export const SCENE_TIME_CUE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: ["string", "null"], enum: [...SCENE_TIME_CUE_KINDS, null] },
    days: { type: "number" },
    evidence: { type: "string", maxLength: SCENE_TIME_CUE_EVIDENCE_MAX_CHARS },
  },
  required: ["kind", "days", "evidence"],
} as const;
