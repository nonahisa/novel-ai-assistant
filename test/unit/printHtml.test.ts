import { describe, expect, test } from "vitest";
import {
  buildPrintHtml,
  PRINT_PRESETS,
  printPreset,
  type PrintPreset,
} from "../../src/core/printHtml";
import { timestampedFileNameCandidates } from "../../src/core/timestampedFileName";

/**
 * 印刷用HTML（PDF出力のもと）。
 *
 * **PDFは直接作らない。** ブラウザの組版エンジンに縦書き・ルビ・傍点・
 * 禁則を任せ、作者が印刷（Ctrl+P）で「PDFに保存」を選ぶ形にしてある。
 * ここで見るのは、その入口になるHTMLの組み立てだけである
 * （実際の書き出しとブラウザ起動は VS Code API が要るので別）。
 */

function html(
  body: string,
  preset: PrintPreset = "bunko-vertical",
  workTitle = "銀の航路"
): string {
  return buildPrintHtml({
    workTitle,
    episodes: [{ heading: "第1話　夜の駅", body }],
    preset,
  });
}

describe("作者の本文を、そのまま文字として出す", () => {
  test("タグらしきものは、タグにならない", () => {
    // **作者の原稿には何が書かれていてもよい。** HTMLとして読まれると、
    // 本文が消える（表示されない）うえ、組版そのものが壊れる
    const out = html("彼は<b>強い</b>と言った。");

    expect(out).toContain("彼は&lt;b&gt;強い&lt;/b&gt;と言った。");
    expect(out).not.toContain("<b>強い</b>");
  });

  test("アンパサンドも逃がす", () => {
    const out = html("AT&Tの前で待つ。");

    expect(out).toContain("AT&amp;Tの前で待つ。");
  });

  test("ルビの中に書かれた記号も逃がす", () => {
    // 記法の中身だけ素通しになっていると、そこが抜け道になる
    const out = html("{<朝>|あさ}が来た。");

    expect(out).toContain("<ruby>&lt;朝&gt;<rt>あさ</rt></ruby>");
  });

  test("作品名も逃がす", () => {
    const out = html("本文", "bunko-vertical", "<script>alert(1)</script>");

    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("記法を組む", () => {
  test("ルビは <ruby> になる", () => {
    expect(html("{朝|あさ}の駅")).toContain(
      "<ruby>朝<rt>あさ</rt></ruby>の駅"
    );
  });

  test("傍点は圏点の印になる", () => {
    const out = html("それは{{大事}}だ");

    expect(out).toContain('<span class="emphasis">大事</span>');
    // 圏点はCSSで出す。ゴマ点が日本語の傍点にあたる
    expect(out).toContain("text-emphasis: filled sesame");
    // Chrome系はまだ接頭辞つきの指定を見るので、両方書く
    expect(out).toContain("-webkit-text-emphasis: filled sesame");
  });

  test("読み仮名の無いルビは、本文だけ残す", () => {
    // 書きかけの `{漢字|}` を消さない（原稿を減らさない）
    const out = html("{朝|}が来た");

    expect(out).toContain("朝が来た");
    expect(out).not.toContain("<ruby>");
  });
});

describe("紙の形", () => {
  test("扉に作品名が入り、そこで改ページする", () => {
    const out = html("本文");

    expect(out).toContain('<h1 class="cover-title">銀の航路</h1>');
    expect(out).toContain("break-after: page");
  });

  test("話ごとに改ページする", () => {
    const out = buildPrintHtml({
      workTitle: "銀の航路",
      episodes: [
        { heading: "第1話", body: "一。" },
        { heading: "第2話", body: "二。" },
      ],
      preset: "a5-vertical",
    });

    expect(out).toContain("break-before: page");
    expect([...out.matchAll(/<section class="episode">/g)]).toHaveLength(2);
    expect(out).toContain('<h2 class="episode-heading">第1話</h2>');
    expect(out).toContain('<h2 class="episode-heading">第2話</h2>');
  });

  test("行が段落になり、空行は段落の空きになる", () => {
    // 日本語の小説は段落のあいだを空けない（字下げで見分ける）。
    // **空行を捨てると場面の切り替わりが消える**ので、空きとして残す
    const out = html("　一行目。\n　二行目。\n\n　場面が変わる。");

    expect(out).toContain("<p>　一行目。</p>");
    expect(out).toContain("<p>　二行目。</p>");
    expect(out).toContain('<p class="gap">　場面が変わる。</p>');
  });

  test("縦書きの版だけ、縦組みになる", () => {
    expect(html("本文", "bunko-vertical")).toContain(
      "writing-mode: vertical-rl"
    );
    expect(html("本文", "a5-vertical")).toContain("writing-mode: vertical-rl");
    expect(html("本文", "a4-horizontal")).not.toContain("writing-mode");
  });

  test("版ごとに紙の大きさが変わる", () => {
    expect(html("本文", "bunko-vertical")).toContain(
      "@page { size: 105mm 148mm;"
    );
    expect(html("本文", "a5-vertical")).toContain("@page { size: 148mm 210mm;");
    expect(html("本文", "a4-horizontal")).toContain(
      "@page { size: 210mm 297mm;"
    );
  });

  test("外のものを一切読み込まない", () => {
    // 書き出したファイルを別のPCへ写しても、同じ組み上がりで開けること
    const out = html("本文");

    expect(out).not.toContain("<script");
    expect(out).not.toContain("http://");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("<link");
  });

  test("日本語の文書として開く", () => {
    const out = html("本文");

    expect(out).toContain('<html lang="ja">');
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain("<title>銀の航路</title>");
  });
});

describe("選べる版", () => {
  test("3つあり、名前で選べる", () => {
    expect(PRINT_PRESETS.map((preset) => preset.label)).toEqual([
      "文庫サイズ・縦書き",
      "A5・縦書き",
      "A4・横書き",
    ]);
  });

  test("知らない版を渡されたら、黙って別の紙を作らない", () => {
    expect(() => printPreset("a3-vertical" as PrintPreset)).toThrow();
  });
});

describe("書き出し先の名前", () => {
  const AT = new Date(2026, 7, 28, 2, 49, 17);

  test("はじめの候補は、分までの名前", () => {
    expect(timestampedFileNameCandidates("印刷用", AT, ".html")[0]).toBe(
      "印刷用 2026-08-28 0249.html"
    );
  });

  test("ぶつかったときの候補は、秒つき・連番の順", () => {
    // **既存ファイルは上書きできない**（`atomicWrite.ts` の設計）。
    // 同じ分に2回書き出しても、どちらも残る
    expect(timestampedFileNameCandidates("印刷用", AT, ".html", 4)).toEqual([
      "印刷用 2026-08-28 0249.html",
      "印刷用 2026-08-28 024917.html",
      "印刷用 2026-08-28 024917-2.html",
      "印刷用 2026-08-28 024917-3.html",
    ]);
  });

  test("候補どうしが重ならない", () => {
    const names = timestampedFileNameCandidates("印刷用", AT, ".html", 20);

    expect(new Set(names).size).toBe(names.length);
  });
});
