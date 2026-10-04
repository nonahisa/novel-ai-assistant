import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import vm from "node:vm";
import { findingPanelStateOf } from "../../../src/core/findingPanelState";
import { outboxContextOf } from "../../../src/core/outboxContext";
import { buildInboxResult, inboxResultName, isPendingInboxPath, parseInboxFile } from "../../../src/core/outboxInbox";
import { BODY_CHANGED_REASON } from "../../../src/core/outboxImport";
import { parseFindingLines, resolveFindings } from "../../../src/models/finding";
import { outboxPack } from "../../../src/mcp/tools/outbox";

/**
 * 出先の原稿箱のページ（`media/outbox/outbox.html`）が持つ判定の写しが、
 * 拡張機能の core と**同じ見本で同じ結果になる**ことを見張る（設計書6.115「GitHub 経由」）。
 *
 * ページは GitHub から指摘の置き場と本文を読んで、未処理の指摘を自分で選ぶ
 * （パソコンが切れていても使うため）。写しがずれても原稿は壊れない——取り込みが
 * パソコンでやり直して断る——が、ずれると出先に「無い指摘」が並び、押しても断られる。
 *
 * ページの `<script>` のうち `outbox-logic:start`〜`end` の区間だけを取り出して動かす。
 */

interface PageLogic {
  DEFAULT_RETENTION_DAYS: number;
  parseFindingLines(text: string): unknown[];
  resolveFindings(lines: unknown[]): Array<Record<string, unknown>>;
  panelStateOf(view: unknown, text: string | undefined, days: number, now: Date): { state: string; line: number };
  contextOf(text: string, line: number, view: unknown): unknown;
  candidateFiles(jsonl: string, days: number, now: Date): string[];
  pendingFindings(jsonl: string, texts: Record<string, string>, days: number, now: Date): Array<Record<string, unknown>>;
  sortWorksByRecent(works: Array<{ path: string; lastCommitAt: string }>): Array<{ path: string }>;
  inboxFileName(date: Date, device: string): string;
  toLfText(text: string): string;
  buildInbox(records: unknown[], meta: { sentAt: string; device: string; writer: string }): unknown;
  resultFileName(box: string): string;
  parseResultFile(text: string): Record<string, { status: string; reason: string }> | null;
  recordStage(record: unknown, doneNames: string[], results: Record<string, unknown>): { stage: string; reason: string };
}

function loadPageLogic(): PageLogic {
  const html = fs.readFileSync(nodePath.resolve("media/outbox/outbox.html"), "utf8");
  const start = html.indexOf("/* outbox-logic:start */");
  const end = html.indexOf("/* outbox-logic:end */");
  expect(start, "ページに判定の区間の印がある").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const code = html.slice(start, end);
  // 区間は画面（document）に触らないこと。触ると試験の外でしか動かない写しになる
  expect(code).not.toMatch(/document\.|window\./);
  return vm.runInNewContext(`${code}\nOutboxLogic`, { Date, Map, Array, JSON, Math, Object, Number, String, isNaN }) as PageLogic;
}

const page = loadPageLogic();
const NOW = new Date("2026-10-04T12:00:00.000Z");
const FILE = "本文/001.txt";

/** 状態ごとの見本（core の決まりを1つずつ踏む） */
const BODY = [
  "一行目の文。",
  "",
  "同じ文。",
  "あいだの文。",
  "同じ文。",
  "彼はゆくりと歩いた。",
  "あとの文。",
  "<0xE3>全角の　空白が　ある文。",
].join("\n");

function line(value: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "finding",
    time: "2026-10-04T00:00:00.000Z",
    file: FILE,
    hintLine: 1,
    target: "",
    suggestion: "",
    before: "",
    after: "",
    message: "",
    category: "typo",
    label: "誤字脱字",
    ...value,
  });
}

const SAMPLES = [
  line({ id: "pending", original: "彼はゆくりと歩いた。", target: "ゆくり", suggestion: "ゆっくり", hintLine: 6 }),
  line({ id: "moved", original: "彼はゆくりと歩いた。", target: "ゆくり", suggestion: "ゆっくり", hintLine: 2, label: "推敲", category: "proofread" }),
  // 同じ文が2か所——前後の本文で絞る（後ろの「彼は…」に接するほう）
  line({ id: "dup", original: "同じ文。", hintLine: 3, after: "彼はゆくりと歩いた。" }),
  // 同じ文が2か所——手がかりが無ければ hintLine に近いほう
  line({ id: "dupNear", original: "同じ文。", hintLine: 5 }),
  line({ id: "normalized", original: "全角の空白がある文。", hintLine: 8 }),
  line({ id: "stale", original: "消えた文。", hintLine: 3 }),
  line({ id: "expired", original: "彼はゆくりと歩いた。", time: "2026-09-20T00:00:00.000Z" }),
  line({ id: "badTime", original: "あとの文。", time: "日時でない" }),
  line({ id: "future", original: "あとの文。", time: "2026-12-01T00:00:00.000Z" }),
  line({ id: "accepted", original: "彼はゆくりと歩いた。" }),
  line({ id: "dismissed", original: "あとの文。" }),
  line({ id: "undone", original: "あとの文。" }),
  line({ id: "other", original: "あとの文。", category: "other", label: "" }),
  line({ id: "legacy", original: "あとの文。", category: "deviation", label: "" }),
  line({ id: "unknownLabel", original: "あとの文。", category: "contradiction", label: "未知の分類" }),
  line({ id: "fact", original: "あとの文。", category: "contradiction", label: "矛盾（事実の照合）" }),
  line({ id: "otherFile", original: "あとの文。", file: "本文/002.txt" }),
  JSON.stringify({ kind: "decision", findingId: "accepted", time: "2026-10-04T01:00:00.000Z", status: "accepted" }),
  JSON.stringify({ kind: "decision", findingId: "dismissed", time: "2026-10-04T01:00:00.000Z", status: "dismissed" }),
  // 採ってから戻した（同じ時刻なら、あとの行が勝つ）
  JSON.stringify({ kind: "decision", findingId: "undone", time: "2026-10-04T01:00:00.000Z", status: "accepted" }),
  JSON.stringify({ kind: "decision", findingId: "undone", time: "2026-10-04T01:00:00.000Z", status: "pending" }),
  "壊れた行",
  "<<<<<<< HEAD",
].join("\n");

describe("未処理の判定（core/findingPanelState.ts の写し）", () => {
  it("同じ見本で、指摘ごとの状態と行が core と一致する", () => {
    const coreViews = resolveFindings(parseFindingLines(SAMPLES));
    const pageViews = page.resolveFindings(page.parseFindingLines(SAMPLES));
    expect(pageViews.map((view) => view.id)).toEqual(coreViews.map((view) => view.id));
    for (const days of [3, 0, 30]) {
      for (const view of coreViews) {
        const text = view.file === FILE ? BODY : undefined;
        const expected = findingPanelStateOf(view, text, days, NOW);
        const pageView = pageViews.find((candidate) => candidate.id === view.id);
        expect(page.panelStateOf(pageView, text, days, NOW), `${view.id}（${days}日）`).toEqual(expected);
      }
    }
  });

  it("見本が core の状態をひととおり踏んでいる（見本が痩せて素通りしないように）", () => {
    const states = new Set(
      resolveFindings(parseFindingLines(SAMPLES)).map(
        (view) => findingPanelStateOf(view, view.file === FILE ? BODY : undefined, 3, NOW).state
      )
    );
    expect([...states].sort()).toEqual(
      ["accepted", "dismissed", "expired", "pending", "stale", "unchecked", "unrestorable"].sort()
    );
  });

  it("本文を読む必要があるファイルは、位置の確かめが残っているものだけ", () => {
    expect(page.candidateFiles(SAMPLES, 3, NOW).sort()).toEqual([FILE, "本文/002.txt"].sort());
  });
});

describe("前後の文（core/outboxContext.ts の写し）", () => {
  const long = "長".repeat(700);
  const cases: Array<[string, string, number, Record<string, unknown>]> = [
    ["範囲の無い指摘", BODY, 6, { hintLine: 6, message: "", compared: undefined }],
    ["語尾単調の範囲（行がずれた）", ["前", "", "a。", "b。", "", "c。", "後ろ", "さらに後ろ", "末尾"].join("\n"), 3, { hintLine: 2, message: "語尾が単調です（2〜5行目）", compared: undefined }],
    ["逸脱の補足の範囲", ["一", "二", "三", "四"].join("\n"), 2, { hintLine: 2, message: "", compared: { note: "2〜3行目" } }],
    ["上限で切る", [long, long, long, long, "x"].join("\n"), 2, { hintLine: 2, message: "（2〜4行目）", compared: undefined }],
    ["前後が上限で切れる", [long, "y", long, long].join("\n"), 2, { hintLine: 2, message: "", compared: undefined }],
  ];
  for (const [name, text, at, view] of cases) {
    it(name, () => {
      expect(page.contextOf(text, at, view)).toEqual(
        outboxContextOf(text, at, view as Parameters<typeof outboxContextOf>[2])
      );
    });
  }
});

describe("並べる指摘（outbox.pack と同じ欄）", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outbox-page-"));
    fs.mkdirSync(nodePath.join(root, "本文"));
    fs.mkdirSync(nodePath.join(root, ".aiwriter"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("パソコンから送る道（outbox.pack）と、ページが GitHub から組む道で、同じ指摘が同じ欄で並ぶ", () => {
    const now = new Date();
    const fresh = SAMPLES.replace(/2026-10-04T00:00:00\.000Z/g, now.toISOString());
    fs.writeFileSync(nodePath.join(root, FILE), `${BODY}\n`, "utf8");
    fs.writeFileSync(nodePath.join(root, ".aiwriter", "findings.jsonl"), fresh, "utf8");

    const packed = outboxPack({ folder: root }).findings;
    const texts = { [FILE]: page.toLfText(`﻿${BODY.replace(/\n/g, "\r\n")}\r\n`) };
    const listed = page.pendingFindings(fresh, texts, 3, new Date());
    const pick = (item: Record<string, unknown>) => ({
      id: item.id,
      file: item.file,
      line: item.line,
      label: item.label,
      original: item.original,
      target: item.target,
      suggestion: item.suggestion,
      message: item.message,
      canFix: item.canFix,
      context: item.context,
    });
    expect(listed.map(pick)).toEqual(packed.map((item) => pick(item as unknown as Record<string, unknown>)));
    expect(listed.length).toBeGreaterThan(3);
  });
});

describe("取り込みの結果のファイル（断られた記録を決め直す）", () => {
  const BOX = "20261004T050102Z-tablet.json";
  const records = [
    { id: "a", writer: "u_1" },
    { id: "b", writer: "u_1" },
    { id: "c", writer: "u_1" },
  ];
  const file = buildInboxResult(
    BOX,
    records,
    [
      { id: "a", writer: "u_1", status: "imported", reason: "入れた" },
      { id: "b", writer: "u_1", status: "refused", reason: BODY_CHANGED_REASON },
      { id: "c", writer: "u_1", status: "already", reason: "入れ済み" },
      // 別の箱の記録（この箱の結果には入らない）
      { id: "z", writer: "u_1", status: "refused", reason: "別の箱" },
    ],
    new Date("2026-10-04T06:00:00.000Z")
  );

  it("拡張機能が置く結果のファイルの名前と形を、ページが読める", () => {
    expect(page.resultFileName(BOX)).toBe(`${BOX}.result.json`);
    expect(inboxResultName(BOX)).toBe(page.resultFileName(BOX));
    expect(file.results.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(page.parseResultFile(JSON.stringify(file))).toEqual({
      a: { status: "imported", reason: "入れた" },
      b: { status: "refused", reason: BODY_CHANGED_REASON },
      c: { status: "already", reason: "入れ済み" },
    });
    expect(page.parseResultFile("{壊れ")).toBeNull();
    expect(page.parseResultFile(JSON.stringify({ ...file, format: "別" }))).toBeNull();
  });

  it("記録の行き先：送っていない・取り込み待ち・取り込み済み・入らなかった（理由つき）", () => {
    const results = { [BOX]: page.parseResultFile(JSON.stringify(file)) };
    const done = [BOX, page.resultFileName(BOX)];
    const stage = (record: Record<string, unknown>, doneNames = done) =>
      page.recordStage(record, doneNames, results);
    expect(stage({ id: "a", sent: false })).toEqual({ stage: "unsent", reason: "" });
    expect(stage({ id: "a", sent: true, sentFile: BOX }, [])).toEqual({ stage: "sent", reason: "" });
    expect(stage({ id: "a", sent: true, sentFile: BOX })).toEqual({ stage: "imported", reason: "" });
    expect(stage({ id: "c", sent: true, sentFile: BOX })).toEqual({ stage: "imported", reason: "" });
    expect(stage({ id: "b", sent: true, sentFile: BOX })).toEqual({ stage: "refused", reason: BODY_CHANGED_REASON });
    // 保管庫の道（Claude Code の取り込み）で入れた印
    expect(stage({ id: "b", imported: true })).toEqual({ stage: "imported", reason: "" });
  });

  it("結果のファイルが無い古い箱は、今までどおり取り込み済み", () => {
    expect(page.recordStage({ id: "b", sent: true, sentFile: "old.json" }, ["old.json"], {})).toEqual({
      stage: "imported",
      reason: "",
    });
  });
});

describe("作品の並べ方と受け取り箱", () => {
  it("最後のコミットの新しい順。時刻の分からない作品は後ろ", () => {
    const sorted = page.sortWorksByRecent([
      { path: "古い", lastCommitAt: "2026-09-01T00:00:00Z" },
      { path: "不明", lastCommitAt: "" },
      { path: "新しい", lastCommitAt: "2026-10-04T04:13:44Z" },
      { path: "", lastCommitAt: "2026-10-01T00:00:00Z" },
    ]);
    expect(sorted.map((work) => work.path)).toEqual(["新しい", "", "古い", "不明"]);
  });

  it("受け取り箱の名前に「:」を入れない（Windows で取り出せない）。拡張機能が箱と見分けられる", () => {
    const name = page.inboxFileName(new Date("2026-10-04T05:01:02.345Z"), "tablet");
    expect(name).toBe("20261004T050102Z-tablet.json");
    expect(isPendingInboxPath(`たゆたう鉛/.aiwriter/inbox/${name}`)).toBe(true);
    expect(page.inboxFileName(new Date(0), "日本語")).toMatch(/-device\.json$/);
  });

  it("ページが組む箱を、拡張機能の parseInboxFile がそのまま読める（画面だけの欄は送らない）", () => {
    const box = page.buildInbox(
      [
        { id: "a", kind: "memo", text: "メモ", episode: FILE, baseBlobSha: "abc", work: "o/r:", sent: false, line: 3 },
        { id: "b", kind: "verdict", verdict: "reject", findingId: "f1" },
        { id: "c", kind: "edit", findingId: "f1", original: "前", text: "後" },
      ],
      { sentAt: "2026-10-04T05:00:00.000Z", device: "タブレット", writer: "u_1" }
    );
    const parsed = parseInboxFile(JSON.stringify(box));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.records).toEqual([
      { id: "a", writer: "u_1", kind: "memo", text: "メモ", episode: FILE, baseBlobSha: "abc", line: 3 },
      { id: "b", writer: "u_1", kind: "verdict", verdict: "reject", findingId: "f1" },
      { id: "c", writer: "u_1", kind: "edit", findingId: "f1", original: "前", text: "後" },
    ]);
  });
});
