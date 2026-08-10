import { SUMMARY_MAX_CHARS } from "../core/summaryLimit";

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
export const CHARACTER_EXTRACT_VERSION = "2.9";

export const BASE_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文に書かれていない情報を推測で補って断定しないこと。根拠が本文にない場合は
   該当フィールドを null または空配列とし、confidence を low とすること。
   ただし人物の personality（性格）だけは例外とし、本文中の言動からの推論を認める。
   小説では性格が明記されることは少なく、行動と台詞で示されるためである。
   その場合も、根拠となる振る舞いを必ず本文から取り、値の中に書き添えること。
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
  /** 既知の組織名。同一組織の判定に使う */
  knownOrganizationNames?: string[];
  /** 既知の世界観の見出し。同じ内容を繰り返し出させないために使う */
  knownWorldNames?: string[];
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
  const knownOrganizations =
    input.knownOrganizationNames && input.knownOrganizationNames.length > 0
      ? input.knownOrganizationNames.join("、")
      : "（まだ登録されていません）";
  const knownWorld =
    input.knownWorldNames && input.knownWorldNames.length > 0
      ? input.knownWorldNames.join("、")
      : "（まだ登録されていません）";
  const abilityTermNote = input.abilityTerm
    ? `この作品では能力を「${input.abilityTerm}」と総称します。abilitySystem.abilityTerm には同じ語を使ってください。`
    : `abilitySystem.abilityTerm には、**作品世界の中で能力を総称している語**を、本文の表記のまま入れてください。
   これは作品のジャンル名ではありません。「ファンタジー」「伝奇」「SF」「現代」などのジャンル名は入れないでください。
   良い例：本文に「神術」「仙術」とあれば "神術"。「魔法」なら "魔法"。「スキル」なら "スキル"。
   本文にそのような総称が見当たらない場合は null にしてください。無理に埋めないでください。`;

  return `以下の小説本文から、登場人物・能力・組織・場所の情報を抽出してください。

【本文】（${input.chapterLabel}）
${input.chunkText}

【既知の登場人物】（同一人物の判定に使用）
${known}

【既知の能力】（同一能力の判定に使用）
${knownAbilities}

【既知の組織】（同一組織の判定に使用）
${knownOrganizations}

【既知の場所】（同一場所の判定に使用）
${knownLocations}

【既知の世界観】（同じ内容を繰り返さないために使用）
${knownWorld}

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
- summary には、その人物が何者かが一目で分かる紹介を**${SUMMARY_MAX_CHARS}字以内**で書くこと。
  一覧で名前の下に並べる短い説明なので、役割と立場が分かれば十分である。
  例：「冒険者ギルドの生活保護課ケースワーカー。転移者で制度の考案者。」
  ${SUMMARY_MAX_CHARS}字を超える場合は削ること。詳しい内容は role / personality / appearance に分けて書く。
- gender（性別）は、**本文から確認できる場合だけ**書くこと。根拠になるのは
  地の文の「彼」「彼女」、性別を示す語（少年・少女・男・女・父・母など）、
  本人や他人による明言である。
  ・男性なら **"男性"**、女性なら **"女性"** と書くこと。本文が「男」「少年」
    「若者」のどう書いていても、この2語のどちらかに揃えること。
  ・男性・女性のどちらでもない場合だけ、本文の記載に合わせて書くこと
    （例：「性別を持たない」「両性」）。
  ・**名前の響きから推測してはならない。** 造語の名前は判断できないのが普通である。
  ・一人称（「俺」「僕」「私」）だけを根拠にしてはならない。作品によって使い分けは異なる。
  ・根拠が無ければ null にすること。空欄のほうが、誤った断定より害が少ない。
- affiliation には所属する組織・部署を、本文の表記のまま入れること。
  例：「生活保護課」「窓口課」「衛兵隊」。組織に属さない人物は null とすること。
  職業や身分（「冒険者」「平民」）は所属ではないので role に書くこと。
- role・personality・appearance は必ず出力すること（読み取れなければ null）。
  本文に手掛かりがある場合は必ず埋めること。以下はすべて手掛かりである。
  ・role：肩書き・職業・立場（「王女」「近衛騎士」「ギルド職員」）
  ・appearance：髪・目・背丈・服装・持ち物など、外見に関する記述

- **personality だけは、本文の言動からの推論を認める。**
  小説では性格は「地の文で説明される」より「行動と台詞で示される」ほうが普通で、
  明記だけを採ると、この項目はほぼ常に空欄になる。
  ・**必ず「どう振る舞ったか」を添えること。** 性質だけを書いてはならない。
    良い例：「命令口調で指示を出し、部下の反論を最後まで聞かない」
    良い例：「危険と分かっている場面へ真っ先に飛び込む」
    悪い例：「傲慢」「勇敢」（何を根拠にそう言えるのか分からない）
  ・根拠にしてよいのは**本文にある振る舞い**だけである。
    発言の調子、他人への接し方、選んだ行動、繰り返し出る癖。
  ・**次のものから推論してはならない。**
    名前の響き／性別／作品のジャンル／似た型の他作品の人物。
  ・複数の面が見えるなら併記すること。1つにまとめないこと。

- personality 以外の項目は、本文に手掛かりが無ければ推測で埋めてはならない。
  「〜だろう」「〜と思われる」と書きたくなる内容は null にすること。

- **「記述なし」「不明」のような文言を値として書いてはならない。**
  読み取れないときは必ず null にすること。
  そう書かれると、設定資料に「性格: （本文から読み取れる記述なし）」と
  そのまま載ってしまう（実データで発生した）。
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

【組織の抽出ルール】
組織とは、人物が所属する集まりのことです。
国家・ギルド・部署・軍・商会・学校・一族などが該当します。
1. 本文で名指しされた組織だけを抽出すること。組織を創作しないこと。
2. 人物の affiliation に入れた組織名は、ここにも組織として出すこと。
   所属だけ書かれていて組織の説明が無い場合は、description を null にして
   名前だけ出せばよい。
3. 上位の組織が本文から読み取れる場合は parent に入れること
   （例：「冒険者ギルドの生活保護課」→ name: "生活保護課", parent: "冒険者ギルド"）。
   読み取れない場合は null とすること。
4. category には作品側の言い方をそのまま入れること
   （「ギルド」「王国」「部署」「商会」「一族」など）。読み取れなければ null。
5. 「彼ら」「あいつら」のような指示語や、その場限りの集まり
   （「野次馬」「通行人たち」）は組織ではないので出さないこと。
6. 場所と組織は分けること。「冒険者ギルド」は組織だが、
   「冒険者ギルドの受付」は場所である。建物そのものを指すなら場所へ、
   人の集まりを指すなら組織へ入れる。両方に出してよい。

【場所の抽出ルール】
1. 物語の舞台となる、または名指しで言及された場所だけを抽出すること。
2. 「そこ」「あの街」のような指示語は抽出しないこと。固有の名前か、
   「冒険者ギルドの窓口」のように本文中で一貫して特定の場所を指す表現だけを対象とする。
3. 上位の地域が本文から読み取れる場合は region に入れること
   （例：「王都リヴェルスの図書塔」→ name: "図書塔", region: "王都リヴェルス"）。
   読み取れない場合は null とすること。
4. 説明は本文から読み取れる範囲だけを書くこと。

【世界観の抽出ルール】（P-03）
世界観とは「**その世界がどうなっているか**」です。
**物語の出来事そのもの（誰が何をしたか）は入れません。**
1. category は次のいずれかにすること。
   ・genre：ジャンル的特徴（現代／異世界／SF／歴史 など、判断の根拠になる記述）
   ・era：時代背景（年代、文明水準、技術水準）
   ・rule：世界の法則（能力の仕組み、その制約や代償）
   ・society：社会構造（国家、身分制度、経済、通貨）
   ・culture：文化・風習（宗教、言語、暦、儀礼）
   ・geography：地理（大陸、気候、地形の特徴）
   ・term：固有の用語・造語とその意味
2. name には**何についての項目か**が分かる短い見出しを付けること（15字以内）。
   例：「詠唱の制約」「冒険者の身分」「通貨の単位」
   本文をそのまま写さないこと。中身は description に書く。
3. description に中身を書くこと。本文から読み取れる範囲に限る。
4. **1話かぎりの出来事は入れないこと。** 「第3話で城が燃えた」は出来事であり、
   世界観ではない。「城は木造で燃えやすい」なら世界観である。
5. 【既知の世界観】に挙がっている内容は出さないこと。
   同じ事柄に本文で新しい情報が加わった場合だけ、同じ見出しで出すこと。
6. evidence には、その項目の根拠になる本文の一節を**そのまま**入れること。
   世界観の見出しは本文に出てこない言葉なので、**引用に見出しを含める必要はない**。

【すべてに共通のルール】
- reading（読み仮名）は、**名前に漢字が含まれる場合だけ**ひらがなで書くこと。
  カタカナだけ・ひらがなだけの名前は null にしてよい（こちらで機械的に作るため）。
  漢字の読みは本文のルビや文脈から判断し、分からなければ最も一般的な読みでよい。
  例：「月島灯」→ "つきしまあかり"、「白瀬澪」→ "しらせみお"
- summary は**${SUMMARY_MAX_CHARS}字以内**の短い紹介にすること。人物・能力・場所のいずれも同じ。
  一覧で名前の下に並べるための1行なので、詳細は他の項目に分けて書く。
- 各レコードには、本文からそのまま抜き出した短い evidence を必ず付けること。
  evidence は説明や要約ではなく、その名称を含む逐語引用にすること。
  （世界観だけは例外で、見出しを含まない引用でよい。上の世界観の規則を参照）
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
          summary: { type: ["string", "null"], maxLength: SUMMARY_MAX_CHARS },
          gender: { type: ["string", "null"] },
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
          "gender",
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
          summary: { type: ["string", "null"], maxLength: SUMMARY_MAX_CHARS },
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
    organizations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          reading: { type: ["string", "null"] },
          summary: { type: ["string", "null"], maxLength: SUMMARY_MAX_CHARS },
          parent: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
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
          summary: { type: ["string", "null"], maxLength: SUMMARY_MAX_CHARS },
          region: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          evidence: { type: "string", minLength: 1 },
        },
        required: ["name", "summary", "description", "evidence"],
      },
    },
    worldview: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 20 },
          category: {
            type: "string",
            enum: [
              "genre",
              "era",
              "rule",
              "society",
              "culture",
              "geography",
              "term",
            ],
          },
          description: { type: ["string", "null"] },
          evidence: { type: "string", minLength: 1 },
        },
        required: ["name", "category", "description", "evidence"],
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
  // 空配列・nullで「該当なし」と明示させるため、4種類とも必須にする。
  required: [
    "characters",
    "abilities",
    "organizations",
    "locations",
    "worldview",
    "abilitySystem",
  ],
} as const;

/** AIから返る抽出結果 */
export interface ExtractedCharacter {
  name: string;
  aliases?: string[];
  entityType?: "person" | "group" | "location" | "unknown";
  isMob?: boolean;
  reading?: string | null;
  summary?: string | null;
  /** 男性／女性は2語に統一される。それ以外は本文の記載に合わせた自由記述 */
  gender?: string | null;
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

/** AIから返る組織。人物の affiliation に対応する */
export interface ExtractedOrganization {
  name: string;
  aliases?: string[];
  reading?: string | null;
  summary?: string | null;
  /** 上位の組織（「冒険者ギルド」等） */
  parent?: string | null;
  /** 種別（「ギルド」「王国」「部署」等）。作品側の言い方に従う */
  category?: string | null;
  description?: string | null;
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

/**
 * AIから返る世界観（P-03）。
 *
 * name は本文の語ではなく、こちらが付けさせる短い見出しである
 * （「詠唱の制約」）。そのため**名前が本文に実在するかは確かめられない**。
 * 照合できるのは evidence の逐語一致だけになる。
 */
export interface ExtractedWorldItem {
  name: string;
  category?: string | null;
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
  organizations?: ExtractedOrganization[];
  locations?: ExtractedLocation[];
  worldview?: ExtractedWorldItem[];
  abilitySystem?: ExtractedAbilitySystem;
  confidence?: string;
}
