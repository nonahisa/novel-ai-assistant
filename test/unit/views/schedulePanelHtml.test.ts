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

  test("「今日」の札は、月の見出し・月曜の日付の札と重ならない高さまで下げる（2026-10-01 の実機：10月1日に「10月」と重なって読めなかった）", () => {
    const start = html.indexOf(">", html.indexOf("<script")) + 1;
    const script = html.slice(start, html.indexOf("</script>"));
    const at = script.indexOf("function freeLabelTop");
    expect(at, "札の高さを決める関数が無い").toBeGreaterThan(0);
    const end = script.indexOf("\n  }\n", at) + 4;
    const freeLabelTop = new Function(`${script.slice(at, end)}; return freeLabelTop;`)() as (
      want: number,
      taken: number[]
    ) => number;
    // 月の見出し（101）のすぐ下に今日（102）が来たら、見出しの下へ逃がす
    expect(freeLabelTop(102, [101])).toBeGreaterThanOrEqual(101 + 13);
    // 逃がした先にさらに札があれば、そのまた下へ
    expect(freeLabelTop(102, [101, 114])).toBeGreaterThanOrEqual(114 + 13);
    // 離れていれば動かさない
    expect(freeLabelTop(200, [101])).toBe(200);
    // 札が無ければそのまま
    expect(freeLabelTop(50, [])).toBe(50);
    // 呼び出し側：月の見出しと月曜の札の高さを覚え、今日の札に使う
    expect(script).toContain("labelTops.push(");
    expect(script).toContain("freeLabelTop(yOf(board.today) + 2, labelTops)");
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
