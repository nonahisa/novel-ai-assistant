import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * プロットモードの画面とAIとの相談（P-01、設計書6.4.10）のつなぎ方。
 *
 * パネルは `vscode` の画面そのものなので動かせない（`plotModePanelPlanned.test.ts`
 * と同じく、ソースを読んで形を見る）。送受信と書き込みの振る舞いは
 * `plotAdvice.test.ts` が作り物のAIで確かめる。ここで見るのは次の3つ。
 *
 * 1. 画面からの用件は `PlotAdviceSession` へ渡すだけ（パネルが自前で書かない）
 * 2. 書き込みは本文と同じ口（`writeTextFilePreservingFormat`）だけ。上書きの
 *    経路（`atomicWriteFile` の replace）や退避の無い書き方を新設しない
 * 3. 相談の会話は目録とは別の知らせで送り、画面を閉じたら答えを待つのをやめる
 */

function source(file: string): string {
  return readFileSync(path.join("src", "features", file), "utf-8")
    // コメントに書いた言葉で検査が通らないよう、先に落とす
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function bodyOf(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`${marker} が見つかりません`);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

describe("パネルのつなぎ方", () => {
  const panel = source("plotModePanel.ts");

  it("画面からの用件は相談の係へ渡すだけ", () => {
    expect(panel).toContain("this.advice.send(message.text)");
    expect(panel).toContain("this.advice?.apply(message.id)");
    expect(panel).toContain("this.advice?.dismiss(message.id)");
    expect(panel).toContain("this.advice?.stop()");
  });

  it("会話は目録とは別の知らせ（plotAdvice）で送り、開き直しで送り直す", () => {
    expect(panel).toContain('type: "plotAdvice"');
    const ready = panel.slice(panel.indexOf('case "ready"'), panel.indexOf('case "reveal"'));
    expect(ready).toContain("this.postAdvice(");
  });

  it("画面を閉じたら答えを待つのをやめる", () => {
    const dispose = panel.slice(panel.indexOf("onDidDispose"), panel.indexOf("this.panel.webview.html"));
    expect(dispose).toContain("this.advice?.dispose()");
  });
});

describe("書き込みの道", () => {
  const advice = source("plotAdvice.ts");
  const apply = bodyOf(advice, "async apply(");

  it("本文と同じ書き戻しの口だけを通る", () => {
    expect(apply).toContain("writeTextFilePreservingFormat(");
    expect(apply).toContain("file.hash");
    expect(advice).not.toMatch(/atomicWriteFile|fs\.writeFile|writePlotText|replaceFile/);
  });

  it("節の差し替えは updatePlotMarkdown（作者の見出しの並びを崩さない）", () => {
    expect(apply).toContain("updatePlotMarkdown(");
  });

  it("書いてある項目を置き換えるときは、モーダルで確かめてから書く", () => {
    const confirm = apply.indexOf("modal: true");
    const write = apply.indexOf("writeTextFilePreservingFormat(");
    expect(confirm).toBeGreaterThan(-1);
    expect(confirm).toBeLessThan(write);
  });

  it("送るときは何も書かない", () => {
    const send = bodyOf(advice, "async send(");
    expect(send).not.toMatch(/writeTextFilePreservingFormat|updatePlotMarkdown/);
  });
});
