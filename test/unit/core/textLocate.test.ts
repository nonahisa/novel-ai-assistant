import { describe, expect, test } from "vitest";
import { findTextRange } from "../../src/core/textLocate";
import { parseChatLocate } from "../../src/core/chatEdit";

describe("該当箇所を探す", () => {
  const text = ["一行目です。", "二行目に探したい文があります。", "三行目です。"].join(
    "\n"
  );

  test("行と桁を返す", () => {
    const found = findTextRange(text, "探したい文");

    expect(found).toEqual({
      line: 1,
      character: 4,
      endLine: 1,
      endCharacter: 9,
    });
  });

  test("複数行にまたがる引用も指せる", () => {
    const found = findTextRange(text, "一行目です。\n二行目");

    expect(found?.line).toBe(0);
    expect(found?.endLine).toBe(1);
  });

  test("CRLFの本文でも行番号がずれない", () => {
    // \r\n を2文字と数えると、行の桁が1つずつずれる
    const crlf = text.replace(/\n/g, "\r\n");
    const found = findTextRange(crlf, "探したい文");

    expect(found?.line).toBe(1);
    expect(found?.character).toBe(4);
  });

  test("前後の空白だけの違いは吸収する", () => {
    const found = findTextRange(text, "  探したい文  ");

    expect(found?.line).toBe(1);
  });

  test("見つからなければ位置を返さない（別の場所を光らせない）", () => {
    // AIが少し言い換えた引用に対して近い場所を光らせると、
    // 作者は「そこは何も問題ないが」と混乱する
    expect(findTextRange(text, "探したかった文")).toBeUndefined();
    expect(findTextRange(text, "")).toBeUndefined();
  });

  test("同じ文字列が複数あれば最初の位置を返す", () => {
    const repeated = "同じ文\n別の行\n同じ文";
    const found = findTextRange(repeated, "同じ文");

    expect(found?.line).toBe(0);
  });
});

describe("「そこを見せて」の指示", () => {
  test("開いているファイルの中の箇所を指せる（pathは省略できる）", () => {
    const locate = parseChatLocate({ text: "気になる一文" });

    expect(locate?.path).toBeUndefined();
    expect(locate?.text).toBe("気になる一文");
    expect(locate?.label).toBe("該当箇所を開く");
  });

  test("別のファイルの箇所を指せる", () => {
    const locate = parseChatLocate({
      path: "episode_0003.txt",
      text: "一文",
      label: "第3話のその場面を見る",
    });

    expect(locate?.path).toBe("episode_0003.txt");
    expect(locate?.label).toBe("第3話のその場面を見る");
  });

  test("ファイルを開くだけの指示も作れる", () => {
    const locate = parseChatLocate({ path: "設定/plot.md" });

    expect(locate?.text).toBeUndefined();
    expect(locate?.label).toBe("設定/plot.md を開く");
  });

  test("作品の外を指すパスは受け付けない", () => {
    // 読み込みと同じ関門を通す。緩めると作品外のファイルを開かせられる
    for (const path of ["../他の作品/秘密.txt", "C:/Windows/system.ini", ".aiwriter/logs/actions.log"]) {
      expect(parseChatLocate({ path, text: "一文" }), path).toBeUndefined();
    }
  });

  test("パスも本文も無ければ受け付けない", () => {
    expect(parseChatLocate({})).toBeUndefined();
    expect(parseChatLocate({ label: "見る" })).toBeUndefined();
    expect(parseChatLocate("episode_0003.txt")).toBeUndefined();
  });
});
