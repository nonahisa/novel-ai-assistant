import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆統計の「なろうの反応」のなろうAPIの欄と、順位の推移のグラフ（作者の指示 2026-11-02）。
 *
 * 画面の関数を切り出して、届いた状態から組む HTML を見る：
 * - ガイドラインを開くまでチェックは押せない（disabled）・開くと押せる
 * - チェックが入るまでボタンは押せない（既定はチェックなし）
 * - Nコード無し・ブラウザ版では案内だけ
 * - 順位の縦の軸は上下逆（1位が上）・圏外で線が切れる・種類ごとの線と凡例
 *
 * 見た目（色・幅）は画面でしか分からない（実機確認リストへ）。
 */

function scriptOf(html: string): string {
  const found = html.match(/<script nonce="N">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
}

function allFunctions(script: string): string {
  const parts: string[] = [];
  let at = script.indexOf("\nfunction ");
  while (at >= 0) {
    const end = script.indexOf("\n}\n", at);
    parts.push(script.slice(at, end + 3));
    at = script.indexOf("\nfunction ", end);
  }
  return parts.join("\n");
}

const script = allFunctions(scriptOf(buildWritingStatsPanelHtml("N", "csp")));

/** 画面の関数を1つ呼ぶ（なろうAPIの欄の手持ちの状態も渡せる） */
function call<T>(name: string, args: unknown[], held: { busy?: boolean; outcome?: unknown } = {}): T {
  return new Function(
    "args",
    [
      `let narouApiBusy = ${held.busy === true};`,
      `let narouApiOutcome = ${JSON.stringify(held.outcome ?? null)};`,
      script,
      `return ${name}(...args);`,
    ].join("\n")
  )(args) as T;
}

const ready = {
  status: "ready",
  ncode: "n1234ab",
  guidelineUrl: "https://dev.syosetu.com/site/guideline/",
  opened: false,
  agreed: false,
  agreedAt: null,
  attribution: "出典：なろうデベロッパー（なろう小説API・なろう殿堂入りAPI）",
  intervalMinutes: 60,
  dailyLimit: 5,
};

function checkbox(html: string): string {
  return html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? "";
}
function fetchButton(html: string): string {
  return html.match(/<button data-narou-fetch="1"[^>]*>/)?.[0] ?? "";
}

describe("なろうAPIの欄", () => {
  test("既定（開いていない）：チェックは押せず「先にガイドラインを開いてください」、ボタンも押せない", () => {
    const html = call<string>("renderNarouApi", [ready]);
    expect(html).toContain('data-narou-guideline="1"');
    expect(html).toContain("なろうデベロッパー利用ガイドライン");
    expect(checkbox(html)).toContain("disabled");
    expect(checkbox(html)).not.toContain("checked");
    expect(html).toContain("先にガイドラインを開いてください");
    expect(fetchButton(html)).toContain("disabled");
    expect(html).toContain("ガイドラインを読み、これに従って使うことに同意します");
    expect(html).toContain("なろうAPIによる作品情報取得");
    expect(html).toContain(ready.attribution);
  });

  test("開いたら：チェックを押せる（まだ入っていない）、ボタンはまだ押せない", () => {
    const html = call<string>("renderNarouApi", [{ ...ready, opened: true }]);
    expect(checkbox(html)).not.toContain("disabled");
    expect(checkbox(html)).not.toContain("checked");
    expect(html).not.toContain("先にガイドラインを開いてください");
    expect(fetchButton(html)).toContain("disabled");
  });

  test("同意したら：チェックが入り、ボタンが押せる。同意した日時と取り消せることを添える", () => {
    const html = call<string>("renderNarouApi", [
      { ...ready, opened: true, agreed: true, agreedAt: "2026-11-02T01:05:00.000Z" },
    ]);
    expect(checkbox(html)).toContain("checked");
    expect(checkbox(html)).not.toContain("disabled");
    expect(fetchButton(html)).not.toContain("disabled");
    expect(html).toContain("外すといつでも取り消せます");
    expect(html).toContain("60分に1回・1日5回まで");
    expect(html).toContain("AIには渡しません");
  });

  test("取得の途中はボタンを押せない。結果の文を出す", () => {
    const agreed = { ...ready, opened: true, agreed: true, agreedAt: "2026-11-02T01:05:00.000Z" };
    expect(fetchButton(call<string>("renderNarouApi", [agreed], { busy: true }))).toContain("disabled");
    const html = call<string>("renderNarouApi", [agreed], {
      outcome: { kind: "failed", message: "なろう小説APIにつながりませんでした。" },
    });
    expect(html).toContain("なろう小説APIにつながりませんでした。");
  });

  test("Nコードが無ければ案内だけ（チェックもボタンも出さない）", () => {
    const html = call<string>("renderNarouApi", [{ ...ready, status: "no-ncode", ncode: null }]);
    expect(html).toContain("投稿サイト設定で Nコードを登録すると使えます。");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("data-narou-fetch");
  });

  test("ブラウザ版ではボタンを隠し「パソコンの VS Code で使えます」の1行", () => {
    const html = call<string>("renderNarouApi", [{ ...ready, status: "web" }]);
    expect(html).toContain("パソコンの VS Code で使えます");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("data-narou-fetch");
  });

  test("なろうに載っていない作品（状態が無い）では何も出さない", () => {
    expect(call<string>("renderNarouApi", [null])).toBe("");
  });
});

describe("順位の推移のグラフ", () => {
  test("縦の軸は上下逆：いちばん良い順位がいちばん上", () => {
    const top = call<number>("rankY", [1, 1, 300, 10, 150]);
    const bottom = call<number>("rankY", [300, 1, 300, 10, 150]);
    const middle = call<number>("rankY", [150, 1, 300, 10, 150]);
    expect(top).toBe(10);
    expect(bottom).toBe(160);
    expect(middle).toBeGreaterThan(top);
    expect(middle).toBeLessThan(bottom);
  });

  test("圏外（null）で線が切れる", () => {
    const segments = call<Array<Array<{ day: string }>>>("rankSegments", [
      [
        { day: "2026-10-01", rank: 10 },
        { day: "2026-10-02", rank: 8 },
        { day: "2026-10-03", rank: null },
        { day: "2026-10-05", rank: 5 },
        { day: "2026-10-06", rank: 4 },
      ],
    ]);
    expect(segments.map((segment) => segment.map((point) => point.day))).toEqual([
      ["2026-10-01", "2026-10-02"],
      ["2026-10-05", "2026-10-06"],
    ]);
  });

  test("種類ごとに線を分け、色と凡例を付ける。圏外の点は描かない。幅に合わせて縮む", () => {
    const html = call<string>("renderRankChart", [
      {
        series: [
          { label: "日間", points: [{ day: "2026-10-01", rank: 10 }, { day: "2026-10-02", rank: null }, { day: "2026-10-03", rank: 5 }, { day: "2026-10-04", rank: 3 }] },
          { label: "週間", points: [{ day: "2026-10-01", rank: 100 }, { day: "2026-10-04", rank: 80 }] },
        ],
        firstDay: "2026-10-01",
        lastDay: "2026-10-04",
        best: 3,
        worst: 100,
      },
    ]);
    // 日間は圏外で切れて1本（点が1つだけのかたまりは線にしない）、週間は1本
    expect(html.match(/<polyline class="rank-line rank-s0"/g)).toHaveLength(1);
    expect(html.match(/<polyline class="rank-line rank-s1"/g)).toHaveLength(1);
    expect(html.match(/<circle class="rank-dot rank-s0"/g)).toHaveLength(3);
    expect(html).toContain('<span class="rank-key rank-s0"><span class="rank-swatch"></span>日間</span>');
    expect(html).toContain('<span class="rank-key rank-s1"><span class="rank-swatch"></span>週間</span>');
    expect(html).toContain("3位");
    expect(html).toContain("100位");
    // 横に送らない作り（viewBox で縮む。幅を数で決めない）
    expect(html).toContain('viewBox="0 0 640 ');
    expect(html).not.toMatch(/<svg width="\d+"/);
    // 0 や大きな数で埋めていない
    expect(html).not.toContain(">0位");
  });

  test("順位が1つも無いサイトは、グラフの代わりに1行", () => {
    expect(call<string>("renderRankChart", [null])).toContain(
      "「ランキング記録」で順位を残すと、ここに推移が出ます。"
    );
  });

  test("増減のグラフには今までどおり順位を混ぜない（増減のグラフの関数は順位の材料を見ない）", () => {
    const changes = script.slice(script.indexOf("function renderReaderCharts"), script.indexOf("function readerSignedCount"));
    expect(changes).not.toContain("rank");
  });
});
