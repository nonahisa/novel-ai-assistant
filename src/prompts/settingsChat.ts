import type { MentionExcerpt } from "../core/mentionExcerpts";

/**
 * P-18 設定についての相談
 *
 * 抽出（P-04a）が「本文に書いてあることを取り出す」のに対し、
 * こちらは「本文からこう読める」を文章で書かせる。
 * 根拠の逐語照合ができないため、結果は既存の項目へ混ぜず、
 * 承認を経て aiNotes に追記するだけにする。
 *
 * 以前は「掘り下げ（観点を指定して書かせる）」と「質問（聞いて答えさせる）」を
 * 別々の機能にしていたが、**入力が観点か質問かが違うだけで中身は同じ**だった。
 * 画面も処理も1つにまとめてある。
 *
 * プロンプトを変更したら version を上げること。
 */
export const SETTINGS_CHAT_VERSION = "3.0";

export const SETTINGS_ASSISTANT_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文に書かれていることと、そこからのあなたの推測を、必ず区別して書くこと。
   推測を書く場合は「〜と読める」「〜の可能性がある」のように、推測だと分かる書き方をすること。
2. 本文に根拠がないことを、事実であるかのように断定しないこと。
3. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを提案しない。
4. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
5. **出来事・数値・固有名詞のような「本文を見れば決まること」**は、抜粋に無ければ
   「本文の抜粋からは見当たりません」と答えること。当てずっぽうは邪魔になります。
6. **人物の捉え方・関係の読み・書けていない側面のような「考えるための問い」は、
   分からないと突き放さないこと。** 原則1のとおり推測だと分かるように書いたうえで、
   読み取れることを述べてください。作者が求めているのは正解ではなく、考える手掛かりです。`;

/** 相談の対象。人物・能力・場所で共通に扱う */
export interface SettingsTarget {
  /** 「登場人物」「能力」「場所」など、種別の表示名 */
  kindLabel: string;
  name: string;
  /** 現在の設定内容を人が読める形にしたもの */
  currentSettings: string;
}

export interface ChatTurn {
  role: "author" | "assistant";
  text: string;
}

export interface SettingsChatInput {
  workTitle: string;
  target: SettingsTarget;
  /** 作者が入力した質問、または掘り下げたい観点 */
  question: string;
  excerpts: MentionExcerpt[];
  /** これまでのやり取り。古いものから順に */
  history: ChatTurn[];
}

/** 入力が空のときに使う。全体的に掘り下げさせる */
export const DEFAULT_CHAT_TOPIC =
  "この設定について、本文から読み取れることを掘り下げてください。";

export function buildSettingsChatPrompt(input: SettingsChatInput): string {
  const question = input.question.trim() || DEFAULT_CHAT_TOPIC;
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
  }」について、作者の求めに応じてください。

【現在の設定】
${input.target.currentSettings}

【本文の抜粋】（この${input.target.kindLabel}が登場する場面）
${formatExcerpts(input.excerpts)}
${history}
【作者の入力】
${question}

【答え方】
- 日本語で答えてください。長くても400字程度にしてください。
- 質問なら答え、観点だけが書かれていればその観点で掘り下げてください。
- 本文に書かれていることと、あなたの推測を区別してください。
- 根拠になる場面があれば「（第12話）」のように示してください。
- 現在の設定にすでに書かれていることの言い換えは書かないでください。
  作者が知らないこと、気づいていないことを書いてください。
- **事実を聞かれていて**抜粋に無ければ「本文の抜粋からは見当たりません」と答えてください。
  作者は自分の作品を知っています。当てずっぽうは邪魔にしかなりません。
- **読み方や捉え方を聞かれているときは、突き放さないでください。**
  推測だと分かるように書いたうえで、読み取れることを述べてください。
- 前置き・後書きは不要です。`;
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
