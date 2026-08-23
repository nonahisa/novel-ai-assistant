/**
 * P-12 矛盾検知（チャンク単位）。
 *
 * **既に生成済みの設定を「正」として突き合わせる**のが方針だが、
 * **設定側が古い・誤っていることがある。** 抽出はAIがやっており、
 * 作者が直していない項目も多い。したがって、
 *
 * - **指摘は断定形にしない。** 「設定ではこう、本文ではこう」と並べるだけにする
 * - **解決の道を2つ出す**（本文を直す／設定を直す）。本文修正だけを提示しない
 * - **自動では何も直さない。** 誤字脱字と違い、どちらが正しいかは作者にしか決められない
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
// 1.2: あとの話で明かされることを、前の話の矛盾にしない（6.10.3）
// 1.3: あとで判明する事実と両立しない記述を、逆向きに探す（6.10.4）
export const CONTRADICTION_CHECK_VERSION = "1.3";

export const CONTRADICTION_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説の設定矛盾だけを検出する編集アシスタントです。

【絶対に守る原則】
1. **確信が持てないものは指摘しないこと。** 見逃しよりも誤検出の方が作者の作業を妨げる。
2. **作中で意図的に描かれた変化を矛盾と呼ばないこと。** 成長による口調の変化、
   秘密が明かされること、関係の変化に伴う呼び方の変化は矛盾ではない。
3. **未回収の伏線は矛盾ではない。**
4. **設定側が古い可能性を常に残すこと。** 断定せず、「設定ではこうなっている」
   「本文ではこうなっている」を並べるだけにする。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

/** 検証する観点。lightなモデルでは上から3つに絞る（プロンプト設計書1.3） */
export const CONTRADICTION_CATEGORIES = [
  "人物",
  "呼称",
  "状態",
  "場所",
  "世界法則",
  "時系列",
  "既出情報",
] as const;

export type ContradictionCategory = (typeof CONTRADICTION_CATEGORIES)[number];

/** 小さいモデルへ渡す観点。負荷を下げて検出漏れを減らす */
export const LIGHT_CATEGORIES: readonly ContradictionCategory[] = [
  "人物",
  "状態",
  "時系列",
];

const CHECK_ITEMS: Record<ContradictionCategory, string> = {
  人物: "一人称、口調、性格、外見、能力が設定と食い違わないか",
  呼称:
    "ある人物が別の人物を呼ぶ呼び方が、確立された呼称と食い違わないか。" +
    "ただし喧嘩・他人行儀になる場面・第三者の目がある場面など、" +
    "意図的に呼び方を変える演出は矛盾ではない",
  状態:
    "既に死亡・離脱した人物が登場していないか、負傷や状態変化が引き継がれているか",
  場所: "地理関係、移動距離と所要時間、場所の描写が設定と一致するか",
  世界法則: "魔法や技術の制約・代償が、確立されたルールを破っていないか",
  時系列: "季節、時刻、経過日数、人物の年齢が矛盾していないか",
  既出情報: "以前の話で描かれた事実と食い違う記述がないか",
};

export interface ContradictionCheckInput {
  /** その話の見出し（「第3話」「投稿2026-08-16」） */
  chapterLabel: string;
  /** 行番号付きの本文 */
  chunkTextWithLineNumbers: string;
  /** 本文に出てくる人物の設定だけ */
  characterDetails: string;
  /** 本文に出てくる場所の設定だけ */
  locationDetails: string;
  /** 世界観のまとめ */
  worldviewSummary: string;
  /** これまでの経緯（前の話のあらすじ） */
  previousSynopses: string;
  /** 見る観点。小さいモデルでは絞る */
  categories: readonly ContradictionCategory[];
  /**
   * **あとで判明する事実**（設計書6.10.4）。空なら従来どおりの突き合わせ。
   *
   * 入っているときは向きが変わる——「この本文は、あとで分かることと
   * **両立するか**」を見る。
   */
  futureFacts?: string;
}

/**
 * あとで判明する事実との突き合わせ（設計書6.10.4）。
 *
 * **向きが逆である。** ふだんは「確立された設定と食い違うか」を見るが、
 * ここでは「**あとで分かることと両立しない記述があるか**」を見る。
 *
 * **いちばん間違えやすいのがここ**なので、してはいけないことを先に書く。
 * 「まだ知らない」を矛盾と言い出すと、この機能を入れた意味が無くなる。
 */
function futureSection(input: ContradictionCheckInput): string {
  const facts = input.futureFacts?.trim();
  if (!facts) return "";

  return `
【あとの話で判明する事実】（${input.chapterLabel} より後で明かされます）
${facts}

【この項目についての判断】
上の事実と、対象本文が**両立するか**だけを見てください。

- **触れていないのは矛盾ではありません。** この時点の登場人物や語り手が
  まだ知らないことは、書かれていなくて当然です。
- **矛盾になるのは、両方が同時に成り立たないときだけです。**
  例：あとの話で「3ヶ月前に退学した」と分かるのに、対象本文（その後の時期）に
  「今日も学校で授業を受けた」と地の文で書かれている——これは両立しません。
- **人物の発言は、嘘・思い違い・知らないことがありえます。**
  地の文（語り手の記述）と食い違う場合だけを矛盾として挙げ、
  発言の食い違いは confidence を low にして note に「発言者が知らない／
  偽っている可能性」と書いてください。
- 迷ったら挙げないこと。**ここでの誤検出は、作者の手を最も煩わせます。**
`;
}

export function buildContradictionCheckPrompt(
  input: ContradictionCheckInput
): string {
  const items = input.categories
    .map((category, index) => `${index + 1}. ${category}：${CHECK_ITEMS[category]}`)
    .join("\n");

  return `以下の小説本文が、確立された設定と矛盾していないか検証してください。

【対象本文】（${input.chapterLabel}）
${input.chunkTextWithLineNumbers}

【登場人物設定】（本文に登場する人物のみ）
${orNone(input.characterDetails)}

【場所設定】（本文に登場する場所のみ）
${orNone(input.locationDetails)}

【世界観設定】
${orNone(input.worldviewSummary)}

【これまでの経緯】（時系列の整合性確認用）
${orNone(input.previousSynopses)}
${futureSection(input)}

【検証項目】
${items}

【判断の注意】
- 作中で意図的に描かれた変化（成長による口調の変化、設定の秘密が明かされる等）を
  矛盾と誤認しないこと。判断がつかない場合は confidence を low とし、
  「意図的な変化の可能性」を note に記載すること。
- 未回収の伏線は矛盾ではありません。
- **設定側が誤っている可能性も考慮し、指摘は断定形にしないこと。**
- 上に設定が示されていない事柄については、何も指摘しないこと。
  照らし合わせる相手が無いものは矛盾とは言えません。
- **いま見ているのは ${input.chapterLabel} です。** ここから先の話で
  明かされることを、この話の矛盾として挙げないこと。
  「この時点ではまだ分かっていないはずのこと」は矛盾ではありません。
  読者がこの話まで読んだ時点で知っている事柄だけを突き合わせてください。
- **人物の身の上が先へ進むのは、矛盾ではありません**（在学→退学、
  無職→就職、生存→死亡など）。あとの話の状態を、前の話へ当てはめないこと。

【出力形式】JSONのみ
category には次のどれか**1つだけ**を入れてください：${input.categories.join("、")}

{
  "contradictions": [
    {
      "line": 42,
      "excerpt": "該当箇所の引用（本文からそのまま写す。40字以内）",
      "category": "${input.categories[0]}",
      "settingSays": "設定ではどうなっているか",
      "textSays": "本文ではどうなっているか",
      "note": "補足（意図的な変化の可能性など）。無ければ空文字",
      "severity": "high|medium|low",
      "confidence": "high|medium|low"
    }
  ]
}`;
}

/**
 * 出力の形。
 *
 * **すべて required にする。** 任意項目にすると、小さいモデルは
 * 埋めずに落とす（この作品で繰り返し起きた）。
 * 中身が無いときは空文字を返させ、コード側で扱う。
 */
export const CONTRADICTION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    contradictions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "number" },
          excerpt: { type: "string" },
          category: { type: "string" },
          settingSays: { type: "string" },
          textSays: { type: "string" },
          note: { type: "string" },
          severity: { type: "string" },
          confidence: { type: "string" },
        },
        required: [
          "line",
          "excerpt",
          "category",
          "settingSays",
          "textSays",
          "note",
          "severity",
          "confidence",
        ],
      },
    },
  },
  required: ["contradictions"],
} as const;

function orNone(value: string): string {
  const trimmed = value.trim();
  return trimmed || "（登録されていません）";
}
