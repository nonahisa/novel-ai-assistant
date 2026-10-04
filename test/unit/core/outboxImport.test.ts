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
