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
//
// 1.2（2026-10-19、A21 の作者の裁定①）：口調の但し書きで、一人称を括弧の3番目から
// 出して独立した1文にした（「一人称は語尾ではありません」）。26b は「一人称の設定と、
// 台詞の語尾（お嬢様言葉）の不一致は…矛盾とはみなせません」と、一人称を語尾の話に
// 含めて読んで却下していた（作者の作品の写しの第10話「わたくし」）。【採用すべき場合】
// にも一人称を足した。**単独では差が出ず、「この設定が分かる話」の索引の直し
// （大きいモデルだけ）と組んだときだけ効く**と測った。
// 一人称の文は小さいモデル（`smallModel`）の形にも入る。版が上がるので、手元のAIの
// 確かめの控えも作り直しになる（e4b は台Cで 2/6・誤検出0 と、いまと同じと測った）
// （docs/measurements/2026-10-18-speech-note-with-index.md）
export const CONTRADICTION_VERIFY_VERSION = "1.2";

// 1.3（2026-10-19 夜、作者の裁定「A+C で実装する」）：**「あとで判明する事実」の段
// （future）から来た指摘にだけ**、出どころの一文を置き、却下の理由から
// 「まだ明かされていない」を外し、「作中の変化」を future 用の説明に差し替える
// （`source: "future"`）。e4b は第3話の「学校で授業を受け」（第4話で判明する
// 「三ヶ月前に退学」）を「作中の変化」で、26b は第2話の「生まれてからずっと本屋」
// （第5話で判明する「元刑事」）を「まだ明かされていない」で取り下げていた。
// future の照合は「設定が対象の話より後に分かる」ことが前提なので、その2つの理由が
// 前提そのもので当たりを消す。
// **本命の突き合わせ（settled）の文面は1文字も変えていない**ので、
// `CONTRADICTION_VERIFY_VERSION` は 1.2 のまま据え置き、future の控えの鍵だけに
// この版と `future:` の印を付ける（`contradictionVerifyPromptVersion`。裁定⑧の
// `strict:` と同じやり方）。上げると作者のクラウドAIの確かめの控えまで作り直しになる
// （docs/進捗と引継ぎ.md 8章「【測定】2026-10-19 夜：矛盾検知「あとで判明する事実」2項目の測り直し」）
//
// 1.4（2026-10-23、作者の裁定「事実の文を渡す」）：future の指摘に、**コードが特定した、
// 照らしたあとの話の事実の文**（【照らした事実（あとの話で判明）】）と、その文と本文を
// 見比べる指示を渡す。検出の段の note は、その下に参考として置く。作り物の台Bで 26b は
// 検出の段で本当の食い違い（第5話の「四十歳まで東京で中学の教師」）を note に書き、
// settingSays には「宗一は七十八歳である。」と書いた。この段には事実の文が渡って
// おらず、「78年間外で暮らしていないと78歳は両立する」で取り下げた。
// 事実の文を渡さない呼び出し（`futureFacts` を省く）は 1.3 と同じ文面のまま
export const CONTRADICTION_VERIFY_FUTURE_VERSION = "1.4";

// travel 1.0（2026-10-25、作者の選択①）：**移動の照合（事実の照合の `findTravelImpossibilities`）
// から来た指摘にだけ**、出どころの欄を置く。コードが照らした所要時間・コードの読み・
// 時の手がかり・前側の箇所の前後を渡し、「場所を移ったこと自体はこの指摘の前提で、問うのは
// 書かれた経過のあいだに移れるか」と書く。却下の理由から「まだ明かされていない」を外し、
// 「作中の変化」「そもそも食い違っていない」を移動の照合の説明に差し替える。
// 旅の台で 26b は3件とも「8行目で港町にいることは作中の変化（移動）として成立する」
// 「前夜から翌朝にかけて移動した結果」で、e4b は「まだ明かされていない」で取り下げた
// （docs/measurements/2026-10-25-travel-stage0-1.md）。
// **本命（settled）と future の文面は1文字も変えていない**ので、その2つの版は据え置き、
// 移動の照合の控えの鍵だけにこの版と `travel` の印を付ける（`factVerifyPromptVersion`）
//
// travel 1.1（2026-10-26、作者の裁定「1文足して測り直す」）：【指摘の出どころ】に、
// **承認待ちの距離も根拠として扱う**1文（`VERIFY_TRAVEL_PENDING_SENTENCE`）を足す。
// **根拠に承認待ちの距離を使った候補にだけ**置く（同日の測り直しで、全部に置くと旅の台の
// e4b が 2/3→1/3 に下がった）。使わない候補の文面は 1.0 と同じなので、その控えの鍵は
// 1.0 のまま（`CONTRADICTION_VERIFY_TRAVEL_BASE_VERSION`、`factVerifyPromptVersion`）。
// 0.112.2 で根拠に承認待ちの距離（本文から AI が読んだ所要時間）が出るようになり、
// e4b は「所要時間は設定資料にない情報であり、本文の記述を優先すべき」（設定が古い）で
// 取り下げた。26b は正しく扱った（docs/measurements/2026-10-26-travel-ai-cues.md）。
// 本命と future の文面はこの版でも変えていない
export const CONTRADICTION_VERIFY_TRAVEL_VERSION = "1.1";
/** 承認待ちの距離を使わない移動の候補の文面の版（1.1 で変えていない＝1.0 のまま） */
export const CONTRADICTION_VERIFY_TRAVEL_BASE_VERSION = "1.0";

// identity 1.0（2026-10-26、母艦の判断④）：**体と心の照合（事実の照合の `findDwellingDrift`）
// から来た指摘にだけ**、出どころの欄を置く。コードが照らした心と体の記録（作者が付けた、
// どの心がどの体にいるか）と、コードの読み（その場面で体を動かしている心）を渡し、
// 「体と心が別の人物であること自体はこの指摘の前提で、問うのは記録の外で心がその体に
// いることを本文が説明しているか」と書く。却下の理由から「まだ明かされていない」を外し、
// 「作中の変化」「そもそも食い違っていない」を体と心の照合の説明に差し替える。
// 移動の照合は文面を分けるまで、全件が「作中の変化」で取り下げられていた（travel 1.0 の測定）。
// 体と心の照合も、心が別の体にいることそのものを「作中の変化」と読まれうるので、最初から分ける。
// **本命・future・travel の文面は1文字も変えていない**ので、その版は据え置き、体と心の
// 照合の控えの鍵だけにこの版と `identity` の印を付ける（`factVerifyPromptVersion`）
export const CONTRADICTION_VERIFY_IDENTITY_VERSION = "1.0";

// death 1.0（2026-10-26、体と心の組の実測 2回目）：**死亡後の登場（事実の照合の
// `findPostDeathAppearances`）から来た指摘にだけ**、出どころの欄を置く。コードの読みと、
// 死亡が書かれた箇所の前後を渡し、「死亡のあとに地の文でその人物が行動していることが両立するか。
// 幽霊・回想・夢・転生・憑依・噂・誤報などの描写があれば両立」と問う。却下の理由から
// 「まだ明かされていない」を外し、「作中の変化」「そもそも食い違っていない」を死亡後の登場の
// 説明に差し替える。e4b は台の仕込み②（第2話で死んだハツが第5話の地の文で味噌汁を作る）を、
// 「「死亡」という設定は、その時点での事実の記述であり、行動の描写とは矛盾しない」と
// 「そもそも食い違っていない」で取り下げた（docs/measurements/2026-10-26-identity-cues-2.md）。
// **本命・future・travel・identity の文面は1文字も変えていない**ので、その版は据え置き、
// 死亡後の登場の控えの鍵だけにこの版と `death` の印を付ける（`factVerifyPromptVersion`）
export const CONTRADICTION_VERIFY_DEATH_VERSION = "1.0";

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
  "しかし、一人称は語尾ではありません。台詞の一人称が設定の一人称と違うなら、語尾が設定どおりでも食い違いです。",
  "また、丁寧さの段や話し方の種類が設定と違う台詞（くだけた話し方の人物のお嬢様言葉、敬語を使わない人物の丁寧語・敬語）も、設定の語尾の変わり型ではありません。",
  "本文にきっかけが描かれていなければ、食い違いとして残してください。",
];

export const VERIFY_SPEECH_NOTE = [
  VERIFY_SPEECH_SAME_MANNER,
  ...VERIFY_SPEECH_KEEP_SENTENCES,
].join("");

/** 指摘がどの突き合わせから来たか（文面の種類）。省けば本命（settled） */
export type VerifySource = "settled" | "future" | "travel" | "identity" | "death";

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
  /**
   * 指摘がどちらの突き合わせから来たか（1.3）。省けば本命（settled）で、1.2 と同じ文面。
   *
   * `"future"`（あとで判明する事実との照合）のときだけ、出どころの一文を置き、
   * 「まだ明かされていない」を並べず、「作中の変化」を future 用の説明にする。
   * 大きいモデルにも小さいモデルにも同じ形を送る。
   */
  source?: VerifySource;
  /**
   * 死亡後の登場から来た指摘の材料（death 1.0）。`source: "death"` のときだけ使う。
   * **どれもコードが組んだもの**（AI の文ではない）
   */
  death?: DeathVerifyMaterial;
  /**
   * 体と心の照合から来た指摘の材料（identity 1.0）。`source: "identity"` のときだけ使う。
   * **どれもコードが組んだもの**（AI の文ではない）
   */
  identity?: IdentityVerifyMaterial;
  /**
   * 移動の照合から来た指摘の材料（travel 1.0）。`source: "travel"` のときだけ使う。
   * **どれもコードが組んだもの**（AI の文ではない）
   */
  travel?: TravelVerifyMaterial;
  /**
   * future の指摘が照らした、あとの話で判明する事実の文（1.4）。検出の段へ送った一覧と
   * 同じ書式の行（「宗一の紹介（第5話で判明）: …」）。**コードが選んだもの**
   * （`core/contradictionFutureFacts.ts` の `futureFactLinesForIssue`）を渡す。
   * 省くか空なら 1.3 と同じ文面。本命（settled）では使わない
   */
  futureFacts?: readonly string[];
  /**
   * 検出の段が書いた補足（`note`）。future で事実の文を渡すときだけ、その下に参考として
   * 置く（1.4）。AI の文なので判断の土台にはさせない
   */
  detectionNote?: string;
}

/**
 * 「あとで判明する事実」から来た指摘で、照らした事実の文を渡すときの出どころの説明（1.4）。
 *
 * 1.3 の文（`VERIFY_FUTURE_SOURCE_NOTE`）は「「設定では」の欄は…事実です」と言うが、
 * その欄は検出の段の AI が書いた要約で、事実の一部しか写していないことがある（台Bの宗一）。
 * 事実そのものは【照らした事実】の欄にあるので、そちらを指す。
 * 却下の理由の語と「明かされていない」は含めない（1.3 と同じ理由）
 */
export const VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS =
  "この指摘は、あとの話で判明する事実との照合から来たものです。" +
  "下の【照らした事実】は、対象の話より後で明らかになる事実です。" +
  "本文の記述が、その事実と両立するかを判断してください。" +
  "その事実が対象の話の本文にまだ書かれていないこと自体は、前提なので却下の理由になりません。";

/**
 * 照らした事実と本文を見比べさせる指示（1.4）。
 *
 * **そのまま答えに返ってくる前提で書く**（CLAUDE.md「繰り返し起きた失敗」3番）。
 * 却下の理由の語を含めない——説明に写っても、決められた理由ではないので読み取りが
 * 却下として受け取らない（`normalizeReason`）。「設定では」の欄を疑えとは書くが、
 * 「引用が違う」のような却下の道を示唆する言い方はしない
 */
export const VERIFY_FUTURE_FACTS_NOTE =
  "「設定では」「本文では」の欄は、検出の段がまとめた文で、照らした事実の一部しか写していないことがあります。" +
  "その2つの欄の文どうしを比べるのではなく、【照らした事実】の文と【該当箇所の前後】の本文を見比べてください。" +
  "事実の文と本文が同時に成り立たないなら、採用です。";

/** 検出の段の補足を、プロンプトへ載せる上限の字数。参考なので長くは要らない */
const DETECTION_NOTE_MAX_CHARS = 200;

/**
 * 「あとで判明する事実」から来た指摘の、出どころの説明（1.3）。
 *
 * **「まだ明かされていない」という言い回しを含めない**（却下の理由の一覧から外した
 * 語を、説明の側から思い出させない。指示の言葉は答えに返ってくる。CLAUDE.md
 * 「繰り返し起きた失敗」3番）。「本文にまだ書かれていないこと自体は却下の理由に
 * ならない」は、26b が前提そのものを理由に取り下げた型への答えとして書く。
 * 「登場人物が知らない」とは書かない——却下の理由「発言者の誤り」（知らずに言った
 * 台詞）とぶつかる。そちらは取り下げても `keepWithdrawnSpeechAsLow` が low で残す。
 */
export const VERIFY_FUTURE_SOURCE_NOTE =
  "この指摘は、あとの話で判明する事実との照合から来たものです。" +
  "「設定では」の欄は、対象の話より後で明らかになる事実です。" +
  "本文の記述が、その事実と両立するかを判断してください。" +
  "その事実が対象の話の本文にまだ書かれていないこと自体は、前提なので却下の理由になりません。";

/**
 * 「あとで判明する事実」から来た指摘で、話数が引けなかったときの書き方（1.3）。
 *
 * 小さいモデル向けの `VERIFY_KNOWN_AT_NONE_SMALL`（「この話より後で明かされる設定だと
 * いう記録はありません」）は、future では事実と逆になる。「（不明）」も、e4b は
 * 「設定が不明」と読んだ（裁定⑧）。後の話であることは分かっているので、それだけを言う。
 */
export const VERIFY_KNOWN_AT_NONE_FUTURE = "対象の話より後の話（何話かは引けませんでした）";

/**
 * 「あとで判明する事実」から来た指摘の、「作中の変化」の説明（1.3）。
 *
 * 1.2 の説明（「人物の身の上が先へ進むのは矛盾ではありません」）は、判明した事実が
 * 対象の話より後の出来事だと決めてかかる。e4b は第4話で判明する「三ヶ月前に退学」を、
 * 第3話の「学校で授業を受け」より後のことと読んで取り下げた。判明した話から見て
 * 過去に起きたことなら、対象の話の時点で既に起きている——その見分けを書く。
 *
 * 例は測定の台の仕込み（退学・元刑事・画家）と重ならない事実にする。重なると、
 * 答えを教えたうえで撃つことになり、効いたかどうかが測れない。
 */
const FUTURE_CHANGE_TEXT = `**作中の変化** … 判明した事実が、対象の話の時点より後に起きた変化と読める場合だけ
   （例：第9話で判明した結婚が、第5話より後の出来事である）。
   判明した事実が、対象の話の時点で既に起きていたこと（例：第7話で「一年前に東京から越してきた」と
   分かり、対象の話がその一年のうちにある）なら、作中の変化には当たりません。`;

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
  source?: VerifySource;
}): readonly VerifyRejectReason[] {
  // **future では大小とも並べない**（1.3）。設定が対象の話より後に分かるのが
  // この照合の前提なので、この理由は前提そのもので当たりを消す（26b の瀬戸）。
  // **移動の照合でも並べない**（travel 1.0）。両側とも本文に書かれた所在で、
  // 明かされる・明かされないの話ではない（e4b は旅の台でこの理由で取り下げた）
  // **体と心の照合でも並べない**（identity 1.0）。両側とも本文の場面の読みと作者の記録で、
  // 明かされる・明かされないの話ではない
  // **死亡後の登場でも並べない**（death 1.0）。死亡もあとの登場も本文に書かれている
  if (
    input.source === "future" ||
    input.source === "travel" ||
    input.source === "identity" ||
    input.source === "death"
  ) {
    return VERIFY_REJECT_REASONS.filter((reason) => reason !== "まだ明かされていない");
  }
  if (!(input.smallModel ?? false) || input.settingKnownAt) return VERIFY_REJECT_REASONS;
  return VERIFY_REJECT_REASONS.filter((reason) => reason !== "まだ明かされていない");
}

/**
 * future の指摘の、出どころの欄（1.3）と照らした事実の欄（1.4）。
 *
 * 事実の文が無ければ 1.3 と同じ文面（出どころの一文だけ）。事実の文があれば、
 * 出どころの一文をそちらを指す形に替え、事実の文 → 見比べる指示 → 検出の段の補足
 * （参考）の順に置く。**AI の文（補足）は事実の文より下に置く**——判断の土台は
 * コードが選んだ事実の文である
 */
function futureSourceBlock(input: ContradictionVerifyInput): string {
  const facts = (input.futureFacts ?? []).map((line) => line.trim()).filter(Boolean);
  if (facts.length === 0) return `\n【指摘の出どころ】\n${VERIFY_FUTURE_SOURCE_NOTE}\n`;
  const note = (input.detectionNote ?? "").trim().slice(0, DETECTION_NOTE_MAX_CHARS);
  const noteBlock = note ? `\n【検出の段の補足（AIが書いた文。参考）】\n${note}\n` : "";
  return (
    `\n【指摘の出どころ】\n${VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS}\n` +
    `\n【照らした事実（あとの話で判明）】\n${facts.map((line) => `- ${line}`).join("\n")}\n` +
    `\n${VERIFY_FUTURE_FACTS_NOTE}\n` +
    noteBlock
  );
}

/** 移動の照合から来た指摘の材料（travel 1.0）。どれもコードが組んだ文 */
export interface TravelVerifyMaterial {
  /** 場所の記録の所要時間（候補の `basis`。「場所の記録では、王都と港町のあいだは3日かかる…」） */
  travelTime: string;
  /** コードの読み（候補の `reason`。「第2話2行目に『王都』、第2話8行目に『港町』。…移っている」） */
  reading: string;
  /**
   * 後ろ側の段落の頭で時計が読んだ語と、その読み方（「「その頃」（前の場面と同じ時）」）。
   * 読めなければ空
   */
  timeCue: string;
  /** 前側の事実の箇所の前後（行番号付き）。後ろ側の前後に入っているとき・本文に無いときは空 */
  leftContext: string;
  /**
   * 所要時間に承認待ちの距離（P-51 が本文から読んだもの）を使った候補か（travel 1.1）。
   * 真のときだけ `VERIFY_TRAVEL_PENDING_SENTENCE` を置く。省くと 1.0 と同じ文面
   */
  pendingDistance?: boolean;
}

/**
 * 移動の照合から来た指摘の、出どころの説明（travel 1.0）。
 *
 * 26b は「8行目で港町にいることは作中の変化（移動）として成立する」と、移動したこと
 * そのものを両立の理由にした。**移動はこの照合の前提で、問いは「間に合うか」**だと先に言う。
 * **そのまま答えに返ってくる前提で書く**（CLAUDE.md「繰り返し起きた失敗」3番）——
 * 却下の理由の語（「作中の変化」「食い違っていない」など）を含めない。2文目
 * （`VERIFY_TRAVEL_KEEP_SENTENCES`）を写したまま却下してきたら、読み取りは判断
 * できなかったものとして通す（`parseVerifyOutcome`）
 */
export const VERIFY_TRAVEL_SOURCE_NOTE =
  "この指摘は、場所の記録の所要時間と、本文の時の手がかりを、コードが突き合わせて挙げたものです。";

/**
 * 移動の照合の「残せ」と言っている文（travel 1.0）。却下の説明にこれを丸ごと写してきたら、
 * 自分で前提だと書きながら移動を理由に消そうとしているので、却下として受け取らない
 */
/**
 * 承認待ちの距離の扱い（travel 1.1）。根拠の頭の「設定資料にはまだ入っていません」を、
 * e4b は「設定資料にない情報だから本文を優先」と読んで取り下げた。
 * **却下の理由の語（「設定が古い」など）を含めない**——指示の言葉はそのまま答えに返る
 * （CLAUDE.md「繰り返し起きた失敗」3番）。写したまま却下してきたら通す見張りにも入れる
 */
export const VERIFY_TRAVEL_PENDING_SENTENCE =
  "承認待ちの距離は、本文からAIが読み取った所要時間で設定資料にまだ載っていないだけなので、場所の記録の所要時間と同じ根拠として扱ってください。";

export const VERIFY_TRAVEL_KEEP_SENTENCES: readonly string[] = [
  "人物が場所を移ったこと自体は、この指摘の前提であって、両立の理由になりません。",
  "書かれた経過が所要時間より短く、速く移る手段も本文に書かれていないなら、同時に成り立ちません。",
  VERIFY_TRAVEL_PENDING_SENTENCE,
];

/** 移動の照合で問うことの説明（travel 1.0）。経過と所要時間を比べさせる */
const VERIFY_TRAVEL_QUESTION =
  "問うのは、書かれた時の経過のあいだに、その道のりを移れるかです。" +
  VERIFY_TRAVEL_KEEP_SENTENCES[0] +
  "本文に、記録より速く移る手段（転移・飛行など）や、もっと長い時が経ったことが書かれていれば両立します。" +
  VERIFY_TRAVEL_KEEP_SENTENCES[1];

/**
 * 移動の照合の「作中の変化」の説明（travel 1.0）。1.2 の説明（「人物の身の上が先へ進むのは
 * 矛盾ではありません」）は、移動をそのまま身の上の変化と読ませる（26b の第6話「前夜から
 * 翌朝にかけて移動した結果」）
 */
const TRAVEL_CHANGE_TEXT = `**作中の変化** … 本文に、記録より速く移る手段や、コードの読みより長い時の経過が書かれている場合だけ。
   移動したことだけでは、これに当たりません。`;

/**
 * 移動の照合の「そもそも食い違っていない」の説明（travel 1.0）。口調の但し書きは要らない。
 * 時計の読み違い（「その頃」が別の日を指すと本文から分かる、など）は正しい却下として残す
 */
const TRAVEL_NO_CONFLICT_TEXT = `**そもそも食い違っていない** … コードの読み（どの場所か・時がどれだけ経ったか）が本文と違っていて、両立する場合。`;

/** 移動の照合の【採用すべき場合】に足す1文（travel 1.0） */
const TRAVEL_ADOPT_LINE =
  "\n移動の指摘では、本文の時の経過が場所の記録の所要時間より短く、速く移る手段も書かれていない場合も矛盾です。";

/** 移動の照合の、出どころと材料の欄（travel 1.0） */
function travelSourceBlock(material: TravelVerifyMaterial | undefined): string {
  // travel 1.1 の1文は、根拠に承認待ちの距離を使った候補にだけ置く。使わない候補の文面は
  // 1.0 と1文字も変えない——全部に置いたら、旅の台の e4b が承認待ちと関係の無い候補を
  // 「作中の変化」で取り下げ、2/3→1/3 に下がった（docs/measurements/2026-10-26-travel-verify-1.1.md）
  const pending = material?.pendingDistance === true ? VERIFY_TRAVEL_PENDING_SENTENCE : "";
  const lines = [`\n【指摘の出どころ】\n${VERIFY_TRAVEL_SOURCE_NOTE}\n${VERIFY_TRAVEL_QUESTION}${pending}\n`];
  if (material?.travelTime.trim()) {
    lines.push(`\n【所要時間（場所の記録）】\n${material.travelTime.trim()}\n`);
  }
  if (material?.reading.trim()) {
    lines.push(`\n【コードの読み】\n${material.reading.trim()}\n`);
  }
  if (material?.timeCue.trim()) {
    lines.push(`\n【時の手がかり（引用の段落の頭）】\n${material.timeCue.trim()}\n`);
  }
  if (material?.leftContext.trim()) {
    lines.push(`\n【前側の箇所の前後】\n${material.leftContext.trim()}\n`);
  }
  return lines.join("");
}

/** 体と心の照合から来た指摘の材料（identity 1.0）。どれもコードが組んだ文 */
export interface IdentityVerifyMaterial {
  /**
   * 心と体の記録の根拠（候補の `basis`。「心と体の記録（作者が人物の編集で付けたもの）では、
   * 三門太志の心が密倉文佳の体にいるのは第2話から第4話」）
   */
  record: string;
  /** コードの読み（候補の `reason`。「第6話 6行目、密倉文佳の体に〈三門太志〉の心がいる。…」） */
  reading: string;
}

/**
 * 体と心の照合から来た指摘の、出どころの説明（identity 1.0）。
 * **却下の理由の語（「作中の変化」「食い違っていない」など）を含めない**——指示の言葉は
 * そのまま答えに返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）
 */
export const VERIFY_IDENTITY_SOURCE_NOTE =
  "この指摘は、作者が付けた人物の心と体の記録（どの心がどの体にいるか）と、本文のその場面で体を動かしている心を、コードが突き合わせて挙げたものです。";

/**
 * 体と心の照合の「残せ」と言っている文（identity 1.0）。却下の説明にこれを丸ごと写してきたら、
 * 自分で前提だと書きながら、心が別の体にいることを理由に消そうとしているので、却下として受け取らない
 */
export const VERIFY_IDENTITY_KEEP_SENTENCES: readonly string[] = [
  "体の持ち主と別の人物の心がその体にいること自体は、この指摘の前提であって、両立の理由になりません。",
  "記録の外でその心がその体にいて、心が入る・戻る描写も本文に無いなら、同時に成り立ちません。",
];

/** 体と心の照合で問うことの説明（identity 1.0） */
const VERIFY_IDENTITY_QUESTION =
  "問うのは、記録の範囲の外や記録に無い組で、その心がその体にいることを本文が説明しているかです。" +
  VERIFY_IDENTITY_KEEP_SENTENCES[0] +
  "本文に、その心がその体に入る・戻る・入れ替わる描写（憑依・交代・入れ替わりなど）が書かれていれば両立します。" +
  VERIFY_IDENTITY_KEEP_SENTENCES[1];

/**
 * 体と心の照合の「作中の変化」の説明（identity 1.0）。1.2 の説明（「人物の身の上が先へ進むのは
 * 矛盾ではありません」）は、心が別の体にいることをそのまま身の上の変化と読ませる
 */
const IDENTITY_CHANGE_TEXT = `**作中の変化** … 本文に、その心がその体に入る・戻る・入れ替わる描写が書かれている場合だけ。
   心が別の体にいることだけでは、これに当たりません。`;

/** 体と心の照合の「そもそも食い違っていない」の説明（identity 1.0）。口調の但し書きは要らない */
const IDENTITY_NO_CONFLICT_TEXT = `**そもそも食い違っていない** … コードの読み（その場面でどの心がその体を動かしているか）が本文と違っていて、両立する場合。`;

/** 体と心の照合の【採用すべき場合】に足す1文（identity 1.0） */
const IDENTITY_ADOPT_LINE =
  "\n体と心の指摘では、記録の外の心がその体にいて、心が入る・戻る描写も本文に無い場合も矛盾です。";

/** 体と心の照合の、出どころと材料の欄（identity 1.0） */
function identitySourceBlock(material: IdentityVerifyMaterial | undefined): string {
  const lines = [`\n【指摘の出どころ】\n${VERIFY_IDENTITY_SOURCE_NOTE}\n${VERIFY_IDENTITY_QUESTION}\n`];
  if (material?.record.trim()) {
    lines.push(`\n【心と体の記録】\n${material.record.trim()}\n`);
  }
  if (material?.reading.trim()) {
    lines.push(`\n【コードの読み】\n${material.reading.trim()}\n`);
  }
  return lines.join("");
}

/** 死亡後の登場から来た指摘の材料（death 1.0）。どれもコードが組んだ文 */
export interface DeathVerifyMaterial {
  /** コードの読み（候補の `reason`。「第2話 7行目に死亡の記録がある。第5話 1行目に『…』が出てくる」） */
  reading: string;
  /**
   * 死亡が書かれた箇所の前後（行番号付き）。確かめの窓（後ろ側の ±5行）に入っているとき・
   * 本文に無いときは空。**窓の外の死亡の行を見せないと、何が死んだと書かれたかを確かめられない**
   */
  deathContext: string;
}

/**
 * 死亡後の登場から来た指摘の、出どころの説明（death 1.0）。
 * **却下の理由の語（「作中の変化」「食い違っていない」など）を含めない**——指示の言葉は
 * そのまま答えに返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）
 */
export const VERIFY_DEATH_SOURCE_NOTE =
  "この指摘は、本文で死亡が書かれた人物が、そのあとの箇所の地の文にも出てくることを、コードが突き合わせて挙げたものです。";

/**
 * 死亡後の登場の「残せ」と言っている文（death 1.0）。却下の説明にこれを丸ごと写してきたら、
 * 自分で前提だと書きながら死亡の記述を理由に消そうとしているので、却下として受け取らない。
 * 1文目は e4b の取り下げ文（「死亡はその時点の事実の記述で、行動の描写とは矛盾しない」）への答え
 */
export const VERIFY_DEATH_KEEP_SENTENCES: readonly string[] = [
  "死亡の記述がその時点の出来事を書いたものであること自体は、この指摘の前提であって、両立の理由になりません。",
  "死んだあとにその人物が地の文で行動していて、それを説明する描写が本文に無いなら、同時に成り立ちません。",
];

/** 死亡後の登場で問うことの説明（death 1.0） */
const VERIFY_DEATH_QUESTION =
  "問うのは、死亡のあとに、地の文でその人物が行動していることが両立するかです。" +
  VERIFY_DEATH_KEEP_SENTENCES[0] +
  "本文に、幽霊・回想・夢・転生・憑依・噂・誤報（実は生きていた）などの描写があれば両立します。" +
  VERIFY_DEATH_KEEP_SENTENCES[1];

/**
 * 死亡後の登場の「作中の変化」の説明（death 1.0）。1.2 の説明（「人物の身の上が先へ進むのは
 * 矛盾ではありません」）は、死んだ人が出てくることまで身の上の変化と読ませうる
 */
const DEATH_CHANGE_TEXT = `**作中の変化** … 本文に、幽霊・転生・憑依・生き返り・実は生きていた（誤報）などの描写が書かれている場合だけ。
   死んだあとに出てくることだけでは、これに当たりません。`;

/**
 * 死亡後の登場の「そもそも食い違っていない」の説明（death 1.0）。口調の但し書きは要らない。
 * 2行目は e4b の取り下げ文をそのまま当てはまらないと書く
 */
const DEATH_NO_CONFLICT_TEXT = `**そもそも食い違っていない** … コードの読み（誰が死んだか・あとで出てくるのが同じ人物か・回想や夢の中か）が本文と違っていて、両立する場合。
   死亡がその時点の事実の記述であることだけでは、これに当たりません。`;

/** 死亡後の登場の【採用すべき場合】に足す1文（death 1.0） */
const DEATH_ADOPT_LINE =
  "\n死亡の指摘では、死んだ人物があとの話の地の文で行動していて、それを説明する描写が本文に無い場合も矛盾です。";

/** 死亡後の登場の、出どころと材料の欄（death 1.0） */
function deathSourceBlock(material: DeathVerifyMaterial | undefined): string {
  const lines = [`\n【指摘の出どころ】\n${VERIFY_DEATH_SOURCE_NOTE}\n${VERIFY_DEATH_QUESTION}\n`];
  if (material?.reading.trim()) {
    lines.push(`\n【コードの読み】\n${material.reading.trim()}\n`);
  }
  if (material?.deathContext.trim()) {
    lines.push(`\n【死亡の箇所の前後】\n${material.deathContext.trim()}\n`);
  }
  return lines.join("");
}

export function buildContradictionVerifyPrompt(
  input: ContradictionVerifyInput
): string {
  const small = input.smallModel ?? false;
  const future = input.source === "future";
  const travel = input.source === "travel";
  const identity = input.source === "identity";
  const death = input.source === "death";
  const knownAt =
    input.settingKnownAt ||
    (future ? VERIFY_KNOWN_AT_NONE_FUTURE : small ? VERIFY_KNOWN_AT_NONE_SMALL : "（不明）");
  const reasons = verifyRejectReasonsFor(input);
  const reasonText = (reason: VerifyRejectReason): string => {
    if (future && reason === "作中の変化") return FUTURE_CHANGE_TEXT;
    if (travel && reason === "作中の変化") return TRAVEL_CHANGE_TEXT;
    if (travel && reason === "そもそも食い違っていない") return TRAVEL_NO_CONFLICT_TEXT;
    if (identity && reason === "作中の変化") return IDENTITY_CHANGE_TEXT;
    if (identity && reason === "そもそも食い違っていない") return IDENTITY_NO_CONFLICT_TEXT;
    if (death && reason === "作中の変化") return DEATH_CHANGE_TEXT;
    if (death && reason === "そもそも食い違っていない") return DEATH_NO_CONFLICT_TEXT;
    return REJECT_REASON_TEXTS[reason];
  };
  const reasonItems = reasons
    .map((reason, index) => `${index + 1}. ${reasonText(reason)}`)
    .join("\n");
  // 本命（settled）では何も足さない。1.2 と1文字も変えないため、欄ごと出さない
  const sourceBlock = future
    ? futureSourceBlock(input)
    : travel
      ? travelSourceBlock(input.travel)
      : identity
        ? identitySourceBlock(input.identity)
        : death
          ? deathSourceBlock(input.death)
          : "";
  const adoptExtra = travel
    ? TRAVEL_ADOPT_LINE
    : identity
      ? IDENTITY_ADOPT_LINE
      : death
        ? DEATH_ADOPT_LINE
        : "";
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
${sourceBlock}
【却下すべき場合】
次のどれかに当てはまるなら、矛盾ではありません。

${reasonItems}

【採用すべき場合】
**両方が同時に成り立たないときだけ**です。とくに、
地の文（語り手の記述）どうしが食い違っている場合は矛盾です。
台詞が、話している人物の設定と違う一人称・丁寧さの段・話し方の種類で話していて、
本文にきっかけが描かれていない場合も矛盾です。${adoptExtra}

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
