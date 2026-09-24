import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isProcessAlive,
  nodeLeaseEnvironment,
  nodeLeaseFileOps,
} from "../../../src/core/localAiLeaseNode";
import { ProcessLease, parseLease } from "../../../src/core/localAiLease";

/**
 * 札のファイルを本物の fs で扱う部品（設計書6.76.1）。
 *
 * **ここが「原子的に作る」の実体である。** 純粋な部分の試験
 * （`localAiLease.test.ts`）は偽のファイルで取り合いを見ているので、
 * 本物の fs で「既にあれば失敗する」「中身ごと現れる」を確かめておく。
 */

let directory: string;
let file: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-lease-"));
  file = path.join(directory, "local-ai", "lease.json");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("札のファイルの操作", () => {
  test("無ければ作る。あれば失敗し、中身を書き換えない", async () => {
    const ops = nodeLeaseFileOps(file);
    expect(await ops.tryCreate("一枚目")).toBe(true);
    expect(await ops.tryCreate("二枚目")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("一枚目");
    // 一時ファイルを残さない
    expect(fs.readdirSync(path.dirname(file))).toEqual(["lease.json"]);
  });

  test("同時に10本作りにいっても、通るのは1本だけ", async () => {
    const ops = nodeLeaseFileOps(file);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => ops.tryCreate(`札${index}`))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect(fs.readFileSync(file, "utf8")).toBe(`札${winner}`);
  });

  test("中身が同じときだけ消す（取り直された札を消さない）", async () => {
    const ops = nodeLeaseFileOps(file);
    await ops.tryCreate("自分の札");
    expect(await ops.removeIfSame("別の札")).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(await ops.removeIfSame("自分の札")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // もう無いものを消しても失敗にしない
    expect(await ops.removeIfSame("自分の札")).toBe(true);
    expect(await ops.read()).toBeUndefined();
  });

  test("生存の印は最終更新時刻を進める（中身は変えない）", async () => {
    const ops = nodeLeaseFileOps(file);
    await ops.tryCreate("札");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    const before = (await ops.read())!.mtimeMs;
    await ops.touch();
    const after = await ops.read();
    expect(after!.mtimeMs).toBeGreaterThan(before + 60_000);
    expect(after!.text).toBe("札");
  });
});

describe("プロセスの生死", () => {
  test("自分は生きている。使われていない番号は死んでいる", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    // 大きな番号はまず使われていない（使われていたら生きている＝true でもよい）
    expect([false, true]).toContain(isProcessAlive(2 ** 22 - 3));
  });
});

describe("本物の fs で2つのプロセスが取り合う", () => {
  test("片方が持つ間はもう片方が待ち、離せば取れる", async () => {
    const a = new ProcessLease(nodeLeaseEnvironment(file), {
      pid: process.pid,
      host: "extension",
      token: "a",
    });
    const b = new ProcessLease(nodeLeaseEnvironment(file), {
      pid: process.pid,
      host: "mcp",
      token: "b",
    });
    const held = await a.enter("誤字脱字の検知");
    let waitedFor: string | undefined;
    const waiting = b.enter("推敲", { onWait: (holder) => (waitedFor = holder.label) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(waitedFor).toBe("誤字脱字の検知");
    expect(parseLease(fs.readFileSync(file, "utf8"))?.token).toBe("a");
    held.release();
    const entry = await waiting;
    expect(entry.kind).toBe("held");
    expect(parseLease(fs.readFileSync(file, "utf8"))?.token).toBe("b");
    entry.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(file)).toBe(false);
  });
});
