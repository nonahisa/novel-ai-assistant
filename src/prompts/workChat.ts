import type { ChatContextKind } from "../core/chatContext";

/**
 * P-21 いま開いている画面について相談する（相談パネル）
 *
 * 設定資料パネルの相談（P-18）は「1つのレコードについて」聞くものだったが、
 * こちらは**作品のどこを見ていても聞ける**。プロット・本文・設定資料・
 * あらすじのどれを開いていても、その文脈を材料に相談できる。
 *
 * **選択肢を返させるのが要点である。** 作者の要望は
 * 「出力が気に入らないときに再考や他の選択肢の検討ができること」だった。
 * 自由入力だけだと、作者が毎回どう言い直すかを考える必要がある。
 * AIに次の一手を3つほど並べさせれば、押すだけで話が進む。
 *
 * プロンプトを変更したら version を上げること。
 */
export const WORK_CHAT_VERSION = "1.0";

export const WORK_CHAT_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。
作者が今開いている画面（本文・プロット・設定資料など）について相談を受けます。

【絶対に守る原則】
1. 本文に書かれていることと、そこからのあなたの推測を、必ず区別して書くこと。
   推測は「〜と読める」「〜の可能性がある」のように、推測だと分かる書き方をすること。
2. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを勧めない。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
4. 渡された材料に答えが無いときは、無理に埋めず「渡された範囲では分かりません」と
   答えること。分からないことを分からないと言うほうが、作者の役に立ちます。
5. 作者はプロの書き手です。基礎的な説明を長々と述べないこと。

【答え方】
- reply は日本語で、300字程度までにまとめること。長い説明より、次に何ができるかを示すこと。
- options には「作者が次に選べる一手」を2〜4個入れること。
  押すだけで話が進むよう、**そのまま次の依頼文になる短い文**にすること
  （例:「もっと短くしてほしい」「別の切り口で3案出してほしい」「今の案の理由を説明してほしい」）。
- 会話を終えてよい場面では options を空配列にしてよい。
- 案を複数出すときは reply の中に並べ、options には「どれを選ぶか」ではなく
  「次にどうするか」を入れること。

【出力形式】JSONのみ。前置き・後書き・コードフェンスを含めないこと。
{"reply": "...", "options": ["...", "..."]}`;

export interface WorkChatTurn {
  role: "author" | "assistant";
  text: string;
}

export interface WorkChatInput {
  workTitle: string;
  /** いま開いている画面の種類 */
  contextKind: ChatContextKind;
  /** 画面の説明（「第7話の本文」など） */
  contextLabel: string;
  /** 開いているファイルの中身（抜粋） */
  excerpt: string;
  /** 抜粋が途中で切れているか。切れていることをAIに伝える */
  excerptTruncated: boolean;
  /** 作者が範囲を選んで聞いているか */
  fromSelection: boolean;
  /** 作品の材料（登場人物名など）。文脈に応じて呼び出し側が詰める */
  reference: string[];
  /** これまでのやり取り。古いものから順に */
  history: WorkChatTurn[];
  question: string;
}

export function buildWorkChatPrompt(input: WorkChatInput): string {
  const blocks: string[] = [`【作品】\n${input.workTitle}`];

  blocks.push(`【いま開いている画面】\n${input.contextLabel}`);

  if (input.excerpt.trim()) {
    const note = input.fromSelection
      ? "作者が選んだ範囲です。ここについての相談だと考えてください。"
      : input.excerptTruncated
        ? "長いため一部だけを抜き出しています。"
        : "";
    blocks.push(
      `【画面の内容】${note ? `\n（${note}）` : ""}\n${input.excerpt.trim()}`
    );
  }

  if (input.reference.length > 0) {
    blocks.push(`【この作品の材料】\n${input.reference.join("\n")}`);
  }

  if (input.history.length > 0) {
    const history = input.history
      .map((turn) => `${turn.role === "author" ? "作者" : "あなた"}: ${turn.text}`)
      .join("\n");
    blocks.push(`【これまでのやり取り】\n${history}`);
  }

  blocks.push(`【作者からの相談】\n${input.question.trim()}`);

  return blocks.join("\n\n");
}

/** 構造化出力に渡すJSONスキーマ */
export const WORK_CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    options: { type: "array", items: { type: "string" } },
  },
  required: ["reply"],
} as const;

export interface WorkChatAnswer {
  reply: string;
  options: string[];
}

/**
 * 応答を読み取る。
 *
 * **JSONとして読めなくても捨てない。** 相談は会話なので、形式が崩れても
 * 本文が読めるなら見せたほうがよい。読めなければ全文を返事として扱う。
 */
export function parseWorkChatAnswer(text: string): WorkChatAnswer {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { reply?: unknown }).reply === "string"
      ) {
        const record = parsed as { reply: string; options?: unknown };
        return {
          reply: record.reply.trim(),
          options: Array.isArray(record.options)
            ? record.options
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 4)
            : [],
        };
      }
    } catch {
      // 次の候補を試す
    }
  }

  return { reply: text.trim(), options: [] };
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
