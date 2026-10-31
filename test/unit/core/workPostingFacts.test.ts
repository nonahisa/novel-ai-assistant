import { describe, expect, test } from "vitest";
import {
  buildPostingSiteRecords,
  buildWorkPostingFacts,
} from "../../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withSiteFacts,
  withSites,
  withWorkCompletion,
  type PostingLedger,
} from "../../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 作品の「連載中／完結」と、サイトごとのタグ・連載の状態の見せ方（作者の指示 2026-11-01）。
 *
 * - 作品の印は**作者が決める値**。サイトから届いた印で書き換えない
 * - 食い違い（作品は完結なのにカクヨムは連載中）は知らせる
 * - 作者がまだ決めていなければ、届いた印を初めの値として提案する
 * - タグはサイトごとの今の値と付け替えの記録、サイト間の食い違いを出す
 */

/** 画面のスクリプトから関数を切り出して呼ぶ（`postingSiteRecords.test.ts` と同じ手） */
const panelScript = (() => {
  const found = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:").match(
    /<script nonce="NONCE123">([\s\S]*?)<\/script>/
  );
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  if (head < 0) throw new Error(name + " が見つからない");
  let depth = 0;
  let started = false;
  for (let index = head; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
      started = true;
    } else if (source[index] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, index + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

function panelFunction<T>(name: string, needs: string[] = []): T {
  return new Function(
    [
      ...needs.map((dependency) => extractFunction(panelScript, dependency)),
      extractFunction(panelScript, name),
      "return " + name + ";",
    ].join("\n")
  )() as T;
}

const KAKUYOMU_POST ="https://kakuyomu.jp/my/works/1111/episodes/new";
const ALPHAPOLIS_POST = "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789";

function registered(): PostingLedger {
  return withSites(emptyPostingLedger(), [
    { site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST },
    { site: "alphapolis", newEpisodeUrl: ALPHAPOLIS_POST },
  ]);
}

function facts(
  ledger: PostingLedger,
  site: "kakuyomu" | "alphapolis",
  readAt: string,
  input: { tags?: string[]; completion?: "ongoing" | "completed" }
): PostingLedger {
  return withSiteFacts(ledger, { site, readAt, ...input }).ledger;
}

describe("作品の連載の状態", () => {
  test("何も無ければ、印も知らせも出さない", () => {
    const result = buildWorkPostingFacts(registered());
    expect(result.completion).toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.mismatches).toEqual([]);
  });

  test("作品は完結なのにカクヨムは連載中なら、食い違いとして知らせる", () => {
    let ledger = withWorkCompletion(registered(), "completed", "2026-11-01T00:00:00.000Z");
    ledger = facts(ledger, "kakuyomu", "2026-11-01T01:00:00.000Z", { completion: "ongoing" });
    ledger = facts(ledger, "alphapolis", "2026-11-01T01:00:00.000Z", { completion: "completed" });
    const result = buildWorkPostingFacts(ledger);
    expect(result.completion).toMatchObject({ value: "completed", label: "完結" });
    expect(result.mismatches).toEqual([
      { site: "kakuyomu", label: "カクヨム", completion: "ongoing", completionLabel: "連載中" },
    ]);
    expect(result.notice).toContain("カクヨムでは連載中");
  });

  test("作者が決めていなければ、届いた印を提案にする（作品の印は決めない）", () => {
    const ledger = facts(registered(), "kakuyomu", "2026-11-01T01:00:00.000Z", {
      completion: "completed",
    });
    const result = buildWorkPostingFacts(ledger);
    expect(result.completion).toBeNull();
    expect(result.suggestion).toEqual({ value: "completed", label: "完結" });
    expect(result.mismatches).toEqual([]);
  });

  test("決めていない作品で、サイトどうしが食い違えば提案せずに知らせる", () => {
    let ledger = facts(registered(), "kakuyomu", "2026-11-01T01:00:00.000Z", {
      completion: "completed",
    });
    ledger = facts(ledger, "alphapolis", "2026-11-01T01:00:00.000Z", { completion: "ongoing" });
    const result = buildWorkPostingFacts(ledger);
    expect(result.suggestion).toBeNull();
    expect(result.notice).toContain("サイトによって");
  });

  test("作者が「決めない」に戻せば、作品の印は消える", () => {
    const set = withWorkCompletion(registered(), "completed", "2026-11-01T00:00:00.000Z");
    expect(withWorkCompletion(set, null, "2026-11-02T00:00:00.000Z").completion).toBeUndefined();
  });
});

describe("サイトごとのタグ", () => {
  test("サイトの記録に今のタグと付け替えの記録（新しい順）が載る", () => {
    let ledger = facts(registered(), "kakuyomu", "2026-09-01T00:00:00.000Z", { tags: ["a"] });
    ledger = facts(ledger, "kakuyomu", "2026-10-01T00:00:00.000Z", { tags: ["a", "b"] });
    ledger = facts(ledger, "kakuyomu", "2026-11-01T00:00:00.000Z", { tags: ["b"] });
    const record = buildPostingSiteRecords(ledger).find((entry) => entry.site === "kakuyomu");
    expect(record?.tags).toEqual(["b"]);
    expect(record?.tagsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(record?.tagHistory.map((change) => change.changedAt)).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ]);
    expect(record?.tagHistory[0]).toMatchObject({ before: ["a", "b"], after: ["b"] });
  });

  test("タグだけが届いたサイトも、サイトの記録に並ぶ", () => {
    const ledger = facts(registered(), "alphapolis", "2026-11-01T00:00:00.000Z", { tags: [] });
    const records = buildPostingSiteRecords(ledger);
    expect(records.map((entry) => entry.site)).toEqual(["alphapolis"]);
    expect(records[0].tags).toEqual([]);
  });

  test("サイト間でタグが違えば、片方にしか無いタグを挙げる", () => {
    let ledger = facts(registered(), "kakuyomu", "2026-11-01T00:00:00.000Z", {
      tags: ["異世界", "群像劇"],
    });
    ledger = facts(ledger, "alphapolis", "2026-11-01T00:00:00.000Z", { tags: ["異世界", "恋愛"] });
    const result = buildWorkPostingFacts(ledger);
    expect(result.tagDifferences).toEqual([
      { site: "kakuyomu", label: "カクヨム", only: ["群像劇"] },
      { site: "alphapolis", label: "アルファポリス", only: ["恋愛"] },
    ]);
  });

  test("サイト間でタグが同じ（並びだけ違う）なら食い違いにしない", () => {
    let ledger = facts(registered(), "kakuyomu", "2026-11-01T00:00:00.000Z", { tags: ["a", "b"] });
    ledger = facts(ledger, "alphapolis", "2026-11-01T00:00:00.000Z", { tags: ["b", "a"] });
    expect(buildWorkPostingFacts(ledger).tagDifferences).toEqual([]);
  });
});

describe("執筆統計の画面", () => {
  test("概要に連載の状態の置き場、読者の反応にタグを描く関数がある", () => {
    const html = buildWritingStatsPanelHtml("n", "csp");
    expect(html).toContain('id="work-facts"');
    expect(html).toContain("function renderWorkFacts");
    expect(html).toContain("function renderSiteTags");
    // 切り替えは拡張機能側へ頼む（画面の中で台帳を書かない）
    expect(html).toContain("setWorkCompletion");
  });

  test("画面のスクリプトが文として読める（足した関数で壊していない）", () => {
    expect(() => new Function(panelScript)).not.toThrow();
  });

  test("タグは並びのまま枠で出し、0個なら「なし」、付け替えは足した・外したを言う", () => {
    const render = panelFunction<(record: unknown) => string>("renderSiteTags", [
      "escapeHtml",
      "formatWhen",
      "formatCount",
    ]);
    const html = render({
      tags: ["異世界", "恋愛"],
      tagsAt: "2026-11-01T00:00:00.000Z",
      tagHistory: [
        { site: "kakuyomu", changedAt: "2026-11-01T00:00:00.000Z", before: ["異世界", "群像劇"], after: ["異世界", "恋愛"] },
        { site: "kakuyomu", changedAt: "2026-10-01T00:00:00.000Z", before: ["群像劇", "異世界"], after: ["異世界", "群像劇"] },
      ],
    });
    expect(html).toContain('<span class="site-tag">異世界</span><span class="site-tag">恋愛</span>');
    expect(html).toContain("足した：恋愛");
    expect(html).toContain("外した：群像劇");
    expect(html).toContain("並べ替え");
    expect(html).toContain("タグの付け替え（2回）");

    expect(render({ tags: [], tagsAt: "2026-11-01T00:00:00.000Z", tagHistory: [] })).toContain("なし");
    // まだ届いていなければ何も出さない
    expect(render({ tags: null, tagsAt: null, tagHistory: [] })).toBe("");
  });

  test("サイト間の食い違いは、片方にしか無いタグをサイトごとに言う", () => {
    const render = new Function(
      [
        "var state = { workFacts: { tagDifferences: [",
        "{ site: 'kakuyomu', label: 'カクヨム', only: ['群像劇'] },",
        "{ site: 'alphapolis', label: 'アルファポリス', only: ['<恋愛>'] } ] } };",
        extractFunction(panelScript, "escapeHtml"),
        extractFunction(panelScript, "renderTagDifferences"),
        "return renderTagDifferences;",
      ].join("\n")
    )() as () => string;
    const html = render();
    expect(html).toContain("サイトによってタグが違います");
    expect(html).toContain("カクヨムだけ 群像劇");
    // タグは作者の入力なので必ず逃がす
    expect(html).toContain("アルファポリスだけ &lt;恋愛&gt;");
  });

  test("全作品の画面（読者の反応のタブが無い）でも、連載の状態の描画で落ちない作り", () => {
    const html = buildWritingStatsPanelHtml("n", "csp", { hasReadersTab: false });
    // state.workFacts が無いときは何も描かない
    expect(html).toContain("state && state.workFacts");
  });
});
