import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆統計のタブ（作者の指示、2026-11-01「タブを有効活用して分け、見た目を
 * シンプルかつおしゃれに」。設計書6.3.9）。
 *
 * 見るのは**置き場所**（どの id がどのタブの面にあるか）と、キーボードで
 * 動かせる作り、最後に開いたタブを覚える配線である。見た目の良し悪しは
 * 画面でしか分からない。
 */

const perWork = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const allWorks = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", {
  hasEpisodesTab: false,
  hasReadersTab: false,
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

/** タブの並び（data-page と字面） */
function tabsOf(html: string): Array<{ key: string; label: string }> {
  return [...html.matchAll(/<div class="tab[^"]*"[^>]*data-page="([^"]+)"[^>]*>([^<]*)<\/div>/g)].map((m) => ({
    key: m[1],
    label: m[2],
  }));
}

describe("タブの分け方", () => {
  test("作品ごとの画面は、概要・執筆の推移・話ごと・読者の反応の4つ", () => {
    expect(tabsOf(perWork)).toEqual([
      { key: "overview", label: "概要" },
      { key: "trend", label: "執筆の推移" },
      { key: "episodes", label: "話ごと" },
      { key: "readers", label: "読者の反応" },
    ]);
  });

  test("作品の単位の名前（投稿など）は、話ごとのタブの名前に使う", () => {
    const sns = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:", { unitNoun: "投稿" });
    expect(tabsOf(sns).map((tab) => tab.label)).toContain("投稿ごと");
  });

  test("全作品の画面は、話ごと・読者の反応を出さない", () => {
    expect(tabsOf(allWorks).map((tab) => tab.key)).toEqual(["overview", "trend"]);
    expect(allWorks).not.toContain('id="page-episodes"');
    expect(allWorks).not.toContain('id="page-readers"');
  });

  test("概要には締切・数の札・目標への入口・達成を置く", () => {
    const page = pageOf(perWork, "overview");
    for (const id of ["contest", "cards", "goal-link", "achievements"]) {
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

  test("話ごとには札と表、読者の反応にはサイトの記録を置く", () => {
    expect(pageOf(perWork, "episodes")).toContain('id="episode-cards"');
    expect(pageOf(perWork, "episodes")).toContain('id="episode-table"');
    expect(pageOf(perWork, "readers")).toContain('id="site-records"');
  });

  test("開いた直後に見えるのは概要（ほかの面は隠れている）", () => {
    expect(perWork).toContain('<section class="page active" id="page-overview"');
    expect(perWork).toContain('<section class="page" id="page-trend"');
  });
});

describe("キーボードで動かせる作り", () => {
  test("tablist・tab・tabpanel の役と、選んでいるタブの印がある", () => {
    expect(perWork).toContain('role="tablist"');
    const tabTags = [...perWork.matchAll(/<div class="tab(?: [^"]*)?"[^>]*>/g)].map((m) => m[0]);
    expect(tabTags).toHaveLength(4);
    for (const tag of tabTags) {
      expect(tag).toContain('role="tab"');
      expect(tag).toMatch(/aria-controls="page-[a-z]+"/);
    }
    // 選んでいるのは1つだけで、焦点で巡るのもそれだけ
    expect(tabTags.filter((tag) => tag.includes('aria-selected="true"'))).toHaveLength(1);
    expect(tabTags.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);
    expect((perWork.match(/role="tabpanel"/g) ?? []).length).toBe(4);
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
  });

  test("関係の無いキーでは移らない", () => {
    expect(after("a", 1, 4)).toBe(-1);
    expect(after("ArrowDown", 1, 4)).toBe(-1);
  });
});

describe("最後に開いていたタブを覚える", () => {
  /** selectTab を作り物の DOM で動かす */
  function run(saved: unknown, click?: string): { active: string | null; stored: unknown } {
    let stored: unknown = saved;
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
    const tabs = ["overview", "trend", "episodes", "readers"].map(makeTab);
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
    const fakeVscode = {
      getState: () => stored,
      setState: (value: unknown) => {
        stored = value;
      },
    };
    const select = new Function(
      "document",
      "vscode",
      `${functionSource("selectTab")}\nfunction pinChartToLatest() {}\nreturn selectTab;`
    )(fakeDocument, fakeVscode) as (page: string, focus: boolean) => void;
    const initial =
      saved && typeof (saved as { tab?: unknown }).tab === "string" ? (saved as { tab: string }).tab : "overview";
    select(initial, false);
    if (click) select(click, false);
    const activePage = pages.find((page) => page.classList.has("active"));
    const selected = tabs.filter((tab) => tab.attributes["aria-selected"] === "true");
    expect(selected).toHaveLength(1);
    expect(activePage?.id).toBe(`page-${selected[0].dataset.page}`);
    return { active: selected[0].dataset.page, stored };
  }

  test("押したタブを覚え、次に開いたときはそのタブから始まる", () => {
    const first = run(undefined, "readers");
    expect(first.stored).toEqual({ tab: "readers" });
    expect(run(first.stored).active).toBe("readers");
  });

  test("覚えていなければ概要から始まる", () => {
    expect(run(undefined).active).toBe("overview");
  });

  test("無いタブを覚えていたら、先頭の概要へ戻す", () => {
    expect(run({ tab: "writing" }).active).toBe("overview");
  });

  test("開いたときに覚えた値を読む配線がある", () => {
    expect(scriptOf(perWork)).toContain("vscode.getState()");
  });
});

describe("読者の反応の空の案内", () => {
  test("記録の無い作品では、何をすればここに並ぶかを言う", () => {
    const host = { innerHTML: "", querySelectorAll: () => [] };
    const render = new Function(
      "document",
      "state",
      `${functionSource("renderSiteRecords")}\nreturn renderSiteRecords;`
    )({ getElementById: (id: string) => (id === "site-records" ? host : null) }, { siteRecords: [] }) as () => void;
    render();
    expect(host.innerHTML).toContain("投稿サイトの記録はまだありません");
    expect(host.innerHTML).toContain("「投稿サイト設定」");
  });
});
