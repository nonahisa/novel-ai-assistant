import { describe, expect, test } from "vitest";
import {
  bodyForPosting,
  extractEpisodeParts,
  nameWithSubtitle,
} from "../../src/core/episodeCopy";

/**
 * サブタイトル・本文のコピーと、ファイル名への付与（設計書6.2.3）。
 *
 * **投稿するときの手作業を減らす。** 投稿欄はサブタイトルと本文が別々の
 * 入力になっている。毎話、ファイルを開いてヘッダーを避けて本文を選んで、
 * ルビを書き換えて……を繰り返すのは、書く時間を削る。
 */
const WITH_HEADER = [
  "【タイトル】",
  "転生",
  "",
  "【公開状態】",
  "公開",
  "",
  "【本文】",
  "気がつくと{森|もり}の中だった。",
].join("\n");

describe("サブタイトルと本文を取り出す", () => {
  test("ヘッダーがあれば、そこから読む", () => {
    const parts = extractEpisodeParts(WITH_HEADER, null);

    expect(parts.subtitle).toBe("転生");
    expect(parts.body).toContain("気がつくと");
    // **ヘッダーは本文に含めない**
    expect(parts.body).not.toContain("【公開状態】");
  });

  test("ファイルの中の題を、ファイル名より優先する", () => {
    // **ファイル名は作者が自由に変えられるが、
    // 中の【タイトル】は投稿したときの題そのものである**
    expect(extractEpisodeParts(WITH_HEADER, "べつの題").subtitle).toBe("転生");
  });

  test("ヘッダーが無ければ、全体が本文", () => {
    const parts = extractEpisodeParts("ただの本文。", "ファイル名の題");

    expect(parts.body).toBe("ただの本文。");
    expect(parts.subtitle).toBe("ファイル名の題");
  });

  test("どこにも題が無ければ null", () => {
    expect(extractEpisodeParts("本文だけ。", null).subtitle).toBeNull();
  });
});

describe("投稿サイト用の本文", () => {
  test("ルビを投稿サイトの記法へ直す", () => {
    const parts = extractEpisodeParts(WITH_HEADER, null);

    expect(bodyForPosting(parts.body, "site")).toContain("｜森《もり》");
  });

  test("HTMLでも出せる", () => {
    expect(bodyForPosting("{森|もり}", "html")).toBe(
      "<ruby>森<rt>もり</rt></ruby>"
    );
  });

  test("前後の空行を落とす", () => {
    // **投稿欄の先頭に空行が入ると、1行目が空いた状態で公開される**
    expect(bodyForPosting("\n\n本文。\n\n", "site")).toBe("本文。");
  });

  test("ルビが無ければ、本文はそのまま", () => {
    expect(bodyForPosting("ただの本文。", "site")).toBe("ただの本文。");
  });
});

describe("ファイル名にサブタイトルを付ける", () => {
  test("話数の後ろに足す", () => {
    // **話数の部分は変えない。** そこは並び順を決めている
    expect(nameWithSubtitle("episode_0001.txt", null, "転生")).toBe(
      "episode_0001_転生.txt"
    );
  });

  test("既に同じものが付いていれば、何もしない", () => {
    expect(
      nameWithSubtitle("episode_0001_転生.txt", "転生", "転生")
    ).toBeUndefined();
  });

  test("違う題なら、付け替える（重ねない）", () => {
    // **重ねると episode_0001_転生_出会い.txt になる**
    expect(nameWithSubtitle("episode_0001_転生.txt", "転生", "出会い")).toBe(
      "episode_0001_出会い.txt"
    );
  });

  test("題が無ければ、何もしない", () => {
    expect(nameWithSubtitle("episode_0001.txt", null, null)).toBeUndefined();
    expect(nameWithSubtitle("episode_0001.txt", null, "  ")).toBeUndefined();
  });

  test("ファイル名に使えない記号を落とす", () => {
    const next = nameWithSubtitle("episode_0001.txt", null, "第一章/序");

    expect(next).toBeDefined();
    expect(next).not.toContain("/");
  });

  test("拡張子は変えない", () => {
    expect(nameWithSubtitle("episode_0001.md", null, "転生")).toBe(
      "episode_0001_転生.md"
    );
  });
});
