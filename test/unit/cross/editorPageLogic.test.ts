import { describe, expect, it } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";
import vm from "node:vm";
import { NOTATION_RULES, notationModeFor, tokenizeLine } from "../../../src/core/manuscriptRender";
import { MEMO_LINE_PATTERN } from "../../../src/core/sceneMemo";
import { countChars } from "../../../src/core/charCount";
import {
  buildInboxResult,
  isPendingInboxPath,
  parseInboxFile,
} from "../../../src/core/outboxInbox";
import {
  gitBlobSha,
  importOutboxRecords,
  jsonLinesAddition,
  type OutboxImportIo,
} from "../../../src/core/outboxImport";
import { decodeBytes } from "../../../src/core/textDecode";

/**
 * 出先の原稿エディターのページ（`media/outbox/editor.html`。設計書6.116）を見張る。
 *
 * - GitHub を読む部品（`github-common` の区間）が、原稿箱のページと**一字違わず**同じこと
 * - 判定の写し（`editor-logic` の区間）が、拡張機能の core と同じ見本で同じ答えになること
 *   （記法の組み方・作者の付箋の行・字数・受け取り箱の形）
 * - ページが送る箱を、拡張機能の取り込みがそのまま読んで入れられること
 * - 原稿へ直接書かない・AI を使わない・外の読み込みを使わない・内部の言葉を画面に出さない
 */

const EDITOR = fs.readFileSync(nodePath.resolve("media/outbox/editor.html"), "utf8");
const OUTBOX = fs.readFileSync(nodePath.resolve("media/outbox/outbox.html"), "utf8");

function region(html: string, name: string): string {
  const start = html.indexOf(`/* ${name}:start */`);
  const end = html.indexOf(`/* ${name}:end */`);
  expect(start, `${name} の区間の印がある`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

interface Token {
  kind: string;
  text?: string;
  base?: string;
  reading?: string;
}

interface EditorLogicShape {
  NOTATION_RULES: unknown;
  MEMO_LINE_PATTERN: string;
  INBOX_VERSION: number;
  EDITOR_SUFFIX: string;
  notationModeFor(file: string): string;
  tokenizeLine(line: string, mode: string): Token[];
  isMemoLine(line: string): boolean;
  countChars(text: string, file: string): { gross: number; net: number };
  isEditorBoxName(name: string): boolean;
  buildBodyBox(record: Record<string, unknown>, meta: { sentAt: string; device: string; writer: string }): unknown;
  parseBox(text: string): unknown;
  latestBodyOf(
    episode: string,
    pending: Array<{ name: string; box: unknown }>,
    done: Array<{ name: string; box: unknown; result: unknown }>
  ): { stage: string; reason: string; currentBlobSha: string; record: { id: string } } | null;
  lineDiff(a: string, b: string): Array<{ type: string; text: string }>;
}

interface GitHubWorksShape {
  inboxFileName(date: Date, slug: string): string;
  parseResultFile(text: string): Record<string, unknown> | null;
  parseRepoSpec(spec: string): { owner: string; name: string } | null;
}

function load(): { logic: EditorLogicShape; works: GitHubWorksShape } {
  const common = region(EDITOR, "github-common");
  const code = region(EDITOR, "editor-logic");
  // 区間は画面に触らない（触ると試験の外でしか動かない写しになる）
  expect(common).not.toMatch(/document\.|window\./);
  expect(code).not.toMatch(/document\.|window\./);
  const sandbox = { Date, Map, Array, JSON, Math, Object, Number, String, RegExp, isNaN, Promise, Uint8Array, TextDecoder, atob };
  return vm.runInNewContext(`${common}\n${code}\n({ logic: EditorLogic, works: GitHubWorks })`, sandbox) as {
    logic: EditorLogicShape;
    works: GitHubWorksShape;
  };
}

const { logic, works } = load();
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("原稿箱のページと同じ部品", () => {
  it("GitHub を読む区間は、2つのページで一字違わない", () => {
    expect(region(EDITOR, "github-common")).toBe(region(OUTBOX, "github-common"));
  });

  it("リポジトリの名前は URL を貼っても読める", () => {
    expect(plain(works.parseRepoSpec("https://github.com/someone/novels.git"))).toMatchObject({ owner: "someone", name: "novels" });
    expect(works.parseRepoSpec("novels")).toBeNull();
  });
});

describe("記法の組み方は、パソコンの原稿エディターと同じ", () => {
  it("規則の文字列そのものが core と同じ", () => {
    expect(plain(logic.NOTATION_RULES)).toEqual(plain(NOTATION_RULES));
  });

  it("どの記法で読むかの決め方（.md だけ拡張機能の記法）", () => {
    for (const name of ["本文/001.md", "本文/001.MD", "本文/001.txt", "合本.txt"]) {
      expect(logic.notationModeFor(name)).toBe(notationModeFor(name));
    }
  });

  const samples: Array<[string, "curly" | "site"]> = [
    ["{漢字|かんじ}と{{強調}}の行", "curly"],
    ["{書きかけ|}のルビ", "curly"],
    ["｜漢字《かんじ》と|半角《はんかく》と東京《とうきょう》", "site"],
    ["《《傍点》》の前に彼《《強調》》", "site"],
    ["｜強調《・・》の代わり", "site"],
    ["記法の無い行", "site"],
    ["", "curly"],
  ];
  it.each(samples)("同じ見本で同じ部品に分ける：%s", (line, mode) => {
    expect(plain(logic.tokenizeLine(line, mode))).toEqual(plain(tokenizeLine(line, mode)));
  });
});

describe("作者の付箋と字数", () => {
  it("付箋の行の決まりが core と同じ", () => {
    expect(logic.MEMO_LINE_PATTERN).toBe(MEMO_LINE_PATTERN);
    expect(logic.isMemoLine("// メモ")).toBe(true);
    expect(logic.isMemoLine("　／／全角")).toBe(true);
    expect(logic.isMemoLine("URL は http://example")).toBe(false);
  });

  const texts = [
    "一行目の文。\n\n　二行目　の文。\n// 付箋は数えない\n",
    "{漢字|かんじ}と{{強調}}。\r\n終わり。",
    "｜漢字《かんじ》のルビは .txt では記法ごと数える。",
  ];
  it.each(texts)("総・純の字数が core と同じ：%s", (text) => {
    for (const file of ["本文/001.md", "本文/001.txt"]) {
      const expected = countChars(text, file.endsWith(".md"));
      expect(logic.countChars(text, file)).toEqual({ gross: expected.gross, net: expected.net });
    }
  });
});

describe("送る箱の形（拡張機能がそのまま読める）", () => {
  const record = {
    id: "b123",
    at: "2026-10-05T01:00:00.000Z",
    device: "スマホ",
    episode: "本文/001.txt",
    baseBlobSha: gitBlobSha(new TextEncoder().encode("一行目\n")),
    basedOn: "b100",
    text: "一行目\n続き\n",
  };

  it("版2・本文の全体の記録1件。書き手は箱の writer にそろう", () => {
    const box = logic.buildBodyBox(record, { sentAt: record.at, device: "スマホ", writer: "editor" });
    const parsed = parseInboxFile(JSON.stringify(box));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.records).toEqual([{ writer: "editor", kind: "body", ...record }]);
    expect(logic.INBOX_VERSION).toBe(2);
  });

  it("箱の名前は受け取り箱の箱として拾われ、原稿エディターの箱と分かる", () => {
    const name = works.inboxFileName(new Date("2026-10-05T01:02:03.456Z"), `phone${logic.EDITOR_SUFFIX}`);
    expect(name).toBe("20261005T010203Z-phone-editor.json");
    expect(isPendingInboxPath(`.aiwriter/inbox/${name}`)).toBe(true);
    expect(logic.isEditorBoxName(name)).toBe(true);
    expect(logic.isEditorBoxName(`${name}.result.json`)).toBe(false);
    expect(logic.isEditorBoxName("20261005T010203Z-phone.json")).toBe(false);
  });

  it("ページが送った箱を、取り込みがそのまま入れる（文字コードと改行はパソコンの形のまま）", async () => {
    const FILE = "本文/001.txt";
    const pcBytes = new TextEncoder().encode("一行目\r\n");
    const store = new Map<string, Uint8Array>([[FILE, pcBytes]]);
    const io: OutboxImportIo = {
      async readText(relative) {
        const bytes = store.get(relative);
        return bytes ? new TextDecoder().decode(bytes) : undefined;
      },
      async listBodyFiles() {
        return [FILE];
      },
      async readBytes(relative) {
        const bytes = store.get(relative);
        if (!bytes) throw new Error("無い");
        return bytes;
      },
      async writeBody(relative, newText, original) {
        const current = store.get(relative);
        if (!current || decodeBytes(current).hash !== original.hash) return { ok: false, changed: true, reason: "変わった" };
        store.set(relative, new TextEncoder().encode(newText.replace(/\n/g, "\r\n")));
        return { ok: true };
      },
      async appendJsonLines(relative, values) {
        const existing = store.get(relative) ?? new Uint8Array();
        store.set(relative, new TextEncoder().encode(new TextDecoder().decode(existing) + jsonLinesAddition(existing, values)));
      },
    };
    // GitHub は LF（core.autocrlf の機械）。ページは GitHub の blob SHA を持つ
    const box = logic.buildBodyBox(
      { ...record, basedOn: "", baseBlobSha: gitBlobSha(new TextEncoder().encode("一行目\n")) },
      { sentAt: record.at, device: "スマホ", writer: "editor" }
    );
    const parsed = parseInboxFile(JSON.stringify(box));
    if (!parsed.ok) throw new Error(parsed.reason);
    const outcome = await importOutboxRecords(io, { isOwner: () => true, records: parsed.records });
    expect(outcome.results[0].status).toBe("imported");
    expect(new TextDecoder().decode(store.get(FILE))).toBe("一行目\r\n続き\r\n");
  });
});

describe("話の状態（取り込み待ち・取り込み済み・断られた）", () => {
  const body = (id: string, at: string) => ({ id, kind: "body", at, episode: "本文/001.txt", baseBlobSha: "a", text: id });
  const box = (records: unknown[]) => ({ format: "novelai-outbox-inbox", version: 2, records });

  it("いちばん新しい本文の記録の行き先を、結果のファイルで分ける", () => {
    const refusedResult = buildInboxResult(
      "x-editor.json",
      [{ id: "b2", writer: "editor" }],
      [{ id: "b2", writer: "editor", status: "refused", reason: "パソコンの本文が変わっています", currentBlobSha: "c" }],
      new Date()
    );
    const done = [
      { name: "1-editor.json", box: box([body("b1", "2026-10-05T01:00:00Z")]), result: null },
      {
        name: "2-editor.json",
        box: box([body("b2", "2026-10-05T02:00:00Z")]),
        result: works.parseResultFile(JSON.stringify(refusedResult)),
      },
    ];
    const latest = logic.latestBodyOf("本文/001.txt", [], done);
    expect(latest && [latest.record.id, latest.stage, latest.reason, latest.currentBlobSha]).toEqual([
      "b2",
      "refused",
      "パソコンの本文が変わっています",
      "c",
    ]);

    // 取り込み待ちの新しい記録があれば、そちら（続きを書ける）
    const pending = [{ name: "3-editor.json", box: box([body("b3", "2026-10-05T03:00:00Z")]) }];
    expect(logic.latestBodyOf("本文/001.txt", pending, done)?.stage).toBe("sent");
    // 結果のファイルが無い箱は「分からない」（取り込み済みと決めつけない）
    expect(logic.latestBodyOf("本文/001.txt", [], [done[0]])?.stage).toBe("unknown");
    // 別の話の記録は見ない
    expect(logic.latestBodyOf("本文/002.txt", pending, done)).toBeNull();
  });

  it("行の違いを並べる（同じ・送った本文だけ・パソコンだけ）", () => {
    expect(plain(logic.lineDiff("一\n二\n三", "一\n二改\n三\n四"))).toEqual([
      { type: "same", text: "一" },
      { type: "del", text: "二" },
      { type: "add", text: "二改" },
      { type: "same", text: "三" },
      { type: "add", text: "四" },
    ]);
  });
});

describe("ページの決まり", () => {
  it("外から来た文字を HTML として差し込まない", () => {
    expect(EDITOR).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("外の読み込みを使わない", () => {
    expect(EDITOR).not.toMatch(/<script[^>]*\ssrc=|<link\b|@import|<iframe|fetch\(/i);
  });

  it("AI を使わない・保管庫も使わない（使う能力は GitHub のコネクターだけ）", () => {
    const uses = [...EDITOR.matchAll(/window\.claude\.use\("([a-z]+)"\)/g)].map((m) => m[1]);
    expect(uses).toEqual(["mcp"]);
    expect(EDITOR).not.toMatch(/sample|\.collection\(/);
  });

  it("呼ぶ GitHub の道具は3つだけ（スキルの capabilities と同じ）", () => {
    const called = new Set([...EDITOR.matchAll(/gh\("([a-z_]+)"/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual(["create_or_update_file", "get_file_contents", "list_commits"]);
  });

  it("画面に出す言葉に、内部の言葉（blob・inbox・records・SHA）を入れない", () => {
    const markup = EDITOR.slice(EDITOR.indexOf('<div class="wrap"'), EDITOR.indexOf("<script>"));
    expect(markup).not.toMatch(/blob|inbox|records|SHA/i);
    // 画面の部品の文字列（日本語を含む文字列）にも出さない
    const ui = EDITOR.slice(EDITOR.lastIndexOf("<script>"));
    const shown = [...ui.matchAll(/"([^"\n]*[぀-ヿ一-鿿][^"\n]*)"/g)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(10);
    for (const text of shown) expect(text, text).not.toMatch(/blob|inbox|records|SHA/i);
  });

  it("打つだけでは送らない。送るのは［パソコンへ送る］（と、移る前の確かめで選んだとき）だけ", () => {
    const calls = [...EDITOR.matchAll(/sendToPc\(\)/g)].length;
    // 定義・ボタン・移る前の確かめの3か所
    expect(calls).toBe(3);
    expect(EDITOR).toMatch(/textEl\.addEventListener\("input", function \(\) \{ saveDraftSoon\(\); paint\(\); \}\);/);
  });

  it("未送信のまま別の話・作品へ移るときと、閉じるときは確かめる", () => {
    expect(EDITOR).toMatch(/episodeEl\.addEventListener\("change"[\s\S]*?leaveIfClean\(\)/);
    expect(EDITOR).toMatch(/workEl\.addEventListener\("change"[\s\S]*?leaveIfClean\(\)/);
    expect(EDITOR).toContain('window.addEventListener("beforeunload"');
  });
});
