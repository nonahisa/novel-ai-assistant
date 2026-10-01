/**
 * 抽出した読み（`reading`）が、名前と食い違っていないかの粗い検算（作者の裁定、2026-10-01）。
 *
 * 実際に起きたこと：「叡智の天使」の読みに「じしょうてんし」（別名「自称天使」の読み）、
 * 「マイナ様」の読みに「まいなせんせい」（別名「マイナ先生」の読み）が入った。
 * AIは別名の読みを本人の読みの欄へ書いてしまう。
 *
 * **判断の考え方**（誤検出＝正しい読みを落とすこと、を避けるほうを優先する）：
 * 1. 名前の中の仮名（カタカナはひらがなへ直す）が、読みの中に**順に**現れなければ食い違い。
 *    「叡智の天使」の仮名は「の」だけで、「じしょうてんし」には無い。
 * 2. 名前の先頭・末尾に漢字があるとき、仮名の前後に余る読みの長さは、漢字1字あたり
 *    3音までとする。「マイナ様」の「様」は1字なので「さま」(2) は通り、
 *    「せんせい」(4) は別の語の読みを足したものとして落とす。
 *    漢字が無い側の余りは、長音の言い換え（るーしー／るうしい）を見込んで2音まで。
 * 3. 判断の材料が足りないものは**通す**。漢字だけの名前（仮名が無い）、英数字を含む名前、
 *    読みが仮名以外を含むもの。AIの読みを疑うより、正しい読みを落とさないことを選ぶ。
 */

const KANJI_RE = /[㐀-鿿々〆豈-﫿]/;
/** ひらがな・カタカナ（長音「ー」と中黒は読みの揺れなので仮名に数えず、比べる前に除く） */
const KANA_RE = /[ぁ-ゖァ-ヺ]/;
const IGNORED_RE = /[ー・・\s　]/g;

/** 漢字1字あたりの読みの長さの上限（「蝶」ちょう、「麗」れいなど3音までを見込む） */
const READING_PER_KANJI = 3;
/** 漢字の無い側の余り（長音の言い換えなど）の許容 */
const SLACK_WITHOUT_KANJI = 2;

function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

/** 名前に対して、読みが食い違っているとみなすか。迷うときは false（通す） */
export function isReadingInconsistentWithName(
  name: string,
  reading: string
): boolean {
  const readingChars = [...toHiragana(reading.replace(IGNORED_RE, ""))];
  if (readingChars.length === 0) return false;
  // 読みが仮名だけでなければ（漢字・英字が混ざる）、この検算の対象外
  if (!readingChars.every((ch) => KANA_RE.test(ch))) return false;

  const nameChars = [...name.replace(IGNORED_RE, "")];
  const kanaIndexes: number[] = [];
  for (let i = 0; i < nameChars.length; i++) {
    const ch = nameChars[i];
    if (KANA_RE.test(ch)) kanaIndexes.push(i);
    else if (!KANJI_RE.test(ch)) return false; // 英数字などを含む名前は見ない
  }
  if (kanaIndexes.length === 0) return false; // 漢字だけの名前は確かめようがない

  // 名前の仮名が、読みの中に順に現れるか（最も左の対応を取る）
  const kana = kanaIndexes.map((i) => toHiragana(nameChars[i]));
  let cursor = 0;
  let firstAt = -1;
  let lastEnd = 0;
  for (const ch of kana) {
    const at = readingChars.indexOf(ch, cursor);
    if (at < 0) return true;
    if (firstAt < 0) firstAt = at;
    cursor = at + 1;
    lastEnd = cursor;
  }

  // 仮名の前後に余った読みが、先頭・末尾の漢字で説明できる長さか
  const leadingKanji = kanaIndexes[0];
  const trailingKanji = nameChars.length - 1 - kanaIndexes[kanaIndexes.length - 1];
  const headSurplus = firstAt;
  const tailSurplus = readingChars.length - lastEnd;
  const limit = (kanjiCount: number): number =>
    kanjiCount > 0 ? kanjiCount * READING_PER_KANJI : SLACK_WITHOUT_KANJI;
  return headSurplus > limit(leadingKanji) || tailSurplus > limit(trailingKanji);
}
