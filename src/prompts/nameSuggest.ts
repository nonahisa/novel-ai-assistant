import { isPlaceholderText } from "../core/placeholderText";

/**
 * P-29 響きが重ならない名前の候補（設計書6.37.2）
 *
 * 作者の指示：「響きが重ならない名前の提案（既存登場名と現実世界における
 * 文化圏ごとの系統も配慮）」。
 *
 * ## AIには候補を出させるだけ
 *
 * **衝突の判定はコードで行う**（`core/nameCollision.ts`）。プロンプトには
 * 「既存の名前と響きが近いものは避けて」と書いてあるが、**守られない前提**で
 * 組んである。この作品では「避けて」と書いた指示が守られなかった事例が
 * 何度もあり、当たる候補はコード側で理由つきに落とす。
 *
 * ## 系統を混ぜない
 *
 * 「指定なし」のときも、既存の名前から系統を1つ推定してその中だけで
 * 出させる。和風とドイツ風が混ざった10件を並べても、作者は世界観の
 * 崩れた候補を選り分けるだけになる。
 *
 * プロンプトを変更したら version を上げること。
 */
export const NAME_SUGGEST_VERSION = "1.0";

/** 一度に出させる候補の数。多すぎると系統が混ざり、少ないと選べない */
export const NAME_SUGGEST_COUNT = 10;

/**
 * 選べる系統（設計書6.37.2）。
 *
 * 「指定なし」は選択肢の側の話なのでここには入れない——**AIには必ず
 * 1つの系統を名乗らせる**（推定した結果がどれなのかを作者に見せるため）。
 */
export const NAME_ORIGINS = [
  "和風",
  "英語圏",
  "ドイツ",
  "フランス",
  "北欧",
  "イタリア・スペイン",
  "スラブ",
  "中華",
  "朝鮮",
  "アラビア",
  "架空語",
] as const;

export type NameOrigin = (typeof NAME_ORIGINS)[number];

/** 材料が無い項目に入れる文字。伏せずに「無い」と書いて渡す */
export const UNSET_MATERIAL = "（未設定）";

/**
 * 指示語のなぞり。
 *
 * **プロンプトに書いた言葉は、そのまま答えとして返ってくる**（この作品で
 * 繰り返し起きた失敗3の型。`"suggestion": "空文字"`、
 * `"category": "人物|状態|時系列"`）。ここに並べた語は、プロンプトの
 * 指示文からも参照する——**同じ定数から出す**ことで、指示を書き換えたのに
 * 検査だけ古い、という食い違いを防ぐ。
 */
export const NAME_SUGGEST_HINTS = [
  "候補",
  "名前",
  "人名",
  "読み",
  "系統",
  "由来",
  "ひらがな",
  "文化圏",
  "登場人物",
] as const;

export const NAME_SUGGEST_SYSTEM_PROMPT = `あなたは日本語の小説の登場人物に、名前の候補を出すアシスタントです。

【絶対に守る原則】
1. 出すのは名前の候補だけです。作品の内容・設定・展開について論評しないこと。
2. 既に使われている名前と、その別名を候補にしないこと。
3. 指定された系統だけで出すこと。複数の文化圏を混ぜないこと。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface NameSuggestPromptInput {
  workTitle: string;
  /** いまの名前 */
  currentName: string;
  /** 性別・役割・所属。読み取れないものは空文字でよい */
  gender: string;
  role: string;
  affiliation: string;
  /**
   * 既存の全名前と読み。**避けるべき響きの一覧**として渡す。
   * 「名前（よみ）」の形に整えたものを受け取る
   */
  existingNames: string[];
  /** 作品の世界観・舞台（`plot.md` の該当の節）。無ければ空文字 */
  setting: string;
  /**
   * 希望の系統。`undefined` なら「指定なし」——既存の名前から
   * 1つ推定させる（混ぜさせない）
   */
  origin?: NameOrigin;
}

export function buildNameSuggestPrompt(input: NameSuggestPromptInput): string {
  const originInstruction = input.origin
    ? `【系統】\n${input.origin}\nこの系統だけで出してください。他の文化圏の名前を混ぜないこと。`
    : `【系統】\n指定なし。既にある名前の並びから、この作品が拠って立つ系統を` +
      `${NAME_ORIGINS.join("・")}のいずれか1つと見立て、` +
      `その1つだけで出してください。複数を混ぜないこと。\n` +
      `見立てた系統を、各候補の origin に書いてください。`;

  return `次の小説の登場人物に、付け直す名前の候補を${NAME_SUGGEST_COUNT}件出してください。

【作品タイトル】
${input.workTitle}

【付け直す人物】
いまの名前：${input.currentName}
性別：${value(input.gender)}
役割：${value(input.role)}
所属：${value(input.affiliation)}

【世界観・舞台】
${value(input.setting)}

${originInstruction}

【既に使われている名前】（この響きと重なるものは出さないこと）
${input.existingNames.length > 0 ? input.existingNames.join("\n") : UNSET_MATERIAL}

【守ること】
- 上に挙げた名前と、読んだときの響きが近いものを出さないこと。
  同じ読み、片方がもう片方の先頭になるもの（ミナとミナモト）、
  頭2音が同じで音数も近いもの（アリアとアリサ）は、読者が取り違えます。
- reading はひらがなだけで書いてください。カタカナ・漢字を混ぜないこと。
- origin には見立てた系統の名前を書いてください。
- note には、その名前の由来か、響きの印象を20字以内で1つだけ書いてください。
- ${NAME_SUGGEST_COUNT}件すべて違う名前にしてください。同じ名前を並べないこと。
- ${NAME_SUGGEST_HINTS.map((hint) => `「${hint}」`).join(
    "・"
  )}のような、この指示文に出てくる語を
  そのまま答えに書かないこと。書くのは実際に使える名前だけです。`;
}

function value(text: string): string {
  return text.trim() || UNSET_MATERIAL;
}

/**
 * 構造化出力のスキーマ。
 *
 * **すべて required にする。** 任意にすると、地力の足りないモデルは
 * 埋めずに落とす（この作品では抽出・推敲・逸脱のすべてで踏んだ）。
 */
export const NAME_SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          reading: { type: "string" },
          origin: { type: "string", enum: NAME_ORIGINS },
          note: { type: "string" },
        },
        required: ["name", "reading", "origin", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

export interface NameCandidate {
  name: string;
  /** ひらがなの読み。読み取れなければ空文字 */
  reading: string;
  origin: string;
  /** 由来・響きの一言。読み取れなければ空文字 */
  note: string;
}

/**
 * 応答から候補を読み取る。
 *
 * **指示語のなぞりは名前として採らない。** 「候補」「名前」という語が
 * `name` に入って返ることがあり、そのまま並べると押せてしまう。
 * 同じ名前が2度来たときは先に来たほうを残す（後勝ちにすると再現しない）。
 */
export function parseNameSuggest(text: string): NameCandidate[] {
  const source = extractJson(text);
  if (!source) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) return [];

  const seen = new Set<string>();
  const candidates: NameCandidate[] = [];
  for (const entry of parsed.candidates) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || isRejectedName(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    candidates.push({
      name,
      reading: cleanText(entry.reading),
      origin: cleanText(entry.origin),
      note: cleanText(entry.note),
    });
  }
  return candidates;
}

/**
 * その文字列は、名前ではなく指示のなぞりか。
 *
 * `isPlaceholderText`（「なし」「空文字」など）に加えて、このプロンプトが
 * 使っている語そのものを弾く。**判定は完全一致で行う**——「アリア」の
 * ような名前に「名」の字が入っていても、それは名前である。
 */
export function isRejectedName(name: string): boolean {
  if (isPlaceholderText(name, true)) return true;
  return (NAME_SUGGEST_HINTS as readonly string[]).includes(name.trim());
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  const body = value.trim().replace(/\s+/g, " ");
  if (!body) return "";
  return isPlaceholderText(body, true) ? "" : body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 応答からJSONの本体を切り出す。
 *
 * 構造化出力に対応していないモデルは、前置きやコードフェンスを付けてくる
 * （`openingCheck.ts` と同じ手）。
 */
function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return body.slice(start, end + 1);
}
