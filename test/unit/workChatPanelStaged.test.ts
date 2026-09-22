import { describe, expect, test } from "vitest";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";

/**
 * **頼んでいない作業を、答えの下に広げない**（作者の指摘、2026-09-08
 * 「AIの相談の青枠部分は何を意図しているのかわかりにくいです。
 * 求めていないので、頼まれてからやればいい気がします」）。
 *
 * 実機では質問1つに対して、`設定/plot.md` の書き換え・プロット逸脱の検知・
 * 登場人物の読み直しの3つが青枠で並んだ。**どれも頼んでいない**うえ、
 * 資料を書き換える操作とAIを回す操作である。
 *
 * 出すのをやめるのではなく、**1行に畳んで押されるまで開かない。**
 * 拡張機能側の staged の仕組みは変えていないので、押せば従来どおり動く。
 *
 * **WebViewは実機でしか動かない。** ここで見るのは、組み立てが壊れて
 * いないことと、畳む側・畳まない側の振り分けが残っていることだけである。
 */

const HTML = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

function script(html: string): string {
  const found = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();
  return found![1];
}

describe("作業の提案は既定で畳む", () => {
  test("JavaScriptとして読める", () => {
    expect(() => new Function(script(HTML))).not.toThrow();
  });

  test("「ほかにできること（N件）を見る」の1行を置く", () => {
    expect(HTML).toContain("'ほかにできること（'");
    expect(HTML).toContain("'件）を'");
    expect(HTML).toContain("'見る'");
  });

  test("中身は既定で隠れている", () => {
    // `hidden` を立てるのは1か所だけ。押したときに反転する
    expect(HTML).toContain("body.className = 'more-body';");
    expect(HTML).toContain("body.hidden = true;");
    expect(HTML).toContain("body.hidden = !body.hidden;");
  });

  test("機能の起動・読み直しを畳む側へ入れる", () => {
    const staged = HTML.slice(HTML.indexOf("function appendStagedActions"));
    const body = staged.slice(0, staged.indexOf("\n}"));
    for (const call of ["appendRun(host", "appendReload(host"]) {
      expect(body, call).toContain(call);
    }
  });

  test("書き込みは畳まない（頼まれた作業なので、その場で書いて結果を出す）", () => {
    /*
      作者の裁定（2026-09-21）「頼んでいるのだから、書き込みはした上で
      次へ行くべきでは？ もう一度書き込むかどうか聞くのは意味がわからない」。

      畳む側へ戻すと、**開いて押して、さらに確認へ答える**という
      実機で嫌われた形に戻る。
    */
    const staged = HTML.slice(HTML.indexOf("function appendStagedActions"));
    const body = staged.slice(0, staged.indexOf("\n}"));
    expect(body).not.toContain("message.edit");

    // 代わりに、書き終えた結果として出す（取り消しの口つき）
    expect(HTML).toContain("message.type === 'editDone'");
    expect(HTML).toContain("appendEditDone(message)");
    expect(HTML).toContain("type: 'undoEdit'");
  });

  test("「そこを見せて」は畳まない（作業ではなく参照）", () => {
    // 答えの根拠を見るための口なので、押すまで見えないと意味が無い
    expect(HTML).toContain("if (message.locate) appendLocate(turn, message.locate);");
    const staged = HTML.slice(HTML.indexOf("function appendStagedActions"));
    expect(staged.slice(0, staged.indexOf("\n}"))).not.toContain("appendLocate");
  });

  test("選択肢（作者の次の一言）は畳まない", () => {
    // 押すだけで話が進む道。ここまで隠すと会話が止まる
    // 答えの下に付くものは、届いた答えと後から開いた画面の履歴で
    // 同じ関数を通る（2026-09-23）。選択肢はその関数の中で畳まずに出す
    expect(HTML).toContain("appendOptions(turn, extras.options || []);");
    expect(HTML).toContain("appendAnswerExtras(turn, message,");
  });

  test("答えの中で、畳んだ枠を直に出していない", () => {
    // 古い呼び方が1つでも残っていると、そこだけ青枠が広がったままになる
    for (const call of [
      "appendEdit(turn, message.edit)",
      "appendReload(turn, message.reload)",
    ]) {
      expect(HTML, call).not.toContain(call);
    }
  });
});
