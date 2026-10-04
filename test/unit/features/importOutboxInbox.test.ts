import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import { runInboxImport, countPendingInboxRecords } from "../../../src/features/importOutboxInbox";
import { outboxImport } from "../../../src/mcp/tools/outbox";
import { OUTBOX_INBOX_FORMAT, parseInboxResult } from "../../../src/core/outboxInbox";
import { BODY_CHANGED_REASON, gitBlobSha, type OutboxRecord } from "../../../src/core/outboxImport";
import { commitAll } from "../../../src/core/gitSetup";
import { runGit } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * ［原稿箱を取り込む］（設計書6.115「GitHub 経由」）を**本物のディスク**で試す。
 *
 * 見張ること
 *
 * 1. 受け取り箱を読み、入れ、`done/` へ移す。壊れた箱は残す。2度目は入れない
 * 2. **MCP の `outbox.import` と拡張機能で、同じ記録が同じ結果になる**
 *    （判断は `core/outboxImport.ts` の1つだけ。本文の書き戻しだけが道ごとに違う）
 * 3. `done/` へ移したものが、次の同期の記録（`git add -A`）に入る
 */

const FILE = "本文/001_はじまり.txt";
const NOW = new Date("2026-10-04T12:00:00.000Z");
/** CRLF の作品（書き戻しで改行の形を保つかも一緒に見る） */
const BODY = "一行目\r\n彼はゆくりと歩いた。\r\n三行目\r\n";

const FINDING = {
  kind: "finding",
  id: "f_typo",
  time: "2026-10-04T00:00:00.000Z",
  file: FILE,
  hintLine: 2,
  original: "彼はゆくりと歩いた。",
  target: "ゆくり",
  suggestion: "ゆっくり",
  before: "一行目",
  after: "三行目",
  message: "脱字",
  category: "typo",
  label: "誤字脱字",
};

let roots: string[] = [];

function makeWork(name: string): WorkEntry {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `outbox-inbox-${name}-`));
  roots.push(root);
  fs.mkdirSync(nodePath.join(root, "本文"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, ".aiwriter", "config.json"),
    JSON.stringify({ schemaVersion: "0.1", workTitle: "試し", manuscriptDir: "本文", settingsDir: "設定", createdAt: "2026-10-01T00:00:00.000Z" })
  );
  fs.writeFileSync(nodePath.join(root, FILE), BODY, "utf8");
  fs.writeFileSync(nodePath.join(root, ".aiwriter", "findings.jsonl"), `${JSON.stringify(FINDING)}\n`, "utf8");
  return { id: `w_${name}`, title: "試し", folderPath: root, registeredAt: "2026-10-01T00:00:00.000Z" };
}

function putBox(work: WorkEntry, name: string, records: unknown[], extra: Record<string, unknown> = {}): void {
  const dir = nodePath.join(work.folderPath, ".aiwriter", "inbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    nodePath.join(dir, name),
    JSON.stringify({
      format: OUTBOX_INBOX_FORMAT,
      version: 1,
      sentAt: "2026-10-04T05:00:00.000Z",
      device: "タブレット",
      writer: "u_1",
      records,
      ...extra,
    }),
    "utf8"
  );
}

/** `vscode.workspace.fs` を本物のディスクへつなぐ（製品の書き戻しの手順をそのまま通す） */
function wireDisk(): void {
  const notFound = (target: string) => new FileSystemError(`無い: ${target}`, "FileNotFound");
  workspace.getConfiguration = () => ({ get: <T>(_key: string, value: T): T => value });
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      try {
        return new Uint8Array(fs.readFileSync(uri.fsPath));
      } catch {
        throw notFound(uri.fsPath);
      }
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
      fs.writeFileSync(uri.fsPath, bytes);
    },
    stat: async (uri: { fsPath: string }) => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(uri.fsPath);
      } catch {
        throw notFound(uri.fsPath);
      }
      return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
    },
    readDirectory: async (uri: { fsPath: string }) => {
      try {
        return fs
          .readdirSync(uri.fsPath, { withFileTypes: true })
          .map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
      } catch {
        throw notFound(uri.fsPath);
      }
    },
    createDirectory: async (uri: { fsPath: string }) => {
      fs.mkdirSync(uri.fsPath, { recursive: true });
    },
    delete: async (uri: { fsPath: string }) => {
      fs.rmSync(uri.fsPath, { recursive: true, force: false });
    },
    rename: async (from: { fsPath: string }, to: { fsPath: string }, options?: { overwrite?: boolean }) => {
      if (!options?.overwrite && fs.existsSync(to.fsPath)) {
        throw new FileSystemError(`在る: ${to.fsPath}`, "FileExists");
      }
      fs.renameSync(from.fsPath, to.fsPath);
    },
  } as unknown as typeof workspace.fs;
}

beforeEach(() => {
  roots = [];
  wireDisk();
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const read = (work: WorkEntry, relative: string) =>
  fs.readFileSync(nodePath.join(work.folderPath, relative), "utf8");

/** 判断の行の時刻（取り込んだ時刻）を外して比べる */
const withoutTimes = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      delete value.time;
      return value;
    });

function recordsFor(bodyBytes: Buffer): Array<Omit<OutboxRecord, "writer">> {
  return [
    { id: "m1", kind: "memo", findingId: "f_typo", text: "ここは急ぎ足で", baseBlobSha: gitBlobSha(bodyBytes), at: "2026-10-04T04:00:00.000Z" },
    { id: "m2", kind: "memo", episode: FILE, text: "古いメモ", baseBlobSha: gitBlobSha(Buffer.from("前の本文\n")), at: "2026-10-04T04:01:00.000Z" },
    { id: "v1", kind: "verdict", findingId: "f_typo", verdict: "fix", at: "2026-10-04T04:02:00.000Z" },
    { id: "m3", kind: "memo", episode: ".aiwriter/config.json", text: "設定へ", baseBlobSha: "x" },
  ];
}

describe("受け取り箱を取り込む", () => {
  it("入れて、done へ移し、壊れた箱は残す。2度目は入れない", async () => {
    const work = makeWork("a");
    const bytes = fs.readFileSync(nodePath.join(work.folderPath, FILE));
    putBox(work, "20261004T050000Z-tablet.json", recordsFor(bytes));
    fs.writeFileSync(nodePath.join(work.folderPath, ".aiwriter", "inbox", "20261004T050100Z-phone.json"), "{壊れ");

    expect(await countPendingInboxRecords(work)).toBe(4);
    const report = await runInboxImport(work, { now: NOW });

    expect(report.outcome.results.map((item) => [item.id, item.status])).toEqual([
      ["m1", "imported"],
      ["m2", "refused"],
      ["v1", "imported"],
      ["m3", "refused"],
    ]);
    // 本文：メモは指摘の行の上、［直す］が当たり、改行は CRLF のまま
    expect(read(work, FILE)).toBe("一行目\r\n// ここは急ぎ足で\r\n彼はゆっくりと歩いた。\r\n三行目\r\n");
    // 読めた箱は done へ、壊れた箱は受け取り箱に残る
    const inbox = nodePath.join(work.folderPath, ".aiwriter", "inbox");
    expect(fs.readdirSync(inbox).sort()).toEqual(["20261004T050100Z-phone.json", "done"]);
    expect(fs.readdirSync(nodePath.join(inbox, "done")).sort()).toEqual([
      "20261004T050000Z-tablet.json",
      "20261004T050000Z-tablet.json.result.json",
    ]);
    expect(report.broken.map((item) => item.name)).toEqual(["20261004T050100Z-phone.json"]);
    // 結果のファイル：ページが断られた記録を理由つきで出すため（記録ごと・箱の中の順）
    const result = parseInboxResult(
      fs.readFileSync(nodePath.join(inbox, "done", "20261004T050000Z-tablet.json.result.json"), "utf8")
    );
    expect(result.ok && result.box).toBe("20261004T050000Z-tablet.json");
    expect(result.ok && result.results.map((item) => [item.id, item.status])).toEqual([
      ["m1", "imported"],
      ["m2", "refused"],
      ["v1", "imported"],
      ["m3", "refused"],
    ]);
    expect(result.ok && result.results[1].reason).toBe(BODY_CHANGED_REASON);

    // 同じ記録を別の箱で送り直しても、入れ済みで返す
    putBox(work, "20261004T060000Z-tablet.json", [recordsFor(bytes)[2]]);
    const again = await runInboxImport(work, { now: NOW });
    expect(again.outcome.results.map((item) => item.status)).toEqual(["already"]);
    // done に同じ名前が無いので、そのままの名前で移る
    expect(fs.readdirSync(nodePath.join(inbox, "done")).sort()).toEqual([
      "20261004T050000Z-tablet.json",
      "20261004T050000Z-tablet.json.result.json",
      "20261004T060000Z-tablet.json",
      "20261004T060000Z-tablet.json.result.json",
    ]);
  });

  it("MCP の outbox.import と同じ記録で、同じ結果・同じ本文・同じ置き場になる", async () => {
    const viaExtension = makeWork("ext");
    const viaMcp = makeWork("mcp");
    const bytes = fs.readFileSync(nodePath.join(viaExtension.folderPath, FILE));
    const records = recordsFor(bytes);

    putBox(viaExtension, "box.json", records);
    const extension = await runInboxImport(viaExtension, { now: NOW });
    const mcp = await outboxImport({
      folder: viaMcp.folderPath,
      ownerId: "u_1",
      records: records.map((record) => ({ ...record, writer: "u_1" })),
    });

    expect(extension.outcome.results).toEqual(mcp.results);
    expect(fs.readFileSync(nodePath.join(viaExtension.folderPath, FILE))).toEqual(
      fs.readFileSync(nodePath.join(viaMcp.folderPath, FILE))
    );
    expect(withoutTimes(read(viaExtension, ".aiwriter/findings.jsonl"))).toEqual(
      withoutTimes(read(viaMcp, ".aiwriter/findings.jsonl"))
    );
    expect(withoutTimes(read(viaExtension, ".aiwriter/history/outbox-imported.jsonl"))).toEqual(
      withoutTimes(read(viaMcp, ".aiwriter/history/outbox-imported.jsonl"))
    );
  });

  it("原稿エディターのページの本文（版2の箱）：BOM・CRLF を保って書き、回復先に前の本文を残す。MCP の道と同じになる", async () => {
    const withBom = `﻿${BODY}`;
    const viaExtension = makeWork("body-ext");
    const viaMcp = makeWork("body-mcp");
    for (const work of [viaExtension, viaMcp]) fs.writeFileSync(nodePath.join(work.folderPath, FILE), withBom, "utf8");
    // ページは GitHub の blob SHA を持つ（リポジトリは LF・BOM つき。core.autocrlf の機械）
    const repoBytes = Buffer.from(withBom.replace(/\r\n/g, "\n"), "utf8");
    const record = {
      id: "b1",
      kind: "body" as const,
      at: "2026-10-05T01:00:00.000Z",
      episode: FILE,
      baseBlobSha: gitBlobSha(repoBytes),
      text: "一行目\n彼はゆっくりと歩いた。\n三行目\n続きを書いた。\n",
    };
    putBox(viaExtension, "20261005T010000Z-phone-editor.json", [record], { version: 2, writer: "editor" });
    const extension = await runInboxImport(viaExtension, { now: NOW });
    const mcp = await outboxImport({ folder: viaMcp.folderPath, ownerId: "editor", records: [{ ...record, writer: "editor" }] });

    expect(extension.outcome.results.map((item) => item.status)).toEqual(["imported"]);
    expect(extension.outcome.results).toEqual(mcp.results);
    const expected = "﻿一行目\r\n彼はゆっくりと歩いた。\r\n三行目\r\n続きを書いた。\r\n";
    expect(read(viaExtension, FILE)).toBe(expected);
    expect(read(viaMcp, FILE)).toBe(expected);
    // 前の本文は回復先（.novelai-recovery）に残る（提案パネルの［戻す］には並ばない。全文の置き換えのため）
    const recovery = nodePath.join(viaExtension.folderPath, "本文", ".novelai-recovery");
    const kept = fs.existsSync(recovery) ? fs.readdirSync(recovery) : [];
    expect(kept.length).toBeGreaterThan(0);
  });

  it("本文の全体は、パソコンの本文が変わっていれば断り、結果にいまの本文の印を返す", async () => {
    const work = makeWork("body-changed");
    putBox(
      work,
      "20261005T010000Z-phone-editor.json",
      [{ id: "b1", kind: "body", episode: FILE, baseBlobSha: gitBlobSha(Buffer.from("前の本文\n")), text: "書いた\n" }],
      { version: 2, writer: "editor" }
    );
    await runInboxImport(work, { now: NOW });
    expect(read(work, FILE)).toBe(BODY);
    const result = parseInboxResult(
      fs.readFileSync(
        nodePath.join(work.folderPath, ".aiwriter", "inbox", "done", "20261005T010000Z-phone-editor.json.result.json"),
        "utf8"
      )
    );
    expect(result.ok && result.results[0].status).toBe("refused");
    expect(result.ok && result.results[0].currentBlobSha).toBe(gitBlobSha(Buffer.from(BODY, "utf8")));
  });

  it("受け取り箱が無ければ何もしない", async () => {
    const work = makeWork("empty");
    expect(await countPendingInboxRecords(work)).toBe(0);
    const report = await runInboxImport(work, { now: NOW });
    expect(report.boxes).toEqual([]);
    expect(report.outcome.results).toEqual([]);
  });
});

describe("done へ移したものは、次の同期で送られる", () => {
  it("git add -A（すべて同期の記録）が、受け取り箱からの移動を記録する", async () => {
    const work = makeWork("git");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: work.folderPath, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "試し");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    git("config", "core.quotepath", "false");
    const bytes = fs.readFileSync(nodePath.join(work.folderPath, FILE));
    putBox(work, "box.json", [recordsFor(bytes)[2]]);
    git("add", "-A");
    git("commit", "-q", "-m", "出先から届いた");

    await runInboxImport(work, { now: NOW });
    const committed = await commitAll(work.folderPath, "取り込んだ", runGit);
    expect(committed.ok).toBe(true);

    const tracked = git("ls-files").split("\n");
    expect(tracked).toContain(".aiwriter/inbox/done/box.json");
    expect(tracked).not.toContain(".aiwriter/inbox/box.json");
    expect(git("status", "--porcelain").trim()).toBe("");
  });
});
