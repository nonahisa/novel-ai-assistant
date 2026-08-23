/**
 * P-12b 矛盾の検証（設計書6.10.5）。
 *
 * 作者の指示（2026-08-23）：「検証でチャンクが増えてもかまいません。
 * 検出された内容に対し、検証を行うフェーズを追加してください」。
 *
 * ## なぜ2度見るのか
 *
 * 検出は**本文を読みながら**行う。1回の呼び出しで何十行も見て、設定も
 * 世界観もあらすじも突き合わせる。**1件ずつを吟味する余裕が無い。**
 *
 * 検証は逆で、**1件だけを見る。** 本文の該当箇所と設定の食い違いだけを
 * 渡し、「これは本当に矛盾か」を問う。**判断材料が少ないぶん、深く見られる。**
 *
 * ## 却下の道を、はっきり用意する
 *
 * 「矛盾か？」とだけ問うと、AIは挙げられたものを肯定しがちである。
 * **却下の理由を選択肢として並べ、どれかを選ばせる。** 「まだ明かされて
 * いないだけ」「発言者が知らない・偽っている」「作中の変化」は、
 * どれも**矛盾ではない**が、検出の段階では見分けにくい。
 *
 * プロンプトを変更したら version を上げること。
 */

// 1.0: 新設
export const CONTRADICTION_VERIFY_VERSION = "1.0";

export const CONTRADICTION_VERIFY_SYSTEM_PROMPT = `あなたは小説の設定と本文を突き合わせる校閲者です。

**すでに挙がっている指摘が、本当に矛盾かどうかだけを判断します。**
新しい矛盾を探す必要はありません。

**却下は正しい仕事です。** 迷ったら却下してください。誤った指摘を作者へ
渡すほうが、見逃すより手を煩わせます。

出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
マークダウンのコードフェンスを一切含めないこと。`;

/** 却下の理由。これ以外はコード側で弾く */
export const VERIFY_REJECT_REASONS = [
  "まだ明かされていない",
  "発言者の誤り",
  "作中の変化",
  "設定が古い",
  "引用が本文と違う",
  "そもそも食い違っていない",
] as const;

export type VerifyRejectReason = (typeof VERIFY_REJECT_REASONS)[number];

export interface ContradictionVerifyInput {
  /** その話の見出し */
  chapterLabel: string;
  /** 該当箇所の前後（行番号付き） */
  contextWithLineNumbers: string;
  /** 指摘された引用 */
  excerpt: string;
  /** 設定ではどうなっているか */
  settingSays: string;
  /** 本文ではどうなっているか */
  textSays: string;
  /** 観点 */
  category: string;
  /**
   * その設定が何話で分かるか。分からなければ空。
   *
   * **これが判断の要になる。** 対象より後の話なら「まだ明かされて
   * いない」を疑う。
   */
  settingKnownAt: string;
}

export function buildContradictionVerifyPrompt(
  input: ContradictionVerifyInput
): string {
  return `次の指摘が、本当に矛盾かどうかを判断してください。

【対象の話】${input.chapterLabel}

【該当箇所の前後】
${input.contextWithLineNumbers}

【指摘の内容】
- 観点: ${input.category}
- 引用: ${input.excerpt}
- 設定では: ${input.settingSays}
- 本文では: ${input.textSays}
- この設定が分かる話: ${input.settingKnownAt || "（不明）"}

【却下すべき場合】
次のどれかに当てはまるなら、矛盾ではありません。

1. **まだ明かされていない** … その設定が対象の話より後で明かされる場合。
   この時点の登場人物や読者が知らないことは、書かれていなくて当然です。
   **触れていないだけなら矛盾ではありません。**
2. **発言者の誤り** … 食い違っているのが登場人物の発言であり、
   その人物が知らない・思い違いをしている・偽っている可能性がある場合。
3. **作中の変化** … 時間の経過で変わったこと（成長、進学、退職、負傷など）。
   **人物の身の上が先へ進むのは矛盾ではありません。**
4. **設定が古い** … 本文のほうが新しく、設定資料が追いついていない場合。
5. **引用が本文と違う** … 上の「該当箇所の前後」に、引用した文が見当たらない場合。
6. **そもそも食い違っていない** … 読み違いで、両立する場合。

【採用すべき場合】
**両方が同時に成り立たないときだけ**です。とくに、
地の文（語り手の記述）どうしが食い違っている場合は矛盾です。

迷ったら却下してください。

【出力形式】JSONのみ

{
  "verdict": "採用" または "却下",
  "reason": "却下のときは ${VERIFY_REJECT_REASONS.join(" / ")} のどれか1つ。採用のときは空文字",
  "explanation": "そう判断した理由（60字以内）",
  "confidence": "high|medium|low"
}`;
}

/**
 * 出力の形。
 *
 * **すべて required にする。** 任意項目にすると、小さいモデルは
 * 埋めずに落とす（この作品で繰り返し起きた）。
 */
export const CONTRADICTION_VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    reason: { type: "string" },
    explanation: { type: "string" },
    confidence: { type: "string" },
  },
  required: ["verdict", "reason", "explanation", "confidence"],
} as const;
