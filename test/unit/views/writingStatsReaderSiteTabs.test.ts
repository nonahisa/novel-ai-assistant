import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 「読者の反応」をサイトごとのタブに分ける（作者の指示 2026-11-01）。
 *
 * 見るのは**組み立て**（どのサイトのタブがどの順に出て、どれが選ばれているか・サイトを
 * またぐ知らせがどのタブに入るか）と、押したときに拡張機能へ知らせる配線。見た目は画面でしか
 * 分からない（実機確認リストへ）。
 */

function scriptOf(html: string): string {
  const found = html.match(/<script nonce="N">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
}

/** スクリプトの最上位の関数を全部切り出す（字下げの無い `}` で終わる） */
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

interface FakeElement {
  innerHTML: string;
}

function render(state: unknown, initialSite = ""): { html: string; posted: unknown[] } {
  const posted: unknown[] = [];
  const host: FakeElement & { querySelectorAll: () => never[] } = {
    innerHTML: "",
    querySelectorAll: () => [],
  };
  const html = buildWritingStatsPanelHtml("N", "csp");
  const run = new Function(
    "document",
    "vscode",
    "state",
    [
      "const readerAdviceOutcomes = {};",
      "const readerAdviceBusy = {};",
      `let readerSite = ${JSON.stringify(initialSite)};`,
      allFunctions(scriptOf(html)),
      "renderSiteRecords();",
    ].join("\n")
  );
  run(
    { getElementById: (id: string) => (id === "site-records" ? host : null), body: { dataset: {} } },
    { postMessage: (message: unknown) => posted.push(message) },
    state
  );
  return { html: host.innerHTML, posted };
}

function record(site: string, label: string): Record<string, unknown> {
  return {
    site,
    label,
    workId: null,
    workUrl: null,
    genre: null,
    note: null,
    registered: true,
    analysisUrl: null,
    latest: null,
    history: [],
    readerLatest: null,
    readerWork: null,
    readerEpisodes: null,
    readerRates: null,
    readerAdvice: null,
    readerCharts: { episodes: null, day: null, month: null, year: null, total: null, changes: [] },
    tags: null,
    tagsAt: null,
    tagHistory: [],
    completion: null,
    completionLabel: null,
  };
}

const twoSites = {
  siteRecords: [record("narou", "小説家になろう"), record("kakuyomu", "カクヨム")],
  readerSites: [
    { site: "kakuyomu", label: "カクヨム" },
    { site: "narou", label: "小説家になろう" },
  ],
  siteRecordsError: null,
  workFacts: {
    completion: null,
    suggestion: null,
    notice: null,
    mismatches: [],
    tagDifferences: [{ site: "kakuyomu", label: "カクヨム", only: ["群像劇"] }],
  },
};

function tabTags(html: string): string[] {
  return [...html.matchAll(/<div class="site-tab[^"]*"[^>]*>[^<]*<\/div>/g)].map((m) => m[0]);
}

describe("読者の反応のサイトのタブ", () => {
  test("届いた並び（なろうが最後尾）のとおりにタブを並べ、先頭を選ぶ", () => {
    const tags = tabTags(render(twoSites).html);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('data-site-tab="kakuyomu"');
    expect(tags[0]).toContain('aria-selected="true"');
    expect(tags[1]).toContain('data-site-tab="narou"');
    expect(tags[1]).toContain('aria-selected="false"');
    expect(tags[1]).toContain('tabindex="-1"');
  });

  test("前に見ていたサイトで開く", () => {
    const tags = tabTags(render(twoSites, "narou").html);
    expect(tags[1]).toContain('aria-selected="true"');
    expect(render(twoSites, "narou").html).toContain('<section class="site-page active" id="site-page-narou"');
  });

  test("覚えていたサイトがもう無ければ、先頭のサイト", () => {
    expect(tabTags(render(twoSites, "alphapolis").html)[0]).toContain('aria-selected="true"');
  });

  test("サイトが1つでもタブを1つ出す", () => {
    const one = {
      ...twoSites,
      siteRecords: [record("narou", "小説家になろう")],
      readerSites: [{ site: "narou", label: "小説家になろう" }],
    };
    expect(tabTags(render(one).html)).toHaveLength(1);
  });

  test("サイトをまたぐ知らせは、そのサイトのタブの中へ入る", () => {
    const html = render(twoSites).html;
    const kakuyomu = html.slice(html.indexOf('id="site-page-kakuyomu"'), html.indexOf('id="site-page-narou"'));
    expect(kakuyomu).toContain("ほかのサイトに無いタグ：群像劇");
    expect(html.slice(html.indexOf('id="site-page-narou"'))).not.toContain("群像劇");
  });

  test("登録しただけで記録の無いサイトは、空の面にせず案内を出す", () => {
    const html = render({
      ...twoSites,
      siteRecords: [record("narou", "小説家になろう")],
    }).html;
    expect(html).toContain("カクヨムの記録はまだありません");
  });

  test("台帳を読めなかった知らせは、どのサイトにも属さないのでタブの上に置く", () => {
    const html = render({ ...twoSites, siteRecordsError: "壊れています" }).html;
    expect(html.indexOf("読者の反応の記録を読めませんでした")).toBeLessThan(html.indexOf('class="site-tabs"'));
  });

  test("サイトのタブは外側のタブと別の印（.site-tab）で、外側の選び直しに巻き込まれない", () => {
    const html = render(twoSites).html;
    expect(html).not.toMatch(/class="tab[ "]/);
    expect(html).toContain('role="tablist" aria-label="読者の反応のサイト"');
  });
});

describe("押したサイトを覚える配線", () => {
  test("押したときだけ拡張機能へ知らせる。開いたときの選び直しでは知らせない", () => {
    const html = buildWritingStatsPanelHtml("N", "csp");
    const script = scriptOf(html);
    expect(script).toContain("selectReaderSite(tab.dataset.siteTab, false, true)");
    expect(script).toContain("type: 'readerSiteSelected'");
    // 描画は覚え直さない（覚えている値で描いたところ）
    expect(render(twoSites).posted).toEqual([]);
  });

  test("拡張機能が覚えているサイトは、知っているサイトの鍵だけ HTML へ埋める", () => {
    expect(buildWritingStatsPanelHtml("N", "csp", { initialReaderSite: "narou" })).toContain(
      'data-initial-site="narou"'
    );
    expect(buildWritingStatsPanelHtml("N", "csp", { initialReaderSite: '"><x>' })).toContain(
      'data-initial-site=""'
    );
  });
});
