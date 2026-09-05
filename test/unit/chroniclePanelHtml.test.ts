import { describe, expect, it } from "vitest";
import { buildChroniclePanelHtml } from "../../src/views/chroniclePanelHtml";

/**
 * 年表の画面（設計書6.39.4）。
 *
 * 見え方の良し悪しは実機でしか分からない。ここで見るのは
 * 「そもそもHTMLとして出来ているか」と「守るべき約束が入っているか」だけ
 * （人物相関図の画面と同じ考え方）。
 */

const html = buildChroniclePanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

/**
 * WebView のスクリプトから関数を1つ取り出す（提案パネルの検査と同じ手）。
 *
 * 中括弧の対応を数えて切り出す。行数で切ると、関数が育ったときに
 * 黙って途中で切れる。
 */
function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let index = head; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
      started = true;
    } else if (source[index] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, index + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

interface RowForRender {
  filePath: string;
  chapterLabel: string;
  title: string;
  timepoint: string;
  appeared: Array<{ id: string; name: string }>;
  events: Array<{ kindLabel: string; characterId: string; text: string }>;
  synopsis: string;
}

/** 画面が使っている行の組み立てを、そのまま呼べる形にして返す */
const renderRow = new Function(
  [
    extractFunction(script, "escapeHtml"),
    extractFunction(script, "renderRow"),
    "return renderRow;",
  ].join("\n")
)() as (row: RowForRender) => string;

describe("年表のHTML", () => {
  it("スクリプトとスタイルにnonceが入っている", () => {
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('<script nonce="NONCE123">');
  });

  it("外から何も読み込ませない（CSP）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
  });

  it("埋め込みの印が残っていない", () => {
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toContain("${");
  });

  /** WebViewのスクリプトにバッククォートを書かない（この作品の決まり） */
  it("バッククォートが混ざっていない", () => {
    expect(html.includes("`")).toBe(false);
  });

  it("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("タグの数が合っている", () => {
    const open = [...html.matchAll(/<div\b/g)].length;
    const close = [...html.matchAll(/<\/div>/g)].length;
    expect(open).toBe(close);
  });
});

describe("画面の入口", () => {
  it("2つの並びを行き来するボタンがある", () => {
    expect(html).toContain('id="byChapter"');
    expect(html).toContain('id="byTimeline"');
  });

  it("人物と種類の絞り込みがある", () => {
    expect(html).toContain('id="character"');
    expect(html).toContain('id="kinds"');
  });

  it("書き出しと、時期・系統の編集の入口がある", () => {
    expect(html).toContain('id="export"');
    expect(html).toContain('id="edit"');
  });

  it("材料が無いときの案内は、拡張機能側から受け取る", () => {
    // 文言を画面に焼き込むと、絞り込みで消えた場合と区別できなくなる
    expect(script).toContain("data.emptyMessage");
  });

  it("読めなかったものの知らせも、拡張機能側から受け取る", () => {
    // `timeline.json` が壊れているときは、検証の文言をそのまま出す
    expect(script).toContain("data.notice");
  });
});

describe("画面は描くだけ", () => {
  it("年表を組み立てない", () => {
    // 組み立ては `core/chronicle.ts`（純粋関数のテストで守る）。
    // 画面で並べ替え始めると、そこだけ試しようがなくなる
    expect(script).not.toContain("buildChronicle");
    expect(script).not.toContain("sortByTimeline");
    expect(script).toContain("data.sections");
  });

  it("時期や系統を書き換える口が無い", () => {
    // 設計書6.39.3「画面の中の表は読むだけ」
    expect(script).not.toContain('post("save"');
    expect(script).not.toContain('post("assign"');
    expect(script).not.toContain("timeline.json");
  });

  it("押したことは拡張機能へ返す", () => {
    expect(script).toContain('post("order"');
    expect(script).toContain('post("filter"');
    expect(script).toContain('post("openCharacter"');
    expect(script).toContain('post("openEpisode"');
    expect(script).toContain('post("export"');
    expect(script).toContain('post("edit"');
  });

  /**
   * 話の行は、見出しも題も同じボタンの中にある（2026-09-05に実機で発見）。
   *
   * 題をボタンの外へ出していたため、作者が題を押すと
   * `closest("[data-file]")` が空振りし、拡張機能へ何も届かなかった。
   * **文字列を探すだけの検査では通ってしまう**ので、画面と同じ関数を
   * 実際に走らせて、押した先に本文の場所が付いているかを見る。
   */
  it("話数も題も、本文の場所を持つ1つのボタンの中にある", () => {
    const html = renderRow({
      filePath: "C:/works/ijime/第1話 気がついたら幽霊に.txt",
      chapterLabel: "第1話",
      title: "気がついたら幽霊に",
      timepoint: "",
      appeared: [],
      events: [],
      synopsis: "",
    });

    const button = html.match(/<button[^>]*data-file="([^"]*)"[^>]*>([\s\S]*?)<\/button>/);
    expect(button, "本文の場所を持つボタンが無い").not.toBeNull();
    expect(button?.[1]).toBe("C:/works/ijime/第1話 気がついたら幽霊に.txt");
    // 見出しも題も、同じボタンの中（＝どちらを押しても本文へ飛べる）
    expect(button?.[2]).toContain("第1話");
    expect(button?.[2]).toContain("気がついたら幽霊に");
  });

  it("作者の文字列は、必ずエスケープを通す", () => {
    // 題や人物名に「<」が入ると画面が壊れる
    expect(script).toContain("function escapeHtml");
    expect(script).toContain("escapeHtml(row.chapterLabel)");
    expect(script).toContain("escapeHtml(entry.name)");
    expect(script).toContain("escapeHtml(row.synopsis)");
  });
});
