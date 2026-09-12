import { looksArchaicText } from "./typoCheckValidation";

/**
 * 作品の作法（設計書6.8.14）——**本文と作者の設定から組み立てる部分だけ**。
 *
 * `plot.md` を読む `readNarrativePerson` は `workStyle.ts` に残してある
 * （あちらは `vscode` を通る）。ここは純粋なので、外から呼ぶ束
 * （設計書6.87.8）からも同じ文体メモを組み立てられる。
 *
 * **AIには、その作品固有のことが何も分からない。** 誤字脱字のプロンプトには
 * 「方言・古語・キャラクターの口癖は指摘しない」と書いてあるが、
 * **どれがそれなのかを渡していなかった。**
 *
 * その結果、コード側で後から弾く規則が3つ増えた。
 *
 * | 弾いている規則 | 本当は何を知らないのか |
 * |---|---|
 * | `isPronounSwap` | 語り手の一人称が「僕」であること |
 * | `isArchaicForm` | この作品が文語体で書かれていること |
 * | `kept_word` | 作者が直さないと決めた語 |
 *
 * **知らないことを、コードで後始末していた。** 先に伝えれば、
 * そもそも生まれる誤検出が減る。
 *
 * ## それでもコードの検証は外さない
 *
 * この作品では「指示を書いても守られない」ことを何度も測っている
 * （誤字脱字は64件中62件が素通り、推敲は修正案が10件中10件空）。
 * **作法を渡すのは「生まれる数を減らす」ため**であって、
 * 「原稿に入れない」のはコードの仕事である。両方いる。
 *
 * ## 短く保つ
 *
 * ここはチャンクごとに毎回送られる。長くすると、まとめ送信（6.8.10）で
 * 減らした送信量が戻ってしまう。**分かっていることだけを、1行ずつ書く。**
 */

/** 語り手の一人称の候補。長いものから見る（「私たち」を「私」と数えない） */
const FIRST_PERSON_CANDIDATES = [
  "わたくし",
  "あたし",
  "わたし",
  "拙者",
  "小生",
  "自分",
  "うち",
  "わし",
  "ぼく",
  "おれ",
  "儂",
  "私",
  "僕",
  "俺",
] as const;

/**
 * 数える前に落とす複数形。
 *
 * **「私たち」を「私」と数えない。** 語り手の一人称は単数で、
 * 複数形は「僕ら」のように別の語である。先に取り除いておく。
 */
const PLURAL_FORMS = [
  "わたくしたち",
  "わたしたち",
  "あたしたち",
  "私たち",
  "僕たち",
  "俺たち",
  "私達",
  "僕達",
  "俺達",
  "僕ら",
  "俺ら",
  "我々",
  "吾々",
] as const;

/** 台詞の外だけを見るために落とす範囲 */
const DIALOGUE = /[「『][^」』]*[」』]/gu;

/** これ以上出てこなければ、語り手の一人称とは言えない */
const MIN_FIRST_PERSON_HITS = 10;
/**
 * 全体に占める割合。**競っているなら決めない。**
 *
 * ちょうど半々のときに決めてしまうと、もう一方の一人称を
 * 「誤り」として扱わせることになる。差が付いているときだけ言う。
 */
const MIN_FIRST_PERSON_SHARE = 0.6;

export interface WorkStyleFacts {
  /** `plot.md` の「人称」。空なら書かれていない */
  narrativePerson: string;
  /** 地の文から数えた、語り手の一人称。決められなければ null */
  firstPerson: string | null;
  /** 作者が「直さない」と決めた語 */
  keepWords: string[];
  /** 文語体で書かれているとみられるか */
  archaic: boolean;
}

/**
 * 地の文で使われている一人称を数える。
 *
 * **台詞は落とす。** 登場人物はそれぞれ違う一人称を使うので、
 * 混ぜて数えると語り手のものが埋もれる。
 *
 * **競っているなら決めない。** 三人称の作品では誰の一人称も
 * 突出しないので、そこで無理に決めると嘘を教えることになる。
 */
export function detectFirstPerson(bodyText: string): string | null {
  let narration = bodyText.replace(DIALOGUE, "");
  if (narration.length < 500) return null;
  // 複数形を先に落とす（「私たち」を「私」と数えないため）
  for (const plural of PLURAL_FORMS) {
    narration = narration.split(plural).join(" ");
  }

  const counts = new Map<string, number>();
  // 長い候補から取り除きながら数える。「私たち」を「私」と数えないため
  let rest = narration;
  for (const word of FIRST_PERSON_CANDIDATES) {
    const parts = rest.split(word);
    const hits = parts.length - 1;
    if (hits > 0) counts.set(word, hits);
    rest = parts.join("\u0000");
  }

  let best: { word: string; hits: number } | null = null;
  let total = 0;
  for (const [word, hits] of counts) {
    total += hits;
    if (!best || hits > best.hits) best = { word, hits };
  }

  if (!best || best.hits < MIN_FIRST_PERSON_HITS) return null;
  if (best.hits / total < MIN_FIRST_PERSON_SHARE) return null;
  return best.word;
}

/** 本文と作者の設定から、その作品の作法をまとめる */
export function collectWorkStyle(input: {
  bodyText: string;
  narrativePerson: string;
  keepWords: string[];
}): WorkStyleFacts {
  return {
    narrativePerson: input.narrativePerson.trim(),
    firstPerson: detectFirstPerson(input.bodyText),
    keepWords: input.keepWords.map((word) => word.trim()).filter(Boolean),
    archaic: looksArchaicText(input.bodyText),
  };
}

/** 作法として書き出す語の上限。長くすると毎回の送信量が増える */
const KEEP_WORD_LIMIT = 80;

/**
 * AIへ渡す形にする。
 *
 * **分かっていることが何も無ければ、空文字を返す。** 「登録されていません」と
 * 書いて送るのは、送信量を増やすだけで何も伝えていない。
 */
export function buildStyleNote(facts: WorkStyleFacts): string {
  const lines: string[] = [];

  if (facts.firstPerson) {
    lines.push(
      `- 語り手の一人称は「${facts.firstPerson}」。ほかの一人称へ置き換えないこと`
    );
  } else if (facts.narrativePerson) {
    lines.push(`- 人称: ${facts.narrativePerson}`);
  }

  if (facts.archaic) {
    lines.push(
      "- 文語体・旧字旧かなで書かれている。現代表記へ直す提案はしないこと" +
        "（「然し」「呉れた」「與へて」などはこのままが正しい）"
    );
  }

  if (facts.keepWords.length > 0) {
    const shown = facts.keepWords.slice(0, KEEP_WORD_LIMIT);
    lines.push(
      `- 作者が「直さない」と決めた語（活用形も含めて指摘しないこと）: ${shown.join("、")}`
    );
  }

  if (lines.length === 0) return "";
  return `【この作品の書き方】（ここから外れる直しは提案しないこと）\n${lines.join("\n")}`;
}
