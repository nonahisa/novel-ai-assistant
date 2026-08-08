import type { MentionExcerpt } from "../core/mentionExcerpts";
import type { SettingsKind } from "../core/settingsSummary";
import type { DeepDiveTarget } from "./settingsDeepDive";

/**
 * P-20 設定項目の充実
 *
 * 掘り下げ（P-18）が「文章のメモを書く」のに対し、こちらは
 * **設定資料の各項目に入れる値そのもの**を提案させる。
 *
 * 提案は自動では反映しない。項目ごとに現在の値と並べて見せ、
 * 作者が選んだものだけを書き込む。
 *
 * プロンプトを変更したら version を上げること。
 */
export const SETTINGS_ENRICH_VERSION = "1.0";

export interface EnrichableField {
  key: string;
  label: string;
  /** AIへ何を書くべきか伝える説明 */
  hint: string;
  /** 文字数の上限。コード側でも切り詰める */
  maxChars?: number;
  /** 長文になる項目か。画面の入力欄の高さに使う */
  multiline?: boolean;
}

/** 種別ごとに、AIへ提案させる項目 */
export const ENRICHABLE_FIELDS: Record<SettingsKind, EnrichableField[]> = {
  character: [
    {
      key: "summary",
      label: "紹介",
      hint: "その人物が何者かが一目で分かる紹介。役割と立場が分かれば十分",
      maxChars: 50,
    },
    {
      key: "affiliation",
      label: "所属",
      hint: "所属する組織・部署。本文の表記のまま。組織に属さないなら null",
    },
    {
      key: "role",
      label: "役割",
      hint: "肩書き・職業・立場",
    },
    {
      key: "personality",
      label: "性格",
      hint:
        "言動から分かる性質。地の文の評価だけでなく、発言の調子・態度・" +
        "他人への接し方も根拠になる。複数の面があれば併記する",
      multiline: true,
    },
    {
      key: "appearance",
      label: "外見",
      hint: "髪・目・背丈・服装・持ち物など、外見に関する記述をまとめる",
      multiline: true,
    },
  ],
  ability: [
    { key: "summary", label: "紹介", hint: "どんな能力かが一目で分かる説明", maxChars: 50 },
    { key: "category", label: "分類", hint: "作品側の分類語をそのまま使う" },
    {
      key: "description",
      label: "説明",
      hint: "何ができるのか。効果と使い方",
      multiline: true,
    },
    { key: "cost", label: "代償", hint: "発動に必要な代償", multiline: true },
    { key: "limitation", label: "制約", hint: "使えない条件", multiline: true },
  ],
  location: [
    { key: "summary", label: "紹介", hint: "どんな場所かが一目で分かる説明", maxChars: 50 },
    { key: "region", label: "地域", hint: "上位の地域・都市。読み取れないなら null" },
    {
      key: "description",
      label: "説明",
      hint: "どんな場所か。役割・雰囲気・特徴",
      multiline: true,
    },
  ],
};

/** その種別のJSONスキーマ。全項目を必須にして、面倒な項目を落とさせない */
export function buildEnrichSchema(kind: SettingsKind): object {
  const fields = ENRICHABLE_FIELDS[kind];
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    properties[field.key] = field.maxChars
      ? { type: ["string", "null"], maxLength: field.maxChars }
      : { type: ["string", "null"] };
  }
  return {
    type: "object",
    properties,
    required: fields.map((field) => field.key),
  };
}

export interface EnrichInput {
  workTitle: string;
  kind: SettingsKind;
  target: DeepDiveTarget;
  excerpts: MentionExcerpt[];
}

export function buildEnrichPrompt(input: EnrichInput): string {
  const fields = ENRICHABLE_FIELDS[input.kind];

  return `小説「${input.workTitle}」の${input.target.kindLabel}「${
    input.target.name
  }」について、設定資料の各項目に入れる内容を提案してください。

【現在の設定】
${input.target.currentSettings}

【本文の抜粋】（この${input.target.kindLabel}が登場する場面）
${formatExcerpts(input.excerpts)}

【提案する項目】
${fields
  .map(
    (field) =>
      `- ${field.key}（${field.label}）: ${field.hint}` +
      (field.maxChars ? `。**${field.maxChars}字以内**` : "")
  )
  .join("\n")}

【書き方】
- **本文の抜粋から読み取れることだけ**を書いてください。
  読み取れない項目は null にしてください。推測で埋めないでください。
- 現在の設定に値がある項目も、本文からより詳しく書ける場合は提案してください。
  作者が現在の値と見比べて選ぶので、遠慮せず具体的に書いてください。
- 「〜だろう」「〜と思われる」と書きたくなる内容は null にしてください。
  それは事実ではなく解釈です。
- 各項目は設定資料に載る文章です。「〜が読み取れる」のような
  分析口調ではなく、「冷静沈着で現実主義」のように設定として書いてください。
- 前置き・後書きは不要です。指定されたJSON形式のみを出力してください。`;
}

function formatExcerpts(excerpts: MentionExcerpt[]): string {
  if (excerpts.length === 0) {
    return "（本文中に該当する場面が見つかりませんでした）";
  }
  return excerpts
    .map((excerpt) => `--- ${excerpt.label} ---\n${excerpt.text}`)
    .join("\n\n");
}
