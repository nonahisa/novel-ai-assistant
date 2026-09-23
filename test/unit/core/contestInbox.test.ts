import { describe, expect, test } from "vitest";
import {
  asOfLabel,
  charLimitSummary,
  contestChanges,
  localIsoString,
  goalFromContest,
  mergeContestInbox,
  normalizeContestInbox,
  rankContests,
  sameContest,
  storeContests,
  type StoredContest,
} from "../../../src/core/contestInbox";
import { parseContestCard, type ContestListing } from "../../../src/core/contestListing";
import type { ContestGoal } from "../../../src/models/workGoals";

/**
 * 取り込んだ公募の置き場と、選ぶ画面の並び（設計書6.3.6.1）。
 *
 * - 取り込んだ公募は**作品に紐づけない**（どの作品の応募先にするかは、あとで選ぶ）
 * - 選ぶ画面は、**いまの字数で応募できるもの・締切までに届きそうなもの**を上に、
 *   その中は締切の近い順。締切の過ぎたものは出さない
 * - 取り込み直して締切・字数が変わっていれば、応募先との違いを並べる（黙って書き換えない）
 */

const TODAY = "2026-09-23";
const IMPORTED_AT = "2026-09-23T10:00:00.000+09:00";

function listing(name: string, lines: string[], organizer = "作り物出版"): ContestListing {
  const parsed = parseContestCard({
    name,
    text: [name, ...lines, ` 主催：${organizer}`].join("\n"),
    url: `https://example.com/${encodeURIComponent(name)}`,
    source: "novelportal",
  });
  if (!parsed) throw new Error("見本が公募として読めない");
  return parsed;
}

function stored(entries: ContestListing[], importedAt = IMPORTED_AT): StoredContest[] {
  return storeContests(entries, {
    importedAt,
    sourcePage: "https://creative-story.net/bungakusyou/",
  });
}

describe("同じ公募の見分け", () => {
  test("名前は空白・全角半角の違いを無視して比べる", () => {
    expect(
      sameContest(
        { name: "第5回 黒猫ミステリー賞", organizer: null },
        { name: "第5回黒猫ミステリー賞", organizer: "作り物出版" }
      )
    ).toBe(true);
    expect(
      sameContest({ name: "第５回　賞", organizer: null }, { name: "第5回 賞", organizer: null })
    ).toBe(true);
  });

  test("主催が両方分かっていて違えば、名前が同じでも別の公募", () => {
    expect(
      sameContest(
        { name: "第1回 短編小説賞", organizer: "A市" },
        { name: "第1回 短編小説賞", organizer: "B社" }
      )
    ).toBe(false);
  });
});

describe("取り込みの置き場", () => {
  test("取り込み直した公募は置き換わる（二重にならない）", () => {
    const first = stored([listing("第3回 みずうみ文学賞", [" 締切：2026年10月31日"])]);
    const again = stored(
      [listing("第3回 みずうみ文学賞", [" 締切：2026年11月15日"])],
      "2026-09-30T10:00:00.000+09:00"
    );
    const merged = mergeContestInbox(first, again, TODAY);
    expect(merged.inbox).toHaveLength(1);
    expect(merged.inbox[0].deadlines).toEqual(["2026-11-15"]);
    expect(merged.updated).toBe(1);
    expect(merged.added).toBe(0);
  });

  test("締切の過ぎた公募は置かない（数は返す）", () => {
    const merged = mergeContestInbox(
      [],
      stored([
        listing("過ぎた賞", [" 締切：2026年9月1日"]),
        listing("これからの賞", [" 締切：2026年12月1日"]),
        listing("随時の賞", [" 締切：随時募集"]),
      ]),
      TODAY
    );
    expect(merged.inbox.map((entry) => entry.name)).toEqual(["これからの賞", "随時の賞"]);
    expect(merged.droppedPast).toBe(1);
    expect(merged.added).toBe(2);
  });

  test("保存した形から読み戻すと、締切・字数は原文から読み直す（壊れた項目は捨てる）", () => {
    const inbox = stored([listing("作り物賞", [" 締切：2026年10月31日", " 字数：5,000〜10,000字"])]);
    const raw = JSON.parse(JSON.stringify(inbox)) as unknown[];
    const restored = normalizeContestInbox([...raw, { name: 3 }, null, "文字"]);
    expect(restored).toHaveLength(1);
    expect(restored[0].charLimit).toEqual({ kind: "range", min: 5000, max: 10000, converted: false });
    expect(restored[0].deadlines).toEqual(["2026-10-31"]);
    expect(normalizeContestInbox("壊れた値")).toEqual([]);
  });
});

describe("選ぶ画面の並び", () => {
  const inbox = stored([
    listing("遠い締切・字数に合う", [" 締切：2027年3月31日", " 字数：1万字以上"]),
    listing("近い締切・字数に合う", [" 締切：2026年10月10日", " 字数：5,000〜50,000字"]),
    listing("上限を超えている", [" 締切：2026年10月1日", " 字数：8,000字以内"]),
    listing("下限まで遠い", [" 締切：2026年10月1日", " 字数：20万字以上"]),
    listing("下限に届きそう", [" 締切：2026年11月30日", " 字数：3万字以上"]),
    listing("字数を読めない", [" 締切：2026年10月5日", " 字数：10,000字程度"]),
    listing("制限なし", [" 締切：2026年12月1日", " 字数：不問"]),
    listing("締切を読めない", [" 締切：随時募集", " 字数：1万字以上"]),
    listing("過ぎた", [" 締切：2026年9月1日", " 字数：1万字以上"]),
  ]);

  test("字数に合うもの→届きそうなもの→字数を読めないもの→遠いもの→超えたもの、締切を読めないものは最後", () => {
    const ranked = rankContests(inbox, { written: 12_000, todayKey: TODAY, pacePerDay: 2000 });
    expect(ranked.map((entry) => entry.contest.name)).toEqual([
      "近い締切・字数に合う",
      "制限なし",
      "遠い締切・字数に合う",
      "下限に届きそう",
      "字数を読めない",
      "下限まで遠い",
      "上限を超えている",
      "締切を読めない",
    ]);
    const reachable = ranked.find((entry) => entry.contest.name === "下限に届きそう");
    expect(reachable).toMatchObject({ fit: "reachable", deadline: "2026-11-30", daysLeft: 69 });
    // あと18,000字を69日で＝1日261字
    expect(reachable?.neededPerDay).toBe(261);
  });

  test("締切の過ぎたものは出さない", () => {
    const ranked = rankContests(inbox, { written: 0, todayKey: TODAY, pacePerDay: 2000 });
    expect(ranked.map((entry) => entry.contest.name)).not.toContain("過ぎた");
  });
});

describe("応募先へ入れる形", () => {
  test("公式の募集要項のリンク・取り込んだ日時・出どころ・主催・原文を持つ", () => {
    const [entry] = stored([
      listing("第3回 みずうみ文学賞", [" 締切：2026年10月31日（土）23:59", " 字数：5,000〜10,000字"]),
    ]);
    const goal = goalFromContest(entry, { deadline: "2026-10-31", minChars: 5000, maxChars: 10000 });
    expect(goal).toEqual({
      name: "第3回 みずうみ文学賞",
      url: `https://example.com/${encodeURIComponent("第3回 みずうみ文学賞")}`,
      deadline: "2026-10-31",
      minChars: 5000,
      maxChars: 10000,
      dailyGoal: null,
      imported: {
        importedAt: IMPORTED_AT,
        sourcePage: "https://creative-story.net/bungakusyou/",
        organizer: "作り物出版",
        deadlineText: "2026年10月31日（土）23:59",
        charText: "5,000〜10,000字",
      },
    });
  });

  test("公募に公式のリンクが無ければ、読んだ一覧のページを持つ", () => {
    const [entry] = storeContests(
      [{ ...listing("作り物賞", [" 締切：2026年10月31日"]), url: null }],
      { importedAt: IMPORTED_AT, sourcePage: "https://tsukuritemirai.com/kobo/novel/" }
    );
    expect(goalFromContest(entry, { deadline: "2026-10-31", minChars: null, maxChars: null }).url).toBe(
      "https://tsukuritemirai.com/kobo/novel/"
    );
  });
});

describe("取り込み直したときの違い", () => {
  const goal: ContestGoal = {
    name: "第3回 みずうみ文学賞",
    url: null,
    deadline: "2026-10-31",
    minChars: 20000,
    maxChars: 40000,
    dailyGoal: null,
    imported: {
      importedAt: IMPORTED_AT,
      sourcePage: null,
      organizer: "作り物出版",
      deadlineText: "2026年10月31日",
      charText: "400字詰原稿用紙で50枚以上100枚以下",
    },
  };

  test("締切・下限・上限の違いを並べる", () => {
    const [entry] = stored([
      listing("第3回 みずうみ文学賞", [" 締切：2026年11月15日", " 字数：400字詰原稿用紙で50枚以上120枚以下"]),
    ]);
    expect(contestChanges(goal, entry, TODAY)).toEqual([
      { field: "deadline", before: "2026-10-31", after: "2026-11-15" },
      { field: "maxChars", before: 40000, after: 48000 },
    ]);
  });

  test("変わっていなければ何も言わない", () => {
    const [entry] = stored([
      listing("第3回 みずうみ文学賞", [" 締切：2026年10月31日", " 字数：400字詰原稿用紙で50枚以上100枚以下"]),
    ]);
    expect(contestChanges(goal, entry, TODAY)).toEqual([]);
  });

  test("字数を読めなかったときは、字数の違いを言わない（推し量って書き換えない）", () => {
    const [entry] = stored([
      listing("第3回 みずうみ文学賞", [" 締切：2026年10月31日", " 字数：10,000字程度"]),
    ]);
    expect(contestChanges(goal, entry, TODAY)).toEqual([]);
  });

  test("別の公募（主催が違う）とは比べない", () => {
    const [entry] = stored([
      listing("第3回 みずうみ文学賞", [" 締切：2026年12月31日"], "別の主催"),
    ]);
    expect(contestChanges(goal, entry, TODAY)).toBeNull();
  });
});

describe("画面に出す言い方", () => {
  test("いつの情報かを日付で言う（取り込んだ日時の日付のまま）", () => {
    expect(asOfLabel("2026-09-23T10:00:00.000+09:00")).toBe("9月23日時点の情報");
    expect(asOfLabel("2026-01-05T23:59:00+09:00")).toBe("1月5日時点の情報");
    expect(asOfLabel("壊れた値")).toBe("取り込んだ日の分からない情報");
  });

  test("字数の読みを短く言う", () => {
    expect(charLimitSummary({ kind: "range", min: 20000, max: 40000, converted: true })).toBe(
      "20,000〜40,000字（原稿用紙換算）"
    );
    expect(charLimitSummary({ kind: "range", min: 5000, max: null, converted: false })).toBe(
      "5,000字以上"
    );
    expect(charLimitSummary({ kind: "range", min: null, max: 8000, converted: false })).toBe(
      "8,000字以内"
    );
    expect(charLimitSummary({ kind: "none" })).toBe("字数の制限なし");
    expect(charLimitSummary({ kind: "unreadable", reason: "理由" })).toBe("字数を読めませんでした");
  });

  test("取り込んだ日時は、その土地の時差つきで書く（日付がずれない）", () => {
    const text = localIsoString(new Date(2026, 8, 23, 0, 30, 0));
    expect(text.startsWith("2026-09-23T00:30:00")).toBe(true);
    expect(text).toMatch(/(?:[+-]\d{2}:\d{2}|Z)$/u);
    expect(asOfLabel(text)).toBe("9月23日時点の情報");
  });
});
