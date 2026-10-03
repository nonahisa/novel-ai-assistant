import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import iconv from "iconv-lite";
import { decodeBytes } from "../../../src/core/textDecode";
import { parseFindingLines, resolveFindings, type Finding } from "../../../src/models/finding";
import {
  BODY_CHANGED_REASON,
  findOutboxTemplate,
  outboxImport,
  outboxPack,
  type OutboxRecord,
} from "../../../src/mcp/tools/outbox";
import { exposureOf } from "../../../src/mcp/tools/accessLog";

/**
 * 出先の原稿箱の段1（設計書6.115）——`outbox.pack` と `outbox.import`。
 *
 * いちばん見張りたいのは3つ。
 *
 * 1. **送る中身に本文が入らない**（段1で claude.ai へ出るのは指摘の一文と題・ハッシュだけ）
 * 2. **原稿を壊さない**——送ったあとに本文が変わっていれば入れない／文字コード・
 *    改行・末尾改行を保つ（実装ルール1）
 * 3. **採否は持ち主の記録だけ**——編集部の採否は入れない
 */

const OWNER = "u_owner";
const EDITOR = "u_editor";
const FILE = "本文/001_はじまり.txt";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outbox-"));
  fs.mkdirSync(nodePath.join(root, "本文"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, ".aiwriter"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeBody(bytes: Uint8Array | string, file = FILE): void {
  fs.writeFileSync(nodePath.join(root, file), bytes);
}

function readBytes(file = FILE): Buffer {
  return fs.readFileSync(nodePath.join(root, file));
}

function hashOf(file = FILE): string {
  return decodeBytes(readBytes(file)).hash;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f_typo1",
    time: new Date().toISOString(),
    file: FILE,
    hintLine: 2,
    original: "彼はわらった。",
    target: "わらった",
    suggestion: "笑った",
    before: "",
    after: "",
    message: "漢字にすると読みやすい",
    category: "typo",
    label: "誤字脱字",
    producer: { providerId: "ollama", model: "gemma" },
    ...overrides,
  };
}

function placeFindings(findings: Finding[]): void {
  fs.writeFileSync(
    nodePath.join(root, ".aiwriter", "findings.jsonl"),
    findings.map((item) => JSON.stringify({ kind: "finding", ...item })).join("\n") + "\n",
    "utf8"
  );
}

function memo(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "r1",
    kind: "memo",
    writer: OWNER,
    episode: FILE,
    text: "ここに潮の匂いを足す",
    baseHash: hashOf(),
    ...overrides,
  };
}

function verdict(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "v1",
    kind: "verdict",
    writer: OWNER,
    findingId: "f_typo1",
    verdict: "fix",
    baseHash: hashOf(),
    ...overrides,
  };
}

function findingStatus(id: string): string | undefined {
  const text = fs.readFileSync(nodePath.join(root, ".aiwriter", "findings.jsonl"), "utf8");
  return resolveFindings(parseFindingLines(text)).find((view) => view.id === id)?.status;
}

describe("outbox.pack——送る中身", () => {
  it("本文そのものは返さない（題・ハッシュ・未処理の指摘の一文だけ）", () => {
    const secret = "この一文は外へ出てはいけない本文である。";
    writeBody(`一行目\n彼はわらった。\n${secret}\n`);
    placeFindings([finding()]);

    const result = outboxPack({ folder: root });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.episodes).toEqual([
      { file: FILE, chapter: 1, title: expect.any(String), hash: hashOf() },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: "f_typo1",
      file: FILE,
      line: 2,
      original: "彼はわらった。",
      suggestion: "笑った",
      canFix: true,
    });
  });

  it("判断の済んだ指摘は送らない（提案パネルと同じ状態の決め方）", () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    fs.appendFileSync(
      nodePath.join(root, ".aiwriter", "findings.jsonl"),
      JSON.stringify({ kind: "decision", findingId: "f_typo1", time: new Date().toISOString(), status: "dismissed", note: "" }) + "\n"
    );
    expect(outboxPack({ folder: root }).findings).toHaveLength(0);
  });

  it("雛形の道は実在するものだけを返す（束の隣 → リポジトリの media/outbox の順）", () => {
    // 束の隣に写してある（製品が保管庫へ写した形）
    const storage = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outbox-storage-"));
    try {
      fs.writeFileSync(nodePath.join(storage, "outbox.html"), "<title>x</title>");
      expect(findOutboxTemplate(nodePath.join(storage, "mcp-server.mjs"))).toBe(
        nodePath.join(storage, "outbox.html")
      );
      // 隣に無く、1つ上にも media が無ければ null（推測の道を返さない）
      fs.rmSync(nodePath.join(storage, "outbox.html"));
      expect(findOutboxTemplate(nodePath.join(storage, "mcp-server.mjs"))).toBeNull();
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
    // リポジトリの dist から走らせた形
    const repo = nodePath.join(__dirname, "..", "..", "..");
    expect(findOutboxTemplate(nodePath.join(repo, "dist", "mcp-server.mjs"))).toBe(
      nodePath.join(repo, "media", "outbox", "outbox.html")
    );
  });

  it("作品に触れない記録の重さ：pack は抜粋、import は出さない", () => {
    expect(exposureOf("outbox.pack", { folder: root })).toBe("excerpt");
    expect(exposureOf("outbox.import", { folder: root })).toBe("none");
  });
});

describe("outbox.import——メモ", () => {
  it("話の末尾へ // の行として入れる", () => {
    writeBody("一行目\n二行目\n");
    const result = outboxImport({ folder: root, ownerId: OWNER, records: [memo()] });
    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe("一行目\n二行目\n// ここに潮の匂いを足す\n");
  });

  it("指摘に付けたメモは、その指摘の行の上へ入れる", () => {
    writeBody("一行目\n彼はわらった。\n三行目\n");
    placeFindings([finding()]);
    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [memo({ findingId: "f_typo1", text: "ここは笑顔の描写を足す" })],
    });
    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe(
      "一行目\n// ここは笑顔の描写を足す\n彼はわらった。\n三行目\n"
    );
  });

  it("持ち主でない人のメモには「編集部：」を付ける", () => {
    writeBody("一行目\n");
    outboxImport({ folder: root, ownerId: OWNER, records: [memo({ writer: EDITOR, text: "ここは早い" })] });
    expect(readBytes().toString("utf8")).toBe("一行目\n// 編集部：ここは早い\n");
  });

  it("送ったあとに本文が変わっていれば入れずに断る（原稿は1バイトも変えない）", () => {
    writeBody("一行目\n");
    const stale = memo();
    writeBody("一行目\n作者がパソコンで書き足した\n");
    const before = readBytes();

    const result = outboxImport({ folder: root, ownerId: OWNER, records: [stale] });

    expect(result.results[0]).toMatchObject({ status: "refused", reason: BODY_CHANGED_REASON });
    expect(readBytes().equals(before)).toBe(true);
  });

  it("同じ話へ2件入れても、2件目を「本文が変わった」で断らない", () => {
    writeBody("一行目\n");
    const base = hashOf();
    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        memo({ id: "a", text: "一つ目", baseHash: base }),
        memo({ id: "b", text: "二つ目", baseHash: base }),
      ],
    });
    expect(result.results.map((item) => item.status)).toEqual(["imported", "imported"]);
    expect(readBytes().toString("utf8")).toBe("一行目\n// 一つ目\n// 二つ目\n");
  });

  it("2度目は入れ済みとして返し、本文へ2度入れない", () => {
    writeBody("一行目\n");
    const record = memo();
    outboxImport({ folder: root, ownerId: OWNER, records: [record] });
    const after = readBytes();

    const second = outboxImport({ folder: root, ownerId: OWNER, records: [record] });

    expect(second.results[0].status).toBe("already");
    expect(second.alreadyCount).toBe(1);
    expect(readBytes().equals(after)).toBe(true);
  });

  it("Shift_JIS・CRLF・末尾改行なしの本文で、文字コードと改行を保つ", () => {
    // 「～」は CP932 で別の符号を持つ字。書いていない行の元バイトが残るかを見る
    const original = iconv.encode("一行目～\r\n二行目", "shift_jis");
    writeBody(original);

    const result = outboxImport({ folder: root, ownerId: OWNER, records: [memo({ text: "足す" })] });

    expect(result.results[0].status).toBe("imported");
    const expected = Buffer.concat([
      original,
      iconv.encode("\r\n// 足す", "shift_jis"),
    ]);
    expect(readBytes().equals(expected)).toBe(true);
    // 書き換える前の本文は回復先に残る（既存ファイルを上書きしない）
    const recovery = fs.readdirSync(nodePath.join(root, "本文", ".novelai-recovery"));
    expect(recovery).toHaveLength(1);
  });

  it("本文でないファイルは指させない", () => {
    writeBody("一行目\n");
    fs.writeFileSync(nodePath.join(root, "メモ.json"), "{}");
    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [memo({ episode: "メモ.json", baseHash: decodeBytes(Buffer.from("{}")).hash })],
    });
    expect(result.results[0].status).toBe("refused");
    expect(fs.readFileSync(nodePath.join(root, "メモ.json"), "utf8")).toBe("{}");
  });
});

describe("outbox.import——採否", () => {
  it("持ち主の［直す］は、提案パネルの［適用］と同じ計算で当てて判断を残す", () => {
    writeBody("一行目\r\n彼はわらった。\r\n");
    placeFindings([finding()]);

    const result = outboxImport({ folder: root, ownerId: OWNER, records: [verdict()] });

    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe("一行目\r\n彼は笑った。\r\n");
    expect(findingStatus("f_typo1")).toBe("accepted");
    const verdicts = fs.readFileSync(
      nodePath.join(root, ".aiwriter", "history", "ai-verdicts.jsonl"),
      "utf8"
    );
    expect(JSON.parse(verdicts.trim())).toMatchObject({
      subject: "f_typo1",
      providerId: "ollama",
      model: "gemma",
      feature: "typo",
      status: "accepted",
    });
  });

  it("持ち主でない人の採否は断る（本文も判断も変えない）", () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const before = readBytes();

    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [verdict({ writer: EDITOR })],
    });

    expect(result.results[0].status).toBe("refused");
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("pending");
  });

  it("欄に持ち主の id が書いてあっても、パスが別の人のものなら採否は断る", () => {
    // 編集部が記録の欄 by に持ち主の id を書いて、持ち主の採否に見せかけた形
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const before = readBytes();

    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [verdict({ writer: EDITOR, by: OWNER })],
    });

    expect(result.results[0]).toMatchObject({ status: "refused", writer: EDITOR });
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("pending");
  });

  it("同じ文書の id でも、書き手が違えば別の記録として扱う", () => {
    writeBody("一行目\n");
    const base = hashOf();
    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        memo({ id: "same", writer: OWNER, text: "作者", baseHash: base }),
        memo({ id: "same", writer: EDITOR, text: "編集", baseHash: base }),
      ],
    });
    expect(result.results.map((item) => [item.writer, item.status])).toEqual([
      [OWNER, "imported"],
      [EDITOR, "imported"],
    ]);
    expect(readBytes().toString("utf8")).toBe("一行目\n// 作者\n// 編集部：編集\n");
  });

  it("［採らない］は退けた、［済み］は採ったとして記録し、本文には触れない", () => {
    writeBody("一行目\n彼はわらった。\n彼女はないた。\n");
    placeFindings([
      finding(),
      finding({ id: "f_typo2", hintLine: 3, original: "彼女はないた。", target: "ないた", suggestion: "泣いた" }),
    ]);
    const before = readBytes();

    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        verdict({ id: "a", verdict: "reject" }),
        verdict({ id: "b", findingId: "f_typo2", verdict: "done" }),
      ],
    });

    expect(result.importedCount).toBe(2);
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("dismissed");
    expect(findingStatus("f_typo2")).toBe("accepted");
  });

  it("メモと［直す］が同じ指摘に付いていても、両方入る（メモが先）", () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const base = hashOf();

    const result = outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        verdict({ id: "v", baseHash: base }),
        memo({ id: "m", findingId: "f_typo1", text: "表情も", baseHash: base }),
      ],
    });

    expect(result.results.map((item) => [item.id, item.status])).toEqual([
      ["v", "imported"],
      ["m", "imported"],
    ]);
    expect(readBytes().toString("utf8")).toBe("一行目\n// 表情も\n彼は笑った。\n");
  });

  it("校閲中のファイルへは［直す］を当てない", () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    fs.mkdirSync(nodePath.join(root, ".aiwriter", "locks"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(root, ".aiwriter", "locks", "locks.jsonl"),
      JSON.stringify({ kind: "acquire", file: FILE, holder: "編集部の田中", holderKind: "editor", time: new Date().toISOString(), note: "" }) + "\n"
    );
    const before = readBytes();

    const result = outboxImport({ folder: root, ownerId: OWNER, records: [verdict()] });

    expect(result.results[0].status).toBe("refused");
    expect(readBytes().equals(before)).toBe(true);
  });
});
