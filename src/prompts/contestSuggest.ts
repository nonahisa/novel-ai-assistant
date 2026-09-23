import { CONTEST_SUGGEST_LIMITS } from "../core/contestSuggestValidation";
import { workProfileText, type WorkProfile } from "../core/contestMatchText";

/**
 * P-42 応募先の提案（設計書6.3.6.5）
 *
 * 作者の依頼（2026-09-23）：完成予定から選び出した公募の候補の中から、
 * 作品のジャンル・形式・ログライン・あらすじ・種類と、公募の募集作品の
 * 説明の合い方で、AIに応募先を並べて理由を添えさせる。**隠し機能**
 * （詳細メニューには出さず、コマンドパレットと相談からだけ）。
 *
 * ## 何をさせて、何をさせないか
 *
 * - **選ぶのは候補の中からだけ。番号で答えさせる。** 締切と字数で間に合う・
 *   合うものは、先にコードが選り分けてある（`core/contestForecast.ts`）。
 *   AIに締切や字数を判断させると、読めた数を読み違いで上書きする。名前で
 *   答えさせると書き写しの揺れで照合を外すので、番号（C1…）にする
 * - **理由は、渡した文に書かれていることからだけ。** 賞の傾向・選考の好み・
 *   受賞のしやすさは材料に無い——推し量らせると、もっともらしい作り話になる
 * - **作品の良し悪しを言わせない。** 頼まれているのは宛先であって値踏みではない
 * - 合うものが無ければ空の配列を返させる（無理に埋めさせない）
 *
 * 検算は `core/contestSuggestValidation.ts`（候補に実在するか・指示の言葉の返り・
 * 重複・上限・字数）。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-42）
 * - 1.0: 初版（0.82.1）。実データでは未確認
 */
export const CONTEST_SUGGEST_VERSION = "1.0";

/** 温度。合い方を読むだけなので、揺らす理由が薄い（理由の言い回しにだけ幅を残す） */
export const CONTEST_SUGGEST_TEMPERATURE = 0.3;

export const CONTEST_SUGGEST_SYSTEM_PROMPT = `あなたは、小説の公募（新人賞・コンテスト）の募集内容と、ある作品の概要を読み比べて、その作品の応募先に合う公募を選ぶ係です。

【絶対に守る原則】
1. 選ぶのは、渡された候補の中からだけです。候補の番号（C1 のような形）で答えてください。候補に無い公募を挙げないこと。
2. 合う理由は、作品の概要と、その公募の募集内容の両方に書かれていることだけから書くこと。賞の傾向、選考の好み、受賞のしやすさなど、渡された文に無いことを推し量って書かないこと。
3. 作品の良し悪しを評価しないこと。あなたが答えるのは宛先だけです。
4. 締切と字数は、別の仕組みがすでに確かめてあります。あなたは募集内容と作品の中身の合い方だけを見てください。
5. 合う候補が無ければ、suggestions を空の配列にしてください。無理に選ばないこと。
6. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

export interface ContestSuggestCandidate {
  /** 候補の番号（C1, C2…） */
  readonly id: string;
  readonly name: string;
  /** これからの締切（YYYY-MM-DD） */
  readonly deadline: string;
  /** 字数の読み（「20,000〜40,000字」「字数の制限なし」など） */
  readonly chars: string;
  /** 募集内容の文（`contestMatchText`） */
  readonly text: string;
}

export interface ContestSuggestPromptInput {
  readonly profile: WorkProfile;
  readonly candidates: readonly ContestSuggestCandidate[];
}

export function buildContestSuggestPrompt(input: ContestSuggestPromptInput): string {
  const candidates = input.candidates
    .map((candidate) =>
      [
        `[${candidate.id}] ${candidate.name}`,
        `締切 ${candidate.deadline}／${candidate.chars}`,
        // 1行目は名前なので重ねない
        ...candidate.text.split("\n").slice(1),
      ].join("\n")
    )
    .join("\n\n");

  return `# 作品の概要

タイトル：${input.profile.title}
${workProfileText(input.profile)}

# 候補の公募（${input.candidates.length}件）

${candidates}

# お願い

候補の中から、この作品の応募先として募集内容に合うものを、合う順に最大${CONTEST_SUGGEST_LIMITS.suggestions}件選んでください。
それぞれに、作品のどこと募集内容のどこが合うのかを、${CONTEST_SUGGEST_LIMITS.reason}字以内の1文で書いてください。`;
}

/**
 * 答えの形。**すべて required**（任意にすると、地力の足りないモデルは埋めずに落とす）。
 */
export const CONTEST_SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
      },
    },
  },
  required: ["suggestions"],
} as const;
