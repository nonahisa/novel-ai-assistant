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
   * - `usage`: 語は当たらないが、使い方を尋ねる言い回しだった
   * - `none`: 作品の内容の相談とみなし、説明は送らない
   */
  reason: "matched" | "usage" | "none";
}

/**
 * 「使い方を尋ねている」と読める言い回し。
 *
 * 機能名が1つも当たらなくても、**漠然と使い方を聞かれることはある**
 * （「使い方を教えて」「何ができるの」）。そのときに説明を1つも送らないと、
 * 目次の名前だけで答えることになり、案内が薄くなる。
 *
 * 「できる？」は全角・半角のどちらの疑問符でも書かれるので両方を持つ。
 */
const USAGE_WORDS = [
  "使い方",
  "どうやって",
  "どうすれば",
  "どこ",
  "やり方",
  "方法",
  "できますか",
  "できる？",
  "できる?",
  "機能",
  "操作",
  "メニュー",
  "ボタン",
  "設定",
  "コマンド",
  "押す",
];

/** 選んだ束の合計字数の上限。目次と合わせても、以前の全文より短く収まる幅 */
const DEFAULT_BUDGET = 3000;

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
  const budget = input.budget ?? DEFAULT_BUDGET;
  const sources = [input.question, ...(input.recentAuthorTurns ?? [])];

  // **文ごとに割ってから混ぜる。** つないでから割ると、質問の末尾と
  // 直前の発言の先頭にまたがる、どこにも無い組みができる
  const grams = new Set<string>();
  for (const source of sources) {
    for (const gram of bigrams(source)) {
      if (isKanaOnly(gram)) continue;
      grams.add(gram);
    }
  }

  const scored = input.bundles
    .map((bundle) => ({
      bundle,
      score: countHits(bundle.text, grams),
    }))
    .filter((entry) => entry.score > 0);

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

  // 機能名は当たらないが、使い方を尋ねている——目次だけでは案内が薄いので、
  // メニュー順に入るだけ渡す
  const asked = sources.some((source) =>
    USAGE_WORDS.some((word) => source.includes(word))
  );
  if (asked) {
    const selected = fit(input.bundles, budget);
    if (selected.length > 0) return { selected, reason: "usage" };
  }

  // 作品の内容についての相談。説明を送っても邪魔になるだけである
  return { selected: [], reason: "none" };
}

/**
 * ひらがなだけの組みか。
 *
 * 「はど」「ます」「です」のような助詞・活用は、**どの束にも当たる**ので
 * 絞り込みにならない。機能の名前は漢字・カタカナ・英字でできている
 * （誤字脱字・ルビ・プロット・PDF）ので、落としても取りこぼさない。
 */
function isKanaOnly(gram: string): boolean {
  return /^[ぁ-ゟー]+$/.test(gram);
}

/** 質問側の組みのうち、束の中に現れるものの数 */
function countHits(text: string, grams: ReadonlySet<string>): number {
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
