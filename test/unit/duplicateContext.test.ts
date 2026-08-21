import { describe, it, expect } from "vitest";
import { wouldDuplicateContext } from "../../src/core/typoCheckValidation";

/**
 * 当てると本文が二重になる修正案を弾く（設計書6.8.11）。
 *
 * **実際に原稿が壊れた**（2026-08-21、作者が実機で発見）。AIが
 * `target`（直す語）と `original`（その周り）を取り違え、文まるごとの
 * 書き換えを `suggestion` に入れてくる。コードは `target` の位置だけを
 * 置き換えるので、**修正案が抱え込んだ前後の文が二重に残る。**
 *
 * 下の4件は、**実データで実際に原稿を壊したもの**である。
 */

/** 適用したらどうなるか。壊れ方を目で確かめられるようにする */
function apply(original: string, target: string, suggestion: string): string {
  const at = original.indexOf(target);
  return original.slice(0, at) + suggestion + original.slice(at + target.length);
}

const 実際に壊れた4件 = [
  {
    name: "第9話 48行目",
    original: "「あんたが望むなら、夢で会わすぐらいのことはできるんだがね」",
    target: "会わすぐらい",
    suggestion: "夢で会わせるくらいのことはできるんだがね",
  },
  {
    name: "第3話 75行目",
    original:
      "「母親さ。元々悪霊に狙われていたのは母親のほうでね。魂を喰われたの子は母親を護ろうとしたらしいんだよ。あんたとあたしがいれば、母親を護りやすいかと思ってたのさ」",
    target: "喰われたの子は",
    suggestion: "魂を喰われた子は母親を護ろうとしたらしいんだよ。",
  },
  {
    name: "第5話 40行目",
    original:
      "一族は相当なお金持ちらしく、恨みもかっていたのだろう。大量の呪詛で一人では全部祓えなかったので、ばあさん様々だ。",
    target: "かっていた",
    suggestion: "恨みもかけていたのだろう",
  },
  {
    name: "第1話 31行目",
    original: "同時に、手足の冷たさがはっきりとと分かる。",
    target: "とと",
    suggestion: "はっきりと分かる",
  },
];

describe("実際に原稿を壊した4件を弾く", () => {
  for (const item of 実際に壊れた4件) {
    it(`${item.name}`, () => {
      // まず、当てると本当に二重になることを見せる
      const broken = apply(item.original, item.target, item.suggestion);
      expect(broken).not.toBe(item.original);
      expect(broken.length).toBeGreaterThan(item.original.length);

      // そのうえで、検査が弾くこと
      expect(
        wouldDuplicateContext(item.original, item.target, item.suggestion)
      ).toBe(true);
    });
  }
});

describe("まっとうな修正案は通す", () => {
  const 通すべき = [
    {
      name: "同音異義語の直し",
      original: "それは意外な結末だった。",
      target: "意外",
      suggestion: "以外",
    },
    {
      name: "送り仮名",
      original: "彼は行なう。",
      target: "行なう",
      suggestion: "行う",
    },
    {
      name: "促音の脱字",
      original: "彼は走つた。",
      target: "走つた",
      suggestion: "走った",
    },
    {
      name: "三点リーダーを偶数にする",
      original: "「………」と彼は言った。",
      target: "………",
      suggestion: "…………",
    },
    {
      name: "助詞の脱字（前後と重ならない）",
      original: "空飛べて壁もすり抜けられるのか。",
      target: "空飛べて",
      suggestion: "空を飛べて",
    },
    {
      name: "1文字だけの偶然の一致は弾かない",
      // 「の」が直前にあり修正案の先頭も「の」だが、これは偶然である
      original: "彼女の乃木坂へ行く。",
      target: "乃木坂",
      suggestion: "の木坂",
    },
  ];

  for (const item of 通すべき) {
    it(`${item.name}`, () => {
      expect(
        wouldDuplicateContext(item.original, item.target, item.suggestion)
      ).toBe(false);
    });
  }
});

describe("端の扱い", () => {
  it("target が見つからなければ何も言わない", () => {
    // 別の検査（target_not_in_original）が先に弾く
    expect(wouldDuplicateContext("あいうえお", "かきく", "けこ")).toBe(false);
  });

  it("行頭の target は、前の重なりを見ない", () => {
    expect(wouldDuplicateContext("走つた。", "走つた", "走った")).toBe(false);
  });

  it("行末の target は、後ろの重なりを見ない", () => {
    expect(wouldDuplicateContext("彼は走つた", "走つた", "走った")).toBe(false);
  });
});
