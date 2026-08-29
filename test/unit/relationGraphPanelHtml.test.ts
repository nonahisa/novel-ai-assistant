import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { TERM_COLORS } from "../../src/core/termColors";
import { buildRelationGraphPanelHtml } from "../../src/views/relationGraphPanelHtml";

/**
 * 人物相関図の画面（設計書6.38.4）。
 *
 * 見え方の良し悪しは実機でしか分からない。ここで見るのは
 * 「そもそもHTMLとして出来ているか」と「守るべき約束が入っているか」だけ。
 */

const html = buildRelationGraphPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

describe("人物相関図のHTML", () => {
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
  it("2つの図を行き来するボタンがある", () => {
    expect(html).toContain('id="toAll"');
    expect(html).toContain('id="back"');
    expect(html).toContain('id="ring2"');
  });

  it("設定資料とSVG書き出しのボタンがある", () => {
    expect(html).toContain('id="openRecord"');
    expect(html).toContain('id="export"');
  });

  it("絞り込みが4つそろっている", () => {
    // 登場話数の下限／関係・呼称／所属／名前で探す（設計書6.38.2）
    expect(html).toContain('id="minChapters"');
    expect(html).toContain('id="kindRelation"');
    expect(html).toContain('id="kindAddress"');
    expect(html).toContain('id="affiliations"');
    expect(html).toContain('id="search"');
    expect(html).toContain('id="showIsolated"');
  });

  it("材料が無いときの案内は、拡張機能側から受け取る", () => {
    // 文言を画面に焼き込むと、絞り込みで消えた場合と区別できなくなる
    expect(script).toContain("data.emptyMessage");
  });
});

describe("画面は描くだけ", () => {
  /**
   * 図の組み立ても配置も拡張機能側で済ませてある（純粋関数のテストで守る）。
   * 画面で座標を計算し始めると、そこだけ試しようがなくなる。
   */
  it("受け取った座標をそのまま使う", () => {
    expect(script).toContain("data.layout");
    expect(script).not.toContain("buildRelationGraph");
    expect(script).not.toContain("layoutCircle");
  });

  it("関係や呼称を書き換える口が無い", () => {
    // 設計書6.38.5「画面は何も書き換えない」
    expect(script).not.toContain('post("save"');
    expect(script).not.toContain('post("edit"');
  });

  it("押したことは拡張機能へ返す", () => {
    expect(script).toContain('post("center"');
    expect(script).toContain('post("filter"');
    expect(script).toContain('post("export"');
    expect(script).toContain('post("openRecord"');
  });
});

describe("用語の色", () => {
  /**
   * 人物のノードは人物の色、所属の帯は組織の色（設計書6.38.2）。
   * 16進は `core/termColors.ts` にしか無い——写しを作らない。
   */
  it("色は termColors から受け取る", () => {
    const source = fs.readFileSync(
      "src/views/relationGraphPanelHtml.ts",
      "utf8"
    );
    expect(source).toMatch(
      /import \{ TERM_COLORS \} from "\.\.\/core\/termColors";/
    );
    for (const pair of Object.values(TERM_COLORS)) {
      expect(source).not.toContain(pair.light);
      expect(source).not.toContain(pair.dark);
    }
  });

  it("明るいテーマと暗いテーマの両方がある", () => {
    expect(html).toContain(`--novelai-character: ${TERM_COLORS.character.light};`);
    expect(html).toContain(`--novelai-character: ${TERM_COLORS.character.dark};`);
    expect(html).toContain(
      `--novelai-organization: ${TERM_COLORS.organization.light};`
    );
    expect(html).toContain("body.vscode-dark, body.vscode-high-contrast {");
  });

  it("ノードと弧が、その色を引いている", () => {
    expect(html).toContain(".g-node-circle { fill: var(--novelai-character); }");
    expect(html).toContain("stroke: var(--novelai-organization);");
  });
});
