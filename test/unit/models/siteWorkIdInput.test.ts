import { describe, expect, test } from "vitest";
import { validateSiteWorkIdInput } from "../../../src/models/posting";

/**
 * 作品IDを入れたときの確かめ（作者の判断 2026-11-01）。
 *
 * アルファポリスの作品IDは数字9桁（投稿画面の URL の末尾）。ヘルパーはこの9桁で
 * 貼り込み先を照合するので、違う形のまま入ると、あとで取り違えとして止まる。
 * **入れたその場で、どこを写すかまで言う。** 空は通す（作品IDは任意の欄）。
 */

describe("アルファポリスの作品ID", () => {
  test("数字9桁なら通す（前後の空白は見ない）", () => {
    expect(validateSiteWorkIdInput("alphapolis", "123456789")).toBeNull();
    expect(validateSiteWorkIdInput("alphapolis", " 123456789 ")).toBeNull();
  });

  test("空は通す（任意の欄）", () => {
    expect(validateSiteWorkIdInput("alphapolis", "")).toBeNull();
    expect(validateSiteWorkIdInput("alphapolis", "   ")).toBeNull();
  });

  test.each(["12345678", "1234567890", "12345/678901234", "abcdefghi", "１２３４５６７８９"])(
    "%s は、投稿画面の URL の末尾の9桁を入れるよう案内する",
    (value) => {
      const message = validateSiteWorkIdInput("alphapolis", value);
      expect(message).toContain("投稿画面の URL の末尾の9桁の数字を入れてください");
    }
  );

  test("ほかのサイトの作品IDは、これまでどおり形を問わない", () => {
    expect(validateSiteWorkIdInput("narou", "n1234ab")).toBeNull();
    expect(validateSiteWorkIdInput("kakuyomu", "16816927859")).toBeNull();
    expect(validateSiteWorkIdInput("note", "なんでも")).toBeNull();
  });
});
