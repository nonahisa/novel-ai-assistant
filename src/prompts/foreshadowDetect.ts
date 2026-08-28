/**
 * P-25 伏線の配置の検知（チャンク単位、設計書6.35.2）。
 *
 * **取り出させるだけにする。** 「これは伏線か」をAIに判定させると、
 * 物語の続きを想像して書き始める（矛盾検知で実際に起きた形）。
 * ここで頼むのは「後の展開を予告・示唆している記述を、本文から写す」ことだけで、
 * 台帳へ入れるかどうかは作者が決める。
 *
 * **引用は逐語で返させる。** 本文と照合して、実在しない候補を捨てるため
 * （`core/foreshadowValidation.ts`）。言い換えられると照合できず、
 * 捏造なのか言い換えなのかを見分けられなくなる。
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
export const FORESHADOW_DETECT_VERSION = "1.0";

/**
 * 短い名の長さ。**一覧の見出しになる**ので、長いと折り返して読めなくなる。
 *
 * 検証側（`foreshadowValidation.ts`）はこれを超えた名前を捨てずに切り詰める。
 * 名前が長いだけの候補を落とすと、**中身（引用と示唆）まで一緒に消える。**
 */
export const FORESHADOW_LABEL_MAX_CHARS = 15;

export const FORESHADOW_DETECT_SYSTEM_PROMPT = `あなたは日本語の小説から、後の展開を予告・示唆している記述だけを取り出す編集アシスタントです。

【絶対に守る原則】
1. **本文に書かれていることだけを扱うこと。** 物語の続きを想像して書かないこと。
2. **引用は本文からそのまま写すこと。** 言い換え・要約・語順の入れ替えをしないこと。
3. 確信が持てないものは挙げないこと。見逃しよりも誤検出の方が作者の作業を妨げる。
4. 挙げるものが1つも無ければ、配列を1件も入れずに返すこと。
   **数を揃えるために当てはまらないものを入れないこと。**
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface ForeshadowDetectInput {
  /** その本文の見出し（「第3話」「第3〜5話」） */
  chapterLabel: string;
  /** 対象の本文。**行番号は振らない**（引用で位置を決めるため） */
  chunkText: string;
  /**
   * 既に台帳にある伏線の短い名。
   *
   * **同じものを二度出させない**（設計書6.35.2）。コード側でも重なりを
   * 落とすが、そちらは「出てきたものを捨てる」ので、送る量は減らない。
   */
  knownLabels: string[];
}

/**
 * 出力例に書く、項目の言い換え。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（`CLAUDE.md` の
 * 「繰り返し起きた失敗3」。`"suggestion": "空文字"` が実データで返った）。
 * ここに並べたものを検証側（`foreshadowValidation.ts`）が弾くので、
 * **プロンプトの文言とこの定数を別々に書かないこと**——別々に書くと、
 * 例文を直したときに検査だけが古い言葉を見張り続ける。
 */
const LABEL_HINT = "一覧の見出しにする名前";
const NOTE_HINT = "何を示唆しているか";
const QUOTE_HINT = "本文からそのまま写した引用";

export const FORESHADOW_DETECT_HINTS: readonly string[] = [
  LABEL_HINT,
  NOTE_HINT,
  QUOTE_HINT,
];

export function buildForeshadowDetectPrompt(
  input: ForeshadowDetectInput
): string {
  const known =
    input.knownLabels.length > 0
      ? input.knownLabels.join("、")
      : "（まだ登録されていません）";

  return `以下の小説本文から、**後の展開を予告・示唆している記述**を取り出してください。

【対象本文】（${input.chapterLabel}）
${input.chunkText}

【既に登録されている伏線】（これらと同じものは挙げないこと）
${known}

【取り出すもの】
- 謎めいた言及（意味を伏せたまま語られる出来事・人物・言葉）
- 意味ありげな小道具（わざわざ描写されるのに、その場では使われないもの）
- 説明されない違和感（不自然な反応、噛み合わない台詞、伏せられた事情）

【取り出さないもの】
- その場で説明が済んでいる記述（後の話へ持ち越されないもの）
- 単なる情景や動作の描写
- 誤字脱字・言い回しの善し悪し（別の機能で扱います）

【出力形式】JSONのみ
{
  "foreshadows": [
    {
      "label": "${LABEL_HINT}（本文の言葉を使い、${FORESHADOW_LABEL_MAX_CHARS}字以内）",
      "note": "${NOTE_HINT}（1〜2文）",
      "quote": "${QUOTE_HINT}（40字以内）"
    }
  ]
}`;
}

/**
 * 出力の形。
 *
 * **すべて required にする。** 任意項目にすると、小さいモデルは
 * 埋めずに落とす（この作品で繰り返し起きた）。プロバイダごとの方言へは
 * `ai/jsonSchema.ts` が変換する。
 */
export const FORESHADOW_DETECT_SCHEMA = {
  type: "object",
  properties: {
    foreshadows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          note: { type: "string" },
          quote: { type: "string" },
        },
        required: ["label", "note", "quote"],
      },
    },
  },
  required: ["foreshadows"],
} as const;

export interface ExtractedForeshadow {
  label: string;
  note: string;
  quote: string;
}

export interface ForeshadowDetectResult {
  foreshadows: ExtractedForeshadow[];
}
