import { FACT_KINDS, FACT_MODALITIES } from "../models/storyFact";

/**
 * P-37 場面の事実の抽出（設計書6.88。矛盾検知の新しい道・第3段）
 *
 * **矛盾を LLM に決めさせない。** P-12（`contradictionCheck.ts`）は本文と
 * 設定資料を丸ごと見せて食い違いを挙げさせるため、精度がモデルの賢さと
 * 指示文の言い回しに全部かかっていた（実測では `gemma4:26b` が仕込んだ矛盾を
 * 2件中0件しか拾わない）。ここでは1チャンクを読ませて、
 * **誰が・何を・どの時点で・地の文か台詞か**を JSON で返させるだけにする。
 * 食い違いを見つけるのは機械（`core/contradictionMatch.ts`）の仕事である。
 *
 * 定型の JSON 化なので、ローカルの小さいモデルでも足りる想定
 * （割当キーは `factExtract`。機能別AI割当への登録は第4段）。
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-37）
 * - 1.0: 初版（0.46.2）。実データでは未確認——第4段で提案パネルへ繋いだあとに測る
 */
export const STORY_FACT_EXTRACT_VERSION = "1.0";

/**
 * 1チャンクから受け取る事実の上限。
 *
 * **小さいモデルは配列が止まらなくなる**（P-04a で実際に起きた）。
 * スキーマの `maxItems` と、プロンプトの文面の両方に同じ数を出す——
 * 構造化出力に対応していないプロバイダでは、文面しか効かないため。
 */
const MAX_FACTS = 60;

export const STORY_FACT_EXTRACT_SYSTEM_PROMPT = `あなたは日本語の小説から「本文にこう書いてある」という事実だけを取り出す装置です。

【絶対に守る原則】
1. **矛盾を探さないこと。** 前の話や設定との食い違いは、別の仕組みが機械的に調べます。
   あなたの仕事は、いま渡された本文に書いてあることを、そのまま項目に分けて返すことだけです。
2. **評価しないこと。** 良し悪し、整合性、作者の意図の推測を書かないこと。
3. **推測で埋めないこと。** 本文から読み取れない項目は null にすること。
   「不明」「記述なし」「特になし」のような語を値として書かないこと。
   そう書かれた事実は、まるごと捨てられます。
4. 本文に書かれていない事実を作らないこと。行間を補わないこと。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

/** 既知の人物1人。`subject`・`speaker`・`pov` を id で揃えさせるために渡す */
export interface KnownCharacterEntry {
  /** 人物の id（`char_006`）。機械照合はこの id で突き合わせる */
  id: string;
  name: string;
  aliases: string[];
}

export interface StoryFactExtractInput {
  /**
   * **行番号つきの**本文（`core/chunker.ts` の `withLineNumbers` で作る）。
   *
   * ここでは振り直さない。渡された文字列をそのまま見せるだけである——
   * 二重に番号を振ると、返ってきた行がチャンクの外を指して検算で全部落ちる。
   */
  chunkText: string;
  /** その話の見出し（「第3話」「投稿2026-08-16」） */
  chapterLabel: string;
  /** その話の話数。相対時期の起点（第1話）からの距離を言うために渡す。読めなければ null */
  chapterNumber: number | null;
  /** 既知の人物の対応表。空でもよい（そのときは本文の表記で返させる） */
  knownCharacters: KnownCharacterEntry[];
  /** 既知の topic（知識矛盾の照合鍵）。同じ事柄に同じ語を付けさせるために渡す */
  knownTopics: string[];
}

/**
 * 人物の対応表。
 *
 * **id で返させないと、同じ人物が場面ごとに別の主語になる**（「文佳」「密倉さん」
 * 「文佳ちゃん」）。機械照合は id で突き合わせるので、ここで揃えておく。
 */
function characterTable(input: StoryFactExtractInput): string {
  if (input.knownCharacters.length === 0) {
    return "（まだ登録がありません。人物は本文の表記のまま書いてください）";
  }
  return input.knownCharacters
    .map((entry) => {
      const aliases = entry.aliases.filter((alias) => alias.trim().length > 0);
      const tail = aliases.length > 0 ? `（${aliases.join("・")}）` : "";
      return `${entry.id}：${entry.name}${tail}`;
    })
    .join("\n");
}

/** 既知の topic。同じ事柄に同じ語を付けさせるための一覧 */
function topicList(input: StoryFactExtractInput): string {
  const topics = input.knownTopics.filter((topic) => topic.trim().length > 0);
  if (topics.length === 0) {
    return "（まだありません。knowledge の事実には、事柄を短い語で自分で付けてください）";
  }
  return topics.map((topic) => `- ${topic}`).join("\n");
}

/**
 * 相対時期の起点の説明（設計書6.88.4）。
 *
 * **暦に直させない。** 小説は「何年何月何日」を書かないことのほうが多く、
 * 書いてあっても架空の暦であることがある。起点からの日数と朝・昼・夕・夜だけなら、
 * たいていの作品から読める。
 */
function storyTimeSection(input: StoryFactExtractInput): string {
  const here =
    input.chapterNumber === null
      ? ""
      : `いま読んでいるのは第${input.chapterNumber}話です。\n`;

  return `【時期（story_time）の数え方】
${here}- **day 0 は、第1話のいちばん最初の場面**です。そこから何日進んだかを書きます。
- 本文に「翌日」「三日後」「その夜」「一週間後」のような手がかりがあるときだけ書きます。
  書き方は "day+3 夜"、"day+14 夕"、回想などで起点より前なら "day-2 朝" です。
  一日の区分は 朝・昼・夕・夜 の4つだけを使ってください。
- **手がかりが無ければ null にしてください。** 何日目かを数えられないときに、
  それらしい日数を書かないでください。推測した時期で矛盾を出すと、作者は本文ではなく
  こちらの推測を直しに行くことになります。`;
}

export function buildStoryFactExtractPrompt(
  input: StoryFactExtractInput
): string {
  return `以下の小説本文から、書かれている事実を取り出してください。矛盾は探さないでください。

【対象本文】（${input.chapterLabel}。各行の左の数字は行番号です）
${input.chunkText}

【人物の対応表】
${characterTable(input)}

【人物の書き方】
- subject・speaker・pov には、対応表の id（char_006 のような形）をそのまま入れてください。
- 対応表に無い人物は、本文の表記のまま（「痩せた男」「店主」）入れてください。
- pov は、その場面を見ている視点人物です。分からなければ null。

【既知の topic】（knowledge の事実の照合鍵。同じ事柄には同じ語を使ってください）
${topicList(input)}

${storyTimeSection(input)}

【kind（事実の種類）】
- static：作中で変わらない属性。髪の色、目の色、年齢、身長、出身、生まれ
- state：変わりうる状態。所在、所持品、怪我、生死、所属、役割
- knowledge：誰が何を知ったか・知っているか。subject は知った人、topic に何をかを書く
- event：起きたこと。死亡、移動、変化、獲得
- **移動は必ず event にしてください。** 「AがBへ着いた」は state ではなく event です
  （どこにいたかの区間は、機械が移動のイベントで切ります）。

【modality（どう書かれているか）】
- narration：地の文
- dialogue：台詞。**speaker に誰の発言かを必ず入れてください。**
  誰が言ったか分からない台詞は、その事実を返さないでください
- thought：心の声、回想
- rumor：伝聞（「〜らしい」「〜と聞いた」）
- lie_suspect：嘘や思い違いの疑いがある発言
**必ず付けてください。** 人物は嘘をつきますし、勘違いもします。地の文の断定と台詞を
同じ強さで扱うと、機械の照合が誤検出だらけになります。

【値（value）の書き方】
- **本文の語のまま**書いてください。「銀髪」を「銀」に縮めたり「銀色の髪」と言い換えたり
  しないでください。言い換えると、機械の照合では別の値になります。
- 1つの事実につき1件です。同じ行に複数の事実があれば、複数の件に分けてください。
- line_start・line_end には、その事実が書かれている行の番号を入れてください。
  1行に収まるなら同じ番号を2つ入れます。本文に無い行番号を書かないでください。

【predicate（項目名）によく使う語】
髪の色、目の色、年齢、身長、所在、所持品、怪我、生死、所属、呼び方、関係
この中に無い事柄は、短い日本語で自由に書いてかまいません。

【出力形式】JSONのみ
{
  "facts": [
    {
      "line_start": 12,
      "line_end": 12,
      "subject": "char_006",
      "predicate": "髪の色",
      "value": "銀髪",
      "kind": "static",
      "story_time": "day+14 夕",
      "modality": "narration",
      "pov": "char_001",
      "speaker": null,
      "topic": null
    }
  ]
}

kind に入れてよい語は次のうち**1つだけ**です：${FACT_KINDS.join("、")}
modality に入れてよい語は次のうち**1つだけ**です：${FACT_MODALITIES.join("、")}
上の見本に書いてある値は、書き方の例です。見本の語をそのまま写して返さないでください。
事実が1つも無ければ "facts": [] と返してください。多くても${MAX_FACTS}件までにしてください。`;
}

/**
 * 出力の形。
 *
 * **すべて required にする。** 任意項目にすると、小さいモデルは埋めずに落とす
 * （この作品で繰り返し起きた）。中身が無いときは null を返させ、コード側で扱う。
 *
 * 項目名が snake_case なのは、小さいモデルが書き写しやすいためである。
 * `StoryFact`（camelCase）への読み替えは `core/storyFactValidation.ts` が1か所で行う。
 *
 * ## 変更履歴（スキーマだけ。プロンプト文は `STORY_FACT_EXTRACT_VERSION`）
 * - 2026-09-11: 初版
 */
export const STORY_FACT_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      maxItems: MAX_FACTS,
      items: {
        type: "object",
        properties: {
          line_start: { type: "number" },
          line_end: { type: "number" },
          subject: { type: "string" },
          predicate: { type: "string" },
          value: { type: "string" },
          // 選べる語は models 側の一覧をそのまま使う（写しを作らない）
          kind: { type: "string", enum: FACT_KINDS },
          // 相対時期は文字列で受け、読み取りは `core/relativeTime.ts` が行う。
          // { day, part } の形で返させると、小さいモデルが入れ子を崩す
          story_time: { type: ["string", "null"] },
          modality: { type: "string", enum: FACT_MODALITIES },
          pov: { type: ["string", "null"] },
          speaker: { type: ["string", "null"] },
          topic: { type: ["string", "null"] },
        },
        required: [
          "line_start",
          "line_end",
          "subject",
          "predicate",
          "value",
          "kind",
          "story_time",
          "modality",
          "pov",
          "speaker",
          "topic",
        ],
      },
    },
  },
  required: ["facts"],
} as const;

/** 検算とテストが同じ上限を見るために出す（写しを作らない） */
export const STORY_FACT_MAX_ITEMS = MAX_FACTS;
