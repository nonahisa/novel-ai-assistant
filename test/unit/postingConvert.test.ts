import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  convertForPosting,
  noteCopyMessage,
} from "../../src/core/postingConvert";
import { postingCopyTargets } from "../../src/core/postingCopyTargets";
import { EXTRA_GUIDE, buildGuideBundles } from "../../src/features/featureGuide";
import { toNoteMarkdown } from "../../src/core/noteMarkdown";
import { toSiteNotation } from "../../src/core/ruby";

/**
 * 「投稿サイト用に変換してコピー」の変換（設計書6.84）。
 *
 * **貼り付け先で変換が変わるのは、ここ1か所だけにする。** 入口は3つ
 * あるので（普通のエディタ・作品一覧の右クリック・原稿エディタ）、
 * 入口ごとに分岐を書くと、noteへ貼ったときの形が入口によって違う。
 */

function targetFor(label: string) {
  const found = postingCopyTargets([]).find(
    (target) => target.label === label
  );
  expect(found, `${label} の貼り付け先が無い`).toBeTruthy();
  return found!;
}

const NOTE = targetFor("note");
const KAKUYOMU = targetFor("カクヨム");

describe("貼り付け先ごとの変換", () => {
  it("noteは、noteが読める形へ整える（`toNoteMarkdown` を通る）", () => {
    const source = "# 題名\n\n## 見出し\n\n{灯|あかり}が点る";
    const result = convertForPosting(source, NOTE);

    expect(result.text).toBe(toNoteMarkdown(source).body);
    expect(result.note?.title).toBe("題名");
    // 記法の変換だけ（`toSiteNotation`）では、題名が本文に残ってしまう
    expect(result.text).not.toContain("# 題名");
  });

  it("投稿サイトは、これまでどおり記法だけを変える", () => {
    const source = "{灯|あかり}が点る";
    const result = convertForPosting(source, KAKUYOMU);

    expect(result.text).toBe(
      toSiteNotation(source, KAKUYOMU.style, KAKUYOMU.emphasis)
    );
    // note用の情報は付かない（知らせの文面が変わらない）
    expect(result.note).toBeUndefined();
  });

  /** シーンメモは作者の付箋。**どの貼り付け先でも公開しない**（設計書6.40.2） */
  it("シーンメモは、どちらの経路でも落ちる", () => {
    expect(convertForPosting("// 付箋\n本文", NOTE).text).toBe("本文");
    expect(convertForPosting("// 付箋\n本文", KAKUYOMU).text).toBe("本文");
  });

  /** コードの中の `//` は付箋ではない（落とすとコードが壊れる） */
  it("noteでは、コードの中の `//` を落とさない", () => {
    const text = convertForPosting("```js\n// 説明\n```", NOTE).text;
    expect(text).toContain("// 説明");
  });
});

/**
 * コピーしたあとの知らせ（設計書6.81の規則3）。
 *
 * **貼り付けでは入らないものを、その場で言う。** 貼ってから気づくと、
 * 何が抜けたのかを探すところからやり直しになる。
 */
describe("noteへコピーしたときの知らせ", () => {
  const base = { images: [], embeds: [], warnings: [] };

  it("字数と、目次の入れ方を伝える", () => {
    const message = noteCopyMessage({ ...base, body: "本文" }, 1200);
    expect(message).toContain("1,200字");
    expect(message).toContain("目次");
  });

  it("画像は件数と、入れ方を伝える", () => {
    const message = noteCopyMessage(
      {
        ...base,
        body: "【画像：猫（cat.png）】",
        images: [{ alt: "猫", path: "cat.png", line: 1 }],
      },
      10
    );
    expect(message).toContain("画像1枚");
    expect(message).toContain("【画像：");
  });

  it("埋め込みは件数と、展開のしかたを伝える", () => {
    const message = noteCopyMessage(
      { ...base, body: "url", embeds: ["https://example.com/a"] },
      10
    );
    expect(message).toContain("埋め込み1件");
  });

  it("画像も埋め込みも無いときは、その話をしない", () => {
    const message = noteCopyMessage({ ...base, body: "本文" }, 10);
    expect(message).not.toContain("画像");
    expect(message).not.toContain("埋め込み");
  });

  /** noteで思ったとおりにならないものは、黙って落とさない */
  it("注意（表など）はそのまま伝える", () => {
    const message = noteCopyMessage(
      { ...base, body: "|a|", warnings: ["表はコピペでは入りません"] },
      10
    );
    expect(message).toContain("表はコピペでは入りません");
  });
});

/**
 * 入口は3つある（設計書6.12.4）。**同じ関数を通していること**を、
 * 書いてあるコードの形で見る（`postingCopyTargets.test.ts` と同じやり方）。
 */
describe("どの入口も、同じ変換を通る", () => {
  /**
   * 関数の中身だけを切り出す（`postingCopyTargets.test.ts` と同じ手）。
   * **波括弧を数えて閉じるところまで**にする——「次の関数の手前まで」だと
   * 関数のあいだの説明文まで拾い、そこに書かれた語で判定が揺れる。
   */
  function bodyOf(file: string, signature: string): string {
    const source = readFileSync(file, "utf8");
    const start = source.indexOf(signature);
    expect(start, `${signature} が ${file} にない`).toBeGreaterThan(-1);

    const open = source.indexOf("{", source.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error(`${signature} の終わりが見つかりません`);
  }

  const entries = [
    ["普通のエディタ", "src/features/ruby.ts", "export async function copyForPosting("],
    [
      "作品一覧の右クリック",
      "src/features/episodeCopy.ts",
      "export async function copyBodyForPosting(",
    ],
    [
      "原稿エディタ",
      "src/features/manuscriptEditor.ts",
      "private async copyForPosting(",
    ],
  ] as const;

  for (const [name, file, signature] of entries) {
    it(`${name}：貼り付け先ごとの分岐を自分で持たない`, () => {
      const body = bodyOf(file, signature);
      expect(body).toContain("convertForPosting(");
      // 記法の変換を直に呼ぶと、noteだけ整えない経路ができる
      expect(body).not.toContain("toSiteNotation(");
    });

    it(`${name}：シーンメモを先に落とさない`, () => {
      // **コードの中の `//` は付箋ではない**（設計書6.84）。落とす場所は
      // 記法を読み分けられる `convertForPosting` の側にしかない
      expect(bodyOf(file, signature)).not.toContain("stripMemoLines(");
    });

    it(`${name}：noteのときの知らせも、同じ関数を通る`, () => {
      // 入口ごとに文面を書くと、「画像は入りません」を言い忘れる口ができる
      expect(bodyOf(file, signature)).toContain("showPostingCopyNotice(");
    });
  }
});

/**
 * 相談へ渡す説明（設計書6.84）。
 *
 * **貼ったらどうなるかは、操作の説明では答えきれない。** 作者が訊くのは
 * 「note に貼ったら画像はどうなるの」であって、メニューの項目名ではない。
 */
describe("相談へ渡す「noteへ貼る」の説明", () => {
  it("EXTRA_GUIDE に note の節がある", () => {
    expect(EXTRA_GUIDE).toContain("【noteへ貼る】");
    // 手で入れることになる3つ（ここを外すと、貼ってから探すことになる）
    expect(EXTRA_GUIDE).toContain("題名");
    expect(EXTRA_GUIDE).toContain("目次");
    expect(EXTRA_GUIDE).toContain("【画像：");
    // 埋め込みの条件（1行に1つ）と、引用の空行の代用
    expect(EXTRA_GUIDE).toContain("1行に1つ");
    expect(EXTRA_GUIDE).toContain("全角スペース");
  });

  it("束として選べる（質問に当たったときだけ送る）", () => {
    const bundle = buildGuideBundles().find((entry) => entry.key === "note");
    expect(bundle, "noteへ貼るの束がない").toBeTruthy();
    expect(bundle?.label).toBe("noteへ貼る");
    expect(bundle?.text).toContain("【noteへ貼る】");
  });
});
