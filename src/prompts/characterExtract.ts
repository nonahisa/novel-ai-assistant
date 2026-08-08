/**
 * P-04a 設定抽出（チャンク単位）
 *
 * 人物・能力・場所を1回の呼び出しでまとめて抽出する。
 * 種別ごとにAIを呼ぶと同じ本文を3回読ませることになり、
 * 時間もコストも3倍かかるため、1チャンク1回に統合している。
 *
 * ファイル名と定数名が character のままなのは、
 * 既存のキャッシュキー・import・テストへの影響を抑えるためである。
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
export const CHARACTER_EXTRACT_VERSION = "2.4";

export const BASE_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文に書かれていない情報を推測で補って断定しないこと。根拠が本文にない場合は
   該当フィールドを null または空配列とし、confidence を low とすること。
2. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを提案しない。
3. 指摘や提案を行う際は、必ず本文中の該当箇所を特定できる情報を添えること。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
5. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
   判断に迷う場合は指摘せず、confidence を low にすること。`;

export interface CharacterExtractInput {
  chunkText: string;
  chapterLabel: string;
  knownCharacterNames: string[];
  /** 既知の能力名。同一能力の判定に使う */
  knownAbilityNames?: string[];
  /** 既知の場所名。同一場所の判定に使う */
  knownLocationNames?: string[];
  /** 既に決まっている能力の総称（「魔法」「スキル」等）。未確定なら省略 */
  abilityTerm?: string;
}

export function buildCharacterExtractPrompt(
  input: CharacterExtractInput
): string {
  const known =
    input.knownCharacterNames.length > 0
      ? input.knownCharacterNames.join("、")
      : "（まだ登録されていません）";
  const knownAbilities =
    input.knownAbilityNames && input.knownAbilityNames.length > 0
      ? input.knownAbilityNames.join("、")
      : "（まだ登録されていません）";
  const knownLocations =
    input.knownLocationNames && input.knownLocationNames.length > 0
      ? input.knownLocationNames.join("、")
      : "（まだ登録されていません）";
  const abilityTermNote = input.abilityTerm
    ? `この作品では能力を「${input.abilityTerm}」と総称します。abilitySystem.abilityTerm には同じ語を使ってください。`
    : `abilitySystem.abilityTerm には、**作品世界の中で能力を総称している語**を、本文の表記のまま入れてください。
   これは作品のジャンル名ではありません。「ファンタジー」「伝奇」「SF」「現代」などのジャンル名は入れないでください。
   良い例：本文に「神術」「仙術」とあれば "神術"。「魔法」なら "魔法"。「スキル」なら "スキル"。
   本文にそのような総称が見当たらない場合は null にしてください。無理に埋めないでください。`;

  return `以下の小説本文から、登場人物・能力・場所の情報を抽出してください。

【本文】（${input.chapterLabel}）
${input.chunkText}

【既知の登場人物】（同一人物の判定に使用）
${known}

【既知の能力】（同一能力の判定に使用）
${knownAbilities}

【既知の場所】（同一場所の判定に使用）
${knownLocations}

【登場人物の抽出ルール】
- entityType で候補を person / group / location / unknown に分類すること。characters に
  出力してよいのは entityType が person の候補だけである。group / location / unknown は
  レコードを出力しないこと。
- 一人称・二人称などの代名詞、汎用的な役職語、家族関係語、集団、場所、組織、種族、
  生物種は人物レコードを作らないこと。特定の人物名が本文から確認できない話者についても、
  仮の名前や説明的な名前を発明してレコードを作らないこと。
- 同一人物が別の呼称で登場する場合（本名／通称／あだ名／役職）、既知の登場人物と
  照合し、同一と判断できる場合は既知の名前を name とし、別呼称を aliases に入れること。
  判断できない場合は新規人物として扱うこと。
- summary には、その人物が何者かが一目で分かる紹介を**50字以内**で書くこと。
  一覧で名前の下に並べる短い説明なので、役割と立場が分かれば十分である。
  例：「冒険者ギルドの生活保護課ケースワーカー。転移者で制度の考案者。」
  50字を超える場合は削ること。詳しい内容は role / personality / appearance に分けて書く。
- affiliation には所属する組織・部署を、本文の表記のまま入れること。
  例：「生活保護課」「窓口課」「衛兵隊」。組織に属さない人物は null とすること。
  職業や身分（「冒険者」「平民」）は所属ではないので role に書くこと。
- role・personality・appearance は必ず出力すること（読み取れなければ null）。
  本文に手掛かりがある場合は必ず埋めること。以下はすべて手掛かりである。
  ・role：肩書き・職業・立場（「王女」「近衛騎士」「ギルド職員」）
  ・personality：言動から分かる性質。地の文の評価だけでなく、
    発言の調子・態度・他人への接し方も根拠になる
    （例：命令口調で話す、他人を気遣う発言が多い）
  ・appearance：髪・目・背丈・服装・持ち物など、外見に関する記述
- ただし本文に手掛かりが無い項目を、推測で埋めてはならない。
  「〜だろう」「〜と思われる」と書きたくなる内容は null にすること。
- 役職・肩書きと本名が両方本文から読み取れる場合、name には本名のみを書き、
  役職・肩書きは role に書くこと。
  例：「衛兵隊副隊長のエバン」→ name: "エバン", role: "衛兵隊副隊長"
- 各人物には、本文からそのまま抜き出した短い evidence を必ず付けること。
  evidence は説明や要約ではなく、人物名または本文上の呼称を含む逐語引用にすること。

【呼称の抽出ルール】（重要）
呼称は「誰が誰をどう呼んだか」の方向を持つ情報です。
1. 会話文・心内語の中で、ある人物が別の人物を呼んだ表現をすべて拾うこと。
   例：「白瀬さん、それは違う」→ 話者が白瀬を「白瀬さん」と呼んでいる
2. 同じ相手に複数の呼び方がある場合、すべて記録すること。
   まとめたり代表的なもの1つに絞ったりしないこと。
   例：平時は「澪」、怒った時は「白瀬」、人前では「白瀬さん」→ 3件すべて記録
3. 使い分けの条件が本文から読み取れる場合のみ context に記述する。
4. 話者が誰か特定できない発話の呼称は抽出しないこと。推測で話者を決めつけないこと。
5. 敬称・接尾辞（さん、くん、様、ちゃん、先輩、殿）は省略せず、
   本文に出てきた形のまま記録すること。
6. 「君」「お前」「あなた」など特定の相手を持たない一般的な呼びかけは
   defaultSecondPerson に入れ、addressTerms には入れないこと。

【能力の抽出ルール】
能力とは、作品世界で人物が行使する特別な力のことです。
ファンタジーなら魔法、伝奇なら超能力、現代ものなら特筆すべき技能が該当します。
1. 本文中で実際に使用された、または名指しで言及された能力だけを抽出すること。
   能力体系を創作したり、本文にない能力を補ったりしないこと。
2. 能力名は本文の表記をそのまま使うこと。ルビがあれば reading に入れること。
3. 効果・代償・制約は本文から読み取れる範囲だけを書くこと。
   読み取れないものは null とし、「おそらく」「〜だろう」と推測しないこと。
4. 誰が使ったか分かる場合は userNames に人物名を入れること。
   使い手を特定できない場合は空配列にすること。
5. 剣術・話術のような一般的な技量は、作品世界で特別な力として
   扱われている場合にのみ抽出すること。単に「腕が立つ」程度なら抽出しないこと。
6. ${abilityTermNote}

【場所の抽出ルール】
1. 物語の舞台となる、または名指しで言及された場所だけを抽出すること。
2. 「そこ」「あの街」のような指示語は抽出しないこと。固有の名前か、
   「冒険者ギルドの窓口」のように本文中で一貫して特定の場所を指す表現だけを対象とする。
3. 上位の地域が本文から読み取れる場合は region に入れること
   （例：「王都リヴェルスの図書塔」→ name: "図書塔", region: "王都リヴェルス"）。
   読み取れない場合は null とすること。
4. 説明は本文から読み取れる範囲だけを書くこと。

【すべてに共通のルール】
- reading（読み仮名）は、**名前に漢字が含まれる場合だけ**ひらがなで書くこと。
  カタカナだけ・ひらがなだけの名前は null にしてよい（こちらで機械的に作るため）。
  漢字の読みは本文のルビや文脈から判断し、分からなければ最も一般的な読みでよい。
  例：「月島灯」→ "つきしまあかり"、「白瀬澪」→ "しらせみお"
- summary は**50字以内**の短い紹介にすること。人物・能力・場所のいずれも同じ。
  一覧で名前の下に並べるための1行なので、詳細は他の項目に分けて書く。
- 各レコードには、本文からそのまま抜き出した短い evidence を必ず付けること。
  evidence は説明や要約ではなく、その名称を含む逐語引用にすること。
- 該当するものが本文になければ、空配列を返すこと。無理に埋めないこと。

【出力形式】
指定されたJSON形式のみを出力してください。`;
}

/**
 * Ollamaの構造化出力に渡すJSONスキーマ。
 * これを指定すると形式が強制され、パース失敗がほぼ無くなる。
 */
export const CHARACTER_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          entityType: {
            type: "string",
            enum: ["person", "group", "location", "unknown"],
          },
          aliases: { type: "array", items: { type: "string" } },
          isMob: { type: "boolean" },
          reading: { type: ["string", "null"] },
          summary: { type: ["string", "null"], maxLength: 50 },
          affiliation: { type: ["string", "null"] },
          role: { type: ["string", "null"] },
          personality: { type: ["string", "null"] },
          appearance: { type: ["string", "null"] },
          firstPerson: { type: ["string", "null"] },
          defaultSecondPerson: { type: ["string", "null"] },
          addressTerms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                targetName: { type: "string" },
                term: { type: "string" },
                category: { type: ["string", "null"] },
                context: { type: ["string", "null"] },
                evidence: { type: ["string", "null"] },
              },
              required: ["targetName", "term"],
            },
          },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                relation: { type: "string" },
              },
              required: ["name", "relation"],
            },
          },
          evidence: { type: "string", minLength: 1 },
        },
        // role / personality / appearance を必須に入れるのは、
        // 省略可能にすると小さいモデルが黙って落とすため（実データで確認）。
        // null は許すので「読み取れなかった」と明示させる形になる。
        required: [
          "name",
          "entityType",
          "summary",
          "affiliation",
          "role",
          "personality",
          "appearance",
          "evidence",
        ],
      },
    },
    abilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          reading: { type: ["string", "null"] },
          summary: { type: ["string", "null"], maxLength: 50 },
          category: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          cost: { type: ["string", "null"] },
          limitation: { type: ["string", "null"] },
          userNames: { type: "array", items: { type: "string" } },
          evidence: { type: "string", minLength: 1 },
        },
        required: ["name", "summary", "description", "evidence"],
      },
    },
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          reading: { type: ["string", "null"] },
          summary: { type: ["string", "null"], maxLength: 50 },
          region: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          evidence: { type: "string", minLength: 1 },
        },
        required: ["name", "summary", "description", "evidence"],
      },
    },
    abilitySystem: {
      type: "object",
      properties: {
        // 「読み取れない」という答えも受け取りたいので null を許す。
        // required に入れるのは、省略されると総称が永久に埋まらないため。
        abilityTerm: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        rules: { type: "array", items: { type: "string" } },
      },
      required: ["abilityTerm"],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  // 省略可能にすると、モデルは面倒な項目を黙って落とす。
  // 空配列・nullで「該当なし」と明示させるため、3種類とも必須にする。
  required: ["characters", "abilities", "locations", "abilitySystem"],
} as const;

/** AIから返る抽出結果 */
export interface ExtractedCharacter {
  name: string;
  aliases?: string[];
  entityType?: "person" | "group" | "location" | "unknown";
  isMob?: boolean;
  reading?: string | null;
  summary?: string | null;
  affiliation?: string | null;
  role?: string | null;
  personality?: string | null;
  appearance?: string | null;
  firstPerson?: string | null;
  defaultSecondPerson?: string | null;
  addressTerms?: Array<{
    targetName: string;
    term: string;
    category?: string | null;
    context?: string | null;
    evidence?: string | null;
  }>;
  relations?: Array<{ name: string; relation: string }>;
  evidence?: string | null;
}

/** AIから返る能力 */
export interface ExtractedAbility {
  name: string;
  aliases?: string[];
  reading?: string | null;
  summary?: string | null;
  category?: string | null;
  description?: string | null;
  cost?: string | null;
  limitation?: string | null;
  /** 使い手の人物名。idの解決はコード側で行う */
  userNames?: string[];
  evidence?: string | null;
}

/** AIから返る場所 */
export interface ExtractedLocation {
  name: string;
  aliases?: string[];
  reading?: string | null;
  summary?: string | null;
  /** 上位の地域（「王都リヴェルス」等） */
  region?: string | null;
  description?: string | null;
  evidence?: string | null;
}

/** AIから返る能力体系。総称はジャンルで変わるため本文から推定させる */
export interface ExtractedAbilitySystem {
  abilityTerm?: string | null;
  description?: string | null;
  rules?: string[];
}

export interface CharacterExtractResult {
  characters: ExtractedCharacter[];
  abilities?: ExtractedAbility[];
  locations?: ExtractedLocation[];
  abilitySystem?: ExtractedAbilitySystem;
  confidence?: string;
}
