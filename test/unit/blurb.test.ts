import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {},
  workspace: { fs: {} },
  commands: {},
}));

import {
  buildSynopsisMarkdown,
  parseSynopsisMarkdown,
} from "../../src/core/synopsisDoc";
import {
  parseBlurbResponse,
  parseCatchphraseResponse,
} from "../../src/features/generateBlurb";
import {
  buildBlurbPrompt,
  buildCatchphrasePrompt,
} from "../../src/prompts/blurb";

describe("synopsis.md の組み立てと読み取り", () => {
  test("キャッチコピーは見出しの直後に置く", () => {
    const md = buildSynopsisMarkdown("図書塔の魔女", {
      catchphrase: "その塔は、忘れた名前を覚えている。",
      blurb: "紹介文の本体。",
    });

    expect(md).toBe(
      "# 図書塔の魔女\n\n> その塔は、忘れた名前を覚えている。\n\n紹介文の本体。\n"
    );
  });

  test("書いたものをそのまま読み戻せる", () => {
    const doc = { catchphrase: "コピー", blurb: "紹介文。\n\n2段落目。" };

    expect(parseSynopsisMarkdown(buildSynopsisMarkdown("作品", doc))).toEqual(
      doc
    );
  });

  test("キャッチコピーが無くても読める", () => {
    expect(parseSynopsisMarkdown("# 作品\n\n紹介文だけ。\n")).toEqual({
      catchphrase: null,
      blurb: "紹介文だけ。",
    });
  });

  test("本文中の引用はキャッチコピーとして拾わない", () => {
    // 紹介文のあとに作者が書いた引用まで持ち上げると、文章が消える
    const doc = parseSynopsisMarkdown(
      "# 作品\n\n紹介文。\n\n> 作中の一節を引いたメモ\n"
    );

    expect(doc.catchphrase).toBeNull();
    expect(doc.blurb).toContain("作中の一節を引いたメモ");
  });

  test("想定外の書式でも中身を捨てない", () => {
    // 読み取れなかったぶんを落とすと、上書き時に作者の文章が消える
    const doc = parseSynopsisMarkdown("作者が自由に書いたメモ\n箇条書き\n");

    expect(doc.blurb).toContain("作者が自由に書いたメモ");
    expect(doc.blurb).toContain("箇条書き");
  });

  test("各話あらすじは紹介文の下に載せる", () => {
    const md = buildSynopsisMarkdown(
      "作品",
      { catchphrase: null, blurb: "紹介文。" },
      "### 第1話\n\n灯が幽霊になる。"
    );

    expect(md).toContain("紹介文。");
    expect(md).toContain("## 各話あらすじ");
    expect(md.indexOf("紹介文。")).toBeLessThan(md.indexOf("## 各話あらすじ"));
  });

  test("あらすじが無ければ見出しごと出さない", () => {
    const md = buildSynopsisMarkdown("作品", {
      catchphrase: null,
      blurb: "紹介文。",
    });

    expect(md).not.toContain("## 各話あらすじ");
  });

  test("読み戻してもあらすじを紹介文に取り込まない（二重に積もらせない）", () => {
    // 書くたびに あらすじ を紹介文へ吸収すると、保存のたびに文書が
    // ふくらみ、最後には紹介文がどれか分からなくなる
    const doc = { catchphrase: "コピー", blurb: "紹介文。" };
    const first = buildSynopsisMarkdown("作品", doc, "### 第1話\n\nあらすじ本文。");

    const readBack = parseSynopsisMarkdown(first);
    expect(readBack).toEqual(doc);

    // もう一度組み立てても同じ文書になる
    const second = buildSynopsisMarkdown(
      "作品",
      readBack,
      "### 第1話\n\nあらすじ本文。"
    );
    expect(second).toBe(first);
  });
});

describe("応答の読み取り", () => {
  test("紹介文はコードフェンス付きでも読める", () => {
    expect(
      parseBlurbResponse('```json\n{"blurb":"紹介文","spoilerCheck":null}\n```')
    ).toEqual({ blurb: "紹介文", spoilerCheck: null });
  });

  test("紹介文が空なら失敗として扱う", () => {
    expect(parseBlurbResponse('{"blurb":"   "}')).toBeNull();
    expect(parseBlurbResponse("ただの文章")).toBeNull();
  });

  test("キャッチコピーは形の違う要素を落として読む", () => {
    const result = parseCatchphraseResponse(
      JSON.stringify({
        catchphrases: [
          { text: " 案1 ", kind: "謎・引き型", intent: "狙い" },
          { notText: "壊れた要素" },
          { text: "案2" },
        ],
      })
    );

    expect(result).toEqual([
      { text: "案1", kind: "謎・引き型", intent: "狙い" },
      { text: "案2", kind: "", intent: null },
    ]);
  });
});

describe("プロンプト", () => {
  test("紹介文では中身の無い煽り文句を禁じる", () => {
    const prompt = buildBlurbPrompt({
      workTitle: "図書塔の魔女",
      plot: "",
      openingExcerpt: "本文",
      chapterSynopses: [],
    });

    expect(prompt).toContain("中身の無い煽り文句を使わない");
    expect(prompt).toContain("ネタバレ");
    // 材料が無いことを黙って隠さない
    expect(prompt).toContain("（まだ書かれていません）");
  });

  test("却下した案を渡して重複を避けさせる", () => {
    const prompt = buildCatchphrasePrompt({
      workTitle: "作品",
      plot: "",
      blurb: "",
      openingExcerpt: "本文",
      rejected: ["前に出た案"],
    });

    expect(prompt).toContain("前に出た案");
    expect(prompt).toContain("実質的に同じものを出さないこと");
  });
});
