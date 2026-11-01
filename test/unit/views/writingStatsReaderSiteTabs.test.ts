import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆統計のサイトのタブ（「カクヨムの反応」など。作者の指示 2026-11-01「読者の反応は
 * 二段のタブとせず、『カクヨムの反応』『なろうの反応』『アルファの反応』で並べてください」）。
 *
 * 見るのは**統計が届いたときの組み立て**（タブの並びを届いたサイトに揃え直す・どの面を見せるか・
 * サイトをまたぐ知らせがどのタブに入るか）。組み立てるときのタブは writingStatsPanelTabs.test.ts、
 * 見た目は画面でしか分からない（実機確認リストへ）。
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

interface FakeTab {
  dataset: { page: string; site?: string };
  label: string;
  active: boolean;
  removed: boolean;
  remove: () => void;
}

function fakeTab(page: string, label: string, active = false): FakeTab {
  const tab: FakeTab = {
    dataset: page.startsWith("site-") ? { page, site: page.slice(5) } : { page },
    label,
    active,
    removed: false,
    remove: () => {
      tab.removed = true;
    },
  };
  return tab;
}

interface Rendered {
  host: string;
  guide: string;
  tabs: Array<{ page: string; label: string }>;
  selected: Array<{ page: string; focus: boolean; remember: boolean }>;
  posted: unknown[];
}

/**
 * renderSiteRecords を作り物の DOM で動かす。
 * @param shownTabs 今出ているサイトのタブ（data-page）
 * @param active いま選んでいるタブ
 */
function render(state: unknown, shownTabs: string[] = [], active = "overview"): Rendered {
  const posted: unknown[] = [];
  const selected: Rendered["selected"] = [];
  const host = { innerHTML: "", querySelectorAll: () => [] };
  const guide = { innerHTML: "" };
  let tabs: FakeTab[] = [
    fakeTab("overview", "概要", active === "overview"),
    fakeTab("trend", "執筆の推移", active === "trend"),
    fakeTab("episodes", "話ごと", active === "episodes"),
    ...shownTabs.map((page) => fakeTab(page, page, active === page)),
  ];
  const bar = {
    querySelectorAll: (selector: string) => {
      if (selector !== ".tab[data-site]") throw new Error(`想定していない探し方: ${selector}`);
      return tabs.filter((tab) => tab.dataset.site !== undefined);
    },
    insertAdjacentHTML: (where: string, html: string) => {
      expect(where).toBe("beforeend");
      tabs = tabs.filter((tab) => !tab.removed);
      for (const m of html.matchAll(/<div class="tab"[^>]*data-page="([^"]+)"[^>]*>([^<]*)<\/div>/g)) {
        tabs.push(fakeTab(m[1], m[2]));
      }
    },
  };
  const fakeDocument = {
    getElementById: (id: string) =>
      id === "site-records" ? host : id === "reader-guide" ? guide : id === "tabs" ? bar : null,
    querySelector: (selector: string) => {
      expect(selector).toBe(".tab.active");
      return tabs.find((tab) => tab.active && !tab.removed) ?? null;
    },
    body: { dataset: { initialTab: "overview" } },
  };
  const html = buildWritingStatsPanelHtml("N", "csp");
  const script = allFunctions(scriptOf(html));
  new Function(
    "document",
    "vscode",
    "state",
    "recordSelect",
    [
      "const readerAdviceOutcomes = {};",
      "const readerAdviceBusy = {};",
      script,
      // 外側のタブの選び直しは writingStatsPanelTabs.test.ts で見る。ここは何を選んだかだけ集める
      "selectTab = function (page, focus, remember) { recordSelect(page, focus, remember); };",
      "renderSiteRecords();",
    ].join("\n")
  )(fakeDocument, { postMessage: (message: unknown) => posted.push(message) }, state, (page: string, focus: boolean, remember: boolean) =>
    selected.push({ page, focus, remember })
  );
  return {
    host: host.innerHTML,
    guide: guide.innerHTML,
    tabs: tabs.filter((tab) => !tab.removed).map((tab) => ({ page: tab.dataset.page, label: tab.label })),
    selected,
    posted,
  };
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
    { site: "kakuyomu", label: "カクヨム", tabLabel: "カクヨムの反応" },
    { site: "narou", label: "小説家になろう", tabLabel: "なろうの反応" },
  ],
  siteRecordsError: null,
  workFacts: {
    completion: { value: "completed", label: "完結", setAt: "x" },
    suggestion: null,
    notice: null,
    mismatches: [{ site: "narou", label: "小説家になろう", completion: "serial", completionLabel: "連載中" }],
    tagDifferences: [{ site: "kakuyomu", label: "カクヨム", only: ["群像劇"] }],
  },
};

const SITE_PAGES = ["site-kakuyomu", "site-narou"];

describe("サイトのタブを、届いたサイトに揃える", () => {
  test("届いた並び（なろうが最後尾）のとおりに、外側のタブの後ろへ「〜の反応」を足す", () => {
    const shown = render(twoSites);
    expect(shown.tabs).toEqual([
      { page: "overview", label: "概要" },
      { page: "trend", label: "執筆の推移" },
      { page: "episodes", label: "話ごと" },
      { page: "site-kakuyomu", label: "カクヨムの反応" },
      { page: "site-narou", label: "なろうの反応" },
    ]);
    // 見ていたのは概要なので、概要のまま（作者が押したのではないので覚え直さない）
    expect(shown.selected).toEqual([{ page: "overview", focus: false, remember: false }]);
  });

  test("並びが同じなら、タブを作り直さない（本文を保存するたびに焦点が外れないように）", () => {
    const shown = render(twoSites, SITE_PAGES, "site-narou");
    expect(shown.selected).toEqual([]);
    expect(shown.host).toContain('<section class="page active" id="page-site-narou"');
    expect(shown.host).toContain('<section class="page" id="page-site-kakuyomu"');
  });

  test("見ていたサイトのタブが無くなったら、概要へ", () => {
    const shown = render({ ...twoSites, readerSites: twoSites.readerSites.slice(0, 1) }, SITE_PAGES, "site-narou");
    expect(shown.tabs.map((tab) => tab.page)).toEqual(["overview", "trend", "episodes", "site-kakuyomu"]);
    expect(shown.selected).toEqual([{ page: "overview", focus: false, remember: false }]);
  });

  test("サイトが増えても、見ていたタブ（執筆の推移・サイトのタブ）から動かさない", () => {
    expect(render(twoSites, ["site-kakuyomu"], "trend").selected).toEqual([
      { page: "trend", focus: false, remember: false },
    ]);
    expect(render(twoSites, ["site-kakuyomu"], "site-kakuyomu").selected).toEqual([
      { page: "site-kakuyomu", focus: false, remember: false },
    ]);
  });

  test("サイトが1つでもタブを1つ出す", () => {
    const one = {
      ...twoSites,
      siteRecords: [record("narou", "小説家になろう")],
      readerSites: [twoSites.readerSites[1]],
    };
    expect(render(one).tabs.filter((tab) => tab.page.startsWith("site-"))).toHaveLength(1);
  });

  test("配信しているサイトが無くなれば、サイトのタブを全部外して概要に案内を出す", () => {
    const shown = render({ ...twoSites, siteRecords: [], readerSites: [] }, SITE_PAGES, "site-kakuyomu");
    expect(shown.tabs.map((tab) => tab.page)).toEqual(["overview", "trend", "episodes"]);
    expect(shown.host).toBe("");
    expect(shown.guide).toContain("読者の反応はまだありません");
  });
});

describe("サイトのタブの中身", () => {
  test("サイトをまたぐ知らせ（タグ・連載の状態の食い違い）は、そのサイトのタブの中へ入る", () => {
    const html = render(twoSites, SITE_PAGES).host;
    const kakuyomu = html.slice(html.indexOf('id="page-site-kakuyomu"'), html.indexOf('id="page-site-narou"'));
    const narou = html.slice(html.indexOf('id="page-site-narou"'));
    expect(kakuyomu).toContain("ほかのサイトに無いタグ：群像劇");
    expect(kakuyomu).not.toContain("連載中");
    expect(narou).not.toContain("群像劇");
    expect(narou).toContain("作品は完結にしてありますが、このサイトでは連載中です");
  });

  test("登録しただけで記録の無いサイトは、空の面にせず案内を出す", () => {
    const html = render({ ...twoSites, siteRecords: [record("narou", "小説家になろう")] }, SITE_PAGES).host;
    expect(html).toContain("カクヨムの記録はまだありません");
  });

  test("台帳を読めなかった知らせは、どのサイトにも属さないので概要に出す", () => {
    const shown = render({ ...twoSites, readerSites: [], siteRecords: [], siteRecordsError: "壊れています" });
    expect(shown.guide).toContain("読者の反応の記録を読めませんでした：壊れています");
    expect(shown.host).not.toContain("読めませんでした");
  });

  test("サイトの面は外側のタブと同じ面（.page）で、外側の選び直しで切り替わる", () => {
    const html = render(twoSites, SITE_PAGES).host;
    expect(html).toContain('role="tabpanel" aria-labelledby="tab-site-kakuyomu"');
    // 0.119.0 の内側のタブ・面の印（.site-tab・.site-page）は使わない
    expect(html).not.toContain('class="site-page');
    expect(html).not.toContain('class="site-tab');
  });
});

describe("押したタブを覚える配線", () => {
  test("描き直しでは拡張機能へ知らせない（覚えている値で描いたところ）", () => {
    expect(render(twoSites).posted).toEqual([]);
    expect(render(twoSites, SITE_PAGES, "site-narou").posted).toEqual([]);
  });

  test("サイトのタブを覚える別の知らせ（0.119.0 の readerSiteSelected）はもう無い", () => {
    const script = scriptOf(buildWritingStatsPanelHtml("N", "csp"));
    expect(script).not.toContain("readerSiteSelected");
    expect(buildWritingStatsPanelHtml("N", "csp")).not.toContain("data-initial-site");
  });
});
