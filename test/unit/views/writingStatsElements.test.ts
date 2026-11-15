import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";
import { EXPECTED_ARCHIVE_FILES } from "../../../scripts/releaseSupport.mjs";

/**
 * 執筆統計のボタンと折りたたみを、VS Code の部品（`@vscode-elements/elements`）へ
 * 置き換えた（作者の決定 2026-11-15）。ここでは次を見張る。
 *
 * - 部品の束（`dist/webview-elements.js`）を nonce つきで読む行が入ること（無いと素の形になる）
 * - その行が、台本の本体を取り出す正規表現（`<script nonce="…">`）に当たらないこと
 *   （当たると、単体テストが束の行を台本と取り違えて、全部の検査が空振りする）
 * - CSP を緩めていないこと（nonce の外部 script は今の script-src のまま通る）
 * - 素の `<button>`・`<details>` が残っていないこと（半分だけ置き換えると見た目がそろわない）
 * - パネルが束の URI と読める場所（localResourceRoots）を渡していること
 * - 束が作られ、配布物の許可リストに載っていること
 */
const NONCE = "NONCE123";
const URI = "https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview-elements.js";

describe("執筆統計：画面の部品の束を読む", () => {
  const html = buildWritingStatsPanelHtml(NONCE, "vscode-resource:", { elementsScriptUri: URI });

  test("束を nonce つきで、head の中で読む", () => {
    const tag = `<script nonce="${NONCE}" src="${URI}"></script>`;
    expect(html).toContain(tag);
    // 本文より先に部品を登録する（描いた直後から部品の形で出す）
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("</head>"));
  });

  test("台本の本体を取り出す正規表現は、束の行に当たらない", () => {
    const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
    expect(found?.[1]).toContain("acquireVsCodeApi()");
    const all = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)];
    expect(all.every((match) => !match[0].includes(" src="))).toBe(true);
  });

  test("CSP は緩めない（script-src は nonce だけ、unsafe-inline を足さない）", () => {
    const csp = /<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(new RegExp(`script-src 'nonce-${NONCE}';`));
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("束の在りかの引用符は逃がす（属性を壊さない）", () => {
    const odd = buildWritingStatsPanelHtml(NONCE, "c", { elementsScriptUri: 'x" onload="y' });
    expect(odd).toContain('src="x&quot; onload=&quot;y"');
  });

  test("束を渡さない呼び出し（台本だけを読む検査）では、読み込みの行を出さない", () => {
    expect(buildWritingStatsPanelHtml(NONCE, "c")).not.toMatch(/<script[^>]*\ssrc=/);
  });
});

describe("執筆統計：ボタンと折りたたみは VS Code の部品", () => {
  const html = buildWritingStatsPanelHtml(NONCE, "vscode-resource:", { elementsScriptUri: URI });

  test("素の button・details は残っていない", () => {
    expect(html).not.toMatch(/<button[\s>]/);
    expect(html).not.toMatch(/<details[\s>]/);
    expect(html).not.toMatch(/<summary[\s>]/);
  });

  test("画面の自動テストが探す印は、部品の外枠に残す", () => {
    // 粒度の切り替え・なろうAPIの取得・AIの助言
    expect(html).toContain(`'<vscode-button data-granularity="'`);
    expect(html).toContain(`'<div class="row"><vscode-button secondary data-narou-fetch="1"'`);
    expect(html).toContain(`'<vscode-button secondary class="advice-ask" data-advice-site="'`);
    // 折りたたみは4か所（AIへ渡す材料・これまでの記録・話ごとの記録・タグの付け替え）
    expect([...html.matchAll(/<vscode-collapsible class="fold" heading="/g)]).toHaveLength(4);
  });

  test("なろうAPIの取得は、押せない印を属性で見る（部品が届く前でも同意を飛ばさない）", () => {
    expect(html).toContain("if (narouApiBusy || el.hasAttribute('disabled')) return;");
    expect(html).not.toContain("el.disabled) return;");
  });

  test("タブは手書きのまま（.tab[data-page]）", () => {
    expect(html).toMatch(/<div class="tab active" role="tab" id="tab-overview" data-page="overview"/);
  });
});

describe("執筆統計のパネル：束の URI と読める場所を渡す", () => {
  for (const file of ["src/features/writingStatsPanel.ts", "src/features/allWorksWritingStatsPanel.ts"]) {
    test(file, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("localResourceRoots: [webviewElementsRoot(context.extensionUri)]");
      expect(source).toMatch(/elementsScriptUri: webviewElementsScriptUri\((panel|created)\.webview, context\.extensionUri\)/);
    });
  }

  test("在りかは joinPath で作る（ブラウザ版で別の所を指さない）", () => {
    // コメントは理由として禁じ手の名前を書くので、落としてから見る
    const source = readFileSync("src/views/webviewElements.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).toContain('vscode.Uri.joinPath(extensionUri, "dist")');
    expect(source).not.toMatch(/Uri\.file\(|from "path"/);
  });
});

describe("画面の部品の束", () => {
  const require = createRequire(import.meta.url);
  const { bundleOptions } = require("../../../esbuild.js") as {
    bundleOptions: () => Record<string, { entryPoints: string[]; platform: string; outfile: string; format: string }>;
  };

  test("拡張機能の束とは別の、ブラウザ向けの束にする", () => {
    const options = bundleOptions().webviewElements;
    expect(options.entryPoints).toEqual(["src/vendor/webviewElementsEntry.ts"]);
    expect(options.platform).toBe("browser");
    expect(options.format).toBe("iife");
    expect(options.outfile).toBe("dist/webview-elements.js");
  });

  test("作る手順（main）にも入っている（設定だけ足して作られない、を防ぐ）", () => {
    expect(readFileSync("esbuild.js", "utf8")).toMatch(/options\.lame, options\.webviewElements\]/);
  });

  test("配布物の許可リストに載っている", () => {
    expect(EXPECTED_ARCHIVE_FILES).toContain("extension/dist/webview-elements.js");
  });

  test("入れる部品は使う分だけ（全部入りにしない）", () => {
    // import の行だけを見る（コメントには「全部入り（bundled.js）にしない」と理由を書いている）
    const imports = readFileSync("src/vendor/webviewElementsEntry.ts", "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("import"));
    expect(imports).toEqual([
      'import "@vscode-elements/elements/dist/vscode-button/index.js";',
      'import "@vscode-elements/elements/dist/vscode-collapsible/index.js";',
    ]);
  });
});
