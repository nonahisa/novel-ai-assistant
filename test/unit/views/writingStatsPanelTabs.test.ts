import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆統計のタブ（作者の指示、2026-11-01「タブを有効活用して分け、見た目を
 * シンプルかつおしゃれに」。設計書6.3.9）。
 *
 * **タブは1段**（同じ日の後の指示「読者の反応は二段のタブとせず、『カクヨムの反応』
 * 『なろうの反応』『アルファの反応』で並べてください」）。
 *
 * 見るのは**置き場所**（どの id がどのタブの面にあるか）と、キーボードで
 * 動かせる作り、最後に開いたタブを覚える配線である。見た目の良し悪しは
 * 画面でしか分からない。
 */

const perWork = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
/** 4つのサイトに配信している作品（並びは core の readerSiteTabs が決めたとおりに届く） */
const fourSites = [
  { site: "kakuyomu", label: "カクヨム", tabLabel: "カクヨムの反応" },
  { site: "alphapolis", label: "アルファポリス", tabLabel: "アルファの反応" },
  { site: "note", label: "note", tabLabel: "noteの反応" },
  { site: "narou", label: "小説家になろう", tabLabel: "なろうの反応" },
] as const;
const withSites = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", { readerSites: fourSites });
const allWorks = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
  hasEpisodesTab: false,
  hasReadersTab: false,
  readerSites: fourSites,
});

function scriptOf(html: string): string {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
}

/** スクリプトの最上位にある関数を1つ切り出す（字下げの無い `}` で終わる） */
function functionSource(name: string): string {
  const script = scriptOf(perWork);
  const start = script.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`関数 ${name} が見つかりません`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

/** 面（section）の中身を取り出す */
function pageOf(html: string, key: string): string {
  const found = html.match(new RegExp(`<section class="page[^"]*" id="page-${key}"[^>]*>([\\s\\S]*?)</section>`));
  return found ? found[1] : "";
}

/** 組み立てたタブの並び（data-page と字面）。スクリプトの中のタブを組み直す字は数えない */
function tabsOf(html: string): Array<{ key: string; label: string }> {
  return [...html.split("<script")[0].matchAll(/<div class="tab[^"]*"[^>]*data-page="([^"]+)"[^>]*>([^<]*)<\/div>/g)].map((m) => ({
    key: m[1],
    label: m[2],
  }));
}

describe("タブの分け方", () => {
  test("概要・執筆の推移・話ごとの後ろに、配信しているサイトの「〜の反応」を1段で並べる", () => {
    expect(tabsOf(withSites)).toEqual([
      { key: "overview", label: "概要" },
      { key: "trend", label: "執筆の推移" },
      { key: "episodes", label: "話ごと" },
      { key: "site-kakuyomu", label: "カクヨムの反応" },
      { key: "site-alphapolis", label: "アルファの反応" },
      { key: "site-note", label: "noteの反応" },
      { key: "site-narou", label: "なろうの反応" },
    ]);
    // 二段のタブ（0.119.0 の「読者の反応」の中のサイトのタブ）は無い
    expect(withSites).not.toContain('data-page="readers"');
    expect(withSites).not.toContain("site-tab");
  });

  test("配信しているサイトが無い作品では、サイトのタブを出さない", () => {
    expect(tabsOf(perWork).map((tab) => tab.key)).toEqual(["overview", "trend", "episodes"]);
  });

  test("知らないサイトの鍵は、タブにも面にも埋めない", () => {
    const odd = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
      readerSites: [{ site: '"><x>' as never, label: "x", tabLabel: "x" }],
    });
    expect(odd).not.toContain('"><x>');
    expect(tabsOf(odd)).toHaveLength(3);
  });

  test("作品の単位の名前（投稿など）は、話ごとのタブの名前に使う", () => {
    const sns = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", { unitNoun: "投稿" });
    expect(tabsOf(sns).map((tab) => tab.label)).toContain("投稿ごと");
  });

  test("全作品の画面は、話ごと・サイトのタブ・取り込み方の案内を出さない", () => {
    expect(tabsOf(allWorks).map((tab) => tab.key)).toEqual(["overview", "trend"]);
    // 見るのは組み立てた所（スクリプトの中には、サイトの面を組み直す字がある）
    const built = allWorks.split("<script")[0];
    expect(built).not.toContain('id="page-episodes"');
    expect(built).not.toContain('id="page-site-');
    expect(built).not.toContain('id="reader-guide"');
    expect(built).not.toContain('id="site-records"');
  });

  test("概要には締切・数の札・目標への入口・読者の反応の案内・達成を置く", () => {
    const page = pageOf(perWork, "overview");
    for (const id of ["contest", "cards", "goal-link", "reader-guide", "achievements"]) {
      expect(page, id).toContain(`id="${id}"`);
    }
    expect(page).not.toContain('id="chart"');
  });

  test("執筆の推移には粒度の切り替え・グラフ・注記・端末ごとを置く", () => {
    const page = pageOf(perWork, "trend");
    for (const id of ["granularity", "chart", "chart-note", "devices"]) {
      expect(page, id).toContain(`id="${id}"`);
    }
  });

  test("話ごとには札と表、サイトのタブの面はサイトの記録の置き場の中に置く", () => {
    expect(pageOf(perWork, "episodes")).toContain('id="episode-cards"');
    expect(pageOf(perWork, "episodes")).toContain('id="episode-table"');
    const records = withSites.slice(withSites.indexOf('<div id="site-records">'), withSites.indexOf("</main>"));
    for (const site of ["kakuyomu", "alphapolis", "note", "narou"]) {
      expect(records, site).toContain(`<section class="page" id="page-site-${site}"`);
    }
  });

  test("開いた直後に見えるのは概要（ほかの面は隠れている）", () => {
    expect(perWork).toContain('<section class="page active" id="page-overview"');
    expect(perWork).toContain('<section class="page" id="page-trend"');
  });

  test("タブが増えても、狭い幅では折り返す（横に送らせない）", () => {
    expect(perWork).toMatch(/\.tabs \{ display: flex; flex-wrap: wrap;/);
  });
});

describe("キーボードで動かせる作り", () => {
  test("tablist・tab・tabpanel の役と、選んでいるタブの印がある", () => {
    expect(withSites).toContain('role="tablist"');
    const tabTags = [...withSites.split("<script")[0].matchAll(/<div class="tab(?: [^"]*)?"[^>]*>/g)].map((m) => m[0]);
    expect(tabTags).toHaveLength(7);
    for (const tag of tabTags) {
      expect(tag).toContain('role="tab"');
      expect(tag).toMatch(/aria-controls="page-[a-z-]+"/);
    }
    // 選んでいるのは1つだけで、焦点で巡るのもそれだけ
    expect(tabTags.filter((tag) => tag.includes('aria-selected="true"'))).toHaveLength(1);
    expect(tabTags.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);
    // 数えるのは組み立てた面だけ（スクリプトの中には、サイトの面を組み直す字がある）
    expect((withSites.split("<script")[0].match(/role="tabpanel"/g) ?? []).length).toBe(7);
  });

  const after = new Function(`${functionSource("tabIndexAfterKey")}\nreturn tabIndexAfterKey;`)() as (
    key: string,
    current: number,
    count: number
  ) => number;

  test("左右の矢印で隣へ移り、端から先は反対の端へ回る", () => {
    expect(after("ArrowRight", 0, 4)).toBe(1);
    expect(after("ArrowRight", 3, 4)).toBe(0);
    expect(after("ArrowLeft", 0, 4)).toBe(3);
    expect(after("ArrowLeft", 2, 4)).toBe(1);
    expect(after("Home", 2, 4)).toBe(0);
    expect(after("End", 0, 4)).toBe(3);
    // サイトのタブが並んで7つになっても、同じ1段の中で巡る
    expect(after("ArrowRight", 6, 7)).toBe(0);
    expect(after("ArrowLeft", 0, 7)).toBe(6);
  });

  test("関係の無いキーでは移らない", () => {
    expect(after("a", 1, 4)).toBe(-1);
    expect(after("ArrowDown", 1, 4)).toBe(-1);
  });

  test("押したときの動きはタブの並びで受ける（統計が届いて作り直したサイトのタブでも効く）", () => {
    const script = scriptOf(perWork);
    expect(script).toContain("document.getElementById('tabs')");
    expect(script).toContain("closest('.tab')");
    expect(script).not.toContain("document.querySelectorAll('.tab').forEach");
  });
});

describe("前に見ていたタブで開く（作品ごと。作者の判断 2026-11-01）", () => {
  /** selectTab を作り物の DOM で動かす。画面から拡張機能へ送った知らせも集める */
  function run(initial: string, click?: string): { active: string | null; posted: unknown[] } {
    const posted: unknown[] = [];
    const makeTab = (page: string) => {
      const classes = new Set<string>();
      const attributes: Record<string, string> = {};
      return {
        dataset: { page },
        tabIndex: -1,
        classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)), has: (name: string) => classes.has(name) },
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
        focus: () => undefined,
        attributes,
      };
    };
    const tabs = ["overview", "trend", "episodes", "site-kakuyomu", "site-narou"].map(makeTab);
    const pages = tabs.map((tab) => {
      const classes = new Set<string>();
      return {
        id: `page-${tab.dataset.page}`,
        classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)), has: (name: string) => classes.has(name) },
      };
    });
    const fakeDocument = {
      querySelectorAll: (selector: string) => (selector === ".tab" ? tabs : selector === ".page" ? pages : []),
    };
    const fakeVscode = { postMessage: (message: unknown) => posted.push(message) };
    const select = new Function(
      "document",
      "vscode",
      `${functionSource("selectTab")}\nfunction pinChartToLatest() {}\nreturn selectTab;`
    )(fakeDocument, fakeVscode) as (page: string, focus: boolean, remember?: boolean) => void;
    // 開いたときの選び直しは覚え直さない（拡張機能が覚えている値で開いたところ）
    select(initial, false, false);
    if (click) select(click, false, true);
    const activePage = pages.find((page) => page.classList.has("active"));
    const selected = tabs.filter((tab) => tab.attributes["aria-selected"] === "true");
    expect(selected).toHaveLength(1);
    expect(activePage?.id).toBe(`page-${selected[0].dataset.page}`);
    return { active: selected[0].dataset.page, posted };
  }

  test("押したタブ（サイトのタブも）を拡張機能へ知らせる（覚えるのは拡張機能の側）", () => {
    const result = run("overview", "site-narou");
    expect(result.active).toBe("site-narou");
    expect(result.posted).toEqual([{ type: "tabSelected", tab: "site-narou" }]);
  });

  test("開いたときの選び直しでは知らせない", () => {
    expect(run("trend").posted).toEqual([]);
  });

  test("無いタブを渡されたら、先頭の概要へ戻す（もう無い「読者の反応」も）", () => {
    expect(run("writing").active).toBe("overview");
    expect(run("readers").active).toBe("overview");
  });

  test("覚えていたサイトのタブを選んだ状態で画面を組む（開いた瞬間に概要が見えない）", () => {
    const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
      initialTab: "site-alphapolis",
      readerSites: fourSites,
    });
    expect(html).toContain('<section class="page active" id="page-site-alphapolis"');
    expect(html).toContain('<section class="page" id="page-overview"');
    const tabTags = [...html.split("<script")[0].matchAll(/<div class="tab(?: [^"]*)?"[^>]*>/g)].map((m) => m[0]);
    expect(tabTags.filter((tag) => tag.includes('aria-selected="true"'))).toEqual([
      expect.stringContaining('data-page="site-alphapolis"'),
    ]);
    expect(html).toContain('data-initial-tab="site-alphapolis"');
  });

  test("覚えていたサイトのタブがもう無ければ（配信をやめた）、概要で組む", () => {
    const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
      initialTab: "site-note",
      readerSites: fourSites.filter((tab) => tab.site !== "note"),
    });
    expect(html).toContain('<section class="page active" id="page-overview"');
    expect(html).toContain('data-initial-tab="overview"');
  });

  test("その画面に無いタブ・知らない鍵を渡されたら概要で組む", () => {
    const all = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
      hasEpisodesTab: false,
      hasReadersTab: false,
      initialTab: "site-kakuyomu",
      readerSites: fourSites,
    });
    expect(all).toContain('<section class="page active" id="page-overview"');
    expect(all).toContain('data-initial-tab="overview"');
    const odd = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
      initialTab: '"><script>',
    });
    expect(odd).toContain('data-initial-tab="overview"');
    expect(odd).not.toContain('"><script>');
  });

  test("WebView の中の記憶（閉じると消える）には頼らない", () => {
    expect(scriptOf(perWork)).not.toContain("vscode.setState");
    expect(scriptOf(perWork)).toContain("dataset.initialTab");
  });
});

describe("0話の作品の「話ごと」", () => {
  test("タブは隠さない", () => {
    // 作品ごとの画面は、話の有無にかかわらず「話ごと」を出す（話の数を見て組み替えない）
    expect(tabsOf(perWork).map((tab) => tab.key)).toContain("episodes");
  });

  function renderEmpty(html: string): { cards: string; table: string } {
    const cards = { innerHTML: "" };
    const table = { innerHTML: "" };
    const script = scriptOf(html);
    const start = script.indexOf("\nfunction renderEpisodes(");
    const end = script.indexOf("\n}\n", start);
    const helpers = ["formatCount", "card", "escapeHtml"]
      .map((name) => {
        const s = script.indexOf(`\nfunction ${name}(`);
        return script.slice(s, script.indexOf("\n}\n", s) + 3);
      })
      .join("\n");
    const render = new Function(
      "document",
      "state",
      `${helpers}\n${script.slice(start, end + 3)}\nreturn renderEpisodes;`
    )(
      { getElementById: (id: string) => (id === "episode-cards" ? cards : id === "episode-table" ? table : null) },
      {
        episodes: {
          summary: {
            countedFiles: 0,
            conflictedFiles: 0,
            totalChars: 0,
            averageChars: 0,
            medianChars: 0,
            longest: null,
            shortest: null,
            collectedFiles: 0,
            countMode: "net",
          },
          rows: [],
        },
      }
    ) as () => void;
    render();
    return { cards: cards.innerHTML, table: table.innerHTML };
  }

  test("中身に「まだ話がありません」と出す（札に NaN を出さない）", () => {
    const shown = renderEmpty(perWork);
    expect(shown.table).toContain("まだ話がありません");
    expect(shown.cards).not.toContain("NaN");
  });

  test("SNS記事の作品では「まだ投稿がありません」", () => {
    const sns = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", { unitNoun: "投稿" });
    expect(renderEmpty(sns).table).toContain("まだ投稿がありません");
  });
});

describe("配信しているサイトが無い作品の案内（概要に1行）", () => {
  function guideOf(state: unknown): { guide: string; host: string } {
    const guide = { innerHTML: "" };
    const host = { innerHTML: "", querySelectorAll: () => [] };
    const render = new Function(
      "document",
      "state",
      [
        functionSource("escapeHtml"),
        // タブの並びの揃え直しと今のタブは、ここでは見ない（下の「サイトのタブを揃え直す」で見る）
        "function syncSiteTabs() {}",
        "function activeTabKey() { return 'overview'; }",
        functionSource("renderSiteRecords"),
        "return renderSiteRecords;",
      ].join("\n")
    )(
      { getElementById: (id: string) => (id === "site-records" ? host : id === "reader-guide" ? guide : null) },
      state
    ) as () => void;
    render();
    return { guide: guide.innerHTML, host: host.innerHTML };
  }

  test("サイトのタブを出さず、何をすればタブが出るかを概要で言う", () => {
    const shown = guideOf({ siteRecords: [], readerSites: [] });
    expect(shown.guide).toContain("読者の反応はまだありません");
    expect(shown.guide).toContain("「投稿サイト設定」");
    expect(shown.guide).toContain("「カクヨムの反応」");
    expect(shown.host).toBe("");
  });

  test("台帳を読めなかった知らせも概要へ（どのサイトにも属さない）", () => {
    const shown = guideOf({ siteRecords: [], readerSites: [], siteRecordsError: "<壊れた>" });
    expect(shown.guide).toContain("読者の反応の記録を読めませんでした：&lt;壊れた&gt;");
  });

  test("配信しているサイトがあれば、概要の案内は空", () => {
    const shown = guideOf({
      siteRecords: [],
      readerSites: [{ site: "kakuyomu", label: "カクヨム", tabLabel: "カクヨムの反応" }],
      siteRecordsError: null,
    });
    expect(shown.guide).toBe("");
    expect(shown.host).toContain('id="page-site-kakuyomu"');
  });
});
