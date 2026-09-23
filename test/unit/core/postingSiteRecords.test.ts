import { describe, expect, test } from "vitest";
import {
  buildPostingSiteRecords,
  isOpenableWorkUrl,
  narouAnalysisUrl,
  readerStatsColumns,
  type GroupedReaderStatsRow,
  type ReaderStatsTable,
} from "../../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withRanking,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

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
  /*
    **Nコードは大文字で渡す**（作者の指摘、2026-09-20。ブラウザで実測）。
    小文字だと**なろう本体へ飛ばされ**、分析ページが出ない。
    「両方なろうのページに飛びます」という報告から見つかった。

    **なろう本体のURLは小文字のままでよい**ので、narouNcode の正規化は
    変えていない。大文字が要るのはこのリンクだけである。
  */
  test("Nコードは大文字で渡す（小文字だとなろう本体へ飛ばされる）", () => {
    const url = narouAnalysisUrl("n2600go");
    expect(url).toBe("https://db.narou.fun/works/N2600GO");
    // 道の部分に小文字が混じらないこと
    expect(url?.split("/works/")[1]).toBe("N2600GO");
  });

  test("作品IDがNコードなら、分析ページのURLを作る", () => {
    expect(narouAnalysisUrl("n1234ab")).toBe(
      "https://db.narou.fun/works/N1234AB"
    );
    // 英字1字のNコードもある
    expect(narouAnalysisUrl("n9999a")).toBe("https://db.narou.fun/works/N9999A");
  });

  test("大文字・前後の空白は整えてから使う", () => {
    expect(narouAnalysisUrl(" N1234AB ")).toBe(
      "https://db.narou.fun/works/N1234AB"
    );
  });

  test("作品IDが空なら、作品ページのURLから拾う", () => {
    expect(narouAnalysisUrl(null, "https://ncode.syosetu.com/n1234ab/")).toBe(
      "https://db.narou.fun/works/N1234AB"
    );
    // 話のページを貼っていても、先頭のNコードを拾う
    expect(narouAnalysisUrl("", "https://ncode.syosetu.com/n1234ab/13/")).toBe(
      "https://db.narou.fun/works/N1234AB"
    );
  });

  test("作品IDのほうを先に使う", () => {
    expect(
      narouAnalysisUrl("n1234ab", "https://ncode.syosetu.com/n9999zz/")
    ).toBe("https://db.narou.fun/works/N1234AB");
  });

  test("作品IDがNコードでなければ、作品ページのURLへ落ちる", () => {
    expect(
      narouAnalysisUrl("わからない", "https://ncode.syosetu.com/n1234ab/")
    ).toBe("https://db.narou.fun/works/N1234AB");
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
      "https://db.narou.fun/works/N1234AB",
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

  /**
   * **貼り込み係の封筒が1回で書き足すもの**（実物。作者の教科書チート）。
   * 「その時点」「日」「月」の3件が、同じ日時で台帳へ入る。
   */
  function threeAtOnce(ledger: PostingLedger, readAt: string): PostingLedger {
    const day = readAt.slice(0, 10);
    let next = withStats(ledger, {
      readAt,
      source: "helper",
      metrics: { pv: 1053339, points: 1612 },
    });
    next = withStats(next, {
      readAt,
      source: "helper",
      period: "day",
      periodKey: day,
      metrics: { pv: 1 },
    });
    return withStats(next, {
      readAt,
      source: "helper",
      period: "month",
      periodKey: day.slice(0, 7),
      metrics: { pv: 667 },
    });
  }

  test("記録が無ければ、反応の欄は空のまま", () => {
    const ledger = withSiteProfile(registered(), "kakuyomu", {
      workId: "1177354054892",
    });
    const record = buildPostingSiteRecords(ledger)[0];

    expect(record.readerLatest).toBeNull();
    expect(record.readerWork).toBeNull();
    expect(record.readerEpisodes).toBeNull();
  });

  test("反応だけがあるサイトも、行として出す", () => {
    const record = buildPostingSiteRecords(withStats(registered(), {}))[0];

    expect(record.site).toBe("kakuyomu");
    // あるものだけを並べる（読めなかった欄は出さない）
    expect(record.readerLatest?.snapshot).toBe("PV 1,234");
    expect(record.readerLatest?.scope).toBe("作品全体");
    expect(record.readerLatest?.isEpisode).toBe(false);
    expect(record.readerLatest?.source).toBe("手入力");
  });

  test("あるものだけを、決まった並びで書く", () => {
    const record = buildPostingSiteRecords(
      withStats(registered(), {
        metrics: { pv: 1234, bookmarks: 56, points: 789, likes: 12 },
      })
    )[0];

    expect(record.readerLatest?.snapshot).toBe(
      "PV 1,234／ブックマーク 56／評価 789pt／いいね 12"
    );
    // **ラベルと数字は分けても渡す**（表の外で大きく見せるため）
    expect(record.readerLatest?.snapshotValues).toEqual([
      { label: "PV", value: "1,234", unit: "" },
      { label: "ブックマーク", value: "56", unit: "" },
      { label: "評価", value: "789", unit: "pt" },
      { label: "いいね", value: "12", unit: "" },
    ]);
  });

  /**
   * **1回の取り込みが1行になる**（作者の言葉「サイトの記録が読みにくいです」、
   * 2026-09-22）。台帳は粒度ごとに1件ずつ書き足すので、ボタンを1回押すと
   * 「その時点」「日」「月」の3件が並び、押したのは2回なのに6行あった。
   */
  test("同じ取り込みの3件が1行になり、粒度は列になる", () => {
    const ledger = threeAtOnce(registered(), "2026-09-22T12:00:00.000Z");
    const record = buildPostingSiteRecords(ledger)[0];
    const rows = record.readerWork?.rows ?? [];

    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).toBe("PV 1,053,339／評価 1,612pt");
    expect(rows[0].day).toBe("PV 1");
    expect(rows[0].month).toBe("PV 667");
    // 畳んだ元の件数は残す（台帳から1件も捨てていないことを数で言えるように）
    expect(rows[0].count).toBe(3);
  });

  test("日時が違えば分かれる。台帳の件数は変わらない", () => {
    let ledger = threeAtOnce(registered(), "2026-09-22T12:00:00.000Z");
    ledger = threeAtOnce(ledger, "2026-09-22T11:45:00.000Z");

    const rows = buildPostingSiteRecords(ledger)[0].readerWork?.rows ?? [];
    expect(rows).toHaveLength(2);
    // 新しい順のまま
    expect(rows[0].readAt).toBe("2026-09-22T12:00:00.000Z");
    // **台帳は1件も捨てない**（畳むのは見せ方だけ）
    expect(ledger.readerStats).toHaveLength(6);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(6);
  });

  test("出どころが違えば畳まない（意味が違う数字を混ぜない）", () => {
    let ledger = withStats(registered(), {
      readAt: "2026-09-22T12:00:00.000Z",
      source: "helper",
    });
    ledger = withStats(ledger, {
      readAt: "2026-09-22T12:00:00.000Z",
      source: "backup",
      metrics: { pv: 9 },
    });

    const rows = buildPostingSiteRecords(ledger)[0].readerWork?.rows ?? [];
    expect(rows.map((row) => row.source)).toEqual(["貼り付け", "バックアップ"]);
  });

  /**
   * **粒度の日付は、ずれているときだけ添える。** ほとんどは取り込んだ日と
   * 同じ日・同じ月なので、毎行「日 2026-09-22」と書くと同じ字を何度も読む。
   */
  test("日付がずれている粒度にだけ、日付を添える", () => {
    let ledger = withStats(registered(), {
      readAt: "2026-09-22T12:00:00.000Z",
      period: "day",
      periodKey: "2026-09-21",
      metrics: { pv: 5 },
    });
    ledger = withStats(ledger, {
      readAt: "2026-09-22T12:00:00.000Z",
      period: "month",
      periodKey: "2026-08",
      metrics: { pv: 400 },
    });

    const rows = buildPostingSiteRecords(ledger)[0].readerWork?.rows ?? [];
    expect(rows[0].day).toBe("PV 5（9/21）");
    expect(rows[0].month).toBe("PV 400（2026/08）");
  });

  test("年と累計は、専用の列が無くても捨てない", () => {
    const ledger = withStats(registered(), {
      readAt: "2026-09-22T12:00:00.000Z",
      period: "total",
      metrics: { pv: 42 },
    });

    const table = buildPostingSiteRecords(ledger)[0].readerWork;
    expect(table?.rows[0].other).toBe("累計 PV 42");
    expect(table?.columns.other).toBe(true);
  });

  /**
   * **話ごとの記録は、作品全体と混ぜない**（設計書6.79.7）。アクセス数の
   * ページは1回で50話ぶん入るので、混ざると作品全体の行が埋もれる。
   */
  test("話ごとの記録は別の表で、最新の1回ぶんだけを番号順に出す", () => {
    let ledger = withStats(registered(), {
      readAt: "2026-09-22T12:00:00.000Z",
      metrics: { pv: 1000 },
    });
    for (const episode of [3, 1]) {
      ledger = withStats(ledger, {
        readAt: "2026-09-22T12:00:00.000Z",
        scope: "episode",
        episode,
        metrics: { pv: episode * 10 },
        source: "helper",
      });
    }
    // 前の回の話ごとの記録。**画面には出さないが、台帳には残る**
    ledger = withStats(ledger, {
      readAt: "2026-09-21T12:00:00.000Z",
      scope: "episode",
      episode: 1,
      metrics: { pv: 5 },
      source: "helper",
    });

    const record = buildPostingSiteRecords(ledger)[0];
    // 作品全体の表に、話ごとの行は入らない
    expect(record.readerWork?.rows.map((row) => row.scope)).toEqual([
      "作品全体",
    ]);
    expect(record.readerEpisodes?.rows.map((row) => row.scope)).toEqual([
      "第1話",
      "第3話",
    ]);
    expect(ledger.readerStats).toHaveLength(4);
  });

  test("話ごとが1件も無ければ、その表は作らない（節ごと出さない）", () => {
    const record = buildPostingSiteRecords(withStats(registered(), {}))[0];
    expect(record.readerEpisodes).toBeNull();
  });

  test("履歴は20回までにする（画面が履歴で埋まらないように）", () => {
    let ledger = registered();
    for (let index = 0; index < 25; index++) {
      ledger = withStats(ledger, {
        readAt: `2026-09-${String(index + 1).padStart(2, "0")}T03:00:00.000Z`,
        metrics: { pv: index + 1 },
      });
    }

    const record = buildPostingSiteRecords(ledger)[0];
    expect(record.readerWork?.rows).toHaveLength(20);
    // 落とすのは古いほうから（新しい順の先頭は残る）
    expect(record.readerWork?.rows[0].snapshot).toBe("PV 25");
  });
});

/** 畳んだあとの1行。検査ごとに、要るところだけ差し替える */
function groupedRow(
  patch: Partial<GroupedReaderStatsRow> = {}
): GroupedReaderStatsRow {
  return {
    readAt: "2026-09-22T12:00:00.000Z",
    scope: "作品全体",
    episode: null,
    isEpisode: false,
    snapshot: "PV 1,234",
    snapshotValues: [{ label: "PV", value: "1,234", unit: "" }],
    day: "",
    month: "",
    other: "",
    source: "貼り付け",
    note: "",
    count: 1,
    ...patch,
  };
}

/** 画面へ渡す表1つぶん。**列の判断は製品と同じ関数に通す** */
function groupedTable(rows: GroupedReaderStatsRow[]): ReaderStatsTable {
  return { rows, columns: readerStatsColumns(rows) };
}

/**
 * 出す列の決め方（設計書6.79.7）。**中身が1種類しかない列は出さない。**
 *
 * 実物では「範囲」が全行「作品全体」、「出どころ」が全行「貼り付け」で
 * 折り返し、「メモ」は1件も入っていないのに見出しが「メ／モ」と縦に潰れていた。
 */
describe("反応の表に出す列", () => {
  const base = groupedRow();

  test("メモが1件でもあれば出し、1件も無ければ出さない", () => {
    expect(readerStatsColumns([base]).note).toBe(false);
    expect(
      readerStatsColumns([base, { ...base, note: "更新直後" }]).note
    ).toBe(true);
  });

  test("範囲は、1種類しかなければ出さない", () => {
    expect(readerStatsColumns([base, { ...base }]).scope).toBe(false);
    expect(
      readerStatsColumns([base, { ...base, scope: "第3話", isEpisode: true }])
        .scope
    ).toBe(true);
  });

  test("出どころは、全行が同じなら列にせず注記へ回す", () => {
    const one = readerStatsColumns([base, { ...base }]);
    expect(one.source).toBe(false);
    expect(one.onlySource).toBe("貼り付け");

    const two = readerStatsColumns([base, { ...base, source: "手入力" }]);
    expect(two.source).toBe(true);
    expect(two.onlySource).toBeNull();
  });

  test("今日・今月の列は、中身のある行があるときだけ出す", () => {
    expect(readerStatsColumns([base]).day).toBe(false);
    expect(readerStatsColumns([{ ...base, day: "PV 1" }]).day).toBe(true);
    expect(readerStatsColumns([{ ...base, month: "PV 667" }]).month).toBe(true);
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
  type RenderTable = (
    table: ReaderStatsTable | null,
    title: string,
    fold: boolean
  ) => string;

  function renderTable(): RenderTable {
    return panelFunction<RenderTable>("renderReaderStatsTable", [
      "escapeHtml",
      "formatWhen",
      "formatCount",
      "readerTableOf",
    ]);
  }

  /**
   * **要る列だけを出す**（作者の言葉「サイトの記録が読みにくいです」、
   * 2026-09-22）。メモは1件も入っていないのに幅を食い、見出しが「メ／モ」と
   * 縦に潰れていた。**消すのではなく、要るときだけ出す。**
   */
  test("メモは、入っている行があるときだけ列にする", () => {
    const render = renderTable();

    const withNote = render(
      groupedTable([groupedRow({ note: "更新直後" })]),
      "読者の反応",
      true
    );
    expect(withNote).toContain("<th>メモ</th>");
    expect(withNote).toContain("更新直後");

    const noNote = render(groupedTable([groupedRow()]), "読者の反応", true);
    expect(noNote).not.toContain("<th>メモ</th>");
  });

  test("出どころが1種類なら、列にせず表の下に1回だけ書く", () => {
    const render = renderTable();

    const one = render(groupedTable([groupedRow()]), "読者の反応", true);
    expect(one).not.toContain("<th>出どころ</th>");
    expect(one).toContain("すべて貼り付けで取り込んだものです。");

    const two = render(
      groupedTable([groupedRow(), groupedRow({ source: "手入力" })]),
      "読者の反応",
      true
    );
    expect(two).toContain("<th>出どころ</th>");
    expect(two).not.toContain("すべて貼り付けで");
  });

  test("粒度は列になり、「その時点」は見出しに1回だけ書く", () => {
    const html = renderTable()(
      groupedTable([groupedRow({ day: "PV 1", month: "PV 667" })]),
      "読者の反応",
      true
    );

    expect(html).toContain("<th>反応（その時点）</th>");
    expect(html).toContain("<th>今日</th>");
    expect(html).toContain("<th>今月</th>");
    // 粒度の列は無くなったので、行ごとに「その時点」とは書かない
    expect(html).not.toContain("<th>粒度</th>");
  });

  /**
   * **古い記録は畳む。** 表に出すのは新しい3回ぶんで、残りは開けば読める
   * （台帳からは1件も捨てていない）。
   */
  test("4回ぶんあれば、3行だけ出して残りは畳む", () => {
    const rows = ["09-22", "09-21", "09-20", "09-19"].map((day) =>
      groupedRow({ readAt: `2026-${day}T12:00:00.000Z` })
    );
    const html = renderTable()(groupedTable(rows), "読者の反応", true);

    expect(html).toContain("これまでの記録（あと 1 件）");
    // 畳んだぶんも、開けば読める（消していない）
    expect(html).toContain("2026/09/19");
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
          readerLatest: unknown;
          analysisUrl: string | null;
        }>
      ) => string
    >("siteRecordsNote");

    const readerOnly = note([
      { history: [], readerLatest: {}, analysisUrl: null },
    ]);
    expect(readerOnly.startsWith("順位は")).toBe(false);
    expect(readerOnly).toContain("読者の反応は");

    // 順位があるときは、これまでどおり順位の但し書きから始める
    const withRank = note([
      { history: [{}], readerLatest: null, analysisUrl: null },
    ]);
    expect(withRank.startsWith("順位は")).toBe(true);
  });

  /**
   * **話ごとの記録は、別の表にして既定で畳む**（設計書6.79.7）。
   * アクセス数のページは1回で50話ぶん入るので、作品全体の行と混ざると読めない。
   */
  test("話ごとの節は、記録が無ければ出ない", () => {
    const render = panelFunction<(table: ReaderStatsTable | null) => string>(
      "renderReaderEpisodes",
      [
        "escapeHtml",
        "formatWhen",
        "formatCount",
        "readerTableOf",
        "renderReaderStatsTable",
      ]
    );

    expect(render(null)).toBe("");
    expect(render(groupedTable([]))).toBe("");

    const html = render(
      groupedTable([
        groupedRow({ scope: "第1話", episode: 1, isEpisode: true }),
        groupedRow({ scope: "第3話", episode: 3, isEpisode: true }),
      ])
    );
    expect(html).toContain("話ごとの記録（2話・最新 2026/09/22");
    // 既定では閉じている（open を付けない）
    expect(html).not.toContain("<details class=\"fold\" open>");
  });

  /**
   * **最新の1回は、表の外で大きく見せる**（作者の言葉、2026-09-22）。
   * ラベルと数字を分けて並べる——1本の長い文字列は読む気にならない。
   */
  test("最新の反応は、ラベルと数字を分けて並べる", () => {
    const render = panelFunction<
      (latest: GroupedReaderStatsRow | null) => string
    >("renderReaderLatest", ["escapeHtml", "formatWhen", "readerValue"]);

    expect(render(null)).toBe("");

    const html = render(
      groupedRow({
        snapshotValues: [
          { label: "PV", value: "1,053,339", unit: "" },
          { label: "評価", value: "1,612", unit: "pt" },
        ],
        day: "PV 1",
        month: "PV 667",
      })
    );
    expect(html).toContain("最新の反応（2026/09/22");
    expect(html).toContain("貼り付け");
    expect(html).toContain('<span class="k">PV</span>');
    expect(html).toContain("1,053,339");
    expect(html).toContain("1,612pt");
    // 今日・今月も同じ塊に入れる（以前は表の別の行に散っていた）
    expect(html).toContain('<span class="k">今日</span>');
    expect(html).toContain('<span class="k">今月</span>');
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
    expect(html).toContain("readerWork");
    expect(html).toContain("readerEpisodes");
    expect(html).toContain("読者の反応");
  });
});
