import { describe, expect, it } from "vitest";
import { parseManuscriptRescue, parseManuscriptRescues } from "../../../src/features/manuscriptEditor";

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

  it("重なって入らなかった字の控えの印（conflict: true）は運ぶ。true 以外は運ばない", () => {
    expect(parseManuscriptRescue({ ...good, conflict: true }, good.docKey)).toEqual({ ...good, conflict: true });
    expect(parseManuscriptRescue({ ...good, conflict: "はい" }, good.docKey)).toEqual(good);
  });
});

/**
 * 控えの置き場は2つ（帯の控え・未送信の字の控え。作者の裁定 2026-10-04）。［開き直す］では
 * 両方を預かる——片方だけ運ぶと、タブを閉じて開き直したときにもう片方が消える。
 */
describe("［開き直す］で預かる控えをまとめて確かめる", () => {
  const key = "c:/作品/第1話.md";
  const one = (text: string) => ({ docKey: key, text, at: 1, baseLength: 0, baseHash: "" });

  it("帯の控え→未送信の字の控えの順に、両方を預かる", () => {
    const parsed = parseManuscriptRescues([one("帯1"), one("帯2")], one("未送信"), key);
    expect(parsed.map((rescue) => rescue.text)).toEqual(["帯1", "帯2", "未送信"]);
  });

  it("形の悪いもの・別の文書のものは捨て、残りは預かる", () => {
    const parsed = parseManuscriptRescues(
      [one("帯"), { ...one("別の話"), docKey: "c:/作品/第2話.md" }, "壊れた"],
      null,
      key
    );
    expect(parsed.map((rescue) => rescue.text)).toEqual(["帯"]);
  });

  it("帯の控えが配列でなくても、未送信の字の控えは預かる（0.98.6 までの画面からの便）", () => {
    expect(parseManuscriptRescues(undefined, one("未送信"), key).map((rescue) => rescue.text)).toEqual(["未送信"]);
  });

  it("預かる数には上限がある（画面から届く値を信用しない）", () => {
    const many = Array.from({ length: 100 }, (_, index) => one(`帯${index}`));
    expect(parseManuscriptRescues(many, null, key).length).toBeLessThanOrEqual(20);
  });
});
