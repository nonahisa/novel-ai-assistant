import type { MentionExcerpt } from "../core/mentionExcerpts";

/**
 * P-18 設定の掘り下げ / P-19 設定についての質問
 *
 * 抽出（P-04a）が「本文に書いてあることを取り出す」のに対し、
 * こちらは「本文からこう読める」を書かせる。根拠の逐語照合ができないため、
 * 結果は既存の項目へ混ぜず、承認を経て aiNotes に追記するだけにする。
 *
 * プロンプトを変更したら version を上げること。
 */
export const SETTINGS_DEEP_DIVE_VERSION = "1.0";

export const SETTINGS_ASSISTANT_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文に書かれていることと、そこからのあなたの推測を、必ず区別して書くこと。
   推測を書く場合は「〜と読める」「〜の可能性がある」のように、推測だと分かる書き方をすること。
2. 本文に根拠がないことを、事実であるかのように断定しないこと。
3. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを提案しない。
4. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
5. 与えられた本文の抜粋に答えがない場合は、無理に埋めず「本文からは分かりません」と答えること。
   分からないことを分からないと言うほうが、作者の役に立ちます。`;

/** 掘り下げの対象。人物・能力・場所で共通に扱う */
export interface DeepDiveTarget {
  /** 「登場人物」「能力」「場所」など、種別の表示名 */
  kindLabel: string;
  name: string;
  /** 現在の設定内容を人が読める形にしたもの */
  currentSettings: string;
}

export interface DeepDiveInput {
  workTitle: string;
  target: DeepDiveTarget;
  /** 作者が指定した観点。空なら全体的に掘り下げる */
  topic: string;
  excerpts: MentionExcerpt[];
}

/** 観点を指定しなかった場合の既定 */
export const DEFAULT_DEEP_DIVE_TOPIC =
  "この設定について、本文から読み取れることを掘り下げる";

export function buildDeepDivePrompt(input: DeepDiveInput): string {
  const topic = input.topic.trim() || DEFAULT_DEEP_DIVE_TOPIC;

  return `小説「${input.workTitle}」の${input.target.kindLabel}「${
    input.target.name
  }」について掘り下げてください。

【現在の設定】
${input.target.currentSettings}

【本文の抜粋】（この${input.target.kindLabel}が登場する場面）
${formatExcerpts(input.excerpts)}

【掘り下げる観点】
${topic}

【書き方】
- 400字程度の日本語の文章で書いてください。箇条書きでも構いません。
- 本文から読み取れることを中心に書き、根拠になる場面を「（第12話）」のように示してください。
- 現在の設定にすでに書かれていることの言い換えは書かないでください。
  作者が知らないこと、気づいていないことを書いてください。
- 本文の抜粋に根拠が乏しい場合は、そのことを正直に書いてください。
  抜粋が足りないなら「本文の抜粋からは分かりません」とだけ答えて構いません。
- 前置き・後書き・見出しは不要です。本文だけを書いてください。`;
}

export interface SettingsChatInput {
  workTitle: string;
  target: DeepDiveTarget;
  question: string;
  excerpts: MentionExcerpt[];
  /** これまでのやり取り。古いものから順に */
  history: ChatTurn[];
}

export interface ChatTurn {
  role: "author" | "assistant";
  text: string;
}

export function buildSettingsChatPrompt(input: SettingsChatInput): string {
  const history =
    input.history.length > 0
      ? `\n【これまでのやり取り】\n${input.history
          .map(
            (turn) =>
              `${turn.role === "author" ? "作者" : "あなた"}: ${turn.text}`
          )
          .join("\n\n")}\n`
      : "";

  return `小説「${input.workTitle}」の${input.target.kindLabel}「${
    input.target.name
  }」について、作者の質問に答えてください。

【現在の設定】
${input.target.currentSettings}

【本文の抜粋】（この${input.target.kindLabel}が登場する場面）
${formatExcerpts(input.excerpts)}
${history}
【作者の質問】
${input.question}

【答え方】
- 日本語で、簡潔に答えてください。長くても400字程度にしてください。
- 本文に書かれていることと、あなたの推測を区別してください。
- 根拠になる場面があれば「（第12話）」のように示してください。
- 抜粋に答えが無ければ「本文の抜粋からは分かりません」と答えてください。
  作者は自分の作品を知っています。当てずっぽうは邪魔にしかなりません。`;
}

/**
 * 抜粋を出典付きで並べる。
 * どの話の場面なのかが分からないと、作者が答えを検証できない。
 */
function formatExcerpts(excerpts: MentionExcerpt[]): string {
  if (excerpts.length === 0) {
    return "（本文中に該当する場面が見つかりませんでした）";
  }
  return excerpts
    .map((excerpt) => `--- ${excerpt.label} ---\n${excerpt.text}`)
    .join("\n\n");
}
