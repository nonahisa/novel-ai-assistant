import { describe, expect, it } from "vitest";
import {
  BODY_CHANGED_REASON,
  gitBlobSha,
  importOutboxRecords,
  jsonLinesAddition,
  parseImportedKeys,
  type OutboxImportIo,
  type OutboxRecord,
} from "../../../src/core/outboxImport";
import { decodeBytes } from "../../../src/core/textDecode";
import { parseFindingLines, resolveFindings } from "../../../src/models/finding";

/**
 * 原稿箱の取り込みの判断（`core/outboxImport.ts`。設計書6.115「GitHub 経由」）。
 *
 * MCP（Node の fs）と拡張機能（`vscode.workspace.fs`）の両方がここを通すので、
 * ここでは**記憶の中の作品**で決まりだけを見る。2つの道で同じ結果になることは
 * `test/unit/features/importOutboxInbox.test.ts` が本物のディスクで見る。
 */

const FILE = "本文/001.txt";
const enc = (text: string) => new TextEncoder().encode(text);

function memoryIo(files: Record<string, Uint8Array | string>): OutboxImportIo & { files: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>(
    Object.entries(files).map(([key, value]) => [key, typeof value === "string" ? enc(value) : value])
  );
  return {
    files: store,
    async readText(relative) {
      const bytes = store.get(relative);
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    },
    async listBodyFiles() {
      return [...store.keys()].filter((key) => key.startsWith("本文/"));
    },
    async readBytes(relative) {
      const bytes = store.get(relative);
      if (!bytes) throw new Error("無い");
      return bytes;
    },
    async writeBody(relative, newText, original) {
      const current = store.get(relative);
      if (!current || decodeBytes(current).hash !== original.hash) {
        return { ok: false, changed: true, reason: "変わった" };
      }
      // 試験では改行の形を LF のまま書く（書き戻しの細部は製品の関数の試験が見る）
      store.set(relative, enc(newText));
      return { ok: true };
    },
    async appendJsonLines(relative, values) {
      const existing = store.get(relative) ?? new Uint8Array();
      store.set(relative, enc(new TextDecoder().decode(existing) + jsonLinesAddition(existing, values)));
    },
  };
}

const finding = {
  kind: "finding",
  id: "f_typo",
  time: "2026-10-04T00:00:00.000Z",
  file: FILE,
  hintLine: 2,
  original: "彼はゆくりと歩いた。",
  target: "ゆくり",
  suggestion: "ゆっくり",
  before: "一行目",
  after: "",
  message: "脱字",
  category: "typo",
  label: "誤字脱字",
};

const NOW = new Date("2026-10-04T12:00:00.000Z");
const BODY = "一行目\n彼はゆくりと歩いた。\n";

function work(body: string | Uint8Array = BODY) {
  return memoryIo({
    [FILE]: body,
    ".aiwriter/findings.jsonl": `${JSON.stringify(finding)}\n`,
  });
}

const memo = (over: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "m1",
  writer: "inbox",
  kind: "memo",
  episode: FILE,
  text: "ここで間を置く",
  ...over,
});

describe("git の blob SHA", () => {
  it("git hash-object と同じ値になる", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(enc("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("GitHub 経由のメモ（baseBlobSha）", () => {
  it("読んだときの blob SHA と同じ本文なら入れる", async () => {
    const io = work();
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [memo({ baseBlobSha: gitBlobSha(enc(BODY)) })],
      now: NOW,
    });
    expect(result.results[0].status).toBe("imported");
    expect(new TextDecoder().decode(io.files.get(FILE))).toContain("// ここで間を置く");
  });

  it("手元が CRLF でも、リポジトリの LF の blob SHA と合えば入れる（core.autocrlf の機械）", async () => {
    const crlf = BODY.replace(/\n/g, "\r\n");
    const io = work(crlf);
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [memo({ baseBlobSha: gitBlobSha(enc(BODY)) })],
      now: NOW,
    });
    expect(result.results[0].status).toBe("imported");
  });

  it("出先で読んだあとにパソコンで本文が変わっていれば断る", async () => {
    const io = work();
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [memo({ baseBlobSha: gitBlobSha(enc("前の本文\n")) })],
      now: NOW,
    });
    expect(result.results[0]).toMatchObject({ status: "refused", reason: BODY_CHANGED_REASON });
    expect(new TextDecoder().decode(io.files.get(FILE))).toBe(BODY);
  });

  it("どちらの値も無いメモは断る（いつの本文に書いたメモか分からない）", async () => {
    const result = await importOutboxRecords(work(), { isOwner: () => true, records: [memo()], now: NOW });
    expect(result.results[0].reason).toBe(BODY_CHANGED_REASON);
  });
});

describe("持ち主の扱いは呼び手が決める", () => {
  it("isOwner が全員を持ち主と言えば、採否を入れる（受け取り箱の道）", async () => {
    const io = work();
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [{ id: "v1", writer: "u_phone", kind: "verdict", findingId: "f_typo", verdict: "reject" }],
      now: NOW,
    });
    expect(result.results[0].status).toBe("imported");
    const views = resolveFindings(parseFindingLines(new TextDecoder().decode(io.files.get(".aiwriter/findings.jsonl"))));
    expect(views[0].status).toBe("dismissed");
  });

  it("isOwner が断れば、採否は入れない（保管庫の道の編集部）", async () => {
    const result = await importOutboxRecords(work(), {
      isOwner: (writer) => writer === "u_owner",
      records: [{ id: "v1", writer: "u_editor", kind: "verdict", findingId: "f_typo", verdict: "reject" }],
      now: NOW,
    });
    expect(result.results[0].status).toBe("refused");
  });
});

describe("二度入れない", () => {
  it("入れた記録の鍵を残し、2度目は already で返す", async () => {
    const io = work();
    const record: OutboxRecord = { id: "v1", writer: "inbox", kind: "verdict", findingId: "f_typo", verdict: "fix" };
    await importOutboxRecords(io, { isOwner: () => true, records: [record], now: NOW });
    expect(new TextDecoder().decode(io.files.get(FILE))).toContain("ゆっくり");
    expect(parseImportedKeys(new TextDecoder().decode(io.files.get(".aiwriter/history/outbox-imported.jsonl")))).toEqual(
      new Set(["inbox/v1"])
    );
    const again = await importOutboxRecords(io, { isOwner: () => true, records: [record], now: NOW });
    expect(again.results[0].status).toBe("already");
    expect(again.alreadyCount).toBe(1);
  });
});

describe("書いてよいのは本文だけ", () => {
  it("設定資料や .aiwriter を指すメモは断る", async () => {
    const io = work();
    io.files.set("設定/plot.md", enc("筋\n"));
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [memo({ episode: "設定/plot.md", baseBlobSha: gitBlobSha(enc("筋\n")) })],
      now: NOW,
    });
    expect(result.results[0].status).toBe("refused");
    expect(result.results[0].reason).toContain("本文のファイルではありません");
  });
});

/* ── 原稿エディターのページから送った本文の全体（kind: "body"。設計書6.116） ── */

const bodyRecord = (over: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "b1",
  writer: "editor",
  kind: "body",
  at: "2026-10-05T01:00:00.000Z",
  episode: FILE,
  baseBlobSha: gitBlobSha(enc(BODY)),
  text: "一行目\n彼はゆっくりと歩いた。\n続きを書いた。\n",
  ...over,
});

const read = (io: ReturnType<typeof work>, file = FILE) => new TextDecoder().decode(io.files.get(file));

describe("本文の全体（kind: body）", () => {
  it("読んだときの本文と同じなら、送った本文に置き換える", async () => {
    const io = work();
    const result = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord()], now: NOW });
    expect(result.results[0]).toMatchObject({ status: "imported" });
    expect(read(io)).toBe("一行目\n彼はゆっくりと歩いた。\n続きを書いた。\n");
  });

  it("出先から CRLF・BOM 付きで来ても、本文の空間（LF）にそろえて書く", async () => {
    const io = work();
    const text = "﻿一行目\r\n書き直した。\r\n";
    await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord({ text })], now: NOW });
    expect(read(io)).toBe("一行目\n書き直した。\n");
  });

  it("パソコンの本文が送ったあとに変わっていれば入れず、違いの場所と今の本文の印を返す", async () => {
    const io = work("一行目\nパソコンで直した。\n");
    const result = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord()], now: NOW });
    expect(result.results[0].status).toBe("refused");
    expect(result.results[0].reason).toContain(BODY_CHANGED_REASON);
    expect(result.results[0].reason).toContain("2行目から");
    expect(result.results[0].currentBlobSha).toBe(gitBlobSha(enc("一行目\nパソコンで直した。\n")));
    expect(read(io)).toBe("一行目\nパソコンで直した。\n");
  });

  it("持ち主でない人の本文は入れない", async () => {
    const io = work();
    const result = await importOutboxRecords(io, {
      isOwner: (writer) => writer === "u_owner",
      records: [bodyRecord()],
      now: NOW,
    });
    expect(result.results[0].status).toBe("refused");
    expect(read(io)).toBe(BODY);
  });

  it("本文のファイルでないもの（設定資料）には書かない", async () => {
    const io = work();
    io.files.set("設定/plot.md", enc("筋\n"));
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [bodyRecord({ episode: "設定/plot.md", baseBlobSha: gitBlobSha(enc("筋\n")) })],
      now: NOW,
    });
    expect(result.results[0].reason).toContain("本文のファイルではありません");
    expect(read(io, "設定/plot.md")).toBe("筋\n");
  });

  it("いまの本文にも、送った本文にも、競合の印があれば書かない", async () => {
    const conflicted = "一行目\n<<<<<<< HEAD\nあ\n=======\nい\n>>>>>>> x\n";
    const io = work(conflicted);
    const first = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [bodyRecord({ baseBlobSha: gitBlobSha(enc(conflicted)) })],
      now: NOW,
    });
    expect(first.results[0].status).toBe("refused");
    expect(read(io)).toBe(conflicted);

    const io2 = work();
    const second = await importOutboxRecords(io2, {
      isOwner: () => true,
      records: [bodyRecord({ text: conflicted })],
      now: NOW,
    });
    expect(second.results[0].status).toBe("refused");
    expect(read(io2)).toBe(BODY);
  });

  it("空の本文は入れない（話がまるごと消えるため）", async () => {
    const io = work();
    const result = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord({ text: " \n" })], now: NOW });
    expect(result.results[0].status).toBe("refused");
    expect(read(io)).toBe(BODY);
  });

  it("校閲中（編集部がロック）の話には書かない", async () => {
    const io = work();
    io.files.set(
      ".aiwriter/locks/locks.jsonl",
      enc(JSON.stringify({ kind: "acquire", file: FILE, holder: "編集部の田中", holderKind: "editor", time: NOW.toISOString(), note: "" }) + "\n")
    );
    const result = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord()], now: NOW });
    expect(result.results[0].status).toBe("refused");
    expect(read(io)).toBe(BODY);
  });

  it("2度目は already（同じ本文を二度書かない）", async () => {
    const io = work();
    await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord()], now: NOW });
    const again = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord()], now: NOW });
    expect(again.results[0].status).toBe("already");
  });

  it("続きの印（basedOn）の付いた2件目は、1件目を入れたあとの本文に続けて入れる（同じ回でも、別の回でも）", async () => {
    const v1 = bodyRecord();
    const v2 = bodyRecord({
      id: "b2",
      at: "2026-10-05T02:00:00.000Z",
      basedOn: "b1",
      text: "一行目\n彼はゆっくりと歩いた。\n続きを書いた。\nさらに書いた。\n",
    });
    // 同じ回（渡す順が逆でも、時刻の順に入れる）
    const io = work();
    const together = await importOutboxRecords(io, { isOwner: () => true, records: [v2, v1], now: NOW });
    expect(together.results.map((item) => item.status)).toEqual(["imported", "imported"]);
    expect(read(io)).toBe(v2.text);

    // 別の回（1件目を入れたあと、出先はまだ古い本文を読んでいた）
    const io2 = work();
    await importOutboxRecords(io2, { isOwner: () => true, records: [v1], now: NOW });
    const later = await importOutboxRecords(io2, { isOwner: () => true, records: [v2], now: NOW });
    expect(later.results[0].status).toBe("imported");
    expect(read(io2)).toBe(v2.text);
  });

  it("続きの印の無い2件目（同じ元の本文から別に書いたもの）は、1件目を消さないよう断る", async () => {
    const io = work();
    const other = bodyRecord({ id: "b9", at: "2026-10-05T03:00:00.000Z", text: "一行目\n別の端末で書いた。\n" });
    const result = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord(), other], now: NOW });
    expect(result.results.map((item) => item.status)).toEqual(["imported", "refused"]);
    expect(read(io)).toBe(bodyRecord().text);
  });

  it("続きの印の先のあとでパソコンで書き換えていれば、続きも断る", async () => {
    const io = work();
    await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord()], now: NOW });
    io.files.set(FILE, enc("一行目\nパソコンで書いた。\n"));
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [bodyRecord({ id: "b2", basedOn: "b1", text: "一行目\n上書き。\n" })],
      now: NOW,
    });
    expect(result.results[0].status).toBe("refused");
    expect(read(io)).toBe("一行目\nパソコンで書いた。\n");
  });

  it("同じ回のメモは、本文を入れたあとの本文へ入れる（本文がメモを消さない）", async () => {
    const io = work();
    const result = await importOutboxRecords(io, {
      isOwner: () => true,
      records: [memo({ baseBlobSha: gitBlobSha(enc(BODY)) }), bodyRecord()],
      now: NOW,
    });
    expect(result.results.map((item) => item.status)).toEqual(["imported", "imported"]);
    expect(read(io)).toContain("続きを書いた。");
    expect(read(io)).toContain("// ここで間を置く");
  });

  it("送った本文が今と同じなら、書かずに入れたことにする", async () => {
    const io = work();
    const result = await importOutboxRecords(io, { isOwner: () => true, records: [bodyRecord({ text: BODY })], now: NOW });
    expect(result.results[0].status).toBe("imported");
    expect(result.results[0].reason).toContain("同じ");
  });
});
