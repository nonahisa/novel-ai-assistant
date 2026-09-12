import { describe, expect, test } from "vitest";
import { TCY_RUN_PATTERN, tcyRuns } from "../../src/core/tateChuYoko";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";

/**
 * 縦書きで立てる半角数字（縦中横）の規則（作者の依頼、2026-09-12）。
 *
 * 規則は `core/tateChuYoko.ts` の1つだけで、画面（webview）へは
 * その文字列が埋め込まれる。**両方が同じ答えを返すこと**まで見る——
 * 片方だけが直ると、表記ゆれ検知が「半角1文字」と数えるものと、
 * 組んで書く面が立てるものが食い違う。
 */

/** その文字列から立てる run を、文字そのもので返す（読みやすさのため） */
function runsOf(text: string): string[] {
  return tcyRuns(text).map((run) => text.slice(run.start, run.end));
}

describe("縦中横にする半角数字の run", () => {
  test("「3月5日」は2か所（それぞれ1文字）", () => {
    expect(runsOf("3月5日")).toEqual(["3", "5"]);
  });

  test("「2026年」は立てない（3文字以上は現行どおり横倒し）", () => {
    expect(runsOf("2026年")).toEqual([]);
  });

  test("「12月」は「12」の1か所", () => {
    expect(runsOf("12月")).toEqual(["12"]);
  });

  test("「F5」は立てない（型番の数字だけが立つと読めない）", () => {
    expect(runsOf("F5")).toEqual([]);
  });

  test("「A-13」も立てない（ハイフンで繋いだ型番）", () => {
    expect(runsOf("A-13")).toEqual([]);
  });

  test("「第1話」は「1」の1か所", () => {
    expect(runsOf("第1話")).toEqual(["1"]);
  });

  test("1行に複数あっても、位置がずれない", () => {
    const line = "　3月5日、12時に第1話を出した。";
    const runs = tcyRuns(line);

    expect(runs.map((run) => line.slice(run.start, run.end))).toEqual([
      "3",
      "5",
      "12",
      "1",
    ]);
    // 位置がそのまま使える（DOMを組むときにここで切る）
    for (const run of runs) {
      expect(line.slice(run.start, run.end)).toMatch(/^[0-9]{1,2}$/);
    }
  });

  test("数字が無い行・空文字では何も返さない", () => {
    expect(tcyRuns("")).toEqual([]);
    expect(tcyRuns("　だが返事は無い。")).toEqual([]);
  });

  test("全角の数字は立てない（もともと寝ない）", () => {
    expect(runsOf("３月５日")).toEqual([]);
  });

  /**
   * EPUB（`epubXhtml.ts` の `applyTateChuYoko`）は「!」「?」も立てる
   * （設計書6.65.15）。**別の面の決まりなので、揃えない。**
   * ここで見張っておかないと、どちらかへ寄せる修正が黙って入る。
   */
  test("「!」「?」は立てない（EPUBとは決まりが違う）", () => {
    expect(runsOf("え!?")).toEqual([]);
  });
});

/* ── 画面側（webview）と同じ規則で動くか ───────────────── */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));
const source = code.slice(
  code.indexOf("/* compose:start */"),
  code.indexOf("/* compose:end */")
);

interface TcyApi {
  composeTcyRuns(value: string): Array<{ start: number; end: number }>;
}

const api = new Function(
  source + "\nreturn { composeTcyRuns };"
)() as TcyApi;

describe("画面側の縦中横は、写しではなく同じ規則で動く", () => {
  test("規則そのものが埋め込まれている", () => {
    expect(source).toContain(JSON.stringify(TCY_RUN_PATTERN));
  });

  test("core と画面側が、同じ文字列に同じ答えを返す", () => {
    const cases = [
      "",
      "3月5日",
      "2026年",
      "12月",
      "F5",
      "A-13",
      "第1話",
      "　3月5日、12時に第1話を出した。",
      "１２月",
      "え!?",
      "123456",
      "9",
      "99",
      "999",
      "あ1い2う",
      "B_7",
      "7-A",
    ];

    for (const value of cases) {
      expect(api.composeTcyRuns(value)).toEqual(tcyRuns(value));
    }
  });
});
