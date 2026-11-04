import {
  VOICE_EMOTIONS,
  VOICE_INTENSITIES,
} from "../core/voiceEngine";
import { CAST_UNKNOWN_SPEAKER, type CastPerson } from "../core/voiceCast";

/**
 * P-54 朗読の台詞の話者と感情（設計書6.42.3）。
 *
 * ## 何をさせるか
 *
 * 人物の声で朗読するとき、台詞ごとに「誰が言ったか」と「どんな気持ちで
 * 言ったか」が要る。本文の台詞の頭に〔番号〕を差し込んで送り、番号ごとに
 * 話者（資料の人物の名前のどれか、または「不明」）・感情（固定の列挙）・
 * 強さ（弱・中・強）を返させる。
 *
 * ## 閉じた選択肢にする
 *
 * 話者・感情・強さは**スキーマの列挙で縛る**（P-53 と同じ考え方）。自由に
 * 書かせると「少年」「やや怒り気味」が返り、声へ落とせない。列挙で縛っても
 * 崩れた答えは来るので、検算はコードが行う（`core/voiceCast.ts` の
 * `validateCastItems`）。
 *
 * ## 指示語はそのまま返ってくる前提で書く
 *
 * 話者の欄に「話者」「人物名」が入って返ることを、検算が捨てて数える
 * （CLAUDE.md 失敗3番）。見本の名前は本文に出ない語にする。
 *
 * プロンプトを変更したら version を上げること。
 */
export const VOICE_CAST_VERSION = "1.1";

/**
 * 1回に送る本文の上限（字）。読みの辞書（P-50）と同じ大きさにする——小さいモデルは
 * 長い区切りの後半の台詞を落とす。話者を決めるには前後の地の文が要るので、
 * これより細かくはしない。
 */
export const VOICE_CAST_CHUNK_CHARS = 2000;

/** 送る人物の上限。多いと小さいモデルが一覧の後ろを見なくなる */
export const VOICE_CAST_MAX_PEOPLE = 40;

/** 見本の名前（本文に出ない語。見本がそのまま返っても資料に無いので捨てられる） */
export const VOICE_CAST_EXAMPLE_NAME = "霞野まどか";

export const VOICE_CAST_SYSTEM_PROMPT = `あなたは、日本語の小説を朗読劇として読み上げる前に、台詞ごとの話し手と気持ちを決める演出家です。
本文の台詞の頭には〔番号〕が付いています。番号ごとに、誰が言ったかと、どんな気持ちで言ったかを答えます。

出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
マークダウンのコードフェンスを一切含めないこと。`;

export interface VoiceCastInput {
  /** 〔番号〕を差し込んだ本文（1区切り） */
  text: string;
  /** この区切りの台詞の数 */
  count: number;
  /** 資料の人物 */
  people: readonly CastPerson[];
}

/** 人物の一覧の1行（名前・別名・口調） */
export function voiceCastPersonLine(person: CastPerson): string {
  const parts = [`- ${person.name}`];
  if (person.aliases.length > 0) parts.push(`（別名：${person.aliases.join("、")}）`);
  if (person.speechStyle && person.speechStyle.trim() !== "") {
    parts.push(` 口調：${person.speechStyle.trim().replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return parts.join("");
}

export function buildVoiceCastPrompt(input: VoiceCastInput): string {
  const people =
    input.people.length > 0
      ? input.people.map(voiceCastPersonLine).join("\n")
      : "（登場人物の資料はありません）";
  return `次の本文には台詞が${input.count}個あり、それぞれの頭に〔1〕〜〔${input.count}〕の番号が付いています。
番号ごとに、話者・感情・強さを答えてください。

【登場人物】
${people}

【本文】
${input.text}

【答え方】
- number：台詞の番号（1〜${input.count}）。**すべての番号に答えます**
- speaker：その台詞を言った人物の名前。上の【登場人物】の名前か別名を、書かれているとおりに写します。
  分からないときは「${CAST_UNKNOWN_SPEAKER}」にします。推測で一覧の誰かに当てはめないでください
  **【登場人物】にいない人物の台詞は、必ず「${CAST_UNKNOWN_SPEAKER}」にします。** 名前の無い兵士・師匠・取調官・店員など、役名や呼び名だけで呼ばれる人物も、一覧にいない人物です。
  その台詞を、会話の相手や直前に話した人物に当ててはいけません（一覧の誰かが答えているとは限りません）
- emotion：台詞の気持ち。次のどれか1つ：${VOICE_EMOTIONS.join("、")}
  とくに気持ちが出ていない台詞は「平静」です。小声・内緒話は「ささやき」、大声で叫ぶ台詞は「叫び」です
- intensity：気持ちの強さ。次のどれか1つ：${VOICE_INTENSITIES.join("、")}

【出力形式】JSONのみ
{
  "lines": [
    { "number": 1, "speaker": "${VOICE_CAST_EXAMPLE_NAME}", "emotion": "喜び", "intensity": "中" }
  ]
}`;
}

/**
 * 出力の形。話者は**人物の名前・別名と「不明」の列挙**で縛る（区切りごとに作る）。
 * 項目の欄はすべて required にする（任意にすると小さいモデルは埋めずに落とす）。
 */
export function buildVoiceCastSchema(people: readonly CastPerson[]): object {
  const names = new Set<string>([CAST_UNKNOWN_SPEAKER]);
  for (const person of people) {
    for (const name of [person.name, ...person.aliases]) {
      if (name.trim() !== "") names.add(name.trim());
    }
  }
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer" },
            speaker: { type: "string", enum: [...names] },
            emotion: { type: "string", enum: [...VOICE_EMOTIONS] },
            intensity: { type: "string", enum: [...VOICE_INTENSITIES] },
          },
          required: ["number", "speaker", "emotion", "intensity"],
        },
      },
    },
    required: ["lines"],
  };
}
