import { describe, expect, test } from "vitest";
import {
  countByteFallback,
  decodeByteFallback,
} from "../../src/core/byteFallback";

/**
 * 実データで見つかった不具合の再現（2026-08-15）。
 *
 * 各話あらすじに「囮」が `<0xE5><0x9B><0xAE>` のまま残っていた。
 * 語彙に無い漢字をモデルがバイトへ分解して返すためで、
 * 作者からは意味の分からない記号にしか見えないうえ、
 * そのまま資料ファイルへ保存されていた。
 */
describe("バイト表記のまま返った文字を戻す", () => {
  test("実データで出た「囮」を戻せる", () => {
    const text = "「僕」は時間を稼ぐため<0xE5><0x9B><0xAE>となり、リナに逃げるよう促す。";

    expect(decodeByteFallback(text)).toBe(
      "「僕」は時間を稼ぐため囮となり、リナに逃げるよう促す。"
    );
  });

  test("1つの文に複数あっても戻せる", () => {
    const text = "<0xE5><0x9B><0xAE>と<0xE5><0x9B><0xAE>";

    expect(decodeByteFallback(text)).toBe("囮と囮");
  });

  test("含まれていなければそのまま返す", () => {
    const text = "普通のあらすじです。";

    expect(decodeByteFallback(text)).toBe(text);
  });

  test("1バイトだけの並びは触らない", () => {
    // <0x41> は 'A' だが、本文にそう書いてある可能性を優先する。
    // 珍しい漢字の取りこぼしは必ず複数バイトになる
    expect(decodeByteFallback("型番は<0x41>です")).toBe("型番は<0x41>です");
  });

  test("ASCIIだけの並びも触らない", () => {
    expect(decodeByteFallback("<0x41><0x42>")).toBe("<0x41><0x42>");
  });

  test("UTF-8として読めない並びは残す", () => {
    // 無理に置き換えると別の文字へ化ける。
    // そのまま残せば、作者が異常に気づける
    const broken = "<0xE5><0x9B>";

    expect(decodeByteFallback(broken)).toBe(broken);
  });

  test("先頭バイトが不正な並びも残す", () => {
    const broken = "<0x80><0x9B><0xAE>";

    expect(decodeByteFallback(broken)).toBe(broken);
  });

  test("小文字の16進でも読める", () => {
    expect(decodeByteFallback("<0xe5><0x9b><0xae>")).toBe("囮");
  });

  test("戻した件数を数えられる", () => {
    // ログに残して、モデルの癖に気づけるようにする
    const text = "<0xE5><0x9B><0xAE>と<0xE5><0x9B><0xAE>と<0x41>";

    expect(countByteFallback(text)).toBe(2);
  });

  test("何も無ければ0件", () => {
    expect(countByteFallback("普通の文章")).toBe(0);
  });
});
