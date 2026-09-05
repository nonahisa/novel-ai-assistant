import { describe, expect, test } from "vitest";
import {
  buildPostingSiteRecords,
  isOpenableWorkUrl,
  narouAnalysisUrl,
} from "../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withRanking,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../src/views/writingStatsPanelHtml";

/**
 * 執筆量パネルの「サイトの記録」（設計書6.68.5）。
 *
 * **サイトへは触りにいかない。** ここに出るのは、作者が「投稿サイトの設定」
 * で入れた作品情報と、「ランキングを記録する」で入れた順位だけである。
 *
 * **何も入っていない作品では、節ごと出さない。** 空の表が1つ増えるだけで、
 * 執筆量を見にきた人の邪魔になる。
 */

const url = {
  narou: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  kakuyomu: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
};

function registered(): PostingLedger {
  return withSites(emptyPostingLedger(), [
    { site: "narou", newEpisodeUrl: url.narou },
    { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
  ]);
}

describe("サイトの記録を組み立てる", () => {
  test("何も入れていなければ、1件も返さない（節ごと出さない）", () => {
    expect(buildPostingSiteRecords(emptyPostingLedger())).toEqual([]);
    // サイトを登録しただけ（投稿ページのURLだけ）でも、まだ見せるものが無い
    expect(buildPostingSiteRecords(registered())).toEqual([]);
  });

  test("作品情報を入れたサイトだけが並ぶ", () => {
    const ledger = withSiteProfile(registered(), "narou", {
      workId: "n1234ab",
      workUrl: "https://ncode.syosetu.com/n1234ab/",
      genre: "ハイファンタジー",
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].label).toBe("小説家になろう");
    expect(records[0].workId).toBe("n1234ab");
    expect(records[0].genre).toBe("ハイファンタジー");
    expect(records[0].workUrl).toBe("https://ncode.syosetu.com/n1234ab/");
    expect(records[0].history).toEqual([]);
    expect(records[0].latest).toBeNull();
  });

  test("履歴は新しい順に並び、いちばん新しいものが最新順位になる", () => {
    let ledger = registered();
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-01T00:00:00.000Z",
      board: "日間",
      rank: 12,
    });
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-05T00:00:00.000Z",
      board: "週間",
      rank: 3,
      note: "更新直後",
    });
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-03T00:00:00.000Z",
      board: "日間",
      rank: 8,
    });

    const narou = buildPostingSiteRecords(ledger)[0];
    expect(narou.history.map((row) => row.rank)).toEqual([3, 8, 12]);
    expect(narou.latest).toEqual({
      recordedAt: "2026-09-05T00:00:00.000Z",
      board: "週間",
      rank: 3,
      note: "更新直後",
    });
    // メモの無い記録は null で埋める（画面の欄が消えないように）
    expect(narou.history[1].note).toBeNull();
  });

  /**
   * **サイトを外しても記録は消さない**（6.68.4の8）。台帳に残っている
   * 順位は、登録を外したあとも見られなければ「消えた」のと同じである。
   */
  test("登録を外したサイトの記録も、見えるところに残す", () => {
    const ledger = withRanking(emptyPostingLedger(), {
      site: "note",
      recordedAt: "2026-09-04T00:00:00.000Z",
      board: "急上昇",
      rank: 20,
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe("note");
    expect(records[0].registered).toBe(false);
  });

  /**
   * **作品情報はサイトの登録から独立している**（設計書6.68.5）。順位と
   * 同じで、投稿先から外しても書いたものは残り、パネルにも出る。
   */
  test("登録を外したサイトでも、作品情報の行は出る", () => {
    const ledger = withSiteProfile(emptyPostingLedger(), "alphapolis", {
      workId: "123456",
      note: "完結済み",
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe("alphapolis");
    expect(records[0].registered).toBe(false);
    expect(records[0].workId).toBe("123456");
    expect(records[0].note).toBe("完結済み");
  });

  test("並びは投稿サイトの一覧と同じ順（画面ごとに順番が変わらない）", () => {
    let ledger = registered();
    ledger = withRanking(ledger, {
      site: "kakuyomu",
      recordedAt: "2026-09-04T00:00:00.000Z",
      board: "週間",
      rank: 40,
    });
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-05T00:00:00.000Z",
      board: "日間",
      rank: 12,
    });

    expect(buildPostingSiteRecords(ledger).map((entry) => entry.site)).toEqual([
      "narou",
      "kakuyomu",
    ]);
  });
});

/**
 * 作品ページを開く道（設計書6.68.5）。
 *
 * **開くのは `openExternal` だけ。** ページを読みにいく処理は無い。
 * 開く前に、http/https であることを確かめる（台帳は作者が手で開いて
 * 直せるファイルなので、`javascript:` が書かれていることがありうる）。
 */
describe("作品ページのリンク", () => {
  test("http・httpsだけを開く", () => {
    expect(isOpenableWorkUrl("https://ncode.syosetu.com/n1234ab/")).toBe(true);
    expect(isOpenableWorkUrl("http://example.com/")).toBe(true);
    expect(isOpenableWorkUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableWorkUrl("file:///C:/secret.txt")).toBe(false);
    expect(isOpenableWorkUrl("")).toBe(false);
  });
});

/**
 * なろうの分析リンク（設計書6.79.7）。
 *
 * **拡張機能はNarou.funへHTTPを発しない。** 作るのはURLだけで、読みに
 * いくのはブラウザを開いた作者である（6.68の原則そのまま）。
 *
 * **形式検証を通ったときだけリンクにする。** Nコードでないものを埋めた
 * URLは、押しても存在しないページに着く——壊れたリンクは出さない。
 */
describe("なろうの分析リンク", () => {
  test("作品IDがNコードなら、分析ページのURLを作る", () => {
    expect(narouAnalysisUrl("n1234ab")).toBe(
      "https://db.narou.fun/works/n1234ab"
    );
    // 英字1字のNコードもある
    expect(narouAnalysisUrl("n9999a")).toBe("https://db.narou.fun/works/n9999a");
  });

  test("大文字・前後の空白は整えてから使う", () => {
    expect(narouAnalysisUrl(" N1234AB ")).toBe(
      "https://db.narou.fun/works/n1234ab"
    );
  });

  test("作品IDが空なら、作品ページのURLから拾う", () => {
    expect(narouAnalysisUrl(null, "https://ncode.syosetu.com/n1234ab/")).toBe(
      "https://db.narou.fun/works/n1234ab"
    );
    // 話のページを貼っていても、先頭のNコードを拾う
    expect(narouAnalysisUrl("", "https://ncode.syosetu.com/n1234ab/13/")).toBe(
      "https://db.narou.fun/works/n1234ab"
    );
  });

  test("作品IDのほうを先に使う", () => {
    expect(
      narouAnalysisUrl("n1234ab", "https://ncode.syosetu.com/n9999zz/")
    ).toBe("https://db.narou.fun/works/n1234ab");
  });

  test("作品IDがNコードでなければ、作品ページのURLへ落ちる", () => {
    expect(
      narouAnalysisUrl("わからない", "https://ncode.syosetu.com/n1234ab/")
    ).toBe("https://db.narou.fun/works/n1234ab");
  });

  test("Nコードが見つからなければ、リンクを作らない", () => {
    expect(narouAnalysisUrl(undefined, undefined)).toBeUndefined();
    expect(narouAnalysisUrl("", "")).toBeUndefined();
    // 形が違うもの（数字4桁・英字1〜2字でない）
    expect(narouAnalysisUrl("1234ab")).toBeUndefined();
    expect(narouAnalysisUrl("n123ab")).toBeUndefined();
    expect(narouAnalysisUrl("n1234abc")).toBeUndefined();
    expect(narouAnalysisUrl("n1234")).toBeUndefined();
    // 作品ページのURLに作品IDが無い（マイページなど）
    expect(narouAnalysisUrl(null, "https://syosetu.com/")).toBeUndefined();
    expect(narouAnalysisUrl(null, "これはURLではない")).toBeUndefined();
  });

  test("なろうの行にだけ、分析リンクを添える", () => {
    let ledger = withSiteProfile(registered(), "narou", {
      workId: "n1234ab",
    });
    ledger = withSiteProfile(ledger, "kakuyomu", {
      workId: "1177354054892",
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records.map((entry) => entry.analysisUrl)).toEqual([
      "https://db.narou.fun/works/n1234ab",
      // カクヨムには分析サイトのリンクを作らない（6.79.7はなろうの代替）
      null,
    ]);
  });

  test("なろうでもNコードが無ければ、リンクを出さない", () => {
    const ledger = withSiteProfile(registered(), "narou", {
      genre: "ハイファンタジー",
    });
    expect(buildPostingSiteRecords(ledger)[0].analysisUrl).toBeNull();
  });
});

/**
 * 読者の反応（設計書6.79.7）。
 *
 * **サイトの行に、最新の反応と履歴を添える。** 台帳にあるのは、作者が
 * 手で打った値か、作者が自分で開いた管理画面から貼り付けた封筒だけである。
 */
describe("読者の反応の行", () => {
  function withStats(ledger: PostingLedger, patch: Partial<ReaderStatsRecord>) {
    return withReaderStats(ledger, {
      site: "kakuyomu",
      readAt: "2026-09-05T00:00:00.000Z",
      scope: "work",
      metrics: { pv: 1234 },
      source: "manual",
      ...patch,
    });
  }

  test("記録が無ければ、反応の欄は空のまま", () => {
    const ledger = withSiteProfile(registered(), "kakuyomu", {
      workId: "1177354054892",
    });
    const record = buildPostingSiteRecords(ledger)[0];

    expect(record.readerLatest).toBeNull();
    expect(record.readerHistory).toEqual([]);
  });

  test("反応だけがあるサイトも、行として出す", () => {
    const record = buildPostingSiteRecords(withStats(registered(), {}))[0];

    expect(record.site).toBe("kakuyomu");
    // あるものだけを並べる（読めなかった欄は出さない）
    expect(record.readerLatest?.metrics).toBe("PV 1,234");
    expect(record.readerLatest?.scope).toBe("作品全体");
    expect(record.readerLatest?.period).toBe("その時点");
    expect(record.readerLatest?.source).toBe("手入力");
  });

  test("あるものだけを、決まった並びで書く", () => {
    const record = buildPostingSiteRecords(
      withStats(registered(), {
        metrics: { pv: 1234, bookmarks: 56, points: 789, likes: 12 },
      })
    )[0];

    expect(record.readerLatest?.metrics).toBe(
      "PV 1,234／ブックマーク 56／評価 789pt／いいね 12"
    );
  });

  test("履歴は新しい順で、範囲と粒度が読める", () => {
    let ledger = withStats(registered(), {
      readAt: "2026-09-01T00:00:00.000Z",
      period: "month",
      periodKey: "2026-08",
    });
    ledger = withStats(ledger, {
      readAt: "2026-09-05T00:00:00.000Z",
      scope: "episode",
      episode: 3,
      metrics: { pv: 120 },
      source: "helper",
    });

    const record = buildPostingSiteRecords(ledger)[0];
    expect(record.readerHistory.map((row) => row.scope)).toEqual([
      "第3話",
      "作品全体",
    ]);
    expect(record.readerHistory[0].source).toBe("貼り付け");
    expect(record.readerHistory[1].period).toBe("月 2026-08");
  });

  test("履歴は20行までにする（画面が履歴で埋まらないように）", () => {
    let ledger = registered();
    for (let index = 0; index < 25; index++) {
      ledger = withStats(ledger, {
        readAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        metrics: { pv: index + 1 },
      });
    }

    const record = buildPostingSiteRecords(ledger)[0];
    expect(record.readerHistory).toHaveLength(20);
    // 落とすのは古いほうから（新しい順の先頭は残る）
    expect(record.readerHistory[0].metrics).toBe("PV 25");
  });
});

/**
 * 画面の組み立て（WebViewのスクリプト）を、そのまま呼べる形にして確かめる。
 * 手は年表・人物相関図の画面の検査と同じ（中括弧の対応で切り出す）。
 */
const panelHtml = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const panelScript = (() => {
  const found = panelHtml.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
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

describe("執筆量パネルの側", () => {
  /**
   * **反応の表にもメモの列を出す**（0.33.9のレビュー、L2）。
   *
   * 順位の表にはメモの列があるのに、反応の表には無かった。手入力でも封筒でも
   * メモは台帳に入るので、書いたのに二度と読めない欄になっていた。
   */
  test("反応の表に、メモの列がある", () => {
    const render = panelFunction<
      (
        rows: Array<{
          readAt: string;
          scope: string;
          period: string;
          metrics: string;
          source: string;
          note: string | null;
        }>
      ) => string
    >("renderReaderStatsTable", ["escapeHtml", "formatWhen"]);

    const html = render([
      {
        readAt: "2026-09-05T00:00:00.000Z",
        scope: "作品全体",
        period: "その時点",
        metrics: "PV 1,234",
        source: "手入力",
        note: "更新直後",
      },
    ]);

    expect(html).toContain("<th>メモ</th>");
    expect(html).toContain("更新直後");
    // メモの無い行でも列は消えない（表がずれる）
    const noNote = render([
      {
        readAt: "2026-09-05T00:00:00.000Z",
        scope: "作品全体",
        period: "その時点",
        metrics: "PV 1,234",
        source: "手入力",
        note: null,
      },
    ]);
    expect(noNote).toContain("<td></td>");
  });

  /**
   * **注記は、あるものについてだけ言う**（0.33.9のレビュー、L8）。
   *
   * 順位を1件も記録していない作品でも「順位は…」で始まる注記が出ていた。
   * 反応だけを記録している作者には、身に覚えのない説明になる。
   */
  test("順位が無い作品の注記は、「順位は」で始めない", () => {
    const note = panelFunction<
      (
        records: Array<{
          history: unknown[];
          readerHistory: unknown[];
          analysisUrl: string | null;
        }>
      ) => string
    >("siteRecordsNote");

    const readerOnly = note([
      { history: [], readerHistory: [{}], analysisUrl: null },
    ]);
    expect(readerOnly.startsWith("順位は")).toBe(false);
    expect(readerOnly).toContain("読者の反応は");

    // 順位があるときは、これまでどおり順位の但し書きから始める
    const withRank = note([
      { history: [{}], readerHistory: [], analysisUrl: null },
    ]);
    expect(withRank.startsWith("順位は")).toBe(true);
  });

  /**
   * **台帳が読めなかったことを、画面で言う**（0.33.9のレビュー、中1）。
   *
   * 以前はログへ残すだけだったので、作者からは「サイトの記録」が黙って
   * 消えたようにしか見えなかった。
   */
  test("台帳を読めなかった理由を出す配線がある", () => {
    expect(panelHtml).toContain("siteRecordsError");
    expect(panelHtml).toContain("サイトの記録を読めませんでした");
  });

  test("節の置き場と、開く道の配線がある", () => {
    const html = buildWritingStatsPanelHtml("nonce", "vscode-resource:");

    // 節の置き場（データが無ければ空のままにする）
    expect(html).toContain('id="site-records"');
    // リンクは画面から直接開かず、拡張機能側へ頼む（openExternal）
    expect(html).toContain("openExternal");
    // 分析リンク（6.79.7）。作るのはURLだけで、読みにいくのは作者である
    expect(html).toContain("analysisUrl");
    expect(html).toContain("分析（Narou.fun）を開く");
  });

  test("読者の反応の最新値と履歴を出す配線がある（設計書6.79.7）", () => {
    const html = buildWritingStatsPanelHtml("nonce", "vscode-resource:");

    expect(html).toContain("readerLatest");
    expect(html).toContain("readerHistory");
    expect(html).toContain("読者の反応");
  });
});
