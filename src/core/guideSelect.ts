import { bigrams } from "./bm25";

/**
 * 質問に関係しそうな「使い方の説明」だけを選ぶ。
 *
 * ## なぜ選ぶのか（2026-08-29）
 *
 * 相談パネルは、この拡張機能の使い方の説明を**1回の相談ごとに毎回**
 * 送っていた。機能を足すたびに自動で伸びるため、上限のテストを何度も
 * 引き上げる羽目になっていた（6,000→6,300字）。**送る量が機能数に
 * 比例する形そのものが行き止まり**である。
 *
 * そこで「**名前は全部**（目次）＋**説明は関係しそうな束だけ**」に分けた。
 * 名前さえ全部あれば「その機能はありません」と嘘を答える心配は残らない。
 * ここは後半、「関係しそうな束」を選ぶ部分を受け持つ。
 *
 * ## なぜAIに判定させないか
 *
 * 「使い方の質問か」をAIに聞くと、相談1回につき呼び出しが1回増える
 * （料金も待ち時間も倍に近づく）。文字2つ組みの一致で足りる。
 *
 * VS Code APIに依存しない。
 */

/** 説明の束。小分類ひとまとまりぶんの説明を想定している */
export interface GuideBundle {
  /** 呼び出し側が束を見分けるための鍵。記録に残すときに使う */
  key: string;
  /** 画面の階層をそのまま表した名前（例:「執筆AI支援 → 校正・校閲」） */
  label: string;
  /** AIへ渡す説明の本文。見出し行から始まる */
  text: string;
}

export interface GuideSelection {
  selected: GuideBundle[];
  /**
   * なぜその束になったか。
   *
   * - `matched`: 質問の語が束に当たった
   * - `none`: 当たる束が無い。作品の内容の相談か、漠然とした使い方の質問
   *
   * 当初は「使い方を教えて」のような**漠然とした使い方の質問**に、束を
   * メニュー順で渡す枝（`usage`）があった。だが先頭の束は作品管理→GitHub
   * であり、質問と関係の無い説明が付くだけだった。**目次に全操作の名前が
   * あるので、漠然とした質問には目次だけで答えさせる**（作者の指定、
   * 2026-08-29「目次だけにしましょう」）。
   */
  reason: "matched" | "none";
}

/**
 * 選んだ束の合計字数の上限。目次と合わせても、以前の全文より短く収まる幅。
 *
 * **外へ出してあるのは、手順書き（`core/procedures.ts`）と分け合うため。**
 * 手順書きを渡した回は、その字数だけ差し引いた予算で束を選ぶ——
 * 両方を満額で渡すと、節約したはずの量が元に戻る。
 */
export const DEFAULT_BUNDLE_BUDGET = 3000;

/**
 * 話題に当たったと見なすのに要る、2文字組みの数。
 *
 * 1個で採っていたため、点が同じ束がメニュー順に上限まで詰め込まれていた
 * （作品の相談に3,000字近い説明が付いた）。機能名は2文字より長いので、
 * 本当に機能を指している質問は2組み以上当たる（「誤字」「字脱」「脱字」）。
 *
 * **手順書きの選び手（`core/procedures.ts`）も同じ数を使う。** 束と手順書きで
 * 当たりの厳しさが違うと、「説明は付くのに手順書きは付かない」（またはその逆）が
 * 起き、どちらの規則が効いたのかを後から説明できない。
 */
export const MIN_EVIDENCE_HITS = 2;

/**
 * 質問に関係しそうな束を選ぶ。
 *
 * 直前の作者の発言も材料にする。「それはどこ？」のような追い質問は、
 * それ自体には機能名が入っていない。**話題は直前の発言が持っている。**
 */
export function selectGuideBundles(input: {
  question: string;
  /** 直前の作者の発言。無ければ空 */
  recentAuthorTurns?: string[];
  bundles: GuideBundle[];
  /** 選んだ束の合計字数の上限。既定 3000 */
  budget?: number;
}): GuideSelection {
  const budget = input.budget ?? DEFAULT_BUNDLE_BUDGET;
  const grams = evidenceGrams([
    input.question,
    ...(input.recentAuthorTurns ?? []),
  ]);

  const terms = featureNameTermsIn([
    input.question,
    ...(input.recentAuthorTurns ?? []),
  ]);

  const scored = input.bundles
    .map((bundle) => ({
      bundle,
      score:
        countGramHits(bundle.text, grams) +
        // 機能の名前は1語で話題を名指しているので、それだけで当たりに届かせる
        // （`FEATURE_NAME_TERMS` の説明）
        terms.filter((term) => bundle.text.includes(term)).length *
          MIN_EVIDENCE_HITS,
    }))
    // **1個では偶然と区別できない。** 束はどれも数百字あるので、
    // 当たりが1つなら「その話題の説明がある」根拠にならない
    // （実データでは「描写」1個で校正の説明が付いていた）
    .filter((entry) => entry.score >= MIN_EVIDENCE_HITS);

  if (scored.length > 0) {
    // 点の高い順。同点は元の並び（メニュー順）のまま——`sort` は安定なので、
    // 作者が画面で見ている順序が保たれる
    scored.sort((a, b) => b.score - a.score);
    const selected = fit(
      scored.map((entry) => entry.bundle),
      budget
    );
    if (selected.length > 0) return { selected, reason: "matched" };
  }

  // 作品の内容についての相談か、機能名の無い漠然とした質問。
  // 説明を送っても邪魔になるだけで、後者は目次（全操作の名前）で答えられる
  return { selected: [], reason: "none" };
}

/**
 * その2文字組みを「当たりの証拠」として使ってよいか。
 *
 * 採るのは**漢字だけの組み**（「誤字」「表記」「同期」「抽出」）と、
 * **英字だけの組み**（「EP」「PU」「UB」＝EPUB、「PD」「DF」＝PDF）だけ。
 *
 * ## なぜここまで絞るか（2026-09-11）
 *
 * 以前はひらがなだけの組みを捨てていたが、**句読点を含む組み**（「す。」
 * 「、も」「か？」）と**かなを混ぜた組み**（「の場」「面の」「は読」
 * 「の話」）が残っていた。これらは日本語のどんな文にも入るので、説明の
 * 本文には必ず当たる。実データ10問で測ると、作品の相談8問に2,057〜3,047字
 * の機能説明が付き、ひどいものは**「す。」の1組みだけ**で9束が選ばれていた
 * （2026-09-11の測定）。**助詞・活用語尾・約物は、話題の証拠にならない。**
 *
 * カタカナも落とす。「タイトルはこれでいいと思う？」のような作品の相談が
 * 「タイ」「イト」「トル」で説明を引き寄せてしまい、漢字だけにしないと
 * 10問すべてを目次だけにできなかった（同じ測定）。
 *
 * **ただし、捨てたままでは「ルビを振りたい」がどの束にも当たらない。** 当たらないと
 * 話題の見分けが創作の相談と言い切り、目次ごと落ちていた（2026-09-25）。
 * 機能を名指すカタカナの語は、下の `FEATURE_NAME_TERMS` で別に拾う。
 */
function isEvidenceGram(gram: string): boolean {
  return /^\p{Script=Han}{2}$/u.test(gram) || /^[A-Za-z]{2}$/.test(gram);
}

/**
 * 質問（と直前の発言）から、話題の証拠になる2文字組みを集める。
 *
 * **文ごとに割ってから混ぜる。** つないでから割ると、質問の末尾と
 * 直前の発言の先頭にまたがる、どこにも無い組みができる。
 *
 * **手順書きの選び手（`core/procedures.ts`）もここを呼ぶ。** 採る組みの
 * 規則（漢字だけ・英字だけ）は上の `isEvidenceGram` の説明にある長い経緯の
 * 結果なので、写しを作ると片方だけ古くなる。
 */
export function evidenceGrams(sources: readonly string[]): Set<string> {
  const grams = new Set<string>();
  for (const source of sources) {
    for (const gram of bigrams(source)) {
      if (!isEvidenceGram(gram)) continue;
      grams.add(gram);
    }
  }
  return grams;
}

/**
 * 1語で機能を名指している名前。質問に入っていれば、**その語を含む束は
 * それだけで当たり**とする（2026-09-25）。
 *
 * ## なぜ要るか
 *
 * 上の `isEvidenceGram` はカタカナを捨て、漢字も2組み以上を求める。
 * そのため「ルビを振りたい」（証拠の組みが0）、「傍点を付けたい」（「傍点」の
 * 1組みだけ）、「音声読み上げはある？」（「音声」の1組みだけ）は、どの束にも
 * 当たらなかった。束に当たらないと話題の見分け（`chatTopic.ts`）が創作の相談と
 * 言い切り、**目次ごと落ちる**。実接続では、目次に「原稿読み上げ」があるのに
 * AIが「この拡張機能には備わっておりません」と答えた（2026-09-25 深夜の測定）。
 *
 * ## なぜ一覧を手で持つか——カタカナを戻すのではない
 *
 * カタカナを捨てたのは、「タイトル」「テーマ」「プロット」のような**作品の
 * 相談で普通に使う語**が説明を引き寄せたためだった（2026-09-11の測定）。
 * カタカナをまるごと戻すと同じことが起きる。ここに並べるのは、
 * **作品の相談にはまず出てこず、出れば機能の話をしている語**だけである。
 *
 * - 入れない語：プロット・タイトル・テーマ・シーン・キャラ・スキル・ジャンル
 *   ・シリーズ・メモ（作品の中身の話で日常的に使う）。「音読」も入れない
 *   （「音読み」に含まれる）
 * - 語は束の本文（操作の名前か説明）に実際に出てくるものに限る
 *   （`featureGuideKatakana.test.ts` が見張る）。束に無い語は当てる先が無い
 *
 * **カタカナの語は、前後がカタカナのときは当たりにしない。** 「ルビー」という
 * 人物名の「ルビ」を拾うと、その人物の相談が操作の相談になる。
 */
export const FEATURE_NAME_TERMS: readonly string[] = [
  // 原稿整備
  "ルビ",
  "傍点",
  "縦書き",
  "読み上げ",
  "章立て",
  // 口述筆記
  "口述",
  // 取り込み・投稿・広報
  "バックアップ",
  "ハッシュタグ",
  "ランキング",
  // 資料の閲覧
  "年表",
  // AIまわり
  "チューニング",
  "ベクトル",
];

/** 前後にカタカナが続くか（「ルビー」の「ルビ」を名前の一部と見分ける） */
const KATAKANA = /[\p{Script=Katakana}ー]/u;

/**
 * 質問（と直前の発言）に入っている機能の名前（`FEATURE_NAME_TERMS`）。
 *
 * 前後がカタカナの所は数えない。語の端がカタカナでない（「傍点」「縦書き」の
 * 末尾など）ときは、その側は見ない——漢字の語は隣の漢字と続いて熟語になるが
 * （「傍点付与」）、それは名前の一部で、別の語に化けるわけではない。
 */
export function featureNameTermsIn(sources: readonly string[]): string[] {
  const found = new Set<string>();
  for (const term of FEATURE_NAME_TERMS) {
    const guardHead = KATAKANA.test(term[0]);
    const guardTail = KATAKANA.test(term[term.length - 1]);
    for (const source of sources) {
      let at = source.indexOf(term);
      while (at >= 0) {
        const before = source[at - 1] ?? "";
        const after = source[at + term.length] ?? "";
        const clean =
          !(guardHead && before && KATAKANA.test(before)) &&
          !(guardTail && after && KATAKANA.test(after));
        if (clean) {
          found.add(term);
          break;
        }
        at = source.indexOf(term, at + 1);
      }
      if (found.has(term)) break;
    }
  }
  return [...found];
}

/** 質問側の組みのうち、渡した文の中に現れるものの数 */
export function countGramHits(
  text: string,
  grams: ReadonlySet<string>
): number {
  let hits = 0;
  for (const gram of grams) {
    if (text.includes(gram)) hits++;
  }
  return hits;
}

/**
 * 上限に収まるところまで採る。
 *
 * **入らなかった束を飛ばして、後ろの短い束を拾わない。** 隙間を埋める
 * ほうが字数は使い切れるが、「関係の薄い説明が来て、濃い説明が無い」
 * という並びになり、後から見て何が渡ったのか説明がつかなくなる。
 */
function fit(bundles: GuideBundle[], budget: number): GuideBundle[] {
  const selected: GuideBundle[] = [];
  let total = 0;
  for (const bundle of bundles) {
    const next = total + bundle.text.length;
    if (next > budget) break;
    selected.push(bundle);
    total = next;
  }
  return selected;
}
