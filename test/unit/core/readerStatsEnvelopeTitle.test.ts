import { describe, expect, test } from "vitest";
import {
  buildReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  parseReaderStatsPaste,
  READER_STATS_BUNDLE_KIND,
  READER_STATS_TITLE_MAX_LENGTH,
} from "../../../src/core/readerStatsEnvelope";
import { groupPendingRegistrations } from "../../../src/features/readerStatsRegister";

/**
 * 封筒のサイトでの作品名（省いてよい欄 `title`、2026-10-11）。
 *
 * 版数は 1 のまま。確かめるのは：
 *
 *   1. 付いていれば受け、付いていない古い封筒も今までどおり読める
 *   2. null と空文字は「欄なし」。文字列でなければ断る。長すぎれば欄なし
 *   3. 作品IDごとに束ねるとき、作品名が登録の候補へ渡る
 */

const readAt = "2026-10-11T10:00:00.000+09:00";

function envelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "novelai-stats": 1,
    site: "kakuyomu",
    workId: "1177354054934574437",
    readAt,
    entries: [{ scope: "work", metrics: { pv: 10 } }],
    ...extra,
  };
}

describe("封筒の作品名", () => {
  test("付いていれば、前後の空白を落として受ける", () => {
    const result = parseReaderStatsEnvelope(
      JSON.stringify(envelope({ title: "  教科書チート  " }))
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.title).toBe("教科書チート");
  });

  test("付いていない古い封筒も今までどおり読める（欄を持たせない）", () => {
    const result = parseReaderStatsEnvelope(JSON.stringify(envelope()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("title" in result.envelope).toBe(false);
  });

  test("null・空文字・空白だけは「欄なし」として受ける", () => {
    for (const title of [null, "", "   "]) {
      const result = parseReaderStatsEnvelope(JSON.stringify(envelope({ title })));
      expect(result.ok, JSON.stringify(title)).toBe(true);
      if (!result.ok) continue;
      expect("title" in result.envelope).toBe(false);
    }
  });

  test("文字列でなければ断る（版の食い違いとして）", () => {
    for (const title of [123, { name: "x" }, ["x"], true]) {
      const result = parseReaderStatsEnvelope(JSON.stringify(envelope({ title })));
      expect(result.ok, JSON.stringify(title)).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain("作品名");
    }
  });

  test("上限を超える長さは断らずに欄なしにする（数は取り込める）", () => {
    const atLimit = "あ".repeat(READER_STATS_TITLE_MAX_LENGTH);
    const ok = parseReaderStatsEnvelope(JSON.stringify(envelope({ title: atLimit })));
    expect(ok.ok && ok.envelope.title).toBe(atLimit);

    const over = parseReaderStatsEnvelope(
      JSON.stringify(envelope({ title: `${atLimit}あ` }))
    );
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect("title" in over.envelope).toBe(false);
    expect(over.envelope.entries).toHaveLength(1);
  });

  test("作品名と、まだ知らない欄が並んでいても読める", () => {
    const result = parseReaderStatsEnvelope(
      JSON.stringify(envelope({ title: "教科書チート", somethingNew: { x: 1 } }))
    );
    expect(result.ok).toBe(true);
  });

  test("作る側と読む側で往復する（空の作品名は書かない）", () => {
    const built = buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: "1",
      readAt,
      title: "教科書チート",
      entries: [{ scope: "work", metrics: { pv: 1 } }],
    });
    const result = parseReaderStatsEnvelope(built);
    expect(result.ok && result.envelope.title).toBe("教科書チート");

    const empty = buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: "1",
      readAt,
      title: " ",
      entries: [{ scope: "work", metrics: { pv: 1 } }],
    });
    expect("title" in JSON.parse(empty)).toBe(false);
  });

  test("束の中の1件の作品名が、作品IDごとの登録の候補へ渡る（新しい画面の名を使う）", () => {
    const pasted = parseReaderStatsPaste(
      JSON.stringify({
        kind: READER_STATS_BUNDLE_KIND,
        version: 1,
        handedAt: "2026-10-11T01:10:00.000Z",
        items: [
          envelope({ title: "旧い題" }),
          envelope(),
          envelope({ title: "新しい題" }),
          envelope({ workId: "999", title: "別の作品" }),
          envelope({ workId: "888" }),
        ],
      })
    );
    expect(pasted.ok && pasted.kind).toBe("bundle");
    if (!pasted.ok || pasted.kind !== "bundle") return;
    const envelopes = pasted.bundle.items.flatMap((item) =>
      item.result.ok ? [item.result.envelope] : []
    );
    expect(envelopes).toHaveLength(5);
    const pending = groupPendingRegistrations(envelopes);
    expect(pending.map((entry) => [entry.workId, entry.title, entry.envelopes.length])).toEqual([
      ["1177354054934574437", "新しい題", 3],
      ["999", "別の作品", 1],
      ["888", undefined, 1],
    ]);
    expect("title" in pending[2]).toBe(false);
  });
});
