import { describe, expect, it } from "vitest";
import { parseManuscriptRescue } from "../../../src/features/manuscriptEditor";

/**
 * ［開き直す］で画面から預かる控えの形（設計書6.25.9）。
 *
 * 拡張機能ホストが起動し直したあと、原稿エディターで打った約100字が
 * 一度もファイルへ届かなかった（2026-10-01、ノートPC、0.94.0）。開き直すと
 * 画面の状態は新しい画面へ引き継がれないので、拡張機能が控えを預かって渡す。
 * 画面から届く値は形を信用しない。
 */
describe("画面から届いた控えを確かめる", () => {
  const good = {
    docKey: "c:/作品/第1話.md",
    text: "打った字",
    at: 1_000,
    baseLength: 3,
    baseHash: "0123abcd",
  };

  it("形が揃っていれば受け取る", () => {
    expect(parseManuscriptRescue(good, good.docKey)).toEqual(good);
  });

  it("**別の文書の控えは受け取らない**", () => {
    expect(parseManuscriptRescue(good, "c:/作品/第2話.md")).toBeUndefined();
  });

  it("欠けた・型の違う控えは受け取らない", () => {
    expect(parseManuscriptRescue(null, good.docKey)).toBeUndefined();
    expect(parseManuscriptRescue("打った字", good.docKey)).toBeUndefined();
    expect(parseManuscriptRescue({ ...good, text: 1 }, good.docKey)).toBeUndefined();
    expect(parseManuscriptRescue({ ...good, at: "昨日" }, good.docKey)).toBeUndefined();
    const { baseHash: _omit, ...noHash } = good;
    expect(parseManuscriptRescue(noHash, good.docKey)).toBeUndefined();
  });

  it("余計な項目は運ばない", () => {
    const parsed = parseManuscriptRescue({ ...good, extra: "<script>" }, good.docKey);
    expect(parsed).toEqual(good);
  });
});
