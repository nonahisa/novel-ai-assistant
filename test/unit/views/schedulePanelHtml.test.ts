import { describe, expect, test } from "vitest";
import { buildSchedulePanelHtml } from "../../../src/views/schedulePanelHtml";

/**
 * スケジュールの画面（設計書6.111.7）。CSP と nonce の流儀、外側のテンプレート文字列で
 * 埋め込みのスクリプトが崩れていないこと、作者の指定の文言を押さえる。
 */

describe("スケジュールの画面", () => {
  const html = buildSchedulePanelHtml("NONCE123", "vscode-resource:");

  test("スクリプトは nonce つきの1つだけで、外からの読み込みは許さない", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="NONCE123">');
  });

  test("埋め込みのスクリプトに、展開し損ねたテンプレートが残っていない", () => {
    const script = html.slice(html.indexOf("<script"), html.indexOf("</script>"));
    expect(script).not.toContain("${");
    expect(script).not.toContain("`");
  });

  test("作品が1つも無いときの案内と、済んだ作品の切り替えがある", () => {
    expect(html).toContain("スケジュールのある作品がありません。");
    expect(html).toContain("済んだ作品も見る");
    expect(html).toContain("＋ スケジュールを足す");
  });

  test("埋め込みのスクリプトは JavaScript として読める（崩れた文で画面が真っ白にならない）", () => {
    const start = html.indexOf(">", html.indexOf("<script")) + 1;
    const script = html.slice(start, html.indexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
  });

  test("カレンダーへの書き出し・祝日の取り込み・作業量の設定、並行と担い手の欄がある（6.111.12〜15）", () => {
    for (const text of [
      "カレンダーへ書き出す",
      "祝日を取り込む",
      "作業量の設定",
      "前の段が終わってから",
      "と同時に進められる",
      "人に頼む",
      "自分で進める",
    ]) {
      expect(html).toContain(text);
    }
    for (const type of ["exportIcs", "importHolidays", "openWorkloadSettings"]) expect(html).toContain(`"${type}"`);
  });

  test("連載の点は色だけでなく記号でも分ける", () => {
    for (const symbol of ["●", "◐", "○", "×"]) expect(html).toContain(symbol);
  });
});
