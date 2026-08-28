/**
 * P-26 伏線の回収の検知（設計書6.35.3）。
 *
 * 未回収の伏線の一覧と本文を渡し、「この本文で回収（説明・成就）されたか」を
 * 見てもらう。**回収も提案である**——作者が承認して初めて `resolved` になる。
 *
 * **誤検知がいちばん怖い。** 回収済みの印が誤って付くと、作者は安心して
 * 回収を忘れる。そこで、
 *
 * - 回収の根拠も**逐語引用**で返させ、本文と照合する
 * - 一覧に無い `id` は捨てる（コード側で照合。AIは番号を作りたがる）
 * - 「まだ回収されていない」は挙げさせない（配列を空にする）
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
export const FORESHADOW_RESOLVE_VERSION = "1.0";

export const FORESHADOW_RESOLVE_SYSTEM_PROMPT = `あなたは日本語の小説で、既に張られた伏線がこの話で回収されたかだけを見る編集アシスタントです。

【絶対に守る原則】
1. **一覧に挙げた伏線だけを扱うこと。** 一覧に無い番号を書かないこと。
2. **回収されたと言い切れるものだけを挙げること。** 触れられただけ、
   同じ言葉が出てきただけは回収ではない。
3. **引用は本文からそのまま写すこと。** 言い換え・要約をしないこと。
4. 回収されたものが1つも無ければ、配列を1件も入れずに返すこと。
   **数を揃えるために当てはまらないものを入れないこと。**
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

/** AIへ渡す、未回収の伏線1件ぶん */
export interface OpenForeshadowBrief {
  id: string;
  label: string;
  note: string;
  /** 張った箇所の逐語引用。**どんな伏線かは、これがいちばん具体的に伝える** */
  plantedQuote: string;
  /** 張った話数。読めていなければ null */
  plantedChapter: number | null;
}

export interface ForeshadowResolveInput {
  /** その本文の見出し（「第7話」） */
  chapterLabel: string;
  /** 対象の本文 */
  chunkText: string;
  /** 未回収の伏線。**張った話より後の本文だけに掛ける**（呼び出し側で絞る） */
  foreshadows: readonly OpenForeshadowBrief[];
}

/**
 * 出力例に書く、項目の言い換え。P-25と同じ理由でここに集める——
 * **指示の言葉はそのまま答えとして返ってくる**ので、検証側が弾く。
 */
const QUOTE_HINT = "回収している箇所の引用";
const NOTE_HINT = "どう回収されたか";

export const FORESHADOW_RESOLVE_HINTS: readonly string[] = [
  QUOTE_HINT,
  NOTE_HINT,
];

export function buildForeshadowResolvePrompt(
  input: ForeshadowResolveInput
): string {
  const list = input.foreshadows
    .map((entry) => describeForeshadow(entry))
    .join("\n");

  return `以下の小説本文で、**未回収の伏線が回収されたか**を見てください。

【対象本文】（${input.chapterLabel}）
${input.chunkText}

【未回収の伏線】
${list}

【回収と見なすもの】
- 伏せられていた意味・正体・事情が、本文で明かされた
- 予告されていた出来事が、本文で実際に起きた
- 置かれていた小道具が、本文で意味を持って使われた

【回収と見なさないもの】
- 同じ言葉や人物が出てくるだけ
- 匂わせが重ねられただけ（まだ明かされていない）
- 読者にはまだ伏せられており、あとの話へ持ち越されている

【出力形式】JSONのみ
id には、上の一覧に書かれた番号をそのまま写してください。
{
  "resolutions": [
    {
      "id": "${input.foreshadows[0]?.id ?? "foreshadow_001"}",
      "quote": "${QUOTE_HINT}（本文からそのまま写す。40字以内）",
      "note": "${NOTE_HINT}（1文）"
    }
  ]
}`;
}

function describeForeshadow(entry: OpenForeshadowBrief): string {
  const parts = [`- ${entry.id}｜${entry.label}`];
  if (entry.note.trim()) parts.push(`  示唆：${entry.note.trim()}`);
  if (entry.plantedQuote.trim()) {
    parts.push(`  張った箇所：「${entry.plantedQuote.trim()}」`);
  }
  // **話数は分かるときだけ書く。** 「不明」と書くと、それを手掛かりに
  // 判断されかねない（分からないことは、渡さないほうがよい）
  if (entry.plantedChapter !== null) {
    parts.push(`  張った話：第${entry.plantedChapter}話`);
  }
  return parts.join("\n");
}

/**
 * 出力の形。**すべて required**（小さいモデルは任意項目を埋めずに落とす）。
 */
export const FORESHADOW_RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    resolutions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          quote: { type: "string" },
          note: { type: "string" },
        },
        required: ["id", "quote", "note"],
      },
    },
  },
  required: ["resolutions"],
} as const;

export interface ExtractedResolution {
  id: string;
  quote: string;
  note: string;
}

export interface ForeshadowResolveResult {
  resolutions: ExtractedResolution[];
}
