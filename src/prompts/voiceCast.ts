import {
  VOICE_EMOTIONS,
  VOICE_INTENSITIES,
} from "../core/voiceEngine";
import { CAST_UNKNOWN_SPEAKER, type CastChunk, type CastPerson } from "../core/voiceCast";

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
 * ## 話者が書いてある台詞は、話者を考えさせない（版1.2。案 A）
 *
 * 地の文に「と灯は言った」と書いてある台詞は、コードが先に話者を決める
 * （`core/voiceCast.ts` の `castSpeakersFromText`）。その番号は「話者を考える番号」から
 * 外し、気持ちと強さだけを答えさせる。**番号のあとに名前は書かない**——気持ちを
 * 決めるのに名前は要らず、書くと隣の台詞にもその名前を写す（引きずる）おそれがある。
 * スキーマは変えない（決まった番号の speaker の欄は、検算が見ずにコードの値で置き換える）。
 *
 * ## 訊き方を2段に分ける（版1.3。案 B）
 *
 * 製品は、1回で全部を訊かず、**1段目で話者だけ、2段目で感情と強さだけ**を訊く
 * （`voiceCastStageRequests`）。小さいモデル（e4b）は、話者と感情を一度に考えさせると
 * 話者を「不明」に倒しやすかったため（2026-11-05 の測定の見逃し）。段ごとに、もう一方の
 * 欄は頼み方にもスキーマにも出さない。
 *
 * - 1段目：人物の一覧と、区切りの前後の本文（参考。番号なし）を渡す。本文に話者が
 *   書いてあった番号は「答えません」と伝えて訊かない（名前は添えない）。訊く番号が
 *   無い区切りは1段目を呼ばない
 * - 2段目：本文だけを渡す。**1段目の話者も、人物の一覧も添えない**——感情は台詞と地の文から
 *   読め、添えると2段目の控えが1段目の答えと人物の一覧に縛られ、人物を1人足すたびに
 *   感情まで訊き直すことになる（処理量。実装ルール4）。1段目の取り違えが感情へ移る道も無くなる
 * - 1段目が全部「不明」でも2段目は飛ばさない（感情は話者が不明でも声に効く）
 *
 * ## 前の区切りの話者の流れを添える（版1.4。案 C）
 *
 * 1段目には、すぐ前の区切りまでに決まった話者の**名前だけ**を、直前の
 * `VOICE_CAST_FLOW_MAX` 件まで古い順に添える（`【前の区切りの話者の流れ】`）。
 * 区切りの頭の台詞は、前の区切りで誰と誰が話していたかが分からないと決めにくい。
 * 流れを組むのはコード（`core/voiceCast.ts` の `castFlowNames`）。
 *
 * 1つ外すと続けて外す（前の取り違えが次の区切りへ移る）のを抑えるため：
 * - **確かではない参考**と書き、この区切りの話者は本文から決めるよう頼む。【答え方】にも
 *   「流れに合わせて当てはめない」を置く（交互に話しているはず、と当てはめさせない）
 * - 決まらなかった台詞は抜かずに「不明」と書く（抜くと実際より交互に見える）。
 *   全部「不明」なら節を出さない
 * - 台詞の本文は添えない（名前の列だけ。前の区切りの字は「前の本文」の節がすでに運ぶ）
 * - 2段目（感情）には添えない
 *
 * 1回で訊く頼み方（`buildVoiceCastPrompt`）は版1.2の文のまま残す。測る台本が
 * 2段と比べるために使う（`VC_STAGES=one`）。製品からは呼ばない。
 *
 * プロンプトを変更したら version を上げること。
 */
export const VOICE_CAST_VERSION = "1.4";

/**
 * 1段目に添える、前の区切りの話者の流れの件数（版1.4。案 C）。直前の数件だけにする——
 * 古い所まで渡すと、場面が変わったのに前の顔ぶれを引きずる。
 */
export const VOICE_CAST_FLOW_MAX = 5;

/**
 * 製品で1段目に前の区切りの話者の流れを添えるか（案 C。版1.4）。**既定は切る**（0.142.2）。
 *
 * 2026-11-08 の測定（`test/live/voiceCastAcrossWorks.test.ts`、VC_STAGES=two）で、流れを
 * 添えると取り違えか見逃しが増えた：e4b は迷って「不明」へ倒れ、同じ区切りで続けて外した。
 * 26b でも取り違えが1件増えた（設計書6.42.3・プロンプト設計書 P-54）。
 *
 * 切ったときの1段目の頼みと控えの鍵は、流れが無い区切りと同じ形（版1.3 の頼みと同じ文）。
 * 流れを組むコード（`castFlowNames` など）と頼みの節は、測る台本の VC_FLOW=on で測り直せる
 * ように残してある。
 */
export const VOICE_CAST_FLOW_ENABLED = false;

/**
 * 1段目に添える、区切りの前後の本文の字数（版1.3）。区切りの頭の台詞は、前の区切りに
 * 書いてある場面の顔ぶれが分からないと話者を決められない。後ろは「と灯は言った」が
 * 次の行へ続く書き方のぶん。
 */
export const VOICE_CAST_CONTEXT_BEFORE_CHARS = 600;
export const VOICE_CAST_CONTEXT_AFTER_CHARS = 300;

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
  /** 本文に話者が書いてあり、コードで決めた台詞の番号（区切りの中の番号。版1.2） */
  decided?: readonly number[];
}

/** 番号を〔1〕〔3〕の形に並べる */
function numberList(numbers: readonly number[]): string {
  return numbers.map((n) => `〔${n}〕`).join("");
}

/** 話者の決まった台詞を伝える節（無ければ空） */
function decidedSection(count: number, decided: readonly number[]): string {
  const fixed = [...new Set(decided)].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  if (fixed.length === 0) return "";
  const held = new Set(fixed);
  const ask: number[] = [];
  for (let n = 1; n <= count; n++) if (!held.has(n)) ask.push(n);
  return [
    "",
    `次の番号は、本文に話し手が書いてあるので話者が決まっています。気持ちと強さだけを答えてください：${numberList(fixed)}`,
    "（これらの speaker には、本文に書いてある話し手の名前を写します）",
    ask.length > 0 ? `話者を考えるのは${numberList(ask)}です。` : "話者を考える台詞はありません。",
    "",
  ].join("\n");
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
${decidedSection(input.count, input.decided ?? [])}
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

/*
  ── 版1.3：2段で訊く（案 B） ──
*/

/** 段の名前（控えの鍵・ログ・測る台本で使う） */
export type VoiceCastStage = "speaker" | "emotion";

/** 1段目の役。気持ちは決めさせない（考えさせると1回で訊くのと同じになる） */
export const VOICE_CAST_SPEAKER_SYSTEM_PROMPT = `あなたは、日本語の小説を朗読劇として読み上げる前に、台詞ごとの話し手を決める演出家です。
本文の台詞の頭には〔番号〕が付いています。番号ごとに、誰が言ったかだけを答えます。

出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
マークダウンのコードフェンスを一切含めないこと。`;

/** 2段目の役。話し手は決めさせない */
export const VOICE_CAST_EMOTION_SYSTEM_PROMPT = `あなたは、日本語の小説を朗読劇として読み上げる前に、台詞ごとの気持ちを決める演出家です。
本文の台詞の頭には〔番号〕が付いています。番号ごとに、どんな気持ちで言ったかだけを答えます。

出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
マークダウンのコードフェンスを一切含めないこと。`;

export interface VoiceCastSpeakerInput extends VoiceCastInput {
  /** 区切りの前の本文（参考。番号なし。空なら節を出さない） */
  before?: string;
  /** 区切りのあとの本文（参考。番号なし。空なら節を出さない） */
  after?: string;
  /**
   * 前の区切りの話者の流れ（名前の列。古い順。版1.4）。空・無しなら節を出さない。
   * 件数を切るのも「不明」を書くのも組む側（`castFlowNames`）の仕事
   */
  flow?: readonly string[];
}

/** 前の区切りの話者の流れの節（無ければ空） */
function flowSection(flow: readonly string[] | undefined): string {
  if (!flow || flow.length === 0) return "";
  return [
    "",
    "【前の区切りの話者の流れ】（参考。確かではありません）",
    `この区切りのすぐ前までの台詞の話者を、古い順に並べました（右端が〔1〕の直前の台詞）：${flow.join(" → ")}`,
    "これは前の区切りまでの推定で、間違っていることがあります。この区切りの話者は本文から決めてください。",
    "",
  ].join("\n");
}

/** 1段目で訊く番号（本文に話者が書いてあった番号を除く） */
function askedNumbers(count: number, decided: readonly number[]): number[] {
  const held = new Set(decided);
  const ask: number[] = [];
  for (let n = 1; n <= count; n++) if (!held.has(n)) ask.push(n);
  return ask;
}

/** 参考の本文の節（無ければ空） */
function contextSection(title: string, body: string | undefined): string {
  const text = body?.trim() ?? "";
  return text === "" ? "" : `\n【${title}】（参考。答える台詞はありません）\n${text}\n`;
}

/**
 * 1段目：話者だけを訊く。**本文に話者が書いてあった番号は訊かない**（名前は添えない——
 * 添えると隣の台詞へその名前を写すおそれがある。版1.2 と同じ考え方）。
 */
export function buildVoiceCastSpeakerPrompt(input: VoiceCastSpeakerInput): string {
  const people =
    input.people.length > 0
      ? input.people.map(voiceCastPersonLine).join("\n")
      : "（登場人物の資料はありません）";
  const fixed = [...new Set(input.decided ?? [])]
    .filter((n) => n >= 1 && n <= input.count)
    .sort((a, b) => a - b);
  const ask = askedNumbers(input.count, fixed);
  const which =
    fixed.length > 0
      ? `\n${numberList(fixed)}は、本文に話し手が書いてあるので答えません。答えるのは${numberList(ask)}だけです。\n`
      : "";
  return `次の本文には台詞が${input.count}個あり、それぞれの頭に〔1〕〜〔${input.count}〕の番号が付いています。
番号ごとに、その台詞を言った人物（話者）だけを答えてください。気持ちは答えません。
${which}
【登場人物】
${people}
${flowSection(input.flow)}${contextSection("この区切りの前の本文", input.before)}
【本文】
${input.text}
${contextSection("この区切りのあとの本文", input.after)}
【答え方】
- number：台詞の番号。**${fixed.length > 0 ? numberList(ask) : `1〜${input.count}`}のすべてに答えます**
- speaker：その台詞を言った人物の名前。上の【登場人物】の名前か別名を、書かれているとおりに写します。
  分からないときは「${CAST_UNKNOWN_SPEAKER}」にします。推測で一覧の誰かに当てはめないでください
  **【登場人物】にいない人物の台詞は、必ず「${CAST_UNKNOWN_SPEAKER}」にします。** 名前の無い兵士・師匠・取調官・店員など、役名や呼び名だけで呼ばれる人物も、一覧にいない人物です。
  その台詞を、会話の相手や直前に話した人物に当ててはいけません（一覧の誰かが答えているとは限りません）
  前後の本文は、場面にいる人物を知るための参考です。誰が話しているかは、その台詞の前後の地の文と会話の流れで決めます
${
  input.flow && input.flow.length > 0
    ? "  前の区切りの話者の流れも参考です。流れに合わせて交互に当てはめないでください。本文から決められなければ「" +
      CAST_UNKNOWN_SPEAKER +
      "」にします\n"
    : ""
}
【出力形式】JSONのみ
{
  "lines": [
    { "number": 1, "speaker": "${VOICE_CAST_EXAMPLE_NAME}" }
  ]
}`;
}

/** 1段目のスキーマ。話者は人物の名前・別名と「不明」の列挙で縛る（1回で訊くときと同じ列挙） */
export function buildVoiceCastSpeakerSchema(people: readonly CastPerson[]): object {
  const full = buildVoiceCastSchema(people) as {
    properties: { lines: { items: { properties: { speaker: object } } } };
  };
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer" },
            speaker: full.properties.lines.items.properties.speaker,
          },
          required: ["number", "speaker"],
        },
      },
    },
    required: ["lines"],
  };
}

/** 2段目：感情と強さだけを訊く。人物の一覧も話者も渡さない（理由は冒頭の注釈） */
export function buildVoiceCastEmotionPrompt(input: { text: string; count: number }): string {
  return `次の本文には台詞が${input.count}個あり、それぞれの頭に〔1〕〜〔${input.count}〕の番号が付いています。
番号ごとに、台詞の気持ちと強さだけを答えてください。誰が言ったかは答えません。

【本文】
${input.text}

【答え方】
- number：台詞の番号（1〜${input.count}）。**すべての番号に答えます**
- emotion：台詞の気持ち。次のどれか1つ：${VOICE_EMOTIONS.join("、")}
  とくに気持ちが出ていない台詞は「平静」です。小声・内緒話は「ささやき」、大声で叫ぶ台詞は「叫び」です
- intensity：気持ちの強さ。次のどれか1つ：${VOICE_INTENSITIES.join("、")}

【出力形式】JSONのみ
{
  "lines": [
    { "number": 1, "emotion": "喜び", "intensity": "中" }
  ]
}`;
}

/** 2段目のスキーマ。感情と強さを列挙で縛る */
export function buildVoiceCastEmotionSchema(): object {
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer" },
            emotion: { type: "string", enum: [...VOICE_EMOTIONS] },
            intensity: { type: "string", enum: [...VOICE_INTENSITIES] },
          },
          required: ["number", "emotion", "intensity"],
        },
      },
    },
    required: ["lines"],
  };
}

/** 1段の頼み（AIへ渡す形） */
export interface VoiceCastStageRequest {
  stage: VoiceCastStage;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: object;
}

/**
 * 1区切りの2段の頼みを作る（製品も測る台本もここを通る）。
 * **全部の番号の話者が本文で決まった区切りは、1段目を作らない**（訊く番号が無い）。
 *
 * `options.flow` は前の区切りの話者の流れ（版1.4）。前の区切りの答えで決まるので
 * `CastChunk` には持たせず、区切りを順に訊く側が組んで渡す。渡さなければ版1.3 と同じ頼み
 * （測る台本の `VC_FLOW=off`）。
 */
export function voiceCastStageRequests(
  chunk: Pick<CastChunk, "text" | "dialogues" | "decided" | "before" | "after">,
  people: readonly CastPerson[],
  options?: { flow?: readonly string[] }
): { speaker?: VoiceCastStageRequest; emotion: VoiceCastStageRequest } {
  const count = chunk.dialogues.length;
  const decided = [...chunk.decided.keys()];
  const emotion: VoiceCastStageRequest = {
    stage: "emotion",
    systemPrompt: VOICE_CAST_EMOTION_SYSTEM_PROMPT,
    userPrompt: buildVoiceCastEmotionPrompt({ text: chunk.text, count }),
    jsonSchema: buildVoiceCastEmotionSchema(),
  };
  if (askedNumbers(count, decided).length === 0) return { emotion };
  return {
    speaker: {
      stage: "speaker",
      systemPrompt: VOICE_CAST_SPEAKER_SYSTEM_PROMPT,
      userPrompt: buildVoiceCastSpeakerPrompt({
        text: chunk.text,
        count,
        people,
        decided,
        before: chunk.before,
        after: chunk.after,
        flow: options?.flow,
      }),
      jsonSchema: buildVoiceCastSpeakerSchema(people),
    },
    emotion,
  };
}
