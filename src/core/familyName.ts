/**
 * 姓（苗字）の取り出しと、姓＋名の形の判定（設計書6.5.9）。
 *
 * **独立したファイルにしてある。** 元は `characterMerge.ts` の中にあったが、
 * 抽出の検算（`characterExtractionValidation.ts`）も同じ判定を要る。
 * `characterMerge` は既に `characterExtractionValidation` を import しており、
 * 逆向きに import すると循環になる。写しを作るほうが危ないので、
 * **両方が呼べる場所へ出した**（判定の実体は1つだけ）。
 *
 * ここは純粋関数だけを置く。VSCode API にもファイル操作にも依存しない。
 */

/** 漢字を1文字でも含むか */
export const HAS_KANJI = /[一-鿿㐀-䶿]/u;

/** 姓とみなせる長さ。「密倉」「三門」「春原」「長谷川」まで */
export const MAX_FAMILY_NAME_LENGTH = 3;

/**
 * 姓として拾う最小の長さ。
 *
 * 「林」「森」のような1字の姓は実在するが、1字で拾うと「中神鷹人」から
 * 「中」が、「田中」「田村」から「田」が姓として立ってしまう。
 * 姓を使う側は**別名を落とす**判定なので、取りこぼすほうへ倒す。
 */
const MIN_FAMILY_NAME_LENGTH = 2;

/**
 * 姓名を繋げた名前と、名だけの名前か（「密倉文佳」と「文佳」）。
 *
 * **日本語の名前は空白で区切られないことが多い。** `splitNameParts` は
 * 空白・中黒がある場合しか分解しないので、「密倉文佳」からは何も取り出せず、
 * 後から「文佳」が出てきても別人として登録される（実データで起きた）。
 *
 * `isSuffixCallOf` は3字以上しか見ない。日本語の名は2字が多いので、
 * 「文佳」「月夜」「太志」はそこを通れない。3字の下限は
 * 「先生」「さん」のような語で候補が溢れるのを防ぐためだった。
 * そこでこちらは**漢字であること**を条件にして、2字から拾えるようにする。
 *
 * **統合はしない。候補として出すだけ。** 「太郎」と「金太郎」のように
 * 別人の可能性は残るので、判断は作者に委ねる（`findMergeCandidates` の方針）。
 */
export function isFamilyNameForm(shorter: string, longer: string): boolean {
  const left = shorter.trim();
  const right = longer.trim();

  // 1字だと「子」「郎」のような字で無関係な組が大量に並ぶ
  if (left.length < 2) return false;
  if (!right.endsWith(left)) return false;

  const family = right.slice(0, right.length - left.length);
  if (family.length < 1 || family.length > MAX_FAMILY_NAME_LENGTH) return false;

  // 姓と名の両方が漢字であること。カタカナ名の省略は isAbbreviationOf が見る。
  // ひらがなだけの語（「ちゃん」「さん」）を姓とみなさないためでもある
  return HAS_KANJI.test(left) && HAS_KANJI.test(family);
}

/**
 * その名前が名乗っている姓の候補（「中神 鷹人」「中神隼人」→「中神」）。
 *
 * 姓として読める形が無ければ空を返す。**切る位置は総当たりする**——
 * 日本語の名前は空白で区切られないことが多く、どこまでが姓かは
 * 名前だけからは決まらないためである（「長谷川太郎」は「長谷」でも
 * 「長谷川」でも読める）。読める形をすべて返し、**2人以上が名乗る姓か
 * どうかは呼び出し側が数えて決める**。
 *
 * 判定そのものは `isFamilyNameForm` に委ねる（写しを作らない）。
 */
export function familyNameCandidates(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const found = new Set<string>();

  // 「中神 蓮」のように名が1字だと、下の総当たりでは拾えない
  // （`isFamilyNameForm` は名を2字以上とする）。
  // 空白で区切られているときは、どこが姓かが書かれている
  const parts = trimmed.split(/[\s　]+/u).filter((part) => part.length > 0);
  if (parts.length >= 2) {
    const head = parts[0];
    const rest = parts.slice(1).join("");
    if (
      head.length >= MIN_FAMILY_NAME_LENGTH &&
      head.length <= MAX_FAMILY_NAME_LENGTH &&
      HAS_KANJI.test(head) &&
      HAS_KANJI.test(rest)
    ) {
      found.add(head);
    }
  }

  const bare = trimmed.replace(/[\s　]/gu, "");
  for (
    let cut = MIN_FAMILY_NAME_LENGTH;
    cut <= MAX_FAMILY_NAME_LENGTH && cut < bare.length;
    cut++
  ) {
    if (isFamilyNameForm(bare.slice(cut), bare)) found.add(bare.slice(0, cut));
  }

  return [...found];
}
