import { SUMMARY_MAX_CHARS } from "../core/summaryLimit";

/**
 * P-32 相談で決まった人物の設定を拾い出す（設計書6.72）
 *
 * ## AIの仕事は「拾い出し」だけ
 *
 * 相談の中で作者が決めたこと——「この人物の年齢は17にしよう」——は、
 * 相談を閉じると流れてしまう。それを承認待ちへ積むための前段である。
 * **資料へ書くかどうかはAIが決めない。** 突合（誰の記録に当てるか）も
 * 台帳への書き込みも、これまでどおりコードと作者が受け持つ。
 *
 * ## 「作者が決めた」だけを拾う
 *
 * 相談は案を出し合う発散の場である。**AIが提案しただけで作者が返事を
 * していない案まで拾うと、承認待ちがゴミ箱になる。** そこで
 *   1. 「作者が決めた・同意したことだけ」を原則として明示し、
 *   2. 根拠（evidence）に**作者の発言**を必ず含めるよう求める
 * の二段で縛る。根拠は会話テキストとの逐語照合（`core/chatSettingsSync.ts`）を
 * 通り、通らなかったものは捨てて件数だけを作者へ伝える。
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
export const CHAT_SETTINGS_SYNC_VERSION = "1.0";

/**
 * 出力例に書く、項目の言い換え。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（`CLAUDE.md` の
 * 「繰り返し起きた失敗3」。`"suggestion": "空文字"` が実データで返った）。
 * ここに並べたものを検証側（`core/chatSettingsSync.ts`）が弾くので、
 * **プロンプトの文言とこの定数を別々に書かないこと**——別々に書くと、
 * 例文を直したときに検査だけが古い言葉を見張り続ける。
 */
const NAME_HINT = "人物の名前";
const DECIDED_HINT = "相談で決まった事柄";
const EVIDENCE_HINT = "根拠になる発言の逐語引用";

export const CHAT_SETTINGS_SYNC_HINTS: readonly string[] = [
  NAME_HINT,
  DECIDED_HINT,
  EVIDENCE_HINT,
];

export const CHAT_SETTINGS_SYNC_SYSTEM_PROMPT = `あなたは、作者とAIの相談の記録から「作者が決めた登場人物の設定」だけを取り出す係です。

【絶対に守る原則】
1. **作者が決めた・同意したことだけを取り出すこと。** あなた（AI側）が案として
   出しただけで、作者が受け入れる返事をしていないものは取り出さないこと。
   相談は案を出し合う場です。出た案をすべて拾うと、作者が選ばなかった設定まで
   資料に入ってしまいます。
2. 根拠（evidence）には、**会話の中の発言をそのまま写すこと。** 言い換え・要約・
   語順の入れ替えをしないこと。**作者の発言を必ず1つ含めること**——
   それが「作者が決めた」ことの証拠になります。
3. 会話に書かれていないことを補わないこと。人物像を想像で作らないこと。
4. 取り出すものが1つも無ければ、配列を1件も入れずに返すこと。
   **数を揃えるために、決まっていないことを入れないこと。**
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface ChatSettingsSyncInput {
  workTitle: string;
  /**
   * 相談の記録。**「作者:」「AI:」を付けた読みやすい形**で渡す
   * （`core/chatSettingsSync.ts` の `formatChatConversation`）。
   * この文字列が、根拠の逐語照合の母材にもなる。
   */
  conversation: string;
  /**
   * 資料にある人物の名前。**絞らずに全部渡す。**
   * 関連度で絞ると、絞り込みに漏れた人物が毎回「新規」として提案される。
   */
  knownNames: readonly string[];
}

export function buildChatSettingsSyncPrompt(
  input: ChatSettingsSyncInput
): string {
  const known =
    input.knownNames.length > 0
      ? `【この作品の登場人物（資料にあるもの）】（この形のまま使うこと）\n${input.knownNames.join(
          "、"
        )}\n\n`
      : "";

  return `小説「${input.workTitle}」について、作者とAIが相談した記録です。
この中で**作者が決めた登場人物の設定**を取り出してください。

${known}【相談の記録】
${input.conversation}

【出すもの】
人物ごとに次の3つ。決まったことが無ければ空の配列。

{
  "decisions": [
    {
      "name": "${NAME_HINT}（上の一覧にあればその形のまま）",
      "decided": "${DECIDED_HINT}（日本語の一文、${SUMMARY_MAX_CHARS}字以内）",
      "evidence": "${EVIDENCE_HINT}（作者の発言を必ず1つ含める）"
    }
  ]
}

【取り出さないもの】
- あなたが案として出しただけで、作者が受け入れていないもの
- 「〜はどうでしょう」「〜も考えられます」のような、まだ決まっていない案
- 本文にもとから書かれている事実（相談で決めたことではありません）`;
}

export const CHAT_SETTINGS_SYNC_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          decided: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["name", "decided", "evidence"],
      },
    },
  },
  required: ["decisions"],
} as const;

/** AIが返した1件。**中身はまだ信用していない**（検証は core 側） */
export interface RawChatDecision {
  name: string;
  decided: string;
  evidence: string;
}

/**
 * 応答から決定の一覧を取り出す。
 *
 * **形が合わないものは黙って捨てる。** ここで見るのは「3つの文字列が
 * 揃っているか」だけで、中身が本物かどうか（指示語の言い換えでないか、
 * 根拠が会話に実在するか）は `core/chatSettingsSync.ts` が判定する。
 * 形の検査と中身の検査を1か所に混ぜると、どちらの理由で落ちたのかを
 * 作者へ伝えられなくなる。
 */
export function parseChatSettingsSync(text: string): RawChatDecision[] {
  const source = extractJson(text);
  if (!source) return [];
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return [];
    const decisions = (parsed as { decisions?: unknown }).decisions;
    if (!Array.isArray(decisions)) return [];

    const out: RawChatDecision[] = [];
    for (const raw of decisions) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        continue;
      }
      const item = raw as Record<string, unknown>;
      const name = asString(item.name);
      if (!name) continue;
      out.push({
        name,
        decided: asString(item.decided),
        evidence: asString(item.evidence),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return body.slice(start, end + 1);
}
