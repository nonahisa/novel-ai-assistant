/**
 * P-06 作品紹介文生成／P-08 キャッチコピー3案提案
 *
 * どちらも**読者に見せる文章**を作る。設定資料の抽出（P-04a）とは
 * 性質が違い、正解が1つに定まらない。だから**自動では書き込まない。**
 * 案として見せ、作者が選んだものだけを `設定/synopsis.md` へ入れる。
 *
 * プロンプトを変更したら version を上げること。
 */
export const BLURB_VERSION = "1.0";

/** 作品紹介文の目安。投稿サイトの入力欄に収まる長さ */
export const BLURB_MIN_CHARS = 300;
export const BLURB_MAX_CHARS = 400;
/** キャッチコピーの上限。コード側でも数え直す */
export const CATCHPHRASE_MAX_CHARS = 30;
/** キャッチコピーの案の数 */
export const CATCHPHRASE_COUNT = 3;

export const BLURB_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文・プロット・あらすじに書かれていないことを書かないこと。
2. 作者の文体・作品の雰囲気を尊重すること。あなたの好みで書き換えを提案しない。
3. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
4. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。`;

export interface BlurbPromptInput {
  workTitle: string;
  /** プロット（`設定/plot.md`）。無ければ空 */
  plot: string;
  /** 冒頭数話の本文 */
  openingExcerpt: string;
  /** 各話あらすじ。多いので前半だけ渡す */
  chapterSynopses: string[];
}

export function buildBlurbPrompt(input: BlurbPromptInput): string {
  return `以下の情報をもとに、小説投稿サイトに掲載する作品紹介文を作成してください。

【作品タイトル】
${input.workTitle}

【プロット】
${input.plot.trim() || "（まだ書かれていません）"}

【冒頭部分の本文】
${input.openingExcerpt}

【各話のあらすじ】
${input.chapterSynopses.length > 0 ? input.chapterSynopses.join("\n") : "（まだありません）"}

【作成方針】
- 長さは${BLURB_MIN_CHARS}〜${BLURB_MAX_CHARS}字。
- 読者が「続きを読みたい」と感じることを最優先とする。
- **物語の核心的なネタバレ（結末、重要な正体、どんでん返し）は書かないこと。**
  ただし冒頭〜序盤で明かされる情報は使ってよい。
- あらすじの羅列にしないこと。作品の魅力（何が面白いか）が伝わる構成にする。
- 作者の文体・作品の雰囲気に合わせること。
  シリアスな作品に軽薄な煽り文句を付けない。
- 「感動必至！」「衝撃のラスト！」のような、**中身の無い煽り文句を使わない**。

【出力形式】
指定されたJSON形式のみを出力してください。
spoilerCheck には、ネタバレを避けるために意図的に伏せた要素を書いてください。
作者がその判断を確かめられるようにするためのものです。`;
}

export const BLURB_SCHEMA = {
  type: "object",
  properties: {
    blurb: { type: "string" },
    spoilerCheck: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["blurb", "spoilerCheck", "confidence"],
  additionalProperties: false,
} as const;

export interface BlurbResult {
  blurb: string;
  spoilerCheck: string | null;
  confidence: string;
}

export interface CatchphrasePromptInput {
  workTitle: string;
  plot: string;
  /** 作品紹介文。まだ無ければ空 */
  blurb: string;
  openingExcerpt: string;
  /** 前に出して採用されなかった案。同じものを出させないために渡す */
  rejected: string[];
}

export function buildCatchphrasePrompt(input: CatchphrasePromptInput): string {
  return `以下の小説について、読者が読みたくなるキャッチコピーを${CATCHPHRASE_COUNT}案提案してください。

【作品タイトル】
${input.workTitle}

【プロット】
${input.plot.trim() || "（まだ書かれていません）"}

【作品紹介文】
${input.blurb.trim() || "（まだありません）"}

【冒頭部分の本文】
${input.openingExcerpt}

【前に出したが採用されなかった案】（重複を避けるために使う）
${input.rejected.length > 0 ? input.rejected.join("\n") : "（まだありません）"}

【提案の条件】
- 各案**${CATCHPHRASE_MAX_CHARS}字以内**。
- ${CATCHPHRASE_COUNT}案はそれぞれ方向性を変えること。
  案1：謎・引き型（読者に問いを投げかける、状況の異常さを示す）
  案2：感情・関係性型（人物の想い、関係の切実さを前面に出す）
  案3：世界観・スケール型（設定の魅力、物語の大きさを示す）
- **作品の実際の内容と離れないこと。** 誇大な表現で釣らない。
- 作品の雰囲気（文体、深刻さ）に合った言葉を選ぶこと。
- 前に出して採用されなかった案と、実質的に同じものを出さないこと。
- 案ごとに「なぜ読者の興味を引くか」を40字以内で書くこと。

【出力形式】
指定されたJSON形式のみを出力してください。`;
}

export const CATCHPHRASE_SCHEMA = {
  type: "object",
  properties: {
    catchphrases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: {
            type: "string",
            enum: ["謎・引き型", "感情・関係性型", "世界観・スケール型"],
          },
          intent: { type: ["string", "null"] },
        },
        required: ["text", "kind", "intent"],
        additionalProperties: false,
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["catchphrases", "confidence"],
  additionalProperties: false,
} as const;

export interface CatchphraseCandidate {
  text: string;
  kind: string;
  intent: string | null;
}

export interface CatchphraseResult {
  catchphrases: CatchphraseCandidate[];
  confidence: string;
}
