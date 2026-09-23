import { describe, expect, test } from "vitest";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";

/**
 * 相談パネルの、独り言まわりの組み立て。
 *
 * **WebViewは実機でしか動かない。** ここでは組み立てが壊れていないこと
 * （スクリプトが読めること、必要な部品が入っていること）だけを見る。
 */
const HTML = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

function script(): string {
  const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();
  return found![1];
}

describe("独り言の表示", () => {
  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script())).not.toThrow();
  });

  test("独り言を受け取れる", () => {
    expect(script()).toContain("'chatter'");
  });

  test("答えと同じ見た目にしない", () => {
    // 聞かれてもいないのに出るものなので、読み飛ばせる見た目にする
    expect(HTML).toContain(".turn.chatter .body");
  });

  test("押せる口を添えられる", () => {
    // 「やっておきましょうか？」と言うだけで押せないと、ただの独り言になる
    const code = script();
    const handler = code.slice(
      code.indexOf("message.type === 'chatter'"),
      code.indexOf("message.type === 'note'")
    );
    expect(handler).toContain("appendRun");
    expect(handler).toContain("appendOptions");
  });

  test("考え中の表示を横取りしない", () => {
    // 質問の答えを待っている最中に割り込むことがある。
    // そこで「考えています…」を消すと、待ちが止まったように見える
    const code = script();
    const handler = code.slice(
      code.indexOf("message.type === 'chatter'"),
      code.indexOf("message.type === 'note'")
    );
    expect(handler).not.toContain("setBusy");
    expect(handler).not.toContain("thinkingEl");
  });
});
