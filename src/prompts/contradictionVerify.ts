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
// 1.1: **口調の食い違いを「語尾の変わり型」として却下しないよう書いた**（作者の裁定、
//      2026-10-11。プロンプト設計書 P-12b）。gemma4:26b が第1段で挙げた千夏の
//      「そうか、ではありませんわ。わたくし、驚きましたのよ」（設定はくだけた話し方、
//      語尾「〜でしょ」「〜ね」「〜よ」）を、この段が「『〜ですわ』は『〜でしょ』『〜ね』
//      『〜よ』の語尾の変わり型に含まれる」として「そもそも食い違っていない」で
//      却下した（10-10 の1回目）。設定に無い語尾や、丁寧さの段（お嬢様言葉・丁寧語・
//      敬語）の違いは、変わり型ではなく食い違いとして残す、を6の但し書きと
//      【採用すべき場合】に書いた（`VERIFY_SPEECH_NOTE`）。
//
// **小さいモデル（検出の段で抑制版を送るモデル）向けの形を足したが、版は 1.1 のまま
// 据え置いた**（作者の裁定⑧、2026-10-16。`smallModel`・`verifyRejectReasonsFor`）。
// 「この設定が分かる話」が引けないときは「（不明）」と書かず、却下の理由から
// 「まだ明かされていない」を外して5つにする。e4b は台Bの検出の段で仕込み2件
// （ギプスの左右・ほくろの左右）を2回とも挙げていたのに、この段が「（不明）」を
// 「設定が不明」と読んで「まだ明かされていない」で取り下げていた。
// **大きいモデルへの文面は1文字も変えていない**ので、版を上げると作者のクラウドAIの
// 検証の控えまで道連れで作り直しになる。**どちらの形を送ったかは、製品の控えの鍵の
// `strict:` の印で分ける**（`contradictionVerifyPromptVersion`。0.70.8 の抑制版と同じやり方）
export const CONTRADICTION_VERIFY_VERSION = "1.1";

/**
 * 送るときの温度。指摘が本当に矛盾かを確かめるだけなので揺らさない。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const CONTRADICTION_VERIFY_TEMPERATURE = 0.0;

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

/*
 * 口調の食い違いを「語尾の変わり型」で却下させないための但し書き（1.1）。
 * 3文を `VERIFY_SPEECH_NOTE` につないで、検証の頼みの 6 の但し書きに置く。
 *
 * **「設定に無い語尾なら全部残す」とは書かない。** 台の罠1（蓬田「なんだ、
 * そんな顔をするな」。設定の語尾は「〜だ」「〜とる」「〜ん」）は、語尾こそ
 * 一覧に無いが、ぶっきらぼうな話し方のままなので食い違いではない。分け目は
 * 語尾の字面ではなく、**丁寧さの段と話し方の種類**に置いた。
 *
 * **そのまま答えに返ってくる前提で置く**（CLAUDE.md「繰り返し起きた失敗」3番）。
 * 却下の `reason` にこの言葉が写っても、決められた理由ではないので読み取り
 * （`contradictionVerifyValidation.ts` の `normalizeReason`）が却下として
 * 受け取らない。`explanation` に「残せ」の文を写したまま却下してきたときは、
 * 判断できなかったものとして通す（`parseVerifyOutcome`）。
 */
const VERIFY_SPEECH_SAME_MANNER =
  "設定に挙がった語尾は例なので、同じ話し方（くだけた・ぶっきらぼう など）のまま語尾だけが違うなら食い違いではありません。";

/**
 * 但し書きのうち「残せ」と言っている文。**却下の説明にこれを写してきたら、
 * 自分で残せと書きながら消そうとしている**ので、却下として受け取らない。
 * 1文目（同じ話し方なら食い違いではない）は却下の根拠として正しく写りうる
 * ので入れない——罠1の正しい却下を、判断できなかったことにしてしまう。
 */
export const VERIFY_SPEECH_KEEP_SENTENCES: readonly string[] = [
  "しかし、丁寧さの段や話し方の種類が設定と違う台詞（くだけた話し方の人物のお嬢様言葉、敬語を使わない人物の丁寧語・敬語、設定に無い一人称）は、設定の語尾の変わり型ではありません。",
  "本文にきっかけが描かれていなければ、食い違いとして残してください。",
];

export const VERIFY_SPEECH_NOTE = [
  VERIFY_SPEECH_SAME_MANNER,
  ...VERIFY_SPEECH_KEEP_SENTENCES,
].join("");

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
  /**
   * **小さいモデル（検出の段で抑制版を送るモデル）向けの形にするか**（裁定⑧。版は 1.1 のまま）。
   * 省けば大きいモデルの形（1.1 と同じ文面）。
   *
   * 検出の段の抑制（`ai/capability.ts` の `suppressUncertainContradictions`、
   * MCP の `suppression: "strict"`）と一対で決める。
   */
  smallModel?: boolean;
}

/**
 * 「この設定が分かる話」が引けなかったときの書き方（小さいモデル向け、裁定⑧）。
 *
 * 大きいモデルの形は「（不明）」のまま。e4b はこれを「設定が不明」「この時点では
 * 判断できない」と読み、台Bで2回とも挙げた仕込み（ギプスの左右・ほくろの左右）を
 * 「まだ明かされていない」で取り下げた（2026-10-16）。索引は値が完全に一致する
 * ときしか話数を返さないので、実データではほぼ常にここに来る。
 */
export const VERIFY_KNOWN_AT_NONE_SMALL =
  "記録なし（この話より後で明かされる設定だという記録はありません）";

/** 却下の理由ごとの説明（【却下すべき場合】の各項目。番号は組むときに振る） */
const REJECT_REASON_TEXTS: Record<VerifyRejectReason, string> = {
  まだ明かされていない: `**まだ明かされていない** … その設定が対象の話より後で明かされる場合。
   この時点の登場人物や読者が知らないことは、書かれていなくて当然です。
   **触れていないだけなら矛盾ではありません。**`,
  発言者の誤り: `**発言者の誤り** … 食い違っているのが登場人物の発言であり、
   その人物が知らない・思い違いをしている・偽っている可能性がある場合。`,
  作中の変化: `**作中の変化** … 時間の経過で変わったこと（成長、進学、退職、負傷など）。
   **人物の身の上が先へ進むのは矛盾ではありません。**`,
  設定が古い: "**設定が古い** … 本文のほうが新しく、設定資料が追いついていない場合。",
  引用が本文と違う:
    "**引用が本文と違う** … 上の「該当箇所の前後」に、引用した文が見当たらない場合。",
  そもそも食い違っていない: `**そもそも食い違っていない** … 読み違いで、両立する場合。
   ただし、口調の指摘では、${VERIFY_SPEECH_NOTE}`,
};

/**
 * この頼みで選ばせる却下の理由（裁定⑧）。
 *
 * **小さいモデルで、話数の記録が無いときは「まだ明かされていない」を並べない。**
 * 裁定⑧の最初の案（「記録なしのときは選ばないで」と但し書きを足す）では、e4b は
 * 但し書きを読んだうえで「後続の話で明かされる可能性があり」と書いて同じ理由を
 * 選び続けた（台B、2026-10-16）。選べる形で置いておくと、迷ったときの逃げ道に
 * なる。話数の記録があるとき・大きいモデルでは、6つとも並べる（1.1 と同じ）。
 *
 * それでもこの理由を返してきたら、決められた語なので却下として受け取る
 * （`parseVerifyOutcome`）。守り（`guardNotYetRevealed`）のように読み取りで
 * 覆すと、e4b では誤検出だけが戻った（2026-10-16 の測定）。
 */
export function verifyRejectReasonsFor(input: {
  settingKnownAt: string;
  smallModel?: boolean;
}): readonly VerifyRejectReason[] {
  if (!(input.smallModel ?? false) || input.settingKnownAt) return VERIFY_REJECT_REASONS;
  return VERIFY_REJECT_REASONS.filter((reason) => reason !== "まだ明かされていない");
}

export function buildContradictionVerifyPrompt(
  input: ContradictionVerifyInput
): string {
  const small = input.smallModel ?? false;
  const knownAt =
    input.settingKnownAt || (small ? VERIFY_KNOWN_AT_NONE_SMALL : "（不明）");
  const reasons = verifyRejectReasonsFor(input);
  const reasonItems = reasons
    .map((reason, index) => `${index + 1}. ${REJECT_REASON_TEXTS[reason]}`)
    .join("\n");
  return `次の指摘が、本当に矛盾かどうかを判断してください。

【対象の話】${input.chapterLabel}

【該当箇所の前後】
${input.contextWithLineNumbers}

【指摘の内容】
- 観点: ${input.category}
- 引用: ${input.excerpt}
- 設定では: ${input.settingSays}
- 本文では: ${input.textSays}
- この設定が分かる話: ${knownAt}

【却下すべき場合】
次のどれかに当てはまるなら、矛盾ではありません。

${reasonItems}

【採用すべき場合】
**両方が同時に成り立たないときだけ**です。とくに、
地の文（語り手の記述）どうしが食い違っている場合は矛盾です。
台詞が、話している人物の設定と違う丁寧さの段や話し方の種類で話していて、
本文にきっかけが描かれていない場合も矛盾です。

迷ったら却下してください。

【出力形式】JSONのみ

{
  "verdict": "採用" または "却下",
  "reason": "却下のときは ${reasons.join(" / ")} のどれか1つ。採用のときは空文字",
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
