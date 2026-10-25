/**
 * P-51 本文の所要時間（設計書6.88.13）。
 *
 * ## 何をさせるか
 *
 * 移動の照合（矛盾検知の事実の照合）は、場所どうしの所要時間の表が無いと
 * 何も比べられない。表の材料は設定資料の場所の記録の距離だけで、本文の
 * 「王都から港町までは馬で三日」は表に入らなかった。そこで、**台帳にある場所の
 * あいだの所要時間を、本文から書き写させる**。
 *
 * ## 書き写しだけをさせる
 *
 * どれが速いか・矛盾しているかは訊かない。照合はコードが行う（実装ルール3）。
 * AIの答えは、引用が本文に一続きにあるか・両端が台帳の別々の場所に引けるか・
 * 値が読めるかをコードで確かめてから、設定資料へ**提案**として置く
 * （`core/travelCues.ts` の `validateTravelDistances`）。
 *
 * ## 見本の値
 *
 * 見本の地名と値は、本文に出ない語にしてある（霧見ヶ原・白砂の浦・牛車で九日）。
 * **指示の言葉は、そのまま答えとして返ってくる**（この作品で繰り返し起きた）ので、
 * 見本と同じ値の答えは検算で捨てる。
 *
 * P-37（事実の抽出）を広げずに別のプロンプトにしたのは、P-37 の版を上げると
 * 全作品の抽出の控えが無効になり、既存の台の成績も動くため。
 *
 * プロンプトを変更したら version を上げること。
 */
export const TRAVEL_DISTANCE_EXTRACT_VERSION = "1.0";

/** 書き写しなので揺らさない */
export const TRAVEL_DISTANCE_EXTRACT_TEMPERATURE = 0.0;

/** 1チャンクから受け取る件数の上限。距離の言い方は1話に数件しか無い */
export const TRAVEL_DISTANCE_MAX_ITEMS = 10;

/** 引用の上限（字）。一続きの1文で足りる */
export const TRAVEL_DISTANCE_EVIDENCE_MAX_CHARS = 80;

/**
 * 送るチャンクを選ぶ語（設計書6.88.13）。台帳の場所の名前か別名を含み、
 * さらにこのどれかを含むチャンクだけを送る。距離の言い方の無いチャンクまで
 * 送ると、呼ぶ回数だけが増える
 */
export const TRAVEL_DISTANCE_CUE_WORDS: readonly string[] = [
  "日",
  "時間",
  "馬",
  "徒歩",
  "船",
  "かかる",
  "道のり",
];

/** 見本（本文に出ない語）。**検算はこれと同じ値の答えを捨てる**（ここだけが持つ） */
export const TRAVEL_DISTANCE_EXAMPLE = {
  from: "霧見ヶ原",
  to: "白砂の浦",
  value: "牛車で九日",
  evidence: "霧見ヶ原から白砂の浦までは牛車で九日の道のりだ",
} as const;

export const TRAVEL_DISTANCE_EXTRACT_SYSTEM_PROMPT = `あなたは日本語の小説から、場所と場所のあいだの道のり（移動にかかる時間）が書かれた文だけを探して書き写す装置です。
推測や計算はしません。本文に書かれていない道のりは答えません。`;

export interface TravelDistanceExtractInput {
  /** 行番号つきの本文（`withLineNumbers`） */
  chunkTextWithLines: string;
  /** 台帳の場所の名前と別名（「王都（別名: リヴェルス）」の形で並べる） */
  locationNames: readonly string[];
}

export function buildTravelDistanceExtractPrompt(
  input: TravelDistanceExtractInput
): string {
  const example = TRAVEL_DISTANCE_EXAMPLE;
  return `## 場所の一覧（この作品の設定資料にある場所）
${input.locationNames.map((name) => `- ${name}`).join("\n")}

## してほしいこと
下の本文から、**一覧の場所2つのあいだの道のり**が書かれている所を探し、書き写してください。

- from と to には、一覧の場所の名前（または別名）を本文に出てきたとおりに書く。一覧に無い場所は答えない
- value には、道のりの言い方を本文から書き写す（乗り物と時間。20字まで）。例の形：「馬で三日」「徒歩で半日」「船で二日」
- evidence には、from・to・value をすべて含む本文の一続きの文を、1字も変えずに書き写す（80字まで。離れた文をつながない）
- line には、evidence がある行の番号を書く
- 台詞の中に書かれた道のりも答えてよい
- 何日かかったかの経過（「三日三晩語り合った」「旅に出て五日目」）は道のりではないので答えない
- 「数日」「すぐそこ」のように数のはっきりしない言い方は答えない
- 見つからなければ distances を空の配列にする

## 答えの形（見本。見本の地名と値は本文に無いので、そのまま写さない）
{ "distances": [ { "from": "${example.from}", "to": "${example.to}", "value": "${example.value}", "evidence": "${example.evidence}", "line": 12 } ] }

## 本文
${input.chunkTextWithLines}`;
}

/**
 * Ollama の `format` へ渡すスキーマ（実装ルール6）。
 *
 * 項目名は短い英語にしてある（小さいモデルが写しやすい。P-37 と同じ考え）。
 */
export const TRAVEL_DISTANCE_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    distances: {
      type: "array",
      maxItems: TRAVEL_DISTANCE_MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          value: { type: "string", maxLength: 20 },
          evidence: {
            type: "string",
            maxLength: TRAVEL_DISTANCE_EVIDENCE_MAX_CHARS,
          },
          line: { type: "number" },
        },
        required: ["from", "to", "value", "evidence", "line"],
      },
    },
  },
  required: ["distances"],
} as const;
