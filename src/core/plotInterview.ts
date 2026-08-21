import { PLOT_SECTIONS, type PlotSectionKey, type PlotSections } from "./plotDoc";

/**
 * 対話でプロットを作る（設計書6.4.7）。
 *
 * **AIに筋書きを作らせない。** まだ何も書いていない作品でAIに「プロットを
 * 作って」と頼むと、材料なしに話を丸ごと組み立てることになり、
 * **作者のものではない話**が出てくる（6.21.2で確かめた）。
 *
 * ここでやるのは**引き出すこと**である。作者の中にあるものを1項目ずつ
 * 尋ね、答えを整えて `plot.md` へ置く。書くのは作者がボタンを押したときだけ。
 *
 * ## 欄に閉じ込めない
 *
 * 設計書6.4は「専用のWebViewエディタ」を構想していたが、6.4.1で
 * **「この文書を欄に閉じ込める形にはしない」**と決めた。`plot.md` は
 * 作者が自由に書けるMarkdownのままにして、対話は相談パネルで行う。
 *
 * ## 問いはコードで持つ
 *
 * ここでAIを呼ぶと、最初の一言に数十秒待たされる（6.21.2と同じ理由）。
 * **どの項目で何を尋ねるかは決まっている**ので、コードに置く。
 */

/** 対話で尋ねる項目と、その順 */
export interface PlotQuestion {
  key: PlotSectionKey;
  /** `plot.md` の見出し */
  heading: string;
  /** 何のための項目か。1行で */
  purpose: string;
  /** 作者へ出す問い。**引き出す形にする** */
  question: string;
  /** 押すだけで答えられる例。作者が言葉に詰まったとき用 */
  options: string[];
}

/**
 * 尋ねる順。
 *
 * **ログラインを先に置く。** 話を一言で言えると、テーマも世界観も
 * そこから決まっていく。逆に世界観から始めると、話の無い設定だけが増える。
 *
 * **タイトル・形式・ジャンルは尋ねない。** タイトルは作品を作るときに
 * 決めており、形式とジャンルは「形式とジャンルを決める」で選ぶ（6.4.4）。
 * 同じことを2か所で聞かない。
 */
export const PLOT_QUESTIONS: readonly PlotQuestion[] = [
  {
    key: "logline",
    heading: "ログライン",
    purpose: "話を一言で言えるようにする",
    question:
      "その話を一言で言うと、どうなりますか。\n" +
      "「誰が」「どんな状況で」「何を目指し」「何に阻まれるか」が入ると、あとで迷いません。",
    options: [
      "主人公は決まっています",
      "書きたい場面が1つだけあります",
      "状況から考えたい",
    ],
  },
  {
    key: "theme",
    heading: "テーマ",
    purpose: "読み終えた人に何が残るかを決める",
    question:
      "読み終えた人に、何が残ってほしいですか。\n" +
      "うまく言えなくて構いません。近い言葉でどうぞ。",
    options: ["まだ決めていません", "言葉にしづらい"],
  },
  {
    key: "worldview",
    heading: "世界観",
    purpose: "現実と何が違うかを決める",
    question:
      "この話の世界は、現実と何が違いますか。\n" +
      "違いは1つでも構いません。現実そのままなら、そう書いておけます。",
    options: ["現実と同じです", "魔法がある", "近未来です"],
  },
  {
    key: "setting",
    heading: "舞台",
    purpose: "話が主に動く場所を決める",
    question: "話は主にどこで動きますか。",
    options: ["学校", "異世界", "現代の日本"],
  },
  {
    key: "narrativePerson",
    heading: "人称",
    purpose: "誰の目から書くかを決める",
    question:
      "誰の目から書きますか。\n" +
      "一人称（主人公の目）／三人称一元（一人に寄り添う）／三人称多元（視点が移る）があります。",
    options: ["一人称", "三人称一元", "三人称多元"],
  },
  {
    key: "protagonistMotive",
    heading: "主人公の行動原理",
    purpose: "主人公が動く理由を決める",
    question:
      "主人公は、なぜそれをするのですか。\n" +
      "ここが決まっていないと、話の途中で主人公が動かなくなります。",
    options: ["守りたいものがある", "取り戻したいものがある", "まだ決めていない"],
  },
  {
    key: "outline",
    heading: "あらすじ",
    purpose: "始まり・転機・終わりを置く",
    question:
      "始まり・転機・終わりの3つだけ、いま言えるところまで教えてください。\n" +
      "途中が空いていても構いません。",
    options: ["終わりは決まっています", "始まりだけ決まっています"],
  },
  {
    key: "mainCharacters",
    heading: "主要登場人物",
    purpose: "外せない人を挙げる",
    question:
      "主人公のほかに、外せない人は誰ですか。\n" +
      "名前が決まっていなければ「幼なじみ」のような呼び方で構いません。",
    options: ["主人公だけです", "相棒がいます", "敵役がいます"],
  },
  {
    key: "motif",
    heading: "モチーフ",
    purpose: "繰り返し出すものを決める",
    question:
      "話の中で繰り返し出したいもの（色・物・言葉）はありますか。\n" +
      "無ければ飛ばして構いません。",
    options: ["特にありません"],
  },
];

/** その節がまだ書かれていないか。ひな形の案内文は「書かれている」に数えない */
export function isBlank(value: string): boolean {
  const body = value
    .split("\n")
    .map((line) => line.trim())
    // ひな形が置く案内（HTMLコメント）と、箇条書きの空の印を落とす
    .filter((line) => line && line !== "-" && !/^<!--[\s\S]*-->$/.test(line))
    .join("");
  return body.length === 0;
}

/** まだ書かれていない項目を、尋ねる順に並べる */
export function pendingQuestions(sections: PlotSections): PlotQuestion[] {
  return PLOT_QUESTIONS.filter((question) => isBlank(sections[question.key]));
}

/** 次に尋ねる項目。全部埋まっていれば undefined */
export function nextQuestion(
  sections: PlotSections
): PlotQuestion | undefined {
  return pendingQuestions(sections)[0];
}

/**
 * どこまで進んだか。
 *
 * **残りの数を見せる。** 終わりが見えないと、作者はどこで切り上げて
 * よいのか分からない。
 */
export function describeProgress(sections: PlotSections): string {
  const total = PLOT_QUESTIONS.length;
  const remaining = pendingQuestions(sections).length;
  const done = total - remaining;
  return `${total}項目のうち${done}項目まで書けています`;
}

/** 見出しから節の鍵を引く。AIが返した書き込み先を照合するのに使う */
export function sectionKeyOf(heading: string): PlotSectionKey | undefined {
  return PLOT_SECTIONS.find((section) => section.heading === heading)?.key;
}
