import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";

/**
 * SNS記事のnote風エディタ（設計書6.69）。
 *
 * **小説の原稿の見え方を1pxも変えないこと**が、この面のいちばんの約束である。
 * note風の指定はすべて `body.note`／`body.notepv` の中に閉じ込め、
 * 縦書きには当たらないようにする。
 */
const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

/**
 * CSSを規則（見出し＋中身）へ割る。
 *
 * **注釈は先に落とす。** この画面の注釈には「なぜそうしたか」が長く
 * 書かれており、その中の `body.note` のような文字列まで見出しとして
 * 数えてしまう。
 */
const rules = html
  .slice(html.indexOf("<style"), html.indexOf("</style>"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("}")
  .map((chunk) => {
    const at = chunk.indexOf("{");
    if (at < 0) return undefined;
    return {
      selector: chunk.slice(0, at).replace(/\s+/g, " ").trim(),
      body: chunk.slice(at + 1),
    };
  })
  .filter((rule): rule is { selector: string; body: string } => !!rule);

/** `body.note`（`body.notepv` を含まない）に当たる規則 */
const noteRules = rules.filter((rule) =>
  /body\.note(?![a-z])/.test(rule.selector)
);
const LAYERS = ["#write", "#marks", "#compose", "#aloudmarks"];

describe("note風の組版（編集面）", () => {
  /**
   * **重ね敷きの4枚を必ず一緒に動かす。** 折り返し幅が1枚でも違うと、
   * 用語の色と読み上げの塗りが本文と無関係な場所に浮く（0.22.24の再発）。
   */
  it("本文の4枚すべてに、同じ幅と行間が当たる", () => {
    const rule = noteRules.find((item) => item.selector.includes("#write"));
    expect(rule, "note風の組版の規則が無い").toBeTruthy();
    for (const layer of LAYERS) {
      expect(rule!.selector, layer).toContain(layer);
    }
    // noteの読み味：中央寄せの620px幅と、広めの行間
    expect(rule!.body).toContain("620px");
    expect(rule!.body).toContain("line-height: 1.8");
  });

  /**
   * **縦書きには当たらない。** noteは横書きの読み物で、縦書きの原稿に
   * 620pxの段を作っても意味が無い（行が短くなるだけ）。
   */
  it("note風の指定は、縦書きには当たらない", () => {
    expect(noteRules.length).toBeGreaterThan(0);
    // 本文の面に当たる規則は、必ず縦書きを除く
    for (const rule of noteRules) {
      if (!LAYERS.some((layer) => rule.selector.includes(layer))) continue;
      expect(rule.selector, rule.selector).toContain(":not(.vertical)");
    }
  });

  /**
   * **note風の指定が、素の面に漏れていないこと。** `#write` などを直に
   * 飾る規則を足すと、小説の原稿の見え方が変わる。
   */
  it("note以外の面のCSSを書き換えない", () => {
    // 従来の寸法（この1行が変わると、すべての原稿の見え方が変わる）
    expect(html).toContain("#write, #marks, #compose, #aloudmarks {");
    expect(html).toContain("  padding: 24px 28px;");
    expect(html).toContain("  line-height: 1.9;");
    // 縦書きの指定もそのまま
    expect(html).toContain("writing-mode: vertical-rl");
    expect(html).toContain("  padding: 28px 24px;");
  });
});

describe("note風プレビューの面", () => {
  it("面の置き場と、切り替えのボタンがある", () => {
    expect(html).toContain('<div id="notepv"');
    expect(html).toContain('id="noteStyle"');
    expect(html).toContain('id="notePv"');
  });

  /** 面を出したら、打つ面と重ね敷きは描かせない（二重に見えないように） */
  it("プレビュー中は、ほかの面を隠す", () => {
    expect(html).toContain("body.notepv #notepv { display: block; }");
    const hide = rules.find(
      (rule) =>
        rule.selector.includes("body.notepv #write") &&
        rule.body.includes("display: none")
    );
    expect(hide, "ほかの面を隠す規則が無い").toBeTruthy();
    // 4枚とも隠す（1枚でも残ると、プレビューの下に古い面が透ける）
    for (const layer of LAYERS) {
      expect(hide!.selector, layer).toContain(layer);
    }
    // 「組んで書く」の表示指定より後に置く（同じ強さなので、後ろが勝つ）
    expect(html.indexOf("body.compose #compose { display: block; }")).toBeLessThan(
      html.indexOf("body.notepv")
    );
  });

  /**
   * **紙面はnoteに寄せて明るく固定する。** ここは編集する面ではなく
   * 「貼ったあとの姿」を見る面なので、VS Codeのテーマではなく
   * noteの読み味（明るい地に濃い字）に合わせる。
   */
  it("プレビューの紙面は、テーマによらず明るい", () => {
    const start = html.indexOf("#notepv {");
    expect(start).toBeGreaterThan(0);
    const body = html.slice(start, html.indexOf("}", start));
    expect(body).toContain("background: #ffffff");
    expect(body).not.toContain("var(--vscode-editor-background)");
  });
});

describe("note風の切り替え", () => {
  /** SNS記事のときだけ出す。小説の道具箱にボタンを増やさない */
  it("ボタンはSNS記事のときだけ出す", () => {
    expect(html).toContain(".note-only { display: none; }");
    expect(html).toContain("body.notelike button.note-only");
    expect(code).toContain('classList.toggle("notelike", noteLike)');
  });

  /** SNS記事では note風が既定。押せば従来の表示へ戻せる */
  it("SNS記事では note風で始まり、押せば戻せる", () => {
    expect(code).toContain("saved.noteStyle !== false");
    expect(code).toContain("noteStyle = !noteStyle");
    expect(code).toContain('classList.toggle("note", noteLike && noteStyle)');
  });

  /**
   * **閉じているあいだは、拡張機能側にも組ませない。**
   * 打つたびに本文ぜんたいをHTMLへ組むのは、0.25.2で一度やめた道である。
   */
  it("プレビューは、開いているあいだだけ組ませる", () => {
    expect(code).toContain('type: "notePreview", on: notePv');
    expect(code).toContain('typeof message.notePreview === "string"');
  });

  /** 覚えるのは組版だけ（プレビューは開き直したら閉じている） */
  it("組版の入り切りは覚える", () => {
    expect(code).toContain("noteStyle: noteStyle");
  });

  /**
   * **縦書きでは、押しても何も起きない。** 消さずに押せなくして理由を出す
   * （`core/processAvailability.ts` と同じ考え方）。
   */
  it("縦書きでは、組版のボタンを押せなくして理由を出す", () => {
    expect(code).toContain("noteStyleButton.disabled = vertical !== false");
    expect(code).toContain("note風の組版は横書きのときだけ効きます");
  });
});

/**
 * 拡張機能側の繋ぎ（`features/manuscriptEditor.ts`）。
 *
 * **判定と描画は core にあり、ここは通すだけ**であることを固める。
 * 画面を実際に開く試験はできないので、繋ぎが外れていないかだけを見る。
 */
describe("拡張機能側の繋ぎ", () => {
  const feature = readFileSync("src/features/manuscriptEditor.ts", "utf8");

  it("SNS記事かどうかは、判定の1か所に訊く", () => {
    expect(feature).toContain("isNoteStyleTarget(");
    expect(feature).toContain("readWorkFormat(found.work)");
    expect(feature).toContain("noteLike,");
  });

  /** 閉じている面のために、本文ぜんたいを組まない（0.25.2で一度やめた道） */
  it("プレビューは、開いているあいだだけ組む", () => {
    expect(feature).toContain("noteLike && notePreviewWanted");
    expect(feature).toContain("renderNotePreview(text)");
    expect(feature).toContain("notePreviewWanted = message.on");
  });
});
