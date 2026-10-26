import { IDENTITY_TRANSITION_KINDS } from "../models/storyFact";

/**
 * P-53 場面の体と心（設計書6.88.14）。
 *
 * ## 何をさせるか
 *
 * 矛盾検知（事実の照合）の体と心の照合は、場面ごとに「どの体を、どの心が動かして
 * いるか」が分からないと何も比べられない。事実の抽出（P-37）は主語を1人の名前で
 * 返すので、憑依の場面の「俺」が体の持ち主のものか心の側のものかを持てない。
 *
 * そこで、**作者が記録した心と体の組（宿り。`Character.dwellings`）の名前を含む
 * チャンクだけ**を送り、場面ごとに体を動かしている心を書き写させる。誰の心かを
 * AI に自由に決めさせない——選べるのは、組に出てくる人物の名前と「分からない」だけ。
 * 心が入る・戻る・入れ替わる描写があれば、それも書き写させる。
 *
 * ## 書き写しだけをさせる
 *
 * 記録の範囲の外か・矛盾かは訊かない。照合はコードが行う（実装ルール3）。
 * 引用が本文に一続きにあるか・名前が台帳に引けるか・遷移の引用が台詞の外かを、
 * コードで確かめてから使う（`core/identityCues.ts`）。
 *
 * ## 見本の名前
 *
 * 見本の名前と引用は、本文に出ない語にしてある（霞野まどか・柊木こはる）。
 * **指示の言葉は、そのまま答えとして返ってくる**（この作品で繰り返し起きた）ので、
 * 見本と同じ名前・引用の答えは検算で捨てる。
 *
 * P-37 を広げずに別のプロンプトにしたのは、P-37 の版を上げると全作品の抽出の控えが
 * 無効になり、既存の台の成績も動くため（P-51 と同じ理由）。
 *
 * プロンプトを変更したら version を上げること。
 */
export const SCENE_MIND_EXTRACT_VERSION = "1.0";

/** 書き写しなので揺らさない */
export const SCENE_MIND_EXTRACT_TEMPERATURE = 0.0;

/** 1チャンクから受け取る場面の読みの上限。**文面にも同じ数を書く** */
export const SCENE_MIND_MAX_MINDS = 12;

/** 1チャンクから受け取る遷移の上限。**文面にも同じ数を書く** */
export const SCENE_MIND_MAX_TRANSITIONS = 6;

/** 引用の上限（字）。一続きの1文で足りる */
export const SCENE_MIND_EVIDENCE_MAX_CHARS = 80;

/**
 * 「分からない」の答え。誰の心か本文から決められないときに選ばせる。
 * **心の選択肢にこの語を必ず入れる**——無いと、迷ったときに体の持ち主を選ぶ
 */
export const SCENE_MIND_UNKNOWN = "分からない";

/** 見本（本文に出ない名前）。**検算はこれと同じ名前・引用の答えを捨てる**（ここだけが持つ） */
export const SCENE_MIND_EXAMPLE = {
  body: "霞野まどか",
  mind: "柊木こはる",
  evidence: "まどかの口を借りて、こはるが笑った",
} as const;

export const SCENE_MIND_EXTRACT_SYSTEM_PROMPT = `あなたは日本語の小説から、登場人物の体を、誰の心（人格）が動かしているかが書かれた所だけを探して書き写す装置です。
推測はしません。本文から決められなければ「分からない」と答えます。矛盾かどうかは判断しません。`;

/** プロンプトへ渡す組1つ（体と、その体に宿ることがある心） */
export interface SceneMindPairForPrompt {
  /** 体の持ち主の名前と別名（「文佳（別名: 密倉さん）」） */
  body: string;
  /** 宿ることがある心の名前と別名 */
  minds: readonly string[];
}

export interface SceneMindExtractInput {
  /** 行番号つきの本文（`withLineNumbers`） */
  chunkTextWithLines: string;
  pairs: readonly SceneMindPairForPrompt[];
}

export function buildSceneMindExtractPrompt(input: SceneMindExtractInput): string {
  const example = SCENE_MIND_EXAMPLE;
  const pairLines = input.pairs
    .map((pair) => `- 体: ${pair.body} ／ 宿ることがある心: ${pair.minds.join("、")}`)
    .join("\n");
  return `## 体と心の組（この作品の設定資料にある記録）
${pairLines}

## してほしいこと
下の本文で、一覧の**体**が出てくる場面を探し、その場面でその体を動かしている心（人格）を書き写してください。

- minds の body には、一覧の体の名前を書く。一覧に無い体は答えない
- minds の mind には、その場面でその体を動かしている心の名前を、一覧に出てくる名前（体の持ち主か、宿ることがある心か、ほかの組の名前）から1つ選んで書く。本文から決められなければ「${SCENE_MIND_UNKNOWN}」と書く
- 体の持ち主が自分の心で動いている場面は、mind に体の持ち主の名前を書く
- evidence には、誰の心かが分かる本文の一続きの文を、1字も変えずに書き写す（${SCENE_MIND_EVIDENCE_MAX_CHARS}字まで。離れた文をつながない）
- line には、evidence がある行の番号を書く
- transitions には、心が体に入る・体から出る・入れ替わる・生まれ変わる・幽霊として現れる**出来事が地の文に書かれている所**だけを書く。kind は ${IDENTITY_TRANSITION_KINDS.join("・")} のどれか（possession＝憑依、switch＝交代・戻る、swap＝入れ替わり、reincarnation＝転生、ghost＝幽霊）。toMind はそのあとに前へ出る心の名前、body はその体の名前（幽霊・転生で体が無ければ空文字）
- 台詞の中の「まるで別人」「人が変わったみたい」のような言い方は、出来事ではないので transitions に書かない
- minds は${SCENE_MIND_MAX_MINDS}件まで、transitions は${SCENE_MIND_MAX_TRANSITIONS}件まで。見つからなければ空の配列にする

## 答えの形（見本。見本の名前と引用は本文に無いので、そのまま写さない）
{ "minds": [ { "body": "${example.body}", "mind": "${example.mind}", "evidence": "${example.evidence}", "line": 12 } ], "transitions": [ { "kind": "possession", "body": "${example.body}", "toMind": "${example.mind}", "evidence": "${example.evidence}", "line": 12 } ] }

## 本文
${input.chunkTextWithLines}`;
}

/**
 * Ollama の `format` へ渡すスキーマ（実装ルール6）。
 *
 * **心と体の名前は列挙で縛る**（閉じた選択肢。誰の心かを AI に自由に決めさせない）。
 * 名前の一覧は作品ごとに違うので、呼ぶたびに組む。列挙が空になると形が崩れるので、
 * 呼ぶ側は組が1つ以上あるときだけ呼ぶ（`runIdentityCues`）。
 */
export function buildSceneMindExtractSchema(input: {
  /** 体の名前（体の持ち主の名前と別名） */
  bodyNames: readonly string[];
  /** 心の名前（組に出てくる人物の名前と別名） */
  mindNames: readonly string[];
}) {
  return {
    type: "object",
    properties: {
      minds: {
        type: "array",
        maxItems: SCENE_MIND_MAX_MINDS,
        items: {
          type: "object",
          properties: {
            body: { type: "string", enum: [...input.bodyNames] },
            mind: { type: "string", enum: [...input.mindNames, SCENE_MIND_UNKNOWN] },
            evidence: { type: "string", maxLength: SCENE_MIND_EVIDENCE_MAX_CHARS },
            line: { type: "number" },
          },
          required: ["body", "mind", "evidence", "line"],
        },
      },
      transitions: {
        type: "array",
        maxItems: SCENE_MIND_MAX_TRANSITIONS,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...IDENTITY_TRANSITION_KINDS] },
            body: { type: "string" },
            toMind: { type: "string", enum: [...input.mindNames] },
            evidence: { type: "string", maxLength: SCENE_MIND_EVIDENCE_MAX_CHARS },
            line: { type: "number" },
          },
          required: ["kind", "body", "toMind", "evidence", "line"],
        },
      },
    },
    required: ["minds", "transitions"],
  } as const;
}
