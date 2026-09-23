import { describe, it, expect } from "vitest";
import { buildProposalPanelHtml } from "../../src/views/proposalPanelHtml";
import { diffChars } from "../../src/core/inlineDiff";

/**
 * 提案パネルで、違うところだけを塗る（設計書6.11.2）。
 *
 * **描画は WebView の中で動くので、普通のテストが届かない。** そこで
 * 組み上がったHTMLから関数を取り出して、実際に走らせて確かめる。
 * 見張るだけの検査（文字列を探すだけ）では、塗る場所を間違えても通る。
 */

const html = buildProposalPanelHtml("test-nonce", "vscode-webview:");

/**
 * WebView のスクリプトから関数を1つ取り出す。
 *
 * 中括弧の対応を数えて切り出す。**行数で切ると、関数が育ったときに
 * 黙って途中で切れる**（この作品で一度やっている）。
 */
function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let i = head; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      started = true;
    } else if (source[i] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, i + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

/** WebView の描画関数を、そのまま呼べる形にして返す */
function loadRenderers(): {
  renderDiff: (item: unknown) => string;
  renderRecordChanges: (item: unknown) => string;
} {
  const body = [
    extractFunction(html, "escapeHtml"),
    extractFunction(html, "diffSide"),
    extractFunction(html, "renderDiff"),
    extractFunction(html, "renderRecordChanges"),
    "return { renderDiff: renderDiff, renderRecordChanges: renderRecordChanges };",
  ].join("\n");
  return new Function(body)() as ReturnType<typeof loadRenderers>;
}

const { renderDiff, renderRecordChanges } = loadRenderers();

/** 指摘1件ぶんを、拡張機能側と同じ手順で組み立てる */
function item(target: string, suggestion: string) {
  return { target, suggestion, diff: diffChars(target, suggestion) };
}

describe("違うところだけを塗る", () => {
  it("作者の画面に出ていた推敲の指摘", () => {
    const rendered = renderDiff(
      item(
        "呪詛だらけの学校は視界が悪いので、引き寄せて視界を確保する。",
        "呪詛だらけの学校は視界が悪いので、引き寄せて確保する。"
      )
    );

    // 消える3文字だけが塗られる
    expect(rendered).toContain('<mark class="del">視界を</mark>');
    // **同じところは塗らない。** ここが崩れると、行まるごとが赤くなる
    expect(rendered.match(/<mark/g) ?? []).toHaveLength(1);
    expect(rendered).toContain("呪詛だらけの学校は視界が悪いので、引き寄せて");
  });

  it("塗る箇所は、違いの数だけ", () => {
    const rendered = renderDiff(
      item(
        "全員廊下側の窓に影がうつらないようしゃがんでいて、",
        "全員が廊下側の窓に影がうつらないようにしゃがんでいて、"
      )
    );
    expect((rendered.match(/<mark class="ins">/g) ?? [])).toHaveLength(2);
    expect(rendered).toContain('<mark class="ins">が</mark>');
    expect(rendered).toContain('<mark class="ins">に</mark>');
    expect(rendered.match(/<mark class="del">/g) ?? []).toHaveLength(0);
  });

  it("塗った印を外すと、元の2つの文に戻る", () => {
    // **画面に出る文字が変わってはいけない。** 塗るのは飾りである
    const target = "意外な結末だった";
    const suggestion = "以外な結末だった";
    const rendered = renderDiff(item(target, suggestion));
    const [from, to] = rendered.split(" → ");
    expect(strip(from)).toBe(target);
    expect(strip(to)).toBe(suggestion);
  });
});

describe("本文の記号で画面が壊れない", () => {
  it("山括弧とアンパサンドを逃がす", () => {
    // **本文には何でも書ける。** 逃がし忘れると画面が崩れる
    const rendered = renderDiff(item("a<b>&c", "a<b>&d"));
    expect(rendered).not.toContain("<b>");
    expect(rendered).toContain("&lt;b&gt;");
    expect(rendered).toContain("&amp;");
  });

  it("差分が添えられていなければ、まるごと出す", () => {
    // 古い作りへ素直に落ちること。落ちても画面は成立する
    const rendered = renderDiff({ target: "もと", suggestion: "あと" });
    expect(rendered).toContain("もと");
    expect(rendered).toContain("あと");
    expect(rendered).not.toContain("<mark");
  });
});

describe("設定資料の更新", () => {
  /** 拡張機能側（applyPendingUpdates.ts）と同じ手順で組み立てる */
  function part(label: string, before: string, after: string) {
    return { label, before, after, diff: diffChars(before, after) };
  }

  it("紹介文は、変わるひと言だけが塗られる", () => {
    // **ここがいちばん効く。** 紹介文は長く、変わるのはたいてい一部である
    const rendered = renderRecordChanges({
      changes: [],
      changeParts: [
        part(
          "紹介",
          "転校してきたばかりの高校生。人付き合いが苦手で、いつも一人でいる。",
          "転校してきたばかりの高校生。人付き合いが苦手で、いつも本を読んでいる。"
        ),
      ],
    });
    // 共通の「でいる。」まで塗らない
    expect(rendered).toContain('<mark class="del">一人</mark>');
    expect(rendered).toContain('<mark class="ins">本を読ん</mark>');
    expect(rendered).toContain("転校してきたばかりの高校生。");
  });

  it("項目名と、現在・更新案の見出しを出す", () => {
    const rendered = renderRecordChanges({
      changes: [],
      changeParts: [part("性別", "男", "女")],
    });
    expect(rendered).toContain("性別");
    expect(rendered).toContain("現在");
    expect(rendered).toContain("更新案");
  });

  it("消える側に足した分は出さない（逆も同じ）", () => {
    // **左右を取り違えると、作者は変わらないものが変わったと読む**
    const rendered = renderRecordChanges({
      changes: [],
      changeParts: [part("読み", "たなか", "たなかたろう")],
    });
    const [current, updated] = rendered.split("更新案");
    expect(current).not.toContain("<mark");
    expect(updated).toContain('<mark class="ins">たろう</mark>');
  });

  it("項目ごとに分けたものが無ければ、説明の行をそのまま並べる", () => {
    // 古い作りへ素直に落ちること
    const rendered = renderRecordChanges({
      changes: ["紹介", "　現在: あ", "　更新案: い"],
    });
    expect(rendered).toContain("　現在: あ");
    expect(rendered).not.toContain("<mark");
  });
});

describe("塗る場所の指定", () => {
  it("行まるごとに取り消し線を引かない", () => {
    // **これが元の作りだった。** 戻すと、また文全体が赤で消える
    expect(html).not.toMatch(/\.diff \.from \{[^}]*line-through/);
  });

  it("消える側と足す側で、別の色を指定している", () => {
    expect(html).toMatch(/\.diff mark\.del \{[^}]*background-color/);
    expect(html).toMatch(/\.diff mark\.ins \{[^}]*background-color/);
  });

  it("消える側には取り消し線も引く", () => {
    // 色を見分けにくくても、どちらが消えるか分かるように
    expect(html).toMatch(/\.diff mark\.del \{[^}]*line-through/);
  });

  it("mark の既定の見た目を上書きしている", () => {
    // 既定は黄色地に黒字。テーマによっては読めなくなる
    expect(html).toMatch(/\.diff mark \{[^}]*background: none/);
  });
});

/** 塗った印を外して、画面に出る文字だけを取り出す */
function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
