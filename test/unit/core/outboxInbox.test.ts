import { describe, expect, it } from "vitest";
import {
  OUTBOX_INBOX_FORMAT,
  buildInboxResult,
  describeInboxImport,
  parseInboxResult,
  doneNameFor,
  isPendingInboxPath,
  parseInboxFile,
  pendingInboxNames,
} from "../../../src/core/outboxInbox";
import { IGNORED_PATHS, missingIgnoreRules } from "../../../src/core/workRegistry";

/**
 * 原稿箱の受け取り箱の形（設計書6.115「GitHub 経由」）。ページが置く箱を、
 * 拡張機能が**決まった欄だけ**読むこと・壊れた箱は直さずに止めることを見る。
 */

const box = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: OUTBOX_INBOX_FORMAT,
    version: 1,
    sentAt: "2026-10-04T05:00:00.000Z",
    device: "タブレット",
    writer: "u_123",
    records: [
      { id: "r1", kind: "memo", episode: "本文/001.txt", text: "メモ", baseBlobSha: "abc", writer: "偽の書き手" },
      { id: "r2", kind: "verdict", findingId: "f1", verdict: "reject", line: 3 },
    ],
    ...over,
  });

describe("箱を読む", () => {
  it("決まった欄だけを読み、書き手は箱の writer にそろえる（記録の欄の writer は見ない）", () => {
    const parsed = parseInboxFile(box());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.records).toEqual([
      { id: "r1", writer: "u_123", kind: "memo", episode: "本文/001.txt", text: "メモ", baseBlobSha: "abc" },
      { id: "r2", writer: "u_123", kind: "verdict", findingId: "f1", verdict: "reject", line: 3 },
    ]);
    expect(parsed.skipped).toBe(0);
  });

  it("形の合わない記録は数えて飛ばす（知らない種類・id が無い・知らない採否）", () => {
    const parsed = parseInboxFile(
      box({
        records: [
          { id: "a", kind: "delete" },
          { kind: "memo", text: "id が無い" },
          { id: "b", kind: "verdict", verdict: "消す" },
          "文字列",
        ],
      })
    );
    expect(parsed.ok && parsed.records.map((r) => [r.id, r.verdict])).toEqual([["b", undefined]]);
    expect(parsed.ok && parsed.skipped).toBe(3);
  });

  it("鍵に使えない書き手は、決まった名前にそろえる", () => {
    const parsed = parseInboxFile(box({ writer: "a/b" }));
    expect(parsed.ok && parsed.writer).toBe("inbox");
  });

  it("壊れた箱・印の無い箱・読めない版は、直さずに理由を返す", () => {
    expect(parseInboxFile("{壊れ").ok).toBe(false);
    expect(parseInboxFile(JSON.stringify({ records: [] })).ok).toBe(false);
    const future = parseInboxFile(box({ version: 3 }));
    expect(future.ok).toBe(false);
    expect(!future.ok && future.reason).toContain("拡張機能を新しく");
  });

  it("版2の箱（原稿エディターのページ）の本文の全体を読む。続きの印も読む", () => {
    const parsed = parseInboxFile(
      box({
        version: 2,
        writer: "editor",
        records: [
          {
            id: "b2",
            kind: "body",
            at: "2026-10-05T01:00:00.000Z",
            episode: "本文/001.txt",
            baseBlobSha: "abc",
            basedOn: "b1",
            text: "全文\n",
          },
        ],
      })
    );
    expect(parsed.ok && parsed.records).toEqual([
      {
        id: "b2",
        writer: "editor",
        kind: "body",
        at: "2026-10-05T01:00:00.000Z",
        episode: "本文/001.txt",
        baseBlobSha: "abc",
        basedOn: "b1",
        text: "全文\n",
      },
    ]);
  });

  it("BOM 付きでも読める", () => {
    expect(parseInboxFile(`﻿${box()}`).ok).toBe(true);
  });
});

describe("取り込み待ちの箱", () => {
  it("inbox の直下の .json だけ（done の中は除く）。書庫の道でも拾う", () => {
    expect(isPendingInboxPath(".aiwriter/inbox/20261004T050000Z-tablet.json")).toBe(true);
    expect(isPendingInboxPath("たゆたう鉛/.aiwriter/inbox/x.json")).toBe(true);
    expect(isPendingInboxPath("たゆたう鉛\\.aiwriter\\inbox\\x.json")).toBe(true);
    expect(isPendingInboxPath(".aiwriter/inbox/done/x.json")).toBe(false);
    expect(isPendingInboxPath(".aiwriter/findings.jsonl")).toBe(false);
  });

  it("名前の一覧から箱だけを、名前の順に", () => {
    expect(pendingInboxNames(["b.json", "done", "a.json", "メモ.txt", ".x.json"])).toEqual(["a.json", "b.json"]);
  });

  it("done に同じ名前があれば、上書きせずに別の名前にする", () => {
    expect(doneNameFor("a.json", new Set())).toBe("a.json");
    expect(doneNameFor("a.json", new Set(["a.json", "a-2.json"]))).toBe("a-3.json");
  });
});

describe("受け取り箱は同期から外れない", () => {
  it("拡張機能が足す除外の規則は、受け取り箱にも done にも当たらない", () => {
    const rules = [...IGNORED_PATHS, ...missingIgnoreRules(new Uint8Array())];
    for (const target of [".aiwriter/inbox/a.json", ".aiwriter/inbox/done/a.json"]) {
      for (const rule of rules) {
        const plain = rule.replace(/^!/, "");
        expect(target.startsWith(plain), `${rule} が ${target} を外している`).toBe(false);
      }
    }
  });
});

describe("結果のファイル", () => {
  it("本文が変わって断った記録には、パソコンのいまの本文の印を添える（ページが違いを並べる）", () => {
    const result = buildInboxResult(
      "a.json",
      [{ id: "b1", writer: "editor" }],
      [{ id: "b1", writer: "editor", status: "refused", reason: "変わった", currentBlobSha: "def" }],
      new Date("2026-10-05T00:00:00.000Z")
    );
    expect(result.results).toEqual([{ id: "b1", status: "refused", reason: "変わった", currentBlobSha: "def" }]);
    const parsed = parseInboxResult(JSON.stringify(result));
    expect(parsed.ok && parsed.results[0].currentBlobSha).toBe("def");
  });
});

describe("知らせの一文", () => {
  it("入れた・断った・入れ済み・読めない箱を並べる", () => {
    expect(describeInboxImport({ importedCount: 2, refusedCount: 1, alreadyCount: 0 }, 1)).toBe(
      "原稿箱から2件を入れました。1件は入れませんでした。読めない箱が1つあります（受け取り箱に残しました）。"
    );
  });
});
