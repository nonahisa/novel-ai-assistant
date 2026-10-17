/**
 * ソースの文字列から、目印（関数の頭など）に続く `{ ... }` の塊を切り出す
 * （2026-10-17。単体テストの前準備の写しを寄せた）。
 *
 * ## なぜここにあるのか
 *
 * 「この関数の中では、あの口を通っている」「あの書き方をしていない」を
 * 確かめるソース読みの試験が、波かっこを数えて関数の本体を切り出す `bodyOf` を
 * 11ファイルに写していた。数え方はどれも同じなので1本にする。
 *
 * **コメントを落とすかどうかは呼ぶ側が決める。** コメントに書いた言葉で
 * 検査が通ってしまうのを避けたい試験は、落としてから渡す（写す前もそうしていた）。
 *
 * 文字列やテンプレートの中の波かっこは数え分けない（写す前と同じ）。
 * 切り出す先の関数の中に、対になっていない波かっこを含む文字列があると狂う。
 */

export interface BlockOptions {
  /**
   * 開きの波かっこをどこから探すか。
   *
   * - `"afterParen"`（既定）：目印のあとの最初の `)` のさらにあと。引数の型に
   *   `{ ... }` が入る関数の頭（`f(options: { a: string })`）で、型の波かっこを本体と取り違えない
   * - `"afterMarker"`：目印のすぐあと（画面の中の素の JavaScript など、目印に `)` まで含めたもの）
   */
  readonly openAt?: "afterParen" | "afterMarker";
}

/** 目印に続く塊を返す。目印が無い・閉じが無いときは `undefined` */
export function findBlockAfter(
  text: string,
  marker: string,
  options: BlockOptions = {}
): string | undefined {
  const start = text.indexOf(marker);
  if (start === -1) return undefined;
  const open =
    options.openAt === "afterMarker"
      ? text.indexOf("{", start)
      : text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/**
 * 目印に続く塊を返す。**目印が無い・閉じが無いときは投げる**（試験を落とす）。
 * `where` には読んだファイルの名前などを渡すと、落ちたときの文に出る。
 */
export function blockAfter(
  text: string,
  marker: string,
  options: BlockOptions & { readonly where?: string } = {}
): string {
  if (!text.includes(marker)) {
    throw new Error(`${options.where ? `${options.where} に ` : ""}${marker} が見つかりません`);
  }
  const block = findBlockAfter(text, marker, options);
  if (block === undefined) throw new Error(`${marker} の閉じ括弧が見つかりません`);
  return block;
}
