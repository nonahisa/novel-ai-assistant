/**
 * モデルが吐く「バイトのまま」の文字を、元の文字へ戻す。
 *
 * ## 何が起きるか
 *
 * 語彙に無い珍しい漢字に当たると、モデルは1文字を分解して
 * `<0xE5><0x9B><0xAE>` のようなバイト表記で出すことがある
 * （SentencePiece系のバイト・フォールバック）。
 * 実データで、各話あらすじに「囮」が
 * `<0xE5><0x9B><0xAE>` として残っていた（2026-08-15、実機で発覚）。
 *
 * 作者からは意味の分からない記号にしか見えず、しかも**そのまま
 * 資料ファイルへ保存される**。放置できない。
 *
 * ## 安全側に倒す
 *
 * **UTF-8として正しく読める並びだけを戻す。** 途中で切れていたり、
 * 順序がおかしい並びは、勝手に別の文字へ化けさせるより
 * そのまま残したほうがよい（作者が異常に気づける）。
 *
 * **1バイトだけの並びは戻さない。** `<0x41>` は 'A' だが、
 * これはバイト・フォールバックではなく本文にそう書いてある可能性がある。
 * 珍しい漢字の取りこぼしは必ず複数バイトになる。
 *
 * VS Code APIに依存しない。
 */

/** `<0xNN>` が1つ以上続く並び */
const BYTE_RUN = /(?:<0x[0-9A-Fa-f]{2}>)+/g;

export function decodeByteFallback(text: string): string {
  if (!text.includes("<0x")) return text;

  return text.replace(BYTE_RUN, (run) => {
    const bytes = [...run.matchAll(/<0x([0-9A-Fa-f]{2})>/g)].map((match) =>
      parseInt(match[1], 16)
    );

    // 1バイトだけなら、本文にそう書いてある可能性を優先して触らない
    if (bytes.length < 2) return run;
    // ASCIIだけの並びも、バイト・フォールバックとは考えにくい
    if (bytes.every((byte) => byte < 0x80)) return run;

    try {
      // fatal にして、UTF-8として読めない並びは例外にする。
      // 読めないものを無理に置き換えると、別の文字へ化ける
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(bytes)
      );
      return decoded;
    } catch {
      return run;
    }
  });
}

/** 直せる文字化けが含まれているか。ログに件数を残すために使う */
export function countByteFallback(text: string): number {
  if (!text.includes("<0x")) return 0;
  let count = 0;
  for (const match of text.matchAll(BYTE_RUN)) {
    if (decodeByteFallback(match[0]) !== match[0]) count++;
  }
  return count;
}
