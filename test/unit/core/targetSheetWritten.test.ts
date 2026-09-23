import { describe, expect, test } from "vitest";
import {
  collectReactions,
  reactionRows,
  writtenRows,
} from "../../../src/core/targetSheetWritten";
import {
  emptyPostingLedger,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";

/**
 * ターゲットシートの「書けたものの実績」（設計書6.108.6）。
 *
 * 0.82.2 まで単独の3つの輪の紙（6.101）にあった「すでに書けたもの」と
 * 「届いている反応」を、作者の裁定（2026-09-23）でシートへ移した。
 * ここにあるのは、前の紙のテスト（`threeCirclesSheet.test.ts`）から
 * この2つに当たるものを移したものである。
 *
 * 1. **「書けるもの」とは書かない**（作者の裁定、2026-09-19）
 * 2. **材料の無い行は出さない**——空の作品で、でっち上げの数字が並ばない
 * 3. **反応は作品全体の最新1件だけ**——話ごとの数字を混ぜない
 */

describe("実績の行", () => {
  test("材料がそろえば、話数・長さ・日数・設定資料・文体が並ぶ", () => {
    const rows = writtenRows({
      episodes: 19,
      chars: 41000,
      length: { typical: 2100, shortest: 900, longest: 4300 },
      days: { active: 32, streak: 5 },
      settings: [
        { label: "登場人物", count: 12 },
        { label: "場所", count: 5 },
      ],
      narrativePerson: "一人称",
      firstPerson: "僕",
      archaic: false,
    });

    expect(rows).toEqual([
      "書き切ったのは19話、合計41,000字。",
      "1話の長さは、ふだん2,100字ほど（いちばん短い話が900字、いちばん長い話が4,300字）。",
      "書いた日は32日。いまは5日続いています。",
      "設定資料は、登場人物12件・場所5件。",
      "人称は「一人称」、地の文の一人称は「僕」。",
    ]);
    for (const row of rows) expect(row).not.toContain("書けるもの");
  });

  test("空の作品では1行も出さない（0話・0字を並べない）", () => {
    expect(writtenRows({})).toEqual([]);
    expect(
      writtenRows({
        episodes: 0,
        chars: 0,
        days: { active: 0, streak: 0 },
        settings: [{ label: "登場人物", count: 0 }],
        narrativePerson: "",
        firstPerson: "",
      })
    ).toEqual([]);
  });

  test("話数だけ分かるときは、長さの癖も日数も出さない", () => {
    const rows = writtenRows({ episodes: 3, chars: 5000 });

    expect(rows).toEqual(["書き切ったのは3話、合計5,000字。"]);
  });

  test("続いていない日は「続いています」と言わない", () => {
    expect(writtenRows({ days: { active: 4, streak: 0 } })).toEqual([
      "書いた日は4日。",
    ]);
  });

  test("文語体は、分かっているときだけ添える", () => {
    expect(writtenRows({ archaic: true })).toEqual([
      "文語体・旧字旧かなで書かれています。",
    ]);
  });
});

/**
 * 届いている反応を、台帳からどう選ぶか（設計書6.79.7）。
 *
 * 前提（新しい順に並べ、`scope: "work"` の最初を採る）は
 * `readerStats.test.ts` が台帳の側で押さえている。ここは**それを使う側**が
 * 話ごとの行を拾っていないことを見る。
 */
describe("届いている反応の選び方", () => {
  function stats(patch: Partial<ReaderStatsRecord> = {}): ReaderStatsRecord {
    return {
      site: "kakuyomu",
      readAt: "2026-09-05T00:00:00.000Z",
      scope: "work",
      metrics: { pv: 1234 },
      source: "manual",
      ...patch,
    };
  }

  function ledgerWith(records: ReaderStatsRecord[]): PostingLedger {
    return { ...emptyPostingLedger(), readerStats: records };
  }

  /**
   * **話ごとの数字を混ぜない。** 混ぜると「この作品はどれくらい
   * 読まれているか」の欄に1話ぶんの数字が出て、勢いを読み違える。
   */
  test("話ごとの記録のほうが新しくても、作品全体の最新を採る", () => {
    const reactions = collectReactions(
      ledgerWith([
        stats({
          readAt: "2026-09-20T00:00:00.000Z",
          scope: "episode",
          episode: 3,
          metrics: { pv: 7 },
        }),
        stats({ readAt: "2026-09-10T00:00:00.000Z", metrics: { pv: 500 } }),
        stats({ readAt: "2026-09-01T00:00:00.000Z", metrics: { pv: 100 } }),
      ])
    );

    expect(reactions).toHaveLength(1);
    expect(reactions[0].site).toBe("カクヨム");
    expect(reactions[0].metrics).toContain("500");
    // 日付だけを出す（読み取った時刻までは要らない）
    expect(reactions[0].readAt).toBe("2026-09-10");
  });

  test("そのサイトの記録が無ければ、その行は出さない", () => {
    expect(collectReactions(ledgerWith([]))).toEqual([]);
    // 話ごとの記録しか無いサイトも、作品全体の数字が無いので出さない
    expect(
      collectReactions(ledgerWith([stats({ scope: "episode", episode: 1 })]))
    ).toEqual([]);
  });

  test("行には、いつの数字かを必ず添える", () => {
    expect(
      reactionRows([
        { site: "小説家になろう", metrics: "PV 1,234", readAt: "2026-09-19" },
      ])
    ).toEqual(["小説家になろう：PV 1,234（2026-09-19 時点）"]);
  });
});
