/**
 * 本文を検索単位（場面）へ切る、葉の部品。
 *
 * **ここは何にも依存しない。** 相談パネルの検索母材（`retrievalCorpus.ts`）と
 * 矛盾検知の過去場面（`pastSceneSelect.ts`）が同じ切り方を使うので、
 * どちらか一方の都合を持ち込まない場所へ置いてある。
 *
 * 元は `retrievalCorpus.ts` にあったが、あちらは設定資料の台帳
 * （`characterStore` など）を読むために VS Code API を引き込む。
 * 純粋関数だけの `pastSceneSelect.ts` が切り方のためだけにそれを
 * 巻き込むのは筋が悪いので、切り方だけをここへ移した
 * （`retrievalCorpus.ts` は再exportで従来どおり使える）。
 */

/** 本文を切る単位。相談パネルの抜粋窓（400字）に合わせる */
export const PASSAGE_CHARS = 400;
/** 隣の場面と重ねる量。場面の切れ目で文脈が消えるのを防ぐ */
export const PASSAGE_OVERLAP = 100;

/**
 * 本文を検索単位へ切る。
 *
 * **行の切れ目に合わせる。** 小説は1行が短いので、行の途中で切ると
 * 台詞が半分になって読めなくなる。
 */
export function splitPassages(
  text: string,
  size = PASSAGE_CHARS,
  overlap = PASSAGE_OVERLAP
): string[] {
  const lines = text.split(/\r?\n/);
  const passages: string[] = [];
  let buffer: string[] = [];
  let length = 0;

  const flush = (): void => {
    const body = buffer.join("\n").trim();
    if (body) passages.push(body);
    // 重なりぶんを次へ持ち越す
    const carry: string[] = [];
    let carryLength = 0;
    for (let i = buffer.length - 1; i >= 0 && carryLength < overlap; i--) {
      carry.unshift(buffer[i]);
      carryLength += buffer[i].length + 1;
    }
    buffer = carry;
    length = carryLength;
  };

  for (const line of lines) {
    buffer.push(line);
    length += line.length + 1;
    if (length >= size) flush();
  }
  const rest = buffer.join("\n").trim();
  // 最後の塊は、持ち越しだけで中身が無いことがある
  if (rest && !passages.includes(rest)) passages.push(rest);

  return passages;
}
