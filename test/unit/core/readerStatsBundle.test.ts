import { describe, expect, test } from "vitest";
import {
  applyReaderStatsEnvelope,
  buildReaderStatsEnvelope,
  parseReaderStatsPaste,
  READER_STATS_BUNDLE_KIND,
  READER_STATS_BUNDLE_VERSION_MISMATCH,
  type ReaderStatsBundle,
  type ReaderStatsEnvelope,
  type ReaderStatsEnvelopeEntry,
} from "../../../src/core/readerStatsEnvelope";
import {
  BUNDLE_FAILURES_SHOWN,
  readerStatsBundleItemLabel,
  readerStatsBundleNotice,
  readerStatsBundlePending,
  routeReaderStatsBundleItem,
} from "../../../src/core/readerStatsHelperLink";
import {
  emptyPostingLedger,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * まとめて渡された読者の反応（束）を読む・振り分ける・知らせる（画面を出さない部分）。
 *
 * ヘルパー 0.9.0 の「まとめて渡す」は、開いた画面ごとに溜めた封筒を
 * `{ kind: "novelai-stats-bundle", version: 1, handedAt, items: [封筒, …] }` で渡す
 * （ヘルパーの README「溜めた分をまとめたデータ」・`common/stash.js` の `makeBundle`）。
 */

const KAKUYOMU_POST_A = "https://kakuyomu.jp/my/works/1111/episodes/new";
const KAKUYOMU_POST_B = "https://kakuyomu.jp/my/works/2222/episodes/new";

function kakuyomuItem(
  workId: string | undefined,
  readAt: string,
  entries: ReaderStatsEnvelopeEntry[] = [{ scope: "work", metrics: { pv: 100 } }]
): Record<string, unknown> {
  return JSON.parse(
    buildReaderStatsEnvelope({ site: "kakuyomu", workId, readAt, entries })
  ) as Record<string, unknown>;
}

function narouFunItem(workId: string): Record<string, unknown> {
  return JSON.parse(
    buildReaderStatsEnvelope({
      site: "narou",
      source: "narou.fun",
      workId,
      readAt: "2026-09-23T01:00:00.000Z",
      readAtBasis: "fetched",
      entries: [{ scope: "work", metrics: { points: 1200 } }],
    })
  ) as Record<string, unknown>;
}

function bundleText(items: unknown[], patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version: 1,
    handedAt: "2026-09-23T05:10:00.000Z",
    items,
    ...patch,
  });
}

function bundleOf(text: string): ReaderStatsBundle {
  const result = parseReaderStatsPaste(text);
  if (!result.ok || result.kind !== "bundle") {
    throw new Error(result.ok ? "束として読めませんでした" : result.reason);
  }
  return result.bundle;
}

function envelopeOf(item: Record<string, unknown>): ReaderStatsEnvelope {
  const result = parseReaderStatsPaste(JSON.stringify(item));
  if (!result.ok || result.kind !== "envelope") throw new Error("封筒として読めませんでした");
  return result.envelope;
}

function kakuyomuWork(postUrl: string, workId?: string): PostingLedger {
  const ledger = withSites(emptyPostingLedger(), [
    { site: "kakuyomu", newEpisodeUrl: postUrl },
  ]);
  return workId ? withSiteProfile(ledger, "kakuyomu", { workId }) : ledger;
}

function narouWork(workId: string): PostingLedger {
  return withSiteProfile(
    withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/" },
    ]),
    "narou",
    { workId }
  );
}

describe("束を読む", () => {
  test("束の目印があれば、中の封筒を1件ずつ同じ関所で読む（溜めた順・何件目か）", () => {
    const result = parseReaderStatsPaste(
      bundleText([
        kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00"),
        narouFunItem("N1234AB"),
      ])
    );
    expect(result.ok && result.kind).toBe("bundle");
    if (!result.ok || result.kind !== "bundle") return;
    expect(result.bundle.handedAt).toBe("2026-09-23T05:10:00.000Z");
    expect(result.bundle.items.map((item) => item.position)).toEqual([1, 2]);
    expect(result.bundle.items.every((item) => item.result.ok)).toBe(true);
    const second = result.bundle.items[1].result;
    expect(second.ok && second.envelope.source).toBe("narou.fun");
  });

  test("クリップボードの前後の空白は許す", () => {
    const text = `\n  ${bundleText([kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")])}\n`;
    expect(parseReaderStatsPaste(text).ok).toBe(true);
  });

  test("知らない版なら束ごと取り込まず、両方を新しくするよう言う", () => {
    for (const version of [2, 0, "1", null, undefined]) {
      const result = parseReaderStatsPaste(
        bundleText([kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")], { version })
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe(READER_STATS_BUNDLE_VERSION_MISMATCH);
      expect(result.reason).toContain("ヘルパーと統合小説執筆環境の片方が古いようです");
      // 「コピーしていない」ではない（管理画面を開く道を出させない）
      expect(result.kind).toBeUndefined();
    }
  });

  test("並びが無い・空の束は取り込まない", () => {
    const noItems = parseReaderStatsPaste(bundleText([], { items: "x" }));
    expect(noItems.ok).toBe(false);
    const empty = parseReaderStatsPaste(bundleText([]));
    expect(empty.ok).toBe(false);
  });

  test("1件が読めなくても、残りは読めたまま並ぶ（理由を持って残る）", () => {
    const broken = kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00");
    (broken.entries as Record<string, unknown>[])[0].metrics = { pv: "1,234" };
    const bundle = bundleOf(
      bundleText([
        kakuyomuItem("1111", "2026-09-23T09:00:00.000+09:00"),
        broken,
        "ただの文字",
        { secret: "封筒ではない" },
        kakuyomuItem("2222", "2026-09-23T11:00:00.000+09:00"),
      ])
    );
    expect(bundle.items.map((item) => item.result.ok)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    const second = bundle.items[1].result;
    expect(!second.ok && second.reason).toContain("数として読めない");
    // 束の中の「封筒でない」は、クリップボードの話として言わない
    const fourth = bundle.items[3].result;
    expect(!fourth.ok && fourth.reason).not.toContain("クリップボード");
    expect(!fourth.ok && fourth.kind).toBeFalsy();
  });

  test("束の目印が無ければ、これまでどおり1件の封筒として読む", () => {
    const single = parseReaderStatsPaste(
      JSON.stringify(kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00"))
    );
    expect(single.ok && single.kind).toBe("envelope");
    const nothing = parseReaderStatsPaste("今日の買い物");
    expect(!nothing.ok && nothing.kind).toBe("notEnvelope");
  });
});

describe("束の1件の振り分け（台帳の作品IDで決まるものだけ）", () => {
  const a = { id: "a", ledger: kakuyomuWork(KAKUYOMU_POST_A, "1111") };
  const b = { id: "b", ledger: kakuyomuWork(KAKUYOMU_POST_B, "2222") };

  test("作品IDの一致した作品へ振り分ける（2作品が混ざっても）", () => {
    expect(
      routeReaderStatsBundleItem(
        envelopeOf(kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")),
        [a, b]
      )
    ).toEqual({ kind: "work", id: "a" });
    expect(
      routeReaderStatsBundleItem(
        envelopeOf(kakuyomuItem("2222", "2026-09-23T10:00:00.000+09:00")),
        [a, b]
      )
    ).toEqual({ kind: "work", id: "b" });
  });

  test("台帳に作品IDが無い作品へは、関所を通っても入れない（1件のときより厳しい）", () => {
    const loose = { id: "c", ledger: kakuyomuWork(KAKUYOMU_POST_A) };
    const route = routeReaderStatsBundleItem(
      envelopeOf(kakuyomuItem("3333", "2026-09-23T10:00:00.000+09:00")),
      [loose]
    );
    expect(route.kind).toBe("none");
    expect(route.kind === "none" && route.reason).toContain("見つかりませんでした");
  });

  test("封筒に作品IDが無ければ決めない", () => {
    const route = routeReaderStatsBundleItem(
      envelopeOf(kakuyomuItem(undefined, "2026-09-23T10:00:00.000+09:00")),
      [a, b]
    );
    expect(route.kind === "none" && route.reason).toContain("作品IDが入っていない");
  });

  test("同じ作品IDの作品が2つあれば決めない（選ばせもしない）", () => {
    const twin = { id: "twin", ledger: kakuyomuWork(KAKUYOMU_POST_A, "1111") };
    const route = routeReaderStatsBundleItem(
      envelopeOf(kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")),
      [a, twin]
    );
    expect(route.kind === "none" && route.reason).toContain("2つあり");
  });

  test("Narou.fun の封筒は、取り込みと同じNコードの照合で決まる（大文字小文字を問わない）", () => {
    const narou = { id: "n", ledger: narouWork("n1234ab") };
    expect(routeReaderStatsBundleItem(envelopeOf(narouFunItem("N1234AB")), [a, narou])).toEqual({
      kind: "work",
      id: "n",
    });
    expect(
      routeReaderStatsBundleItem(envelopeOf(narouFunItem("N9999ZZ")), [a, narou]).kind
    ).toBe("none");
  });

  test("取り込めなかった1件は、サイトと作品IDで見分けられる名前で言う", () => {
    expect(
      readerStatsBundleItemLabel(envelopeOf(kakuyomuItem("3333", "2026-09-23T10:00:00.000+09:00")))
    ).toBe("カクヨム 作品ID 3333");
    expect(readerStatsBundleItemLabel(envelopeOf(narouFunItem("N1234AB")))).toBe(
      "小説家になろう（Narou.fun） 作品ID N1234AB"
    );
  });
});

describe("同じ作品の画面を続けて積む（二重に積まない）", () => {
  // 作品管理（日ごとのPVのグラフ）とアクセス数の画面は、日ごとの数が重なる
  const days: ReaderStatsEnvelopeEntry[] = [
    { scope: "work", period: "day", periodKey: "2026-09-21", metrics: { pv: 30 } },
    { scope: "work", period: "day", periodKey: "2026-09-22", metrics: { pv: 40 } },
  ];

  test("あとの画面の重なった行は、前の画面の行を見て止まる", () => {
    const management = envelopeOf(
      kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00", [
        { scope: "work", metrics: { pv: 500 } },
        ...days,
      ])
    );
    const access = envelopeOf(
      kakuyomuItem("1111", "2026-09-23T10:02:00.000+09:00", [
        ...days,
        { scope: "episode", episode: 1, metrics: { pv: 200 } },
      ])
    );
    const first = applyReaderStatsEnvelope(kakuyomuWork(KAKUYOMU_POST_A, "1111"), management);
    expect(first).toMatchObject({ added: 3, repeated: 0 });
    const second = applyReaderStatsEnvelope(first.ledger, access);
    expect(second).toMatchObject({ added: 1, repeated: 2 });
    // 日ごとの行は1日1行のまま
    const dayRows = (second.ledger.readerStats ?? []).filter((row) => row.period === "day");
    expect(dayRows).toHaveLength(2);
  });

  test("同じ画面が2度入っていても、2度目は積まない", () => {
    const screen = envelopeOf(kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00"));
    const first = applyReaderStatsEnvelope(kakuyomuWork(KAKUYOMU_POST_A, "1111"), screen);
    const second = applyReaderStatsEnvelope(first.ledger, screen);
    expect(second).toMatchObject({ added: 0, repeated: 1 });
    expect(second.ledger.readerStats).toHaveLength(1);
  });
});

describe("窓に戻ったとき訊くか（まだ取り込んでいない画面）", () => {
  test("作品の決まる画面のうち、まだ取り込んでいないものだけを作品ごとに数える", () => {
    const screenA = kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00");
    const bundle = bundleOf(
      bundleText([
        screenA,
        kakuyomuItem("2222", "2026-09-23T10:01:00.000+09:00"),
        kakuyomuItem("2222", "2026-09-23T10:02:00.000+09:00", [
          { scope: "work", metrics: { pv: 7 } },
        ]),
        kakuyomuItem("9999", "2026-09-23T10:03:00.000+09:00"),
      ])
    );
    const imported = applyReaderStatsEnvelope(
      kakuyomuWork(KAKUYOMU_POST_A, "1111"),
      envelopeOf(screenA)
    ).ledger;
    expect(
      readerStatsBundlePending(bundle, [
        { id: "a", ledger: imported },
        { id: "b", ledger: kakuyomuWork(KAKUYOMU_POST_B, "2222") },
      ])
    ).toEqual([{ id: "b", screens: 2 }]);
  });
});

describe("知らせ（1つにまとめる）", () => {
  test("作品ごとの画面の数と、積まなかった数を1つの知らせで言う", () => {
    const notice = readerStatsBundleNotice({
      works: [
        { title: "作品A", screens: 3, added: 10, repeated: 2 },
        { title: "作品B", screens: 1, added: 1, repeated: 0 },
      ],
      failures: [],
    });
    expect(notice.level).toBe("info");
    expect(notice.message).toBe(
      "読者の反応を取り込みました：「作品A」3画面・「作品B」1画面（同じ数で積まなかったもの 2件）。" +
        "執筆量パネルの「サイトの記録」で履歴を見られます。"
    );
  });

  test("取り込めなかったものがあれば注意の知らせにし、作品IDで直るものには直し方を添える", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "作品A", screens: 1, added: 1, repeated: 0 }],
      failures: [
        {
          label: "カクヨム 作品ID 9999",
          reason: "この作品IDを登録した作品が見つかりませんでした。",
          fixByWorkId: true,
        },
      ],
    });
    expect(notice.level).toBe("warning");
    expect(notice.message).toContain("「作品A」1画面");
    expect(notice.message).toContain(
      "取り込めなかったもの（1画面）：カクヨム 作品ID 9999：この作品IDを登録した作品が見つかりませんでした。"
    );
    expect(notice.message).toContain("「投稿サイトの設定」で作品IDを登録");
    expect(notice.message).toContain("「もう一度渡す」");
  });

  test("作品IDで直らない失敗だけなら、直し方は添えない", () => {
    const notice = readerStatsBundleNotice({
      works: [],
      failures: [{ label: "2件目", reason: "数として読めない値がありました。", fixByWorkId: false }],
    });
    expect(notice.message.startsWith("読者の反応を取り込めませんでした。")).toBe(true);
    expect(notice.message).not.toContain("投稿サイトの設定");
    expect(notice.message).not.toContain("サイトの記録");
  });

  test("取り込めなかったものが多ければ、先頭だけ並べて残りは件数で言う", () => {
    const failures = Array.from({ length: BUNDLE_FAILURES_SHOWN + 2 }, (_, index) => ({
      label: `カクヨム 作品ID ${index}`,
      reason: "この作品IDを登録した作品が見つかりませんでした。",
      fixByWorkId: true,
    }));
    const notice = readerStatsBundleNotice({ works: [], failures });
    expect(notice.message).toContain(`取り込めなかったもの（${failures.length}画面）`);
    expect(notice.message).toContain("ほか2画面");
    expect(notice.message).not.toContain(`作品ID ${BUNDLE_FAILURES_SHOWN}：`);
  });

  test("全部が取り込み済みの数と同じなら、記録を変えていないと言う", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "作品A", screens: 2, added: 0, repeated: 5 }],
      failures: [],
    });
    expect(notice.message).toBe(
      "読者の反応は、すでに取り込んだ数と同じでした：「作品A」2画面（5件）。記録は変えていません。"
    );
  });

  test("知らせに内輪の呼び名を出さない", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "作品A", screens: 1, added: 1, repeated: 1 }],
      failures: [{ label: "カクヨム 作品ID 1", reason: "見つかりません。", fixByWorkId: true }],
    });
    for (const word of ["母艦", "封筒", "台帳", "束"]) {
      expect(notice.message).not.toContain(word);
    }
  });
});
