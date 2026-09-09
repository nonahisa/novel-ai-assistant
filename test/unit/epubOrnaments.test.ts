import { describe, expect, test } from "vitest";
import {
  BUILTIN_ORNAMENTS,
  MAX_ORNAMENT_SVG_BYTES,
  buildOrnamentFragment,
  findOrnament,
  mergeOrnaments,
  sanitizeOrnamentSvg,
  unknownOrnamentIds,
  type OrnamentDef,
} from "../../src/core/epubOrnaments";

/**
 * 飾りの図録（設計書6.65.17）。
 *
 * 目次・中表紙・奥付に置く飾りを1か所で持つ。**画像ファイルは増やさない**
 * ——罫線はCSS、それ以外は断片の中に書いたSVGである（OPFのmanifestへ
 * 載せ忘れて「本は開くが飾りだけ出ない」を作らないため）。
 */

describe("組み込みの飾り", () => {
  test("6種以上あり、idは重複しない", () => {
    expect(BUILTIN_ORNAMENTS.length).toBeGreaterThanOrEqual(6);
    const ids = BUILTIN_ORNAMENTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("「なし」は必ず先頭にある（既定の見た目を選び直せる）", () => {
    expect(BUILTIN_ORNAMENTS[0].id).toBe("none");
  });

  test("どれにも日本語の呼び名がある", () => {
    for (const item of BUILTIN_ORNAMENTS) {
      expect(item.label.trim()).not.toBe("");
      expect(item.source).toBe("builtin");
    }
  });

  /**
   * **形の左右対称は目視でしか見られない**ので、ここでは形式だけを見る。
   * 縦組みの本では飾りが寝るため、左右非対称の絵は横倒しになる
   * （既存の「中央飾り」を菱形にしたのと同じ理由）。
   */
  test("SVGの飾りは、決めた形式で書かれている", () => {
    const drawn = BUILTIN_ORNAMENTS.filter((item) => item.svg);
    expect(drawn.length).toBeGreaterThanOrEqual(4);
    for (const item of drawn) {
      expect(item.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(item.svg).toContain('viewBox="0 0 24 24"');
      expect(item.svg).toContain('aria-hidden="true"');
      expect(item.svg).toContain('role="presentation"');
      expect(item.svg).toContain("currentColor");
      // 取り込む飾りと同じ検査を、組み込みの飾り自身も通ること
      expect(sanitizeOrnamentSvg(item.svg as string).ok).toBe(true);
    }
  });

  test("罫線の飾りはSVGを持たない（CSSで引く）", () => {
    const rule = findOrnament("rule", BUILTIN_ORNAMENTS);
    const doubleRule = findOrnament("double-rule", BUILTIN_ORNAMENTS);
    expect(rule?.css).toBe("rule");
    expect(rule?.svg).toBeUndefined();
    expect(doubleRule?.css).toBe("double-rule");
    expect(doubleRule?.svg).toBeUndefined();
  });
});

describe("飾りの断片を組む", () => {
  test("「なし」は1文字も出さない", () => {
    expect(buildOrnamentFragment("none", BUILTIN_ORNAMENTS)).toBe("");
  });

  test("罫線はCSSの印だけ", () => {
    expect(buildOrnamentFragment("rule", BUILTIN_ORNAMENTS)).toBe(
      '<span class="ornament ornament-rule"></span>'
    );
    expect(buildOrnamentFragment("double-rule", BUILTIN_ORNAMENTS)).toBe(
      '<span class="ornament ornament-double-rule"></span>'
    );
  });

  /** 第1段からの本の中身を変えない（菱形の中央飾りはそのまま） */
  test("中央飾りは、いままでと1文字も変わらない", () => {
    expect(buildOrnamentFragment("center", BUILTIN_ORNAMENTS)).toBe(
      '<span class="ornament ornament-center">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' +
        ' width="24" height="24" aria-hidden="true" role="presentation">' +
        '<path d="M12 2 L16 12 L12 22 L8 12 Z" fill="currentColor" />' +
        "</svg></span>"
    );
  });

  /**
   * **知らない id で本を壊さない**（設計書6.65.17）。book.json に書かれた
   * 飾りが図録から消えている（共通フォルダーを外した等）ことは起こりうる。
   */
  test("知らないidは「なし」と同じ扱い", () => {
    expect(buildOrnamentFragment("しらない飾り", BUILTIN_ORNAMENTS)).toBe("");
    expect(unknownOrnamentIds(["none", "rule", "花"], BUILTIN_ORNAMENTS)).toEqual(
      ["花"]
    );
  });

  test("外から足した飾りも同じ形で出る", () => {
    const extra: OrnamentDef = {
      id: "うちの花",
      label: "うちの花",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" role="presentation"><circle cx="12" cy="12" r="5" fill="currentColor" /></svg>',
      source: "work",
    };
    const fragment = buildOrnamentFragment("うちの花", [
      ...BUILTIN_ORNAMENTS,
      extra,
    ]);
    expect(fragment).toContain('class="ornament ornament-center"');
    expect(fragment).toContain("<circle");
  });
});

describe("図録を重ねる", () => {
  const work: OrnamentDef = {
    id: "うちの花",
    label: "うちの花",
    css: "rule",
    source: "work",
  };
  const shared: OrnamentDef = {
    id: "共通の花",
    label: "共通の花",
    css: "rule",
    source: "shared",
  };

  test("組み込み → 作品 → 共通 の順に並ぶ", () => {
    const merged = mergeOrnaments(BUILTIN_ORNAMENTS, [work], [shared]);
    const ids = merged.catalogue.map((item) => item.id);
    expect(ids.slice(0, BUILTIN_ORNAMENTS.length)).toEqual(
      BUILTIN_ORNAMENTS.map((item) => item.id)
    );
    expect(ids[ids.length - 2]).toBe("うちの花");
    expect(ids[ids.length - 1]).toBe("共通の花");
  });

  /**
   * **先勝ち。** 後勝ちにすると、共通フォルダーへ `rule.svg` を1つ置いた
   * だけで、その端末のすべての本の罫線が黙って変わる。
   */
  test("idがぶつかったら先勝ち（組み込みは上書きできない）", () => {
    const merged = mergeOrnaments(
      BUILTIN_ORNAMENTS,
      [{ id: "rule", label: "にせ罫線", css: "double-rule", source: "work" }],
      []
    );
    expect(findOrnament("rule", merged.catalogue)?.label).toBe(
      findOrnament("rule", BUILTIN_ORNAMENTS)?.label
    );
    expect(merged.shadowed).toEqual(["rule"]);
  });
});

/**
 * 取り込むSVGの検査（設計書6.65.17）。
 *
 * **通ったものだけを本へ入れる。** 外から来たSVGは、本の中で開かれる
 * XHTMLの一部になる——スクリプトや外部参照が混じると、本が壊れるか、
 * 読者の端末が知らないところへ通信する。
 */
describe("取り込むSVGを検査して整える", () => {
  const plain =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M12 2 L16 12 L12 22 L8 12 Z" fill="currentColor"/></svg>';

  function reason(text: string): string {
    const result = sanitizeOrnamentSvg(text);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  }

  test("素直なSVGは通る", () => {
    const result = sanitizeOrnamentSvg(plain);
    expect(result.ok).toBe(true);
  });

  test("整形式でなければ断る", () => {
    expect(reason("<svg><path></svg>")).toContain("XML");
  });

  test("根が svg でなければ断る", () => {
    expect(reason("<div><svg /></div>")).toContain("svg");
  });

  test("64KBを超えたら断る", () => {
    const huge =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      `<path d="${"M12 2 ".repeat(MAX_ORNAMENT_SVG_BYTES)}" />` +
      "</svg>";
    expect(reason(huge)).toContain("64");
  });

  /* ---- 拒否する6種（設計書6.65.17） ---------------------------------- */

  test("script は断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
      )
    ).toContain("script");
  });

  test("foreignObject は断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="1" height="1"><p xmlns="http://www.w3.org/1999/xhtml">あ</p></foreignObject></svg>'
      )
    ).toContain("foreignObject");
  });

  test("image は断る（外の絵を持ち込ませない）", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="a.png" width="1" height="1" /></svg>'
      )
    ).toContain("image");
  });

  test("on… の属性は断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1" onload="alert(1)" /></svg>'
      )
    ).toContain("onload");
  });

  test("# 以外の href / xlink:href は断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/a.svg#x" /></svg>'
      )
    ).toContain("href");
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="other.svg#x" /></svg>'
      )
    ).toContain("href");
    // 本の中を指す `#` は通す（グラデーションの参照などに要る）
    expect(
      sanitizeOrnamentSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><path id="a" d="M0 0" /></defs><use href="#a" /></svg>'
      ).ok
    ).toBe(true);
  });

  /**
   * **整形式でないXMLは、断片にすると本ごと開けなくなる。** DOCTYPEを
   * 落としたあとのXHTMLは厳密に読まれるので、ここで通したものが
   * そのまま「本が開かない」になる（設計書6.65.17）。
   */
  test("同じ属性が2つある札は断る", () => {
    expect(
      reason('<svg xmlns="http://www.w3.org/2000/svg" fill="a" fill="b" />')
    ).toContain("fill");
  });

  test("`;` の無い実体参照は断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>A &amp B</text></svg>'
      )
    ).toContain("実体参照");
    // 属性値の中も同じ（値だけ素通りする口を作らない）
    expect(
      reason('<svg xmlns="http://www.w3.org/2000/svg"><path d="&amp" /></svg>')
    ).toContain("実体参照");
  });

  /**
   * **未宣言の接頭辞は、足さずに断る**（0.37.5の裁定）。`xlink` だけを
   * 特別扱いして根へ宣言を足すと、「どの接頭辞なら直してもらえるのか」が
   * 図録の中に隠れる。断れば失うのは飾り1つで、本そのものは開く。
   */
  test("宣言されていない名前空間の接頭辞は断る", () => {
    expect(
      reason('<svg xmlns="http://www.w3.org/2000/svg"><zz:rect /></svg>')
    ).toContain("zz");
    expect(
      reason('<svg xmlns="http://www.w3.org/2000/svg"><use xl:href="#a" /></svg>')
    ).toContain("xl");
    // 根で宣言してあれば通る（`xml:` は宣言なしでも使える）
    expect(
      sanitizeOrnamentSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xl="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><defs><path id="a" d="M0 0" /></defs><use xl:href="#a" xml:space="preserve" /></svg>'
      ).ok
    ).toBe(true);
  });

  /** 外部参照の遮断は、綴りではなく**名前の実体**で見る（`xl:href` の逃げ道） */
  test("別の接頭辞で書いた href も断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xl="http://www.w3.org/1999/xlink"><use xl:href="other.svg#x" /></svg>'
      )
    ).toContain("href");
  });

  /**
   * `url(` は `<style>` の中だけの話ではない。`fill`・`filter`・`mask`・
   * `clip-path`・`marker-*` と入口が多いので、**属性は全部見る**。
   */
  test("属性値の url( は、# 始まり以外を断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(http://x/a.svg#g)" /></svg>'
      )
    ).toContain("url(");
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect style="filter:url(&apos;https://x/f&apos;)" /></svg>'
      )
    ).toContain("url(");
    // 同じ絵の中を指すものは通す（グラデーションの参照に要る）
    expect(
      sanitizeOrnamentSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" /></defs><rect fill="url(#g)" width="24" height="24" /></svg>'
      ).ok
    ).toBe(true);
  });

  test("style の中の @import と url( は断る", () => {
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("x.css");</style></svg>'
      )
    ).toContain("@import");
    expect(
      reason(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a { fill: url(http://x/a.svg#g); }</style></svg>'
      )
    ).toContain("url(");
  });

  /** **`url(` の規則は1つ。** 属性値で通るものは `<style>` でも通る */
  test("style の中でも、# 始まりの url( は通す", () => {
    expect(
      sanitizeOrnamentSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" /></defs><style>.a { fill: url(#g); }</style><rect class="a" width="24" height="24" /></svg>'
      ).ok
    ).toBe(true);
  });

  /* ---- 整える -------------------------------------------------------- */

  test("XML宣言・DOCTYPE・コメントを落とす", () => {
    const result = sanitizeOrnamentSvg(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        "<!-- Inkscape で作りました -->\n" +
        plain
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toContain("<?xml");
    expect(result.svg).not.toContain("DOCTYPE");
    expect(result.svg).not.toContain("Inkscape");
    expect(result.svg.startsWith("<svg")).toBe(true);
  });

  test("読み上げから外す印を根に付ける", () => {
    const result = sanitizeOrnamentSvg(plain);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain('aria-hidden="true"');
    expect(result.svg).toContain('role="presentation"');
  });

  test("大きさが無ければ viewBox から24相当にする", () => {
    const result = sanitizeOrnamentSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path d="M0 0" /></svg>'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain('width="24"');
    expect(result.svg).toContain('height="12"');
  });

  /**
   * **`%` や単位つきの大きさは、割り出しへ倒す。** `width="100%"` の飾りは
   * リーダーによって面いっぱいに広がり、本文が1行も見えない面ができる。
   */
  test("大きさが数値でなければ viewBox から割り出す", () => {
    const result = sanitizeOrnamentSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24" width="100%" height="100%"><path d="M0 0" /></svg>'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain('width="24"');
    expect(result.svg).toContain('height="12"');
    expect(result.svg).not.toContain("100%");
  });

  test("名前空間が無ければ足す（XHTMLの中で絵にならないため）", () => {
    const result = sanitizeOrnamentSvg(
      '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M0 0" /></svg>'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  test("整えた結果は、もう一度通しても同じ（本へ入れる前の形が1つ）", () => {
    const once = sanitizeOrnamentSvg(plain);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = sanitizeOrnamentSvg(once.svg);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.svg).toBe(once.svg);
  });
});
