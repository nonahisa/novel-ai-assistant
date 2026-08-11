/**
 * P-07 各話あらすじ生成＋サブタイトル提案
 *
 * 1話ぶんの本文から、あらすじ（150字以内）と、
 * ファイル名が初期状態のときだけサブタイトル案（15字以内・3案）を作る。
 *
 * **あらすじは「何が起きたか」だけを書かせる。** 面白さの評価や
 * 盛り上げの語を入れさせない。作品紹介文（P-06）の材料になるほか、
 * 後の矛盾検知・プロット逸脱検知でも文脈として使うため、
 * 事実だけが入っている必要がある。
 *
 * プロンプトを変更したら version を上げること。
 * 生成済みのあらすじはこの版と本文のハッシュで作り直しを判断する。
 */
export const SYNOPSIS_VERSION = "1.0";

/** あらすじの上限。コード側でも切り詰める */
export const SYNOPSIS_MAX_CHARS = 150;
/** サブタイトルの上限。ファイル名になるので厳守する */
export const SUBTITLE_MAX_CHARS = 15;

export const SYNOPSIS_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文に書かれていない出来事を書かないこと。推測で補わないこと。
2. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを提案しない。
3. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
4. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。`;

export interface SynopsisPromptInput {
  /** 「第7話」など。本文の位置を示すだけで、値の判断には使わせない */
  chapterLabel: string;
  chapterText: string;
  /** 前話までのあらすじ。文脈把握用（多すぎると本文が入らないので絞る） */
  previousSynopses: string[];
  /** この話に出ている人物名。表記を揃えるために渡す */
  characterNames: string[];
  /** サブタイトル案も出させるか。ファイル名が初期状態のときだけ true */
  needsSubtitle: boolean;
}

export function buildSynopsisPrompt(input: SynopsisPromptInput): string {
  const previous =
    input.previousSynopses.length > 0
      ? input.previousSynopses.join("\n")
      : "（まだありません）";
  const characters =
    input.characterNames.length > 0
      ? input.characterNames.join("、")
      : "（まだ登録されていません）";

  const subtitleSection = input.needsSubtitle
    ? `
【サブタイトル案】
このファイルのファイル名は話数のみです。サブタイトルを3案提案してください。
- 各案**${SUBTITLE_MAX_CHARS}字以内**。超えたものは出力しないこと
- この話の内容を象徴する言葉を選ぶこと
- 次を読みたくなる引きがあるとよいが、**この話より先の内容に触れないこと**
- 3案は方向性を変えること
  案1：出来事を示す型（この話で何が起きたか）
  案2：象徴的な語句型（この話を表す物・場所・言葉）
  案3：台詞・心情型（印象に残る一言や心の動き）
- 案ごとに「なぜこの案か」を30字以内で添えること
`
    : `
【サブタイトル案】
このファイルには既にサブタイトルが付いています。subtitles は空配列にしてください。
`;

  return `以下は小説の${input.chapterLabel}です。あらすじを作成してください。

【本文】
${input.chapterText}

【前話までのあらすじ】（文脈の把握にのみ使う。ここから出来事を持ち込まないこと）
${previous}

【登場人物】（表記を揃えるために使う）
${characters}

【あらすじの方針】
- **${SYNOPSIS_MAX_CHARS}字以内**。この話で何が起きたかを、起きた順に書くこと。
- **評価や感想を入れないこと。** 「感動的な」「衝撃の」「圧巻の」は書かない。
- 本文に書かれていない出来事を書かないこと。次の話の予想も書かないこと。
- 人物は【登場人物】にある表記で書くこと。
${subtitleSection}
【出力形式】
指定されたJSON形式のみを出力してください。`;
}

/** 応答の形。文字数はコード側で数え直すので、AIには申告させない */
export const SYNOPSIS_SCHEMA = {
  type: "object",
  properties: {
    synopsis: { type: "string" },
    subtitles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: {
            type: "string",
            enum: ["出来事型", "象徴型", "台詞・心情型"],
          },
          reason: { type: ["string", "null"] },
        },
        required: ["text", "kind", "reason"],
        additionalProperties: false,
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["synopsis", "subtitles", "confidence"],
  additionalProperties: false,
} as const;

export interface SubtitleSuggestion {
  text: string;
  kind: string;
  reason: string | null;
}

export interface SynopsisResult {
  synopsis: string;
  subtitles: SubtitleSuggestion[];
  confidence: string;
}
